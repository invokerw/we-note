package store

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"os"
	"sync"

	"github.com/weifei/we-note/services/api/internal/blob"
)

const vaultOwners = `SELECT id,owner_user_id AS owner FROM vaults UNION ALL SELECT id,owner FROM encrypted_vaults`

type ownedStore struct {
	raw    blob.Store
	owners *sync.Map
}

func (s ownedStore) namespace(vault string) (string, error) {
	owner, ok := s.owners.Load(vault)
	if !ok {
		return "", errors.New("unknown vault owner")
	}
	return blob.VaultNamespace(owner.(string), vault)
}
func (s ownedStore) Put(ctx context.Context, v, h string, size int64, in io.Reader) (string, error) {
	key, err := s.namespace(v)
	if err != nil {
		return "", err
	}
	return s.raw.Put(ctx, key, h, size, in)
}
func (s ownedStore) OpenContext(ctx context.Context, v, h string) (io.ReadCloser, error) {
	key, err := s.namespace(v)
	if err != nil {
		return nil, err
	}
	in, err := s.raw.OpenContext(ctx, key, h)
	if errors.Is(err, os.ErrNotExist) {
		return s.raw.OpenContext(ctx, v, h)
	}
	return in, err
}
func readOwners(ctx context.Context, db *sql.DB) (*sync.Map, error) {
	owners := new(sync.Map)
	rows, err := db.QueryContext(ctx, vaultOwners)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var v, o string
		if err = rows.Scan(&v, &o); err != nil {
			return nil, err
		}
		owners.Store(v, o)
	}
	return owners, rows.Err()
}
func unwrap(s blob.Store) blob.Store {
	if scoped, ok := s.(ownedStore); ok {
		return scoped.raw
	}
	return s
}
func (r *Repository) bindOwners(ctx context.Context, s blob.Store) error {
	owners, err := readOwners(ctx, r.db.DB)
	if err != nil {
		return err
	}
	r.owners = owners
	if s != nil {
		r.blobStore = ownedStore{unwrap(s), owners}
	}
	return nil
}

// Migrate once, before accepting requests. An interrupted pass resumes safely because
// the legacy object is removed only after the owned object has been read and verified.
func (r *Repository) migrateOwnedLayout(ctx context.Context) error {
	var done bool
	if err := r.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=4)`).Scan(&done); err != nil || done {
		return err
	}
	raw := unwrap(r.blobStore)
	rows, err := r.db.QueryContext(ctx, backedUpObjects)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var v, h string
		var size int64
		if err = rows.Scan(&v, &h, &size); err != nil {
			return err
		}
		ns, err := r.blobStore.(ownedStore).namespace(v)
		if err != nil {
			return err
		}
		in, err := raw.OpenContext(ctx, v, h)
		if errors.Is(err, os.ErrNotExist) {
			out, err := raw.OpenContext(ctx, ns, h)
			if err != nil {
				return err
			}
			if err = verifyReader(out, h, size); err != nil {
				return err
			}
			continue
		}
		if err != nil {
			return err
		}
		_, err = raw.Put(ctx, ns, h, size, in)
		in.Close()
		if err != nil {
			return err
		}
		out, err := raw.OpenContext(ctx, ns, h)
		if err != nil {
			return err
		}
		if err = verifyReader(out, h, size); err != nil {
			return err
		}
		if err = blob.Remove(ctx, raw, v, h); err != nil {
			return err
		}
	}
	if err = rows.Err(); err != nil {
		return err
	}
	rows.Close()
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = migrateEnvelopes(ctx, tx, raw); err != nil {
		return err
	}
	for _, table := range []string{"blobs", "upload_sessions"} {
		_, err = tx.ExecContext(ctx, `UPDATE `+table+` SET storage_key=(SELECT 'users/'||owner_user_id||'/vaults/'||id||'/'||substr(content_hash,8,2)||'/'||substr(content_hash,8) FROM vaults WHERE id=`+table+`.vault_id) WHERE storage_key IS NOT NULL`)
		if err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO schema_migrations(version) VALUES(4)`); err != nil {
		return err
	}
	return tx.Commit()
}
