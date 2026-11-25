package store

import (
	"context"
	"database/sql"
	"github.com/weifei/we-note/services/api/internal/blob"
)

// Existing attachments enter the new lifetime policy only after migration establishes ownership.
func enrollImage(ctx context.Context, tx *sql.Tx, upload string) error {
	_, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO image_lifetimes(asset_id,orphan_since) SELECT id,unixepoch() FROM assets WHERE upload_id=? AND media_type IN ('image/png','image/jpeg','image/gif','image/webp')`, upload)
	return err
}

func (r *Repository) indexVersionImages(ctx context.Context, tx *sql.Tx, vault, version string, data []byte) error {
	for _, ref := range r.assetReferences(data) {
		asset, err := r.assetForReference(ctx, tx, "", vault, ref)
		if err != nil {
			return fileError(409, "ASSET_NOT_READY", "referenced asset is unavailable")
		}
		if _, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO version_image_refs VALUES(?,?)`, version, asset.ID); err != nil {
			return err
		}
	}
	return nil
}

// The caller holds the same maintenance gate as backup, migrations and snapshot exports.
func (r *Repository) collectImages(ctx context.Context) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	const pinned = `EXISTS(SELECT 1 FROM version_image_refs WHERE asset_id=a.id) OR EXISTS(SELECT 1 FROM (` + snapshots + `) s WHERE s.vault=a.vault_id AND instr(s.snapshot,a.id)>0)`
	if _, err = tx.ExecContext(ctx, `UPDATE image_lifetimes SET orphan_since=NULL WHERE orphan_since IS NOT NULL AND asset_id IN (SELECT a.id FROM assets a WHERE `+pinned+`)`); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE image_lifetimes SET orphan_since=unixepoch() WHERE orphan_since IS NULL AND asset_id IN (SELECT a.id FROM assets a WHERE NOT (`+pinned+`))`); err != nil {
		return err
	}
	ids, err := stringList(ctx, tx, `SELECT asset_id FROM image_lifetimes WHERE orphan_since<=unixepoch()-7*86400`)
	if err != nil {
		return err
	}
	for _, id := range ids {
		a, err := r.scanAsset(tx.QueryRowContext(ctx, assetSelect+`WHERE a.id=?`, id))
		if err != nil {
			return err
		}
		// Historical documents imported before reference indexing can still contain old URL forms.
		used, err := r.noteUsesAsset(ctx, tx, a.Vault, a.ID)
		if err != nil {
			return err
		}
		if used {
			continue
		}
		for _, q := range []string{`DELETE FROM trash_items WHERE item=? AND kind='asset'`, `DELETE FROM assets WHERE id=?`} {
			if _, err = tx.ExecContext(ctx, q, id); err != nil {
				return err
			}
		}
		if _, err = tx.ExecContext(ctx, `DELETE FROM upload_sessions WHERE id=?`, a.Upload); err != nil {
			return err
		}
		// If the canonical blob used this date, use another surviving copy before retiring the key.
		if _, err = tx.ExecContext(ctx, `UPDATE blobs SET storage_key=(SELECT u.storage_key FROM upload_sessions u WHERE u.vault_id=?1 AND u.content_hash=?2 AND u.status='completed' AND u.storage_key<>?3 ORDER BY u.storage_key LIMIT 1) WHERE vault_id=?1 AND content_hash=?2 AND storage_key=?3 AND EXISTS(SELECT 1 FROM upload_sessions WHERE vault_id=?1 AND content_hash=?2 AND status='completed' AND storage_key<>?3)`, a.Vault, a.Hash, a.StorageKey); err != nil {
			return err
		}
		if err = queueUnused(ctx, tx, a.Vault, a.Hash); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func PictureType(media string) bool {
	switch media {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return true
	}
	return false
}

// Equal hashes on different UTC dates have independent physical keys.
func (r *Repository) removeRetiredImageKeys(ctx context.Context) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT k.vault_id,k.hash,k.storage_key,v.owner_user_id FROM retired_object_keys k JOIN vaults v ON v.id=k.vault_id WHERE k.storage_key LIKE '%/assets/%' AND NOT EXISTS(SELECT 1 FROM (`+storedObjects+`) live WHERE live.vault_id=k.vault_id AND live.storage_key=k.storage_key)`)
	if err != nil {
		return err
	}
	type retired struct{ vault, hash, key, owner string }
	var keys []retired
	for rows.Next() {
		var k retired
		if err = rows.Scan(&k.vault, &k.hash, &k.key, &k.owner); err != nil {
			rows.Close()
			return err
		}
		keys = append(keys, k)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, k := range keys {
		ns, err := blob.VaultNamespace(k.owner, k.vault)
		if err != nil {
			return err
		}
		if err = blob.RemoveKey(ctx, unwrap(r.blobStore), ns, k.hash, k.key); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `DELETE FROM retired_object_keys WHERE vault_id=? AND hash=? AND storage_key=?`, k.vault, k.hash, k.key); err != nil {
			return err
		}
	}
	return tx.Commit()
}
