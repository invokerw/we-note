package store

import (
	"context"
	"database/sql"
	"errors"
	"log"

	"github.com/weifei/we-note/services/api/internal/blob"
)

const accountBytes = `(SELECT coalesce(sum(content_size),0) FROM (` + backedUpObjects + `) b WHERE vault_id IN (SELECT id FROM (` + vaultOwners + `) WHERE owner=u.id))+(SELECT coalesce(sum(length(ciphertext)),0) FROM encrypted_vaults WHERE owner=u.id)+(SELECT coalesce(sum(length(p.data)),0) FROM upload_parts p JOIN upload_sessions s ON s.id=p.upload_id JOIN vaults v ON v.id=s.vault_id WHERE v.owner_user_id=u.id)`
const accountGarbage = `(SELECT coalesce(sum(g.bytes),0) FROM garbage_objects g JOIN (` + vaultOwners + `) v ON v.id=g.vault_id WHERE v.owner=u.id)`
const accountTotal = `coalesce((SELECT bytes FROM account_cleanup WHERE user_id=u.id),` + accountBytes + `+` + accountGarbage + `)`
const retentionDays = `(SELECT CAST(value AS INTEGER) FROM system_settings WHERE key='trash_retention_days')`

func (r *Repository) CleanupInBackground() {
	if err := r.RunCleanup(context.Background()); err != nil {
		log.Printf("storage cleanup: %v", err)
	}
}
func (r *Repository) RunCleanup(ctx context.Context) error {
	var due bool
	err := r.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM account_cleanup UNION ALL SELECT 1 FROM garbage_objects UNION ALL SELECT 1 FROM trash_items t JOIN vaults v ON t.vault_id=v.id JOIN users u ON u.id=v.owner_user_id WHERE u.status IN ('active','disabled') AND t.deleted<=unixepoch()-86400*`+retentionDays+`)`).Scan(&due)
	if err != nil || !due {
		return err
	}
	r.Maintenance.Lock()
	defer r.Maintenance.Unlock()
	r.Cleaning.Store(true)
	defer r.Cleaning.Store(false)
	ids, err := stringList(ctx, r.db.DB, `SELECT user_id FROM account_cleanup`)
	if err != nil {
		return err
	}
	var failures []error
	for _, id := range ids {
		if err = r.purgeAccount(ctx, id); err != nil {
			_, writeErr := r.db.ExecContext(ctx, `UPDATE account_cleanup SET error=? WHERE user_id=?`, err.Error(), id)
			failures = append(failures, err, writeErr)
		}
	}
	failures = append(failures, r.expireTrash(ctx), r.drainGarbage(ctx))
	return errors.Join(failures...)
}

type queryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func stringList(ctx context.Context, q queryer, query string, args ...any) ([]string, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []string
	for rows.Next() {
		var s string
		if err = rows.Scan(&s); err != nil {
			return nil, err
		}
		result = append(result, s)
	}
	return result, rows.Err()
}
func (r *Repository) purgeAccount(ctx context.Context, id string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	const vaults = `SELECT id FROM vaults WHERE owner_user_id=?1`
	const shares = `SELECT id FROM shares WHERE sender=?1 OR recipient=?1 OR vault_id IN (` + vaults + `) OR target_vault IN (` + vaults + `)`
	const links = `SELECT id FROM share_links WHERE owner=?1 OR vault IN (` + vaults + `)`
	for _, stmt := range []string{
		`INSERT OR IGNORE INTO cleanup_vaults SELECT id,owner FROM (` + vaultOwners + `) WHERE owner=?1`,
		`DELETE FROM share_copy_versions WHERE share_id IN (` + shares + `)`,
		`DELETE FROM share_publications WHERE share_id IN (` + shares + `)`,
		`DELETE FROM share_asset_copies WHERE share_id IN (` + shares + `)`,
		`DELETE FROM shares WHERE id IN (` + shares + `)`,
		`DELETE FROM share_link_sessions WHERE link IN (` + links + `)`,
		`DELETE FROM share_link_imports WHERE target IN (` + vaults + `) OR link IN (` + links + `)`,
		`DELETE FROM share_links WHERE id IN (` + links + `)`,
		`INSERT OR IGNORE INTO garbage_objects SELECT vault_id,hash,size FROM export_jobs WHERE user_id=?1 AND status='completed' AND vault_id NOT IN (` + vaults + `)`,
		`DELETE FROM export_jobs WHERE vault_id IN (` + vaults + `) OR user_id=?1`,
		`DELETE FROM assets WHERE vault_id IN (` + vaults + `)`,
		`DELETE FROM file_requests WHERE vault_id IN (` + vaults + `)`,
		`DELETE FROM changes WHERE vault_id IN (` + vaults + `)`,
		`DELETE FROM vaults WHERE owner_user_id=?1`,
		`DELETE FROM encrypted_vaults WHERE owner=?1`,
		`DELETE FROM invitations WHERE invited_by=?1 OR email=(SELECT email FROM users WHERE id=?1)`,
		`DELETE FROM email_deliveries WHERE recipient=(SELECT email FROM users WHERE id=?1)`,
		`DELETE FROM devices WHERE user_id=?1`,
		`DELETE FROM audit_events WHERE owner=?1`,
	} {
		if _, err = tx.ExecContext(ctx, stmt, id); err != nil {
			return err
		}
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	ids, err := stringList(ctx, r.db.DB, `SELECT vault_id FROM cleanup_vaults WHERE user_id=?`, id)
	if err != nil {
		return err
	}
	for _, v := range ids {
		if err = r.removeObjects(ctx, id, v, ""); err != nil {
			return err
		}
		r.owners.Delete(v)
	}
	if r.blobStore != nil {
		if err = blob.RemoveOwner(ctx, unwrap(r.blobStore), id); err != nil {
			return err
		}
	}
	finish, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer finish.Rollback()
	if _, err = finish.ExecContext(ctx, `INSERT INTO admin_audit_events(actor_user_id,action,object_type,object_id,created_at) SELECT actor_user_id,'user.purge.completed','user',object_id,strftime('%Y-%m-%dT%H:%M:%SZ','now') FROM admin_audit_events WHERE action='user.purge' AND object_id=? ORDER BY id DESC LIMIT 1`, id); err != nil {
		return err
	}
	if _, err = finish.ExecContext(ctx, `DELETE FROM users WHERE id=? AND status='purging'`, id); err != nil {
		return err
	}
	return finish.Commit()
}
func (r *Repository) removeObjects(ctx context.Context, owner, vault, hash string) error {
	ns, err := blob.VaultNamespace(owner, vault)
	if err != nil {
		return err
	}
	raw := unwrap(r.blobStore)
	if err = blob.Remove(ctx, raw, ns, hash); err != nil {
		return err
	}
	return blob.Remove(ctx, raw, vault, hash)
}
