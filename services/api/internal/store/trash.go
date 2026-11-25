package store

import (
	"context"
	"database/sql"
	"errors"
	"slices"
	"strings"
)

type TrashItem struct {
	Batch   string `json:"batch,omitempty"`
	Folder  string `json:"folder,omitempty"`
	Kind    string `json:"kind"`
	ID      string `json:"id"`
	Name    string `json:"name"`
	Deleted int64  `json:"deleted_at"`
	Expires int64  `json:"expires_at"`
}

func (r *Repository) TrashItems(ctx context.Context, vault string) ([]TrashItem, error) {
	return r.trashItems(ctx, vault, false)
}
func (r *Repository) trashItems(ctx context.Context, vault string, expired bool) ([]TrashItem, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT coalesce(g.batch,''),coalesce(g.folder,''),t.kind,t.item,coalesce(f.path,a.name),t.deleted,t.deleted+86400*`+retentionDays+` FROM trash_items t LEFT JOIN trash_folder_members g ON g.vault_id=t.vault_id AND g.kind=t.kind AND g.item=t.item LEFT JOIN files f ON t.kind='file' AND f.id=t.item LEFT JOIN assets a ON t.kind='asset' AND a.id=t.item WHERE t.vault_id=? AND (?=0 OR t.deleted+86400*`+retentionDays+`<=unixepoch()) ORDER BY t.kind DESC,t.deleted,t.item`, vault, expired)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []TrashItem{}
	for rows.Next() {
		var i TrashItem
		if err = rows.Scan(&i.Batch, &i.Folder, &i.Kind, &i.ID, &i.Name, &i.Deleted, &i.Expires); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

// Snapshot records pin their source bytes and version identities until the corresponding share or export releases them.
const snapshots = `SELECT vault_id AS vault,snapshot FROM shares WHERE status IN ('pending','accepted') UNION ALL SELECT s.vault_id,p.snapshot FROM share_publications p JOIN shares s ON s.id=p.share_id UNION ALL SELECT vault,snapshot FROM share_links WHERE revoked=0 AND expires>unixepoch() UNION ALL SELECT vault_id,snapshot FROM export_jobs WHERE status='pending'`

func (r *Repository) noteUsesAsset(ctx context.Context, q interface {
	queryer
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, vault, id string) (bool, error) {
	asset, err := r.scanAsset(q.QueryRowContext(ctx, assetSelect+`WHERE a.vault_id=? AND a.id=?`, vault, id))
	if err != nil {
		return false, err
	}
	rows, err := q.QueryContext(ctx, `SELECT DISTINCT v.content_hash,v.content_size,b.storage_key FROM file_versions v JOIN blobs b ON b.vault_id=v.vault_id AND b.id=v.blob_id JOIN files f ON f.id=v.file_id WHERE v.vault_id=? AND f.format<>'xmind'`, vault)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var hash, key string
		var size int64
		if err = rows.Scan(&hash, &size, &key); err != nil {
			return false, err
		}
		data, err := r.readNoteBlobAt(ctx, vault, hash, size, key)
		if err != nil {
			return false, err
		}
		refs := r.assetReferences(data)
		digest := strings.TrimPrefix(asset.Hash, "sha256:")
		scopedFullURL := asset.URL[:strings.LastIndexByte(asset.URL, '/')+1] + digest
		if slices.Contains(refs, asset.URL) || slices.Contains(refs, asset.LegacyURL) || slices.Contains(refs, scopedFullURL) || slices.Contains(refs, r.publicBase+"/assets/"+asset.CreatedAt.UTC().Format(assetDateLayout)+"/"+digest) {
			return true, nil
		}
	}
	return false, rows.Err()
}

var errPinned = fileError(409, "ITEM_IN_USE", "笔记版本、分享或导出仍在引用此项，已保留。")

func (r *Repository) purgeItem(ctx context.Context, vault, kind, id string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := r.purgeItemTx(ctx, tx, vault, kind, id); err != nil {
		return err
	}
	return tx.Commit()
}
func (r *Repository) purgeItemTx(ctx context.Context, tx *sql.Tx, vault, kind, id string) error {
	var err error
	var exists bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM trash_items WHERE vault_id=? AND kind=? AND item=?)`, vault, kind, id).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	var hashes []string
	var pinned bool
	switch kind {
	case "asset":
		var upload, hash string
		if err = tx.QueryRowContext(ctx, `SELECT upload_id,content_hash FROM assets a JOIN upload_sessions u ON u.id=a.upload_id WHERE a.id=? AND a.vault_id=? AND a.is_deleted=1`, id, vault).Scan(&upload, &hash); err != nil {
			return err
		}
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM (`+snapshots+`) WHERE vault=? AND instr(snapshot,?)>0)`, vault, id).Scan(&pinned); err != nil {
			return err
		}
		if !pinned {
			pinned, err = r.noteUsesAsset(ctx, tx, vault, id)
			if err != nil {
				return err
			}
		}
		if pinned {
			return errPinned
		}
		hashes = []string{hash}
		if _, err = tx.ExecContext(ctx, `DELETE FROM assets WHERE id=?`, id); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `DELETE FROM upload_sessions WHERE id=?`, upload); err != nil {
			return err
		}
	case "file":
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM file_versions v JOIN (`+snapshots+`) s ON s.vault=v.vault_id WHERE v.file_id=?1 AND instr(s.snapshot,v.id)>0 UNION ALL SELECT 1 FROM share_copy_versions c JOIN file_versions v ON v.id IN(c.source_version,c.target_version) WHERE v.file_id=?1)`, id).Scan(&pinned); err != nil {
			return err
		}
		if pinned {
			return errPinned
		}
		hashes, err = stringList(ctx, tx, `SELECT DISTINCT content_hash FROM file_versions WHERE file_id=? AND vault_id=?`, id, vault)
		if err != nil {
			return err
		}
		for _, stmt := range []string{
			`DELETE FROM upload_sessions WHERE vault_id=?2 AND id IN (SELECT json_extract(request_json,'$.blob_reference') FROM sync_operations WHERE file_id=?1 AND vault_id=?2 AND json_valid(request_json)) AND NOT EXISTS(SELECT 1 FROM assets WHERE upload_id=upload_sessions.id) AND NOT EXISTS(SELECT 1 FROM sync_operations WHERE file_id<>?1 AND vault_id=?2 AND json_valid(request_json) AND json_extract(request_json,'$.blob_reference')=upload_sessions.id)`,
			`DELETE FROM changes WHERE file_id=?1 AND vault_id=?2`, `DELETE FROM sync_operations WHERE file_id=?1 AND vault_id=?2`, `DELETE FROM file_requests WHERE json_valid(response) AND json_extract(response,'$.file_id')=?1 AND vault_id=?2`, `DELETE FROM files WHERE id=?1 AND vault_id=?2 AND is_deleted=1`} {
			if _, err = tx.ExecContext(ctx, stmt, id, vault); err != nil {
				return err
			}
		}
		if _, err = tx.ExecContext(ctx, `UPDATE vaults SET current_revision=current_revision+1,min_available_revision=current_revision+1 WHERE id=?`, vault); err != nil {
			return err
		}
	default:
		return ErrNotFound
	}
	for _, hash := range hashes {
		if err = queueUnused(ctx, tx, vault, hash); err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM trash_items WHERE vault_id=? AND kind=? AND item=?`, vault, kind, id); err != nil {
		return err
	}
	return nil
}
func queueUnused(ctx context.Context, tx *sql.Tx, vault, hash string) error {
	_, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO garbage_objects SELECT vault_id,content_hash,content_size FROM blobs WHERE vault_id=?1 AND content_hash=?2 AND NOT EXISTS(SELECT 1 FROM file_versions WHERE vault_id=?1 AND content_hash=?2 UNION ALL SELECT 1 FROM upload_sessions WHERE vault_id=?1 AND content_hash=?2 AND status IN ('pending','completed') UNION ALL SELECT 1 FROM export_jobs WHERE vault_id=?1 AND hash=?2 UNION ALL SELECT 1 FROM (`+snapshots+`) WHERE vault=?1 AND instr(snapshot,?2)>0)`, vault, hash)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `DELETE FROM blobs WHERE vault_id=? AND content_hash=? AND EXISTS(SELECT 1 FROM garbage_objects g WHERE g.vault_id=blobs.vault_id AND g.hash=blobs.content_hash)`, vault, hash)
	return err
}
func (r *Repository) drainGarbage(ctx context.Context) error {
	rows, err := r.db.QueryContext(ctx, `SELECT g.vault_id,g.hash,v.owner FROM garbage_objects g JOIN (`+vaultOwners+`) v ON v.id=g.vault_id`)
	if err != nil {
		return err
	}
	type item struct{ vault, hash, owner string }
	var items []item
	for rows.Next() {
		var i item
		if err = rows.Scan(&i.vault, &i.hash, &i.owner); err != nil {
			rows.Close()
			return err
		}
		items = append(items, i)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	var failures []error
	for _, i := range items {
		var live bool
		if err = r.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM (`+backedUpObjects+`) WHERE vault_id=? AND content_hash=?)`, i.vault, i.hash).Scan(&live); err != nil {
			return err
		}
		if !live {
			if err = r.removeObjects(ctx, i.owner, i.vault, i.hash); err != nil {
				failures = append(failures, err)
				continue
			}
		}
		if _, err = r.db.ExecContext(ctx, `DELETE FROM garbage_objects WHERE vault_id=? AND hash=?`, i.vault, i.hash); err != nil {
			return err
		}
	}
	return errors.Join(failures...)
}
func (r *Repository) emptyTrash(ctx context.Context, vault string, expired bool) (int, error) {
	items, err := r.trashItems(ctx, vault, expired)
	if err != nil {
		return 0, err
	}
	held := 0
	for _, i := range items {
		err = r.purgeItem(ctx, vault, i.Kind, i.ID)
		if errors.Is(err, errPinned) {
			held++
			continue
		}
		if err != nil {
			return held, err
		}
	}
	return held, nil
}
func (r *Repository) expireTrash(ctx context.Context) error {
	vaults, err := stringList(ctx, r.db.DB, `SELECT DISTINCT vault_id FROM trash_items t JOIN vaults v ON v.id=t.vault_id JOIN users u ON u.id=v.owner_user_id WHERE u.status IN ('active','disabled') AND deleted<=unixepoch()-86400*`+retentionDays)
	if err != nil {
		return err
	}
	var failures []error
	for _, v := range vaults {
		_, err = r.emptyTrash(ctx, v, true)
		failures = append(failures, err)
	}
	return errors.Join(failures...)
}

// A folder operation uses only members of this deletion, including nested notes.
func (r *Repository) changeTrashFolder(ctx context.Context, user, vault, operation, batch string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ids, err := stringList(ctx, tx, `SELECT item FROM trash_folder_members WHERE vault_id=? AND batch=? ORDER BY item`, vault, batch)
	if err != nil {
		return err
	}
	if len(ids) == 0 {
		return ErrNotFound
	}
	for _, id := range ids {
		if operation == "purge" {
			err = r.purgeItemTx(ctx, tx, vault, "file", id)
		} else {
			var version, originalPath string
			if err = tx.QueryRowContext(ctx, `SELECT current_version_id,path FROM files WHERE vault_id=? AND id=?`, vault, id).Scan(&version, &originalPath); err != nil {
				return err
			}
			key, keyErr := newID("op")
			if keyErr != nil {
				return keyErr
			}
			_, err = r.writeFileTx(ctx, tx, vault, id, "restore_file", key, FileWrite{Path: originalPath, BaseVersion: version, Device: "web_" + user}, storedContent{})
		}
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}
func (r *Repository) ManageTrash(ctx context.Context, user, vault, operation, kind, id string) (int, error) {
	v, err := r.VaultForUser(ctx, user, vault)
	if err != nil {
		return 0, err
	}
	if kind == "folder" && (operation == "restore" || operation == "purge") {
		if operation == "restore" {
			ok, err := r.UserCanWriteVault(ctx, user, vault)
			if err != nil {
				return 0, err
			}
			if !ok {
				return 0, ErrNotFound
			}
		} else if v.OwnerUserID != user {
			return 0, ErrNotFound
		}
		return 0, r.changeTrashFolder(ctx, user, vault, operation, id)
	}
	if v.OwnerUserID != user {
		return 0, ErrNotFound
	}
	switch operation {
	case "empty":
		return r.emptyTrash(ctx, vault, false)
	case "purge":
		return 0, r.purgeItem(ctx, vault, kind, id)
	case "restore":
		if kind != "asset" {
			return 0, ErrNotFound
		}
		res, err := r.db.ExecContext(ctx, `UPDATE assets SET is_deleted=0 WHERE vault_id=? AND id=? AND is_deleted=1`, vault, id)
		if err != nil {
			return 0, err
		}
		n, err := res.RowsAffected()
		if n == 0 {
			return 0, ErrNotFound
		}
		return 0, err
	default:
		return 0, ErrNotFound
	}
}
