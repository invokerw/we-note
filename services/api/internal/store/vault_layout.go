package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/weifei/we-note/services/api/internal/blob"
	"github.com/weifei/we-note/services/api/internal/model"
)

type directoryVersion struct {
	model.FileVersion
	Object string   `json:"object"`
	Images []string `json:"images,omitempty"`
}
type directoryImage struct {
	Asset
	Object   string `json:"object"`
	Uploader string `json:"uploader_id,omitempty"`
	Note     string `json:"upload_note_id,omitempty"`
}
type vaultDirectory struct {
	Format   int                `json:"format_version"`
	Owner    string             `json:"owner_id"`
	ID       string             `json:"vault_id"`
	Name     string             `json:"name"`
	Revision int64              `json:"revision"`
	Notes    []model.File       `json:"notes"`
	Versions []directoryVersion `json:"versions"`
	Assets   []directoryImage   `json:"assets"`
}

// PublishVaults retries durable work after restart. The manifest is installed after its objects.
func (r *Repository) PublishVaults(ctx context.Context) error {
	r.Maintenance.RLock()
	defer r.Maintenance.RUnlock()
	if r.blobStore == nil {
		return nil
	}
	if err := r.backupBeforeLayoutUpgrade(ctx); err != nil {
		return err
	}
	ids, err := stringList(ctx, r.db.DB, `SELECT vault FROM vault_publications WHERE dirty=1 OR NOT EXISTS(SELECT 1 FROM history_sweeps s WHERE s.vault=vault_publications.vault AND s.day=`+historyToday+`) ORDER BY vault`)
	if err != nil {
		return err
	}
	var failed []error
	for _, id := range ids {
		if err = r.publishVault(ctx, r.blobStore, id, false); err != nil {
			failed = append(failed, fmt.Errorf("vault %s: %w", id, err))
		}
	}
	return errors.Join(failed...)
}

