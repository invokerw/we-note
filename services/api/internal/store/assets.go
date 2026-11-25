package store

import (
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

const assetDateLayout = "2006/01/02"

func canonicalAssetURL(publicBase, owner, vault string, createdAt time.Time, contentHash string) string {
	return strings.TrimRight(publicBase, "/") + "/assets/" + owner + "/" + vault + "/" + createdAt.UTC().Format(assetDateLayout) + "/" + strings.TrimPrefix(contentHash, "sha256:")
}

func (r *Repository) SetPublicBase(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return err
	}
	localHTTP := u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")
	if (u.Scheme != "https" && !localHTTP) || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.Trim(u.Path, "/") != "" {
		return errors.New("public URL requires HTTPS or a loopback HTTP origin")
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

	CreatedAt     time.Time `json:"-"`
	StorageKey    string    `json:"-"`
	LegacyURL     string    `json:"-"`
	ReferenceURLs []string  `json:"reference_urls,omitempty"`
}

const assetSelect = `SELECT a.id,a.vault_id,a.name,a.media_type,u.status,u.content_hash,u.content_size,u.id,a.created_at,u.storage_key,v.owner_user_id FROM assets a JOIN vaults v ON v.id=a.vault_id JOIN upload_sessions u ON u.id=a.upload_id AND u.vault_id=a.vault_id `

func (r *Repository) scanAsset(row scanner) (Asset, error) {
	var a Asset
	var createdAt, owner string
	var storageKey sql.NullString
	err := row.Scan(&a.ID, &a.Vault, &a.Name, &a.Type, &a.Status, &a.Hash, &a.Size, &a.Upload, &createdAt, &storageKey, &owner)
	if errors.Is(err, sql.ErrNoRows) {
		return a, ErrNotFound
	}
	if err != nil {
		return a, err
	}
	a.CreatedAt, err = parseTime(createdAt)
	if err != nil {
		return a, err
	}
	if storageKey.Valid {
		a.StorageKey = storageKey.String
	}
	a.LegacyURL = r.publicBase + "/assets/" + a.ID
	a.URL = canonicalAssetURL(r.publicBase, owner, a.Vault, a.CreatedAt, a.Hash)
	return a, nil
}
func (r *Repository) CreateAsset(ctx context.Context, user, vault, name, mediaType, hash, key string, size int64) (Asset, error) {
	return r.createAsset(ctx, user, vault, "", name, mediaType, hash, key, size)
}
func (r *Repository) CreateNoteImage(ctx context.Context, user, vault, note, name, mediaType, hash, key string, size int64) (Asset, error) {
	if note == "" {
		return Asset{}, fileError(400, "NOTE_REQUIRED", "请升级客户端，从笔记内插入图片")
	}
	return r.createAsset(ctx, user, vault, note, name, mediaType, hash, key, size)
}
func (r *Repository) createAsset(ctx context.Context, user, vault, note, name, mediaType, hash, key string, size int64) (Asset, error) {
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
	params := []any{user, name, mt, hash, size}
	if note != "" {
		var exists bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM files WHERE id=? AND vault_id=? AND is_deleted=0)`, note, vault).Scan(&exists); err != nil {
			return a, err
		}
		if !exists {
			return a, ErrNotFound
		}
		params = append(params, note)
	}
	fingerprint, err := FingerprintRequest(params)
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
	if note != "" {
		if _, err = tx.ExecContext(ctx, `INSERT INTO note_image_uploads VALUES(?,?,?)`, id, note, user); err != nil {
			return a, err
		}
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
	storageKey := a.StorageKey
	if storageKey == "" {
		_ = r.db.QueryRowContext(ctx, `SELECT storage_key FROM blobs WHERE vault_id=? AND content_hash=?`, a.Vault, a.Hash).Scan(&storageKey)
	}
	return r.blobStore.OpenContext(ctx, a.Vault, a.Hash, storageKey)
}

func (r *Repository) AssetForPublicPath(ctx context.Context, user, year, month, day, digest string) (Asset, error) {
	date := strings.Join([]string{year, month, day}, "/")
	if _, err := time.Parse(assetDateLayout, date); err != nil || !syncHashPattern.MatchString("sha256:"+digest) {
		return Asset{}, ErrNotFound
	}
	asset, err := r.assetForReference(ctx, r.db, user, "", r.publicBase+"/assets/"+date+"/"+digest)
	if !errors.Is(err, ErrNotFound) {
		return asset, err
	}
	ids, err := stringList(ctx, r.db.DB, `SELECT a.id FROM assets a JOIN upload_sessions u ON u.id=a.upload_id AND u.vault_id=a.vault_id JOIN workspace_members m ON m.vault_id=a.vault_id WHERE m.user_id=? AND a.is_deleted=1 AND u.status='completed' AND substr(a.created_at,1,10)=? AND u.content_hash=? ORDER BY a.id`, user, strings.Join([]string{year, month, day}, "-"), "sha256:"+digest)
	if err != nil {
		return Asset{}, err
	}
	for _, id := range ids {
		asset, err = r.AssetForUser(ctx, user, "", id)
		if !errors.Is(err, ErrNotFound) {
			return asset, err
		}
	}
	return Asset{}, ErrNotFound
}

func (r *Repository) AssetForScopedPath(ctx context.Context, user, owner, vault, year, month, day, digest string) (Asset, error) {
	reference := r.publicBase + "/assets/" + strings.Join([]string{owner, vault, year, month, day, digest}, "/")
	return r.assetForReference(ctx, r.db, user, vault, reference)
}

func (r *Repository) assetForReference(ctx context.Context, queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, user, vault, reference string) (Asset, error) {
	assetPath := strings.TrimPrefix(reference, r.publicBase+"/assets/")
	if assetPath == reference {
		return Asset{}, ErrNotFound
	}
	where := `a.is_deleted=0 AND u.status='completed'`
	args := []any{}
	if strings.HasPrefix(assetPath, "asset_") {
		where += ` AND a.id=?`
		args = append(args, assetPath)
	} else {
		parts := strings.Split(assetPath, "/")
		if len(parts) == 6 {
			where += ` AND v.owner_user_id=? AND a.vault_id=?`
			args = append(args, parts[0], parts[1])
			parts = parts[2:]
		}
		if len(parts) != 4 || len(parts[0]) != 4 || len(parts[1]) != 2 || len(parts[2]) != 2 || !syncHashPattern.MatchString("sha256:"+parts[3]) {
			return Asset{}, ErrNotFound
		}
		if _, err := time.Parse(assetDateLayout, strings.Join(parts[:3], "/")); err != nil {
			return Asset{}, ErrNotFound
		}
		where += ` AND substr(a.created_at,1,10)=? AND u.content_hash=?`
		args = append(args, strings.Join(parts[:3], "-"), "sha256:"+parts[3])
	}
	if vault != "" {
		where += ` AND a.vault_id=?`
		args = append(args, vault)
	}
	if user != "" {
		where += ` AND EXISTS(SELECT 1 FROM workspace_members m WHERE m.vault_id=a.vault_id AND m.user_id=?)`
		args = append(args, user)
	}
	return r.scanAsset(queryer.QueryRowContext(ctx, assetSelect+` WHERE `+where, args...))
}
func (r *Repository) DeleteAsset(ctx context.Context, user, vault, id string) error {
	res, err := r.db.ExecContext(ctx, `UPDATE assets SET is_deleted=1 WHERE vault_id=? AND id=? AND NOT EXISTS(SELECT 1 FROM image_lifetimes WHERE asset_id=assets.id) AND EXISTS(SELECT 1 FROM workspace_members WHERE vault_id=? AND user_id=? AND role IN ('owner','editor'))`, vault, id, vault, user)
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
	pattern := regexp.MustCompile(regexp.QuoteMeta(r.publicBase+"/assets/") + `((?:[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+/)?[0-9]{4}/[0-9]{2}/[0-9]{2}/[0-9a-f]{64}|asset_[a-zA-Z0-9_-]+)`)
	seen := map[string]bool{}
	refs := []string{}
	for _, match := range pattern.FindAllSubmatch(content, -1) {
		ref := r.publicBase + "/assets/" + string(match[1])
		if !seen[ref] {
			refs = append(refs, ref)
			seen[ref] = true
		}
	}
	return refs
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

func (r *Repository) copyLinkedImages(ctx context.Context, tx *sql.Tx, user, target string, data []byte) (map[string]string, error) {
	var links map[string]string
	for _, url := range r.assetReferences(data) {
		parts := strings.Split(strings.TrimPrefix(url, r.publicBase+"/assets/"), "/")
		if len(parts) != 6 || parts[1] == target {
			continue
		}
		a, err := r.assetForReference(ctx, tx, user, parts[1], url)
		if err != nil {
			return nil, err
		}
		if !PictureType(a.Type) {
			return nil, fileError(415, "IMAGE_TYPE_REQUIRED", "仅支持跨库复制图片")
		}
		dest, err := r.copyAsset(ctx, tx, target, a)
		if err != nil {
			return nil, err
		}
		if links == nil {
			links = make(map[string]string)
		}
		links[url] = dest
	}
	return links, nil
}
