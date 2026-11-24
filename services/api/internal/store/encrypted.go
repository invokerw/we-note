package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"regexp"
	"time"

	"github.com/weifei/we-note/services/api/internal/blob"
)

type EncryptedVault struct {
	ID         string `json:"id"`
	Revision   int64  `json:"revision"`
	Updated    string `json:"updated_at"`
	IV         []byte `json:"iv,omitempty"`
	Ciphertext []byte `json:"ciphertext,omitempty"`
}
type Envelope struct {
	Base       int64  `json:"base_revision"`
	IV         []byte `json:"iv"`
	Ciphertext []byte `json:"ciphertext"`
}

var encryptedID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func (r *Repository) EncryptedVaults(ctx context.Context, user string) ([]EncryptedVault, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT id,revision,updated_at FROM encrypted_vaults WHERE owner=? ORDER BY updated_at DESC`, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []EncryptedVault{}
	for rows.Next() {
		var v EncryptedVault
		if err = rows.Scan(&v.ID, &v.Revision, &v.Updated); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (r *Repository) EncryptedVault(ctx context.Context, user, id string) (EncryptedVault, error) {
	var v EncryptedVault
	var hash string
	var size int64
	err := r.db.QueryRowContext(ctx, `SELECT e.id,revision,updated_at,iv,ciphertext,COALESCE(o.hash,''),COALESCE(o.size,0) FROM encrypted_vaults e LEFT JOIN encrypted_objects o ON o.vault_id=e.id WHERE e.id=? AND owner=?`, id, user).Scan(&v.ID, &v.Revision, &v.Updated, &v.IV, &v.Ciphertext, &hash, &size)
	if errors.Is(err, sql.ErrNoRows) {
		return v, ErrNotFound
	}
	if err != nil || hash == "" {
		return v, err
	}
	if r.blobStore == nil || size < 16 || size > 16<<20 {
		return v, errors.New("invalid encrypted vault storage")
	}
	in, err := r.blobStore.OpenContext(ctx, id, hash)
	if err != nil {
		return v, err
	}
	defer in.Close()
	v.Ciphertext, err = io.ReadAll(io.LimitReader(in, size+1))
	if err == nil && (int64(len(v.Ciphertext)) != size || fmt.Sprintf("sha256:%x", sha256.Sum256(v.Ciphertext)) != hash) {
		return v, errors.New("encrypted content verification failed")
	}
	return v, err
}
func (r *Repository) SaveEncrypted(ctx context.Context, user, id string, q Envelope) (EncryptedVault, error) {
	var v EncryptedVault
	if !encryptedID.MatchString(id) || q.Base < 0 || q.Base >= maxSafeRevision || len(q.IV) != 12 || len(q.Ciphertext) < 16 || len(q.Ciphertext) > 16<<20 {
		return v, fileError(400, "INVALID_ENVELOPE", "invalid encrypted vault envelope (16 MiB maximum)")
	}
	v = EncryptedVault{ID: id, Revision: q.Base + 1, Updated: formatTime(time.Now().UTC())}
	var res sql.Result
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return v, err
	}
	defer tx.Rollback()
	inline := q.Ciphertext
	hash := ""
	if r.managedOnline {
		inline = []byte{}
		hash = fmt.Sprintf("sha256:%x", sha256.Sum256(q.Ciphertext))
	}
	if q.Base == 0 {
		res, err = tx.ExecContext(ctx, `INSERT INTO encrypted_vaults VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, id, user, v.Revision, inline, q.IV, v.Updated)
	} else {
		res, err = tx.ExecContext(ctx, `UPDATE encrypted_vaults SET revision=?,ciphertext=?,iv=?,updated_at=? WHERE id=? AND owner=? AND revision=? AND iv<>?`, v.Revision, inline, q.IV, v.Updated, id, user, q.Base, q.IV)
	}
	if err != nil {
		return v, err
	}
	n, err := res.RowsAffected()
	if err == nil && n == 0 {
		err = tx.QueryRowContext(ctx, `SELECT updated_at FROM encrypted_vaults e LEFT JOIN encrypted_objects o ON o.vault_id=e.id WHERE id=? AND owner=? AND revision=? AND iv=? AND (ciphertext=? OR o.hash=?)`, id, user, v.Revision, q.IV, q.Ciphertext, hash).Scan(&v.Updated)
		if !errors.Is(err, sql.ErrNoRows) {
			return v, err
		}
		return v, fileError(409, "ENCRYPTED_CONFLICT", "云端版本已变化，请先导出本地草稿再重新解锁")
	}
	if err != nil {
		return v, err
	}
	if r.managedOnline {
		if err = writeEnvelope(ctx, tx, r.blobStore, id, hash, q.Ciphertext); err != nil {
			return v, err
		}
	} else if _, err = tx.ExecContext(ctx, `DELETE FROM encrypted_objects WHERE vault_id=?`, id); err != nil {
		return v, err
	}
	return v, tx.Commit()
}
func writeEnvelope(ctx context.Context, tx *sql.Tx, target blob.Store, id, hash string, data []byte) error {
	size := int64(len(data))
	if _, err := target.Put(ctx, id, hash, size, bytes.NewReader(data)); err != nil {
		return err
	}
	out, err := target.OpenContext(ctx, id, hash)
	if err != nil {
		return err
	}
	if err = verifyReader(out, hash, size); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO encrypted_objects(vault_id,hash,size) VALUES(?,?,?) ON CONFLICT(vault_id) DO UPDATE SET hash=excluded.hash,size=excluded.size`, id, hash, size)
	return err
}
func migrateEnvelopes(ctx context.Context, tx *sql.Tx, target blob.Store) error {
	cursor := ""
	for {
		var id string
		var data []byte
		err := tx.QueryRowContext(ctx, `SELECT id,ciphertext FROM encrypted_vaults WHERE id>? AND length(ciphertext)>0 ORDER BY id LIMIT 1`, cursor).Scan(&id, &data)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		hash := fmt.Sprintf("sha256:%x", sha256.Sum256(data))
		if err = writeEnvelope(ctx, tx, target, id, hash, data); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `UPDATE encrypted_vaults SET ciphertext=X'' WHERE id=?`, id); err != nil {
			return err
		}
		cursor = id
	}
}

type AuditEvent struct {
	ID      int64  `json:"id"`
	Action  string `json:"action"`
	Object  string `json:"object_id"`
	Created string `json:"created_at"`
}

func (r *Repository) Audit(ctx context.Context, user string, before int64) ([]AuditEvent, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT id,action,object_id,created_at FROM audit_events WHERE owner=? AND (?=0 OR id<?) ORDER BY id DESC LIMIT 100`, user, before, before)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AuditEvent{}
	for rows.Next() {
		var e AuditEvent
		if err = rows.Scan(&e.ID, &e.Action, &e.Object, &e.Created); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