func (r *Repository) publishVault(ctx context.Context, storage blob.Store, vault string, full bool) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	m := vaultDirectory{Format: 1, ID: vault, Notes: []model.File{}, Versions: []directoryVersion{}, Assets: []directoryImage{}}
	var dirty bool
	if err = tx.QueryRowContext(ctx, `SELECT v.owner_user_id,v.name,v.current_revision,p.dirty FROM vaults v JOIN vault_publications p ON v.id=p.vault WHERE v.id=?`, vault).Scan(&m.Owner, &m.Name, &m.Revision, &dirty); err != nil {
		return err
	}
	ns, err := blob.VaultNamespace(m.Owner, vault)
	if err != nil {
		return err
	}
	var report layoutUpgradeReport
	var saved string
	err = tx.QueryRowContext(ctx, `SELECT backup_id,report FROM vault_layout_upgrades WHERE vault=?`, vault).Scan(&report.Backup, &saved)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	upgrading := err == nil && saved == ""
	if upgrading && report.Backup == "" {
		return errors.New("vault upgrade requires a verified backup")
	}
	if !upgrading && !full {
		pruned, e := pruneNoteHistory(ctx, tx, vault)
		if e != nil {
			return e
		}
		if !dirty && !pruned {
			return tx.Commit()
		}
	}
	scoped := ownedStore{unwrap(storage), r.owners}
	files, err := tx.QueryContext(ctx, strings.Replace(activeFileQuery, " AND f.is_deleted = 0", "", 1)+` ORDER BY f.id`, vault)
	if err != nil {
		return err
	}
	for files.Next() {
		f, e := scanFile(files)
		if e != nil {
			files.Close()
			return e
		}
		m.Notes = append(m.Notes, f)
	}
	err = files.Err()
	files.Close()
	if err != nil {
		return err
	}
	previous := map[string]string{}
	rows, err := tx.QueryContext(ctx, `SELECT path,hash FROM vault_published_files WHERE vault=?`, vault)
	if err != nil {
		return err
	}
	for rows.Next() {
		var k, h string
		if e := rows.Scan(&k, &h); e != nil {
			rows.Close()
			return e
		}
		previous[k] = h
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	publish := func(key string, v model.FileVersion) error {
		old := previous[key]
		delete(previous, key)
		if !full && old == v.ContentHash {
			return nil
		}
		reader, e := scoped.OpenContext(ctx, vault, v.ContentHash, v.StorageKey)
		if e != nil {
			return e
		}
		defer reader.Close()
		if e = blob.WriteDocumentFrom(ctx, unwrap(storage), m.Owner, vault, key, reader, v.ContentSize, v.ContentHash); e != nil {
			return e
		}
		_, e = tx.ExecContext(ctx, `INSERT OR REPLACE INTO vault_published_files VALUES(?,?,?)`, vault, key, v.ContentHash)
		return e
	}

	for _, f := range m.Notes {
		vs, e := tx.QueryContext(ctx, strings.Replace(fileVersionQuery, " AND f.is_deleted = 0", "", 1)+` ORDER BY v.vault_revision`, vault, f.ID)
		if e != nil {
			return e
		}
		var versions []model.FileVersion
		for vs.Next() {
			v, e := scanFileVersion(vs)
			if e != nil {
				vs.Close()
				return e
			}
			versions = append(versions, v)
		}
		e = vs.Err()
		vs.Close()
		if e != nil {
			return e
		}
		for _, v := range versions {
			key := "notes/" + f.ID + "/versions/" + v.ID + "." + v.Metadata.Format

			if e = publish(key, v); e != nil {
				return e
			}
			if f.CurrentVersionID != nil && v.ID == *f.CurrentVersionID {
				if e = publish("notes/"+f.ID+"/current."+f.Format, v); e != nil {
					return e
				}
			}
			if upgrading && v.Metadata.Format == "md" {
				data, e := r.readNoteBlobAt(ctx, vault, v.ContentHash, v.ContentSize, v.StorageKey)
				if e != nil {
					return e
				}
				for _, link := range r.assetReferences(data) {
					a, e := r.assetForReference(ctx, tx, "", vault, link)
					if errors.Is(e, ErrNotFound) {
						report.Unresolved = append(report.Unresolved, link)
						continue
					}
					if e != nil {
						return e
					}
					if _, e = tx.ExecContext(ctx, `INSERT OR IGNORE INTO version_image_refs VALUES(?,?)`, v.ID, a.ID); e != nil {
						return e
					}
				}
			}
			refs, e := stringList(ctx, tx, `SELECT asset_id FROM version_image_refs WHERE version_id=? ORDER BY asset_id`, v.ID)
			if e != nil {
				return e
			}
			m.Versions = append(m.Versions, directoryVersion{v, key, refs})
		}
	}
	items, err := tx.QueryContext(ctx, assetSelect+`WHERE a.vault_id=? AND u.status='completed' ORDER BY a.id`, vault)
	if err != nil {
		return err
	}
	var assets []Asset
	for items.Next() {
		a, e := r.scanAsset(items)
		if e != nil {
			items.Close()
			return e
		}
		assets = append(assets, a)
	}
	err = items.Err()
	items.Close()
	if err != nil {
		return err
	}
	for _, a := range assets {
		rel := strings.TrimPrefix(a.StorageKey, ns+"/")
		if rel == "" {
			if e := tx.QueryRowContext(ctx, `SELECT coalesce(storage_key,'') FROM blobs WHERE vault_id=? AND content_hash=?`, vault, a.Hash).Scan(&rel); e != nil {
				return e
			}
			a.StorageKey = rel
			rel = strings.TrimPrefix(rel, ns+"/")
			if rel == "" {
				digest := strings.TrimPrefix(a.Hash, "sha256:")
				rel = digest[:2] + "/" + digest
			}
		}
		if strings.HasPrefix(a.Type, "image/") && !strings.HasPrefix(rel, "assets/") {
			body, e := scoped.OpenContext(ctx, vault, a.Hash, a.StorageKey)
			if e != nil {
				return e
			}
			key, e := putResource(ctx, scoped, vault, a.Hash, a.Size, a.CreatedAt, body)
			body.Close()
			if e != nil {
				return e
			}
			out, e := scoped.OpenContext(ctx, vault, a.Hash, key)
			if e != nil {
				return e
			}
			if e = verifyReader(out, a.Hash, a.Size); e != nil {
				return e
			}
			if _, e = tx.ExecContext(ctx, `UPDATE upload_sessions SET storage_key=? WHERE id=?`, key, a.Upload); e != nil {
				return e
			}
			rel = strings.TrimPrefix(key, ns+"/")
		}
		item := directoryImage{Asset: a, Object: rel}
		err = tx.QueryRowContext(ctx, `SELECT note_id,uploader_id FROM note_image_uploads WHERE asset_id=?`, a.ID).Scan(&item.Note, &item.Uploader)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		m.Assets = append(m.Assets, item)
		if upgrading {
			var referenced bool
			if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM version_image_refs WHERE asset_id=?)`, a.ID).Scan(&referenced); err != nil {
				return err
			}
			if PictureType(a.Type) && referenced {
				if _, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO image_lifetimes(asset_id) VALUES(?)`, a.ID); err != nil {
					return err
				}
			} else {
				report.Preserved = append(report.Preserved, a.ID)
			}
		}
	}
	if upgrading {
		raw, e := json.MarshalIndent(report, "", "  ")
		if e != nil {
			return e
		}
		saved = string(raw)
		if _, e = tx.ExecContext(ctx, `UPDATE vault_layout_upgrades SET report=? WHERE vault=?`, saved, vault); e != nil {
			return e
		}
	}
	if saved != "" && (upgrading || full) {
		if err = blob.WriteDocument(ctx, unwrap(storage), m.Owner, vault, "migration-report.json", []byte(saved)); err != nil {
			return err
		}
	}
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	if err = blob.WriteDocument(ctx, unwrap(storage), m.Owner, vault, "manifest.json", data); err != nil {
		return err
	}
	for k := range previous {
		if err = blob.RemoveDocument(ctx, unwrap(storage), m.Owner, vault, k); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `DELETE FROM vault_published_files WHERE vault=? AND path=?`, vault, k); err != nil {
			return err
		}
	}
	// Staging a new storage location must never switch keys in the live database.
	if full {
		return tx.Rollback()
	}
	if _, err = tx.ExecContext(ctx, `UPDATE vault_publications SET dirty=0 WHERE vault=?`, vault); err != nil {
		return err
	}
	return tx.Commit()
}

