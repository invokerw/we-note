package store

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path"
	"strings"
	"time"
)

type ExportOptions struct {
	Scope string `json:"scope"`
	Mode  string `json:"mode"`
}

type Export struct {
	ID         string `json:"job_id"`
	Mode       string `json:"mode"`
	Scope      string `json:"scope"`
	Created    string `json:"created_at"`
	Status     string `json:"status"`
	Hash       string `json:"content_hash,omitempty"`
	Size       int64  `json:"content_size"`
	StorageKey string `json:"-"`
}
type exportEntry struct {
	Path       string `json:"path"`
	ID         string `json:"id"`
	Version    string `json:"version_id,omitempty"`
	Hash       string `json:"content_hash"`
	Size       int64  `json:"content_size"`
	SourceHash string `json:"source_content_hash,omitempty"`
	Name       string `json:"original_name,omitempty"`
	URL        string `json:"canonical_url,omitempty"`
	StorageKey string `json:"-"`
}
type exportSnapshot struct {
	Mode    string        `json:"mode"`
	Layout  string        `json:"layout"`
	Created string        `json:"exported_at"`
	Scope   string        `json:"scope"`
	Files   []exportEntry `json:"files"`
	Assets  []exportEntry `json:"assets"`
}

const exportColumns = `SELECT id,scope,created_at,status,hash,size,storage_key,coalesce(json_extract(snapshot,'$.mode'),'online') FROM export_jobs `

func scanExport(row scanner) (Export, error) {
	var j Export
	var storageKey sql.NullString
	err := row.Scan(&j.ID, &j.Scope, &j.Created, &j.Status, &j.Hash, &j.Size, &storageKey, &j.Mode)
	if storageKey.Valid {
		j.StorageKey = storageKey.String
	}
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return j, err
}
func (r *Repository) Exports(ctx context.Context, user, vault string) ([]Export, error) {
	rows, err := r.db.QueryContext(ctx, exportColumns+`WHERE vault_id=? AND user_id=? ORDER BY created_at DESC`, vault, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Export{}
	for rows.Next() {
		j, e := scanExport(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, j)
	}
	return out, rows.Err()
}
func (r *Repository) Export(ctx context.Context, user, vault, id string) (Export, error) {
	return scanExport(r.db.QueryRowContext(ctx, exportColumns+`WHERE vault_id=? AND user_id=? AND id=?`, vault, user, id))
}
func (r *Repository) CanExport(ctx context.Context, user, vault string) (bool, error) {
	var ok bool
	err := r.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM workspace_members WHERE vault_id=? AND user_id=? AND role IN ('owner','editor','exporter'))`, vault, user).Scan(&ok)
	return ok, err
}
func (r *Repository) CreateExport(ctx context.Context, user, vault, key string, options ExportOptions) (Export, error) {
	scope, mode := options.Scope, options.Mode
	if mode == "" {
		mode = "online"
	}
	var j Export
	if scope != "notes" && scope != "all" {
		return j, fileError(400, "INVALID_SCOPE", "expected notes or all")
	}
	if mode != "online" && (mode != "portable" || scope != "all") {
		return j, fileError(400, "INVALID_EXPORT_MODE", "portable mode requires a full vault export")
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return j, err
	}
	defer tx.Rollback()
	if key != "" {
		existing, e := scanExport(tx.QueryRowContext(ctx, exportColumns+`WHERE vault_id=? AND user_id=? AND operation_key=?`, vault, user, key))
		if e == nil {
			if existing.Scope != scope || existing.Mode != mode {
				return j, fileError(409, "IDEMPOTENCY_KEY_REUSED", "export options changed")
			}
			return existing, nil
		}
		if !errors.Is(e, ErrNotFound) {
			return j, e
		}
	}
	j.ID, err = newID("export")
	if err != nil {
		return j, err
	}
	j.Created = formatTime(time.Now().UTC())
	j.Scope = scope
	j.Mode = mode
	j.Status = "pending"
	snap := exportSnapshot{Created: j.Created, Scope: scope, Mode: mode, Files: []exportEntry{}, Assets: []exportEntry{}}
	if scope != "assets" {
		rows, e := tx.QueryContext(ctx, activeFileQuery+` ORDER BY f.path`, vault)
		if e != nil {
			return j, e
		}
		defer rows.Close()
		for rows.Next() {
			f, e := scanFile(rows)
			if e != nil {
				return j, e
			}
			if f.CurrentVersionID == nil || !PortablePath(f.Path) {
				return j, errors.New("invalid file in export")
			}
			snap.Files = append(snap.Files, exportEntry{Path: "notes/" + f.Path, ID: f.ID, Version: *f.CurrentVersionID, Hash: f.CurrentContentHash, Size: f.CurrentContentSize, StorageKey: f.CurrentStorageKey})
		}
		if e = rows.Err(); e != nil {
			return j, e
		}
		rows.Close()
	}
	if scope != "notes" {
		rows, e := tx.QueryContext(ctx, assetSelect+` WHERE a.vault_id=? AND a.is_deleted=0 AND u.status='completed' ORDER BY a.id`, vault)
		if e != nil {
			return j, e
		}
		defer rows.Close()
		for rows.Next() {
			a, e := r.scanAsset(rows)
			if e != nil {
				return j, e
			}
			name := path.Base(strings.ReplaceAll(a.Name, `\`, "/"))
			if !PortablePath(name) {
				name = "attachment"
			}
			archivePath := "assets/" + a.ID + "/" + name
			if PictureType(a.Type) {
				archivePath = "assets/" + a.CreatedAt.UTC().Format(assetDateLayout) + "/" + strings.TrimPrefix(a.Hash, "sha256:")
			}
			snap.Assets = append(snap.Assets, exportEntry{Path: archivePath, ID: a.ID, Hash: a.Hash, Size: a.Size, Name: a.Name, URL: a.URL, StorageKey: a.StorageKey})
		}
		if e = rows.Err(); e != nil {
			return j, e
		}
		rows.Close()
	}
	if mode == "portable" && len(snap.Assets) > 0 {
		for _, f := range snap.Files {
			if strings.EqualFold(path.Ext(f.Path), ".md") && f.Size > maxNoteBytes {
				return j, fileError(413, "NOTE_TOO_LARGE", "离线链接转换支持最大 16 MiB 的 Markdown 笔记。保留在线链接可导出此库。")
			}
		}
	}
	raw, err := json.Marshal(snap)
	if err != nil {
		return j, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO export_jobs(id,vault_id,user_id,operation_key,scope,created_at,snapshot) VALUES(?,?,?,NULLIF(?,''),?,?,?)`, j.ID, vault, user, key, scope, j.Created, string(raw))
	if err != nil {
		return j, err
	}
	return j, tx.Commit()
}

