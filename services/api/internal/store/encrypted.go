package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/weifei/we-note/services/api/internal/blob"
)

// Preserve archived ciphertext when an administrator migrates historical storage.
func writeEnvelope(ctx context.Context, tx *sql.Tx, target blob.Store, owner, id, hash string, data []byte) error {
	ns, err := blob.VaultNamespace(owner, id)
	if err != nil {
		return err
	}
	size := int64(len(data))
	if _, err := target.PutAt(ctx, ns, hash, size, time.Time{}, bytes.NewReader(data)); err != nil {
		return err
	}
	out, err := target.OpenContext(ctx, ns, hash, "")
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
		var id, owner string
		var data []byte
		err := tx.QueryRowContext(ctx, `SELECT id,owner,ciphertext FROM encrypted_vaults WHERE id>? AND length(ciphertext)>0 ORDER BY id LIMIT 1`, cursor).Scan(&id, &owner, &data)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		hash := fmt.Sprintf("sha256:%x", sha256.Sum256(data))
		if err = writeEnvelope(ctx, tx, unwrap(target), owner, id, hash, data); err != nil {
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
