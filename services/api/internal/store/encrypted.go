package store

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"time"
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
	err := r.db.QueryRowContext(ctx, `SELECT id,revision,updated_at,iv,ciphertext FROM encrypted_vaults WHERE id=? AND owner=?`, id, user).Scan(&v.ID, &v.Revision, &v.Updated, &v.IV, &v.Ciphertext)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
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
	var err error
	if q.Base == 0 {
		res, err = r.db.ExecContext(ctx, `INSERT INTO encrypted_vaults VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, id, user, v.Revision, q.Ciphertext, q.IV, v.Updated)
	} else {
		res, err = r.db.ExecContext(ctx, `UPDATE encrypted_vaults SET revision=?,ciphertext=?,iv=?,updated_at=? WHERE id=? AND owner=? AND revision=? AND iv<>?`, v.Revision, q.Ciphertext, q.IV, v.Updated, id, user, q.Base, q.IV)
	}
	if err != nil {
		return v, err
	}
	n, err := res.RowsAffected()
	if err == nil && n == 0 {
		err = r.db.QueryRowContext(ctx, `SELECT updated_at FROM encrypted_vaults WHERE id=? AND owner=? AND revision=? AND iv=? AND ciphertext=?`, id, user, v.Revision, q.IV, q.Ciphertext).Scan(&v.Updated)
		if !errors.Is(err, sql.ErrNoRows) {
			return v, err
		}
		return v, fileError(409, "ENCRYPTED_CONFLICT", "云端版本已变化，请先导出本地草稿再重新解锁")
	}
	return v, err
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