// Pending snapshots are durable. A process restart resumes from the same immutable input blobs.
func (r *Repository) RunExports() {
	r.exportMu.Lock()
	defer r.exportMu.Unlock()
	if r.exportRunning {
		return
	}
	r.exportRunning = true
	go r.processExports()
}
func (r *Repository) processExports() {
	r.Maintenance.RLock()
	defer r.Maintenance.RUnlock()
	ctx := context.Background()
	for {
		var id, vault string
		var raw []byte
		r.exportMu.Lock()
		err := r.db.QueryRowContext(ctx, `SELECT id,vault_id,snapshot FROM export_jobs WHERE status='pending' ORDER BY created_at LIMIT 1`).Scan(&id, &vault, &raw)
		if err != nil {
			r.exportRunning = false
			r.exportMu.Unlock()
			if !errors.Is(err, sql.ErrNoRows) {
				log.Printf("export queue: %v", err)
			}
			return
		}
		r.exportMu.Unlock()
		hash, size, storageKey, err := r.buildArchive(ctx, vault, raw)
		status := "completed"
		if err != nil {
			log.Printf("export %s: %v", id, err)
			status = "failed"
		}
		if _, err = r.db.ExecContext(ctx, `UPDATE export_jobs SET status=?,hash=?,size=?,storage_key=? WHERE id=?`, status, hash, size, storageKey, id); err != nil {
			log.Printf("record export: %v", err)
			r.exportMu.Lock()
			r.exportRunning = false
			r.exportMu.Unlock()
			return
		}
	}
}
func (r *Repository) buildArchive(ctx context.Context, vault string, raw []byte) (string, int64, string, error) {
	var snap exportSnapshot
	if e := json.Unmarshal(raw, &snap); e != nil {
		return "", 0, "", e
	}
	tmp, e := os.CreateTemp("", "wenote-export-*.zip")
	if e != nil {
		return "", 0, "", e
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	hash := sha256.New()
	z := zip.NewWriter(io.MultiWriter(tmp, hash))
	if e = r.writeExportSnapshot(ctx, z, vault, &snap); e != nil {
		return "", 0, "", e
	}
	if e = z.Close(); e != nil {
		return "", 0, "", e
	}
	size, e := tmp.Seek(0, io.SeekCurrent)
	if e != nil {
		return "", 0, "", e
	}
	if _, e = tmp.Seek(0, io.SeekStart); e != nil {
		return "", 0, "", e
	}
	digest := fmt.Sprintf("sha256:%x", hash.Sum(nil))
	storageKey, e := r.blobStore.PutAt(ctx, vault, digest, size, time.Now().UTC(), tmp)
	return digest, size, storageKey, e
}
func (r *Repository) writeExportEntry(ctx context.Context, z *zip.Writer, vault string, f exportEntry) error {
	storageKey := f.StorageKey
	if storageKey == "" {
		_ = r.db.QueryRowContext(ctx, `SELECT storage_key FROM blobs WHERE vault_id=? AND content_hash=?`, vault, f.Hash).Scan(&storageKey)
	}
	src, e := r.blobStore.OpenContext(ctx, vault, f.Hash, storageKey)
	if e != nil {
		return e
	}
	defer src.Close()
	w, e := z.Create(f.Path)
	if e != nil {
		return e
	}
	hash := sha256.New()
	n, e := io.Copy(io.MultiWriter(w, hash), io.LimitReader(src, f.Size+1))
	if e != nil {
		return e
	}
	if n != f.Size || fmt.Sprintf("sha256:%x", hash.Sum(nil)) != f.Hash {
		return errors.New("export source integrity mismatch")
	}
	return nil
}
func (r *Repository) OpenExport(ctx context.Context, user, vault string, j Export, download bool) (io.ReadCloser, error) {
	if j.Status != "completed" {
		return nil, fileError(409, "EXPORT_NOT_READY", "archive is not ready")
	}
	body, err := r.blobStore.OpenContext(ctx, vault, j.Hash, j.StorageKey)
	if err != nil {
		return nil, err
	}
	if download {
		if _, err = r.db.ExecContext(ctx, `INSERT INTO audit_events(owner,action,object_id) VALUES(?,'export.download',?)`, user, j.ID); err != nil {
			body.Close()
			return nil, err
		}
	}
	return body, nil
}
