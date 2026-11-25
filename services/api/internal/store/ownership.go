package store

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"sync"
	"time"

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
func (s ownedStore) PutAt(ctx context.Context, v, h string, size int64, createdAt time.Time, in io.Reader) (string, error) {
	key, err := s.namespace(v)
	if err != nil {
		return "", err
	}
	return s.raw.PutAt(ctx, key, h, size, createdAt, in)
}
func putResource(ctx context.Context, store blob.Store, vault, hash string, size int64, date time.Time, body io.Reader) (string, error) {
	scoped, ok := store.(ownedStore)
	if !ok {
		return "", errors.New("resource requires a vault owner")
	}
	ns, err := scoped.namespace(vault)
	if err != nil {
		return "", err
	}
	return scoped.raw.PutAt(ctx, ns+"/assets", hash, size, date, body)
}
func (s ownedStore) OpenContext(ctx context.Context, v, h, storageKey string) (io.ReadCloser, error) {
	key, err := s.namespace(v)
	if err != nil {
		return nil, err
	}
	return s.raw.OpenContext(ctx, key, h, storageKey)
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