type layoutUpgradeReport struct {
	Backup     string   `json:"backup_id"`
	Preserved  []string `json:"retained_legacy_asset_ids,omitempty"`
	Unresolved []string `json:"unresolved_urls,omitempty"`
}

func (r *Repository) backupBeforeLayoutUpgrade(ctx context.Context) error {
	var actor string
	err := r.db.QueryRowContext(ctx, `SELECT owner_user_id FROM vaults JOIN vault_layout_upgrades u ON vaults.id=u.vault WHERE u.backup_id='' LIMIT 1`).Scan(&actor)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	job, err := r.createBackup(ctx, actor, "before_vault_layout_upgrade")
	if err != nil {
		return err
	}
	if err = r.VerifyBackup(ctx, job.ID); err != nil {
		return err
	}
	_, err = r.db.ExecContext(ctx, `UPDATE vault_layout_upgrades SET backup_id=? WHERE backup_id=''`, job.ID)
	return err
}

// Put the immutable version in the vault before its revision becomes visible.
func (r *Repository) writeVersionObject(ctx context.Context, tx *sql.Tx, vault, file, version, format, hash string, size int64) error {
	if r.blobStore == nil {
		return nil
	}
	var owner, key string
	if err := tx.QueryRowContext(ctx, `SELECT v.owner_user_id,coalesce(b.storage_key,'') FROM vaults v JOIN blobs b ON v.id=b.vault_id WHERE v.id=? AND b.content_hash=?`, vault, hash).Scan(&owner, &key); err != nil {
		return err
	}
	body, err := r.blobStore.OpenContext(ctx, vault, hash, key)
	if err != nil {
		return err
	}
	defer body.Close()
	rel := "notes/" + file + "/versions/" + version + "." + format
	if err = blob.WriteDocumentFrom(ctx, unwrap(r.blobStore), owner, vault, rel, body, size, hash); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO vault_published_files VALUES(?,?,?)`, vault, rel, hash)
	return err
}
