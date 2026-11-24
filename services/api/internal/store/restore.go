package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/mattn/go-sqlite3"
	"github.com/weifei/we-note/services/api/internal/blob"
	"github.com/weifei/we-note/services/api/internal/sqlite"
)

// ApplyBackup runs with exclusive maintenance access. Only the last SQLite transaction
// makes the staged data visible. Previously stored content remains available for rollback.
func (r *Repository) ApplyBackup(ctx context.Context, actor, id string) (string, error) {
	if err := r.drainGarbage(ctx); err != nil {
		return "", err
	}
	var pending bool
	if err := r.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM account_cleanup UNION ALL SELECT 1 FROM garbage_objects)`).Scan(&pending); err != nil {
		return "", err
	}
	if pending {
		return "", errors.New("请等待在线数据清理完成后再恢复整机备份")
	}
	dir, err := r.RestoreBackup(ctx, id)
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	filename := filepath.Join(dir, "wenote.db")
	stage, err := sqlite.Open(ctx, filename)
	if err != nil {
		return "", err
	}
	defer stage.Close()
	if err = stage.Migrate(ctx); err != nil {
		return "", err
	}
	var check, owner string
	if err = stage.QueryRowContext(ctx, `PRAGMA integrity_check`).Scan(&check); err != nil {
		return "", err
	}
	if check != "ok" {
		return "", errors.New("备份数据库完整性校验失败")
	}
	if err = stage.QueryRowContext(ctx, `SELECT id FROM users WHERE role='system_admin' AND status='active' ORDER BY id=? DESC,id LIMIT 1`, actor).Scan(&owner); err != nil {
		return "", errors.New("备份中缺少可登录的管理员")
	}
	safety, err := r.createBackup(ctx, actor, "before_restore")
	if err != nil {
		return "", fmt.Errorf("保护当前数据的备份失败：%w", err)
	}
	if err = r.VerifyBackup(ctx, safety.ID); err != nil {
		return "", fmt.Errorf("恢复前备份校验失败：%w", err)
	}
	source, err := blob.NewLocalStore(filepath.Join(dir, "storage"))
	if err != nil {
		return "", err
	}
	if err = copyObjects(ctx, stage.DB, source, r.blobStore); err != nil {
		return "", err
	}
	if r.blobStore != nil {
		tx, err := stage.BeginTx(ctx, nil)
		if err != nil {
			return "", err
		}
		defer tx.Rollback()
		if err = migrateEnvelopes(ctx, tx, r.blobStore); err != nil {
			return "", err
		}
		if err = tx.Commit(); err != nil {
			return "", err
		}
	}
	dest, err := r.db.Conn(ctx)
	if err != nil {
		return "", err
	}
	defer dest.Close()
	if err = keepRecoveryCatalog(ctx, dest, filename, owner, actor, id, safety.ID); err != nil {
		return "", err
	}
	var invalid int
	if err = stage.QueryRowContext(ctx, `SELECT count(*) FROM pragma_foreign_key_check`).Scan(&invalid); err != nil {
		return "", err
	}
	if invalid != 0 {
		return "", errors.New("备份数据库引用不完整")
	}
	src, err := stage.Conn(ctx)
	if err != nil {
		return "", err
	}
	defer src.Close()
	err = dest.Raw(func(d any) error {
		return src.Raw(func(s any) error {
			b, err := d.(*sqlite3.SQLiteConn).Backup("main", s.(*sqlite3.SQLiteConn), "main")
			if err != nil {
				return err
			}
			done, stepErr := b.Step(-1)
			closeErr := b.Finish()
			if stepErr != nil {
				return stepErr
			}
			if !done {
				return errors.New("数据库繁忙，恢复未提交")
			}
			return closeErr
		})
	})
	if err != nil {
		return "", err
	}
	dest.Close()
	if err = r.bindOwners(ctx, r.blobStore); err != nil {
		return "", err
	}
	return safety.ID, nil
}

// Backup history and deployment storage settings belong to the running instance.
func keepRecoveryCatalog(ctx context.Context, conn *sql.Conn, filename, owner, actor, target, safety string) error {
	if _, err := conn.ExecContext(ctx, `ATTACH DATABASE ? AS recovered`, filename); err != nil {
		return err
	}
	defer conn.ExecContext(context.Background(), `DETACH DATABASE recovered`)
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Devices may still hold cursors from the abandoned timeline. Force a full
	// manifest read, and prevent stale encrypted-vault saves from matching a revision.
	for _, table := range []struct{ name, column string }{{"vaults", "current_revision"}, {"encrypted_vaults", "revision"}} {
		revision := "MAX(r." + table.column + ",COALESCE((SELECT l." + table.column + " FROM main." + table.name + " l WHERE l.id=r.id),0))+1"
		assignments := table.column + "=" + revision
		if table.name == "vaults" {
			assignments += ",min_available_revision=" + revision
		}
		if _, err = tx.ExecContext(ctx, "UPDATE recovered."+table.name+" AS r SET "+assignments); err != nil {
			return err
		}
		var tooLarge bool
		if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM recovered."+table.name+" WHERE "+table.column+">?)", maxSafeRevision).Scan(&tooLarge); err != nil {
			return err
		}
		if tooLarge {
			return errors.New("恢复后的版本号超出同步协议范围")
		}
	}
	for _, stmt := range []string{
		`DELETE FROM recovered.backup_locations`,
		`DELETE FROM recovered.backup_jobs`,
		`DELETE FROM recovered.system_settings WHERE key GLOB 'storage_*' OR key GLOB 'backup_*'`,
		`UPDATE recovered.users SET status='disabled',disabled_at=CURRENT_TIMESTAMP,disabled_reason='从未完成的清理任务恢复，请管理员核实' WHERE status='purging'`,
		`DELETE FROM recovered.account_cleanup`,
		`DELETE FROM recovered.garbage_objects`,
		`DELETE FROM recovered.sessions`,
		`DELETE FROM recovered.refresh_sessions`,
		`DELETE FROM recovered.password_reset_tokens`,
		`DELETE FROM recovered.email_verification_tokens`,
		`DELETE FROM recovered.share_link_sessions`,
		`UPDATE recovered.invitations SET revoked_at=CURRENT_TIMESTAMP WHERE used_at IS NULL AND revoked_at IS NULL`,
	} {
		if _, err = tx.ExecContext(ctx, stmt); err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO recovered.backup_jobs SELECT j.id,COALESCE(u.id,?),j.status,j.path,j.size,j.checksum,j.error,j.created_at,j.completed_at FROM main.backup_jobs j LEFT JOIN recovered.users u ON u.id=j.created_by`, owner); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO recovered.backup_locations SELECT * FROM main.backup_locations`); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO recovered.system_settings SELECT s.key,s.value,CASE WHEN s.updated_by IS NULL THEN NULL ELSE COALESCE(u.id,?) END,s.updated_at FROM main.system_settings s LEFT JOIN recovered.users u ON u.id=s.updated_by WHERE s.key GLOB 'storage_*' OR s.key GLOB 'backup_*'`, owner); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO recovered.admin_audit_events SELECT a.* FROM main.admin_audit_events a JOIN recovered.users u ON a.actor_user_id=u.id`); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO recovered.admin_audit_events(actor_user_id,action,object_type,object_id,detail,created_at) VALUES(?,'backup.apply','backup',?,?,strftime('%Y-%m-%dT%H:%M:%SZ','now'))`, owner, target, "actor="+actor+" safety="+safety); err != nil {
		return err
	}
	return tx.Commit()
}
