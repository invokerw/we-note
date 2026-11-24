package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"io"
	"mime"
	"net/url"
	"regexp"
	"strings"
	"time"
)

func (r *Repository) SetPublicBase(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.Trim(u.Path, "/") != "" {
		return errors.New("public URL must be an HTTPS origin")
	}
	r.publicBase = strings.TrimRight(raw, "/")
	return nil
}

type Asset struct {
	ID     string `json:"asset_id"`
	Vault  string `json:"vault_id"`
	Name   string `json:"name"`
	Type   string `json:"media_type"`
	URL    string `json:"canonical_url"`
	Status string `json:"status"`
	Hash   string `json:"content_hash"`
	Size   int64  `json:"content_size"`
	Upload string `json:"-"`
}

const assetSelect = `SELECT a.id,a.vault_id,a.name,a.media_type,u.status,u.content_hash,u.content_size,u.id FROM assets a JOIN upload_sessions u ON u.id=a.upload_id AND u.vault_id=a.vault_id `

func (r *Repository) scanAsset(row scanner) (Asset, error) {
	var a Asset
	err := row.Scan(&a.ID, &a.Vault, &a.Name, &a.Type, &a.Status, &a.Hash, &a.Size, &a.Upload)
	if errors.Is(err, sql.ErrNoRows) {
		return a, ErrNotFound
	}
	a.URL = r.publicBase + "/assets/" + a.ID
	return a, err
}
func (r *Repository) CreateAsset(ctx context.Context, user, vault, name, mediaType, hash, key string, size int64) (Asset, error) {
	var a Asset
	allowed, err := r.UserCanWriteVault(ctx, user, vault)
	if err != nil {
		return a, err
	}
	if !allowed {
		return a, ErrNotFound
	}
	mt, _, err := mime.ParseMediaType(mediaType)
	if err != nil || name == "" || len(name) > 255 || size < 0 || size > MaxAssetSize || !syncHashPattern.MatchString(hash) {
		return a, fileError(400, "INVALID_ASSET", "invalid asset name, size, media type or SHA-256")
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return a, err
	}
	defer tx.Rollback()
	fingerprint, err := FingerprintRequest([]any{user, name, mt, hash, size})
	if err != nil {
		return a, err
	}
	if key != "" {
		var existing, fp string
		err := tx.QueryRowContext(ctx, `SELECT id,fingerprint FROM assets WHERE vault_id=? AND operation_key=?`, vault, key).Scan(&existing, &fp)
		if err == nil {
			if fp != fingerprint {
				return a, fileError(409, "IDEMPOTENCY_KEY_REUSED", "asset key reused")
			}
			return r.scanAsset(tx.QueryRowContext(ctx, assetSelect+`WHERE a.id=? AND a.is_deleted=0`, existing))
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return a, err
		}
	}
	upload, err := newID("upload")
	if err != nil {
		return a, err
	}
	id, err := newID("asset")
	if err != nil {
		return a, err
	}
	now := formatTime(time.Now().UTC())
	if _, err = tx.ExecContext(ctx, `INSERT INTO upload_sessions(id,vault_id,content_hash,content_size,status,created_at) VALUES(?,?,?,?,'pending',?)`, upload, vault, hash, size, now); err != nil {
		return a, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO assets(id,vault_id,name,media_type,upload_id,created_at,operation_key,fingerprint) VALUES(?,?,?,?,?,?,NULLIF(?,''),?)`, id, vault, name, mt, upload, now, key, fingerprint); err != nil {
		return a, err
	}
	a, err = r.scanAsset(tx.QueryRowContext(ctx, assetSelect+`WHERE a.id=?`, id))
	if err != nil {
		return a, err
	}
	return a, tx.Commit()
}
func (r *Repository) AssetForUser(ctx context.Context, user, vault, id string) (Asset, error) {
	asset, err := r.scanAsset(r.db.QueryRowContext(ctx, assetSelect+`JOIN workspace_members m ON m.vault_id=a.vault_id WHERE m.user_id=? AND a.id=? AND (?='' OR a.vault_id=?) AND a.is_deleted=0`, user, id, vault, vault))
	if err != ErrNotFound || vault != "" {
		return asset, err
	}
	asset, err = r.scanAsset(r.db.QueryRowContext(ctx, assetSelect+`JOIN workspace_members m ON m.vault_id=a.vault_id WHERE m.user_id=? AND a.id=? AND a.is_deleted=1`, user, id))
	if err != nil {
		return asset, err
	}
	used, err := r.noteUsesAsset(ctx, r.db.DB, asset.Vault, id)
	if err == nil && !used {
		err = ErrNotFound
	}
	return asset, err
}
func (r *Repository) OpenAsset(ctx context.Context, a Asset) (io.ReadCloser, error) {
	if a.Status != "completed" {
		return nil, ErrNotFound
	}
	return r.blobStore.OpenContext(ctx, a.Vault, a.Hash)
}
func (r *Repository) DeleteAsset(ctx context.Context, user, vault, id string) error {
	res, err := r.db.ExecContext(ctx, `UPDATE assets SET is_deleted=1 WHERE vault_id=? AND id=? AND EXISTS(SELECT 1 FROM workspace_members WHERE vault_id=? AND user_id=? AND role IN ('owner','editor'))`, vault, id, vault, user)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return err
}

// Only canonical links on this instance form dependencies. External links survive imports verbatim.
func (r *Repository) assetReferences(content []byte) []string {
	pattern := regexp.MustCompile(regexp.QuoteMeta(r.publicBase+"/assets/") + `(asset_[a-zA-Z0-9_-]+)`)
	seen := map[string]bool{}
	ids := []string{}
	for _, match := range pattern.FindAllSubmatch(content, -1) {
		id := string(match[1])
		if !seen[id] {
			ids = append(ids, id)
			seen[id] = true
		}
	}
	return ids
}
func (r *Repository) validateAssetReferences(ctx context.Context, tx *sql.Tx, vault string, content []byte) error {
	if !bytes.Contains(content, []byte("/assets/")) {
		return nil
	}
	for _, id := range r.assetReferences(content) {
		var ready bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM assets a JOIN upload_sessions u ON u.id=a.upload_id WHERE a.id=? AND a.vault_id=? AND a.is_deleted=0 AND u.status='completed')`, id, vault).Scan(&ready); err != nil {
			return err
		}
		if !ready {
			return fileError(409, "ASSET_NOT_READY", "referenced asset is unavailable")
		}
	}
	return nil
}

func (r *Repository) PublicBase() string { return r.publicBase }

func (r *Repository) ListAssets(ctx context.Context, vault string) ([]Asset, error) {
	rows, err := r.db.QueryContext(ctx, assetSelect+` WHERE a.vault_id=? AND a.is_deleted=0 AND u.status='completed' ORDER BY a.name,a.id`, vault)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	assets := []Asset{}
	for rows.Next() {
		a, err := r.scanAsset(rows)
		if err != nil {
			return nil, err
		}
		assets = append(assets, a)
	}
	return assets, rows.Err()
}

func (r *Repository) SetMailBase(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.Trim(u.Path, "/") != "" {
		return errors.New("invalid mail URL")
	}
	local := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if u.Scheme != "https" && !(local && u.Scheme == "http") {
		return errors.New("mail URL requires HTTPS or loopback HTTP")
	}
	r.mailBase = strings.TrimRight(raw, "/")
	return nil
}
func (r *Repository) MailBase() string {
	if r.mailBase != "" {
		return r.mailBase
	}
	return r.publicBase
}
