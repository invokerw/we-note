package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
)

// A trailing slash denotes a folder. Expected pins the complete set of notes the user saw.
type EntryChange struct {
	Operation   string            `json:"operation"`
	Source      string            `json:"source"`
	Destination string            `json:"destination"`
	Expected    map[string]string `json:"expected"`
}

func (r *Repository) ChangeEntry(ctx context.Context, user, vault, key string, in EntryChange) error {
	allowed, err := r.UserCanWriteVault(ctx, user, vault)
	if err != nil {
		return err
	}
	if !allowed {
		return ErrNotFound
	}
	src, dst := in.Source, norm.NFC.String(in.Destination)
	folder := strings.HasSuffix(src, "/")
	op := map[string]string{"move": "move_file", "copy": "create_file", "delete": "delete_file"}[in.Operation]
	if key == "" || !PortablePath(strings.TrimSuffix(src, "/")) || op == "" {
		return fileError(400, "INVALID_REQUEST", "无效的目录操作")
	}
	fold := func(s string) string { return cases.Fold().String(norm.NFC.String(s)) }
	sourceKey, destinationKey := fold(src), fold(dst)
	insideSource := folder && strings.HasPrefix(destinationKey, sourceKey)
	if in.Operation != "delete" && (!PortablePath(strings.TrimSuffix(dst, "/")) || strings.HasSuffix(dst, "/") != folder || destinationKey == sourceKey || insideSource) {
		return fileError(400, "INVALID_PATH", "请选择其他目标位置")
	}
	fingerprint, err := FingerprintRequest([]any{user, "entry", in})
	if err != nil {
		return err
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var prior string
	err = tx.QueryRowContext(ctx, `SELECT fingerprint FROM file_requests WHERE vault_id=? AND operation_id=?`, vault, key).Scan(&prior)
	if err == nil {
		if prior != fingerprint {
			return fileError(409, "IDEMPOTENCY_KEY_REUSED", "operation already used")
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	rows, err := tx.QueryContext(ctx, `SELECT id,path,COALESCE(current_version_id,''),current_content_hash,current_content_size FROM files WHERE vault_id=? AND is_deleted=0 ORDER BY path`, vault)
	if err != nil {
		return err
	}
	defer rows.Close()
	type entry struct {
		id, path, version string
		content           storedContent
	}
	var entries []entry
	conflict := fileError(409, "FILE_VERSION_CONFLICT", "目录内容已更改，请刷新后重试")
	for rows.Next() {
		var f entry
		if err = rows.Scan(&f.id, &f.path, &f.version, &f.content.Hash, &f.content.Size); err != nil {
			return err
		}
		if f.path == src || folder && strings.HasPrefix(f.path, src) {
			if expected, ok := in.Expected[f.path]; !ok || expected != f.version || f.version == "" {
				return conflict
			}
			entries = append(entries, f)
		} else if in.Operation != "delete" && (fold(f.path) == strings.TrimSuffix(destinationKey, "/") || strings.HasPrefix(fold(f.path), strings.TrimSuffix(destinationKey, "/")+"/")) {
			return fileError(409, "PATH_CONFLICT", "目标位置已存在同名项目")
		}
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if err = rows.Close(); err != nil {
		return err
	}
	if len(entries) == 0 || len(entries) != len(in.Expected) {
		return conflict
	}
	for _, f := range entries {
		changeKey, err := newID("op")
		if err != nil {
			return err
		}
		_, err = r.writeFileTx(ctx, tx, vault, f.id, op, changeKey, FileWrite{BasePath: f.path, BaseVersion: f.version, Device: "web_" + user, Path: dst + strings.TrimPrefix(f.path, src)}, f.content)
		if err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO file_requests(vault_id,operation_id,fingerprint,response) VALUES(?,?,?,'{}')`, vault, key, fingerprint); err != nil {
		return err
	}
	return tx.Commit()
}
