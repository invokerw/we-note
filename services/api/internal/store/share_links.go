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
	"path"
	"strings"
	"time"

	"github.com/weifei/we-note/services/api/internal/password"
)

type LinkOptions struct {
	TokenHash          string   `json:"token_hash"`
	Vault              string   `json:"vault_id"`
	Paths              []string `json:"paths"`
	AssetIDs           []string `json:"asset_ids"`
	Password           string   `json:"password"`
	Expires            int64    `json:"expires"`
	DurationDays       *int     `json:"duration_days,omitempty"`
	LegacyMaxDownloads int      `json:"max_downloads"` // Retain the original request fingerprint for retries.
	Download           bool     `json:"allow_download"`
	Import             bool     `json:"allow_import"`
}
type ShareLink struct {
	Vault     string `json:"vault_id"`
	Title     string `json:"title"`
	ID        string `json:"id"`
	Expires   int64  `json:"expires"`
	Download  bool   `json:"allow_download"`
	Import    bool   `json:"allow_import"`
	Revoked   bool   `json:"revoked"`
	Protected bool   `json:"password_required"`
}

const linkColumns = `vault,id,expires,allow_download,allow_import,revoked,password_hash<>'',coalesce(json_extract(snapshot,'$.files[0].path'),json_extract(snapshot,'$.assets[0].name'),'分享') || CASE WHEN json_array_length(snapshot,'$.files')>1 THEN ' 等 ' || json_array_length(snapshot,'$.files') || ' 篇笔记' ELSE '' END`

func scanLink(row scanner) (ShareLink, error) {
	var l ShareLink
	err := row.Scan(&l.Vault, &l.ID, &l.Expires, &l.Download, &l.Import, &l.Revoked, &l.Protected, &l.Title)
	return l, err
}
func ownedVaultTx(ctx context.Context, tx *sql.Tx, user, vault string) error {
	var ok bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM vaults WHERE id=? AND owner_user_id=?)`, vault, user).Scan(&ok); err != nil {
		return err
	}
	if !ok {
		return ErrNotFound
	}
	return nil
}
func (r *Repository) CreateLink(ctx context.Context, user, key string, q LinkOptions) (ShareLink, error) {
	var l ShareLink
	if !syncHashPattern.MatchString("sha256:"+q.TokenHash) || len(q.Password) > 512 {
		return l, fileError(400, "INVALID_LINK", "invalid token hash or password")
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return l, err
	}
	defer tx.Rollback()
	if err = ownedVaultTx(ctx, tx, user, q.Vault); err != nil {
		return l, err
	}
	// Persist a fingerprint of the non-secret options. Password equality is checked with its salted verifier.
	options := q
	options.Password = ""
	fingerprint, err := FingerprintRequest(options)
	if err != nil {
		return l, err
	}
	if key != "" {
		var id, fp, encoded string
		err = tx.QueryRowContext(ctx, `SELECT id,fingerprint,password_hash FROM share_links WHERE owner=? AND operation_key=?`, user, key).Scan(&id, &fp, &encoded)
		if err == nil {
			if fingerprint != fp || (encoded == "") != (q.Password == "") || (encoded != "" && !password.Compare(encoded, q.Password)) {
				return l, fileError(409, "IDEMPOTENCY_KEY_REUSED", "link options changed")
			}
			return scanLink(tx.QueryRowContext(ctx, `SELECT `+linkColumns+` FROM share_links WHERE id=?`, id))
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return l, err
		}
	}
	if q.LegacyMaxDownloads != 0 {
		return l, fileError(400, "INVALID_LINK", "分享链接已取消次数设置")
	}
	// Resolve relative durations after replay lookup so retries retain the original expiry.
	if q.DurationDays != nil {
		if q.Expires != 0 {
			return l, fileError(400, "INVALID_EXPIRY", "choose one expiry format")
		}
		switch *q.DurationDays {
		case 0: // Permanent until revoked.
		case 1, 3, 7:
			q.Expires = time.Now().Add(time.Duration(*q.DurationDays) * 24 * time.Hour).Unix()
		default:
			return l, fileError(400, "INVALID_EXPIRY", "请选择 1 天、3 天、7 天或永久")
		}
	} else if q.Expires <= time.Now().Unix() {
		return l, fileError(400, "INVALID_EXPIRY", "choose a future expiry")
	}
	if len(q.Paths) != 1 || len(q.AssetIDs) != 0 || !PortablePath(q.Paths[0]) {
		return l, fileError(400, "INVALID_SHARE", "请选择一篇笔记分享")
	}
	f, err := scanFile(tx.QueryRowContext(ctx, activeFileQuery+` AND f.path=?`, q.Vault, q.Paths[0]))
	if err != nil {
		return l, err
	}
	if f.CurrentVersionID == nil || (strings.HasSuffix(f.Path, "/.wenote-folder.json") && f.CurrentContentHash == "sha256:62837e3e3cc858e7102d86bce9f026008296ae23e621644486d155744e372496") {
		return l, fileError(400, "INVALID_SHARE", "请选择一篇已保存的笔记分享")
	}
	snap := Snapshot{Files: []SnapshotFile{{Path: f.Path, Version: *f.CurrentVersionID, Hash: f.CurrentContentHash, Size: f.CurrentContentSize, StorageKey: f.CurrentStorageKey}}}
	snap.Assets, err = r.snapshotAssets(ctx, tx, q.Vault, snap.Files, nil)
	if err != nil {
		return l, err
	}
	raw, err := json.Marshal(snap)
	if err != nil {
		return l, err
	}
	var pass string
	if q.Password != "" {
		pass, err = password.Hash(q.Password)
		if err != nil {
			return l, err
		}
	}
	id, err := newID("link")
	if err != nil {
		return l, err
	}
	l, err = scanLink(tx.QueryRowContext(ctx, `INSERT INTO share_links(id,owner,vault,token_hash,password_hash,snapshot,expires,max_downloads,allow_download,allow_import,operation_key,fingerprint) VALUES(?,?,?,?,?,?,?,0,?,?,NULLIF(?,''),?) RETURNING `+linkColumns, id, user, q.Vault, q.TokenHash, pass, string(raw), q.Expires, q.Download, q.Import, key, fingerprint))
	if err != nil {
		return l, err
	}
	return l, tx.Commit()
}
func (r *Repository) Links(ctx context.Context, user, vault string) ([]ShareLink, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT `+linkColumns+` FROM share_links WHERE owner=?1 AND (?2='' OR vault=?2) AND `+activeLink+` ORDER BY rowid DESC`, user, vault)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ShareLink{}
	for rows.Next() {
		l, err := scanLink(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}
func (r *Repository) RevokeLink(ctx context.Context, user, id string) error {
	var found string
	err := r.db.QueryRowContext(ctx, `UPDATE share_links SET revoked=1 WHERE id=? AND owner=? RETURNING id`, id, user).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

const unexpiredLink = `revoked=0 AND (expires=0 OR expires>unixepoch())`
const activeLink = unexpiredLink + ` AND (max_downloads=0 OR downloads<max_downloads)`
const LinkSessionSeconds = 900

func secretHash(secret string) string { return fmt.Sprintf("%x", sha256.Sum256([]byte(secret))) }
func (r *Repository) ExchangeLink(ctx context.Context, id, secret, pass string) (string, error) {
	var encoded string
	err := r.db.QueryRowContext(ctx, `SELECT password_hash FROM share_links WHERE id=? AND token_hash=? AND `+activeLink, id, secretHash(secret)).Scan(&encoded)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if encoded != "" && !password.Compare(encoded, pass) {
		return "", fileError(403, "PASSWORD_REQUIRED", "请输入正确的分享密码")
	}
	raw, hash, err := sessionSecret()
	if err != nil {
		return "", err
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `DELETE FROM share_link_sessions WHERE expires<=unixepoch()`); err != nil {
		return "", err
	}
	var saved string
	err = tx.QueryRowContext(ctx, `INSERT INTO share_link_sessions(token_hash,link,expires) SELECT ?,id,unixepoch()+? FROM share_links WHERE id=? AND `+activeLink+` RETURNING link`, hash, LinkSessionSeconds, id).Scan(&saved)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return raw, tx.Commit()
}

type LinkSnapshot struct {
	Snapshot
	legacyLimited bool
	Download      bool   `json:"allow_download"`
	Import        bool   `json:"allow_import"`
	Vault         string `json:"-"`
}

func readLink(ctx context.Context, tx *sql.Tx, id, session string) (LinkSnapshot, error) {
	var s LinkSnapshot
	var raw string
	err := tx.QueryRowContext(ctx, `SELECT vault,snapshot,allow_download,allow_import,max_downloads>0 FROM share_links WHERE id=? AND `+activeLink+` AND EXISTS(SELECT 1 FROM share_link_sessions WHERE link=? AND token_hash=? AND expires>unixepoch())`, id, id, secretHash(session)).Scan(&s.Vault, &raw, &s.Download, &s.Import, &s.legacyLimited)
	if errors.Is(err, sql.ErrNoRows) {
		return s, ErrNotFound
	}
	if err != nil {
		return s, err
	}
	err = json.Unmarshal([]byte(raw), &s.Snapshot)
	return s, err
}
func (r *Repository) LinkSnapshot(ctx context.Context, id, session string, download bool) (LinkSnapshot, error) {
	var s LinkSnapshot
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return s, err
	}
	defer tx.Rollback()
	s, err = readLink(ctx, tx, id, session)
	if err != nil {
		return s, err
	}
	if download {
		if err = recordLinkDownload(ctx, tx, id, s); err != nil {
			return s, err
		}
	}
	return s, tx.Commit()
}

func recordLinkDownload(ctx context.Context, tx *sql.Tx, id string, s LinkSnapshot) error {
	if !s.Download {
		return fileError(403, "DOWNLOAD_DISABLED", "此链接未开放下载")
	}
	if s.legacyLimited {
		// This update also fires the legacy download audit trigger.
		_, err := tx.ExecContext(ctx, `UPDATE share_links SET downloads=downloads+1 WHERE id=?`, id)
		return err
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO audit_events(owner,action,object_id) SELECT owner,'link.download',id FROM share_links WHERE id=?`, id)
	return err
}

func (r *Repository) DownloadLinkFile(ctx context.Context, id, session, version string) (string, []byte, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return "", nil, err
	}
	defer tx.Rollback()
	s, err := readLink(ctx, tx, id, session)
	if err != nil {
		return "", nil, err
	}
	for _, f := range s.Files {
		if f.Version != version {
			continue
		}
		if err = recordLinkDownload(ctx, tx, id, s); err != nil {
			return "", nil, err
		}
		data, err := r.readNoteBlobWithQuery(ctx, tx, s.Vault, f.Hash, f.Size)
		if err != nil {
			return "", nil, err
		}
		return path.Base(f.Path), data, tx.Commit()
	}
	return "", nil, ErrNotFound
}

func (r *Repository) ImportLink(ctx context.Context, user, id, session, target, folder string, placeSingleFileHere bool) ([]FileResult, error) {
	if folder != "" && !PortablePath(folder) {
		return nil, fileError(400, "INVALID_PATH", "invalid import folder")
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err = ownedVaultTx(ctx, tx, user, target); err != nil {
		return nil, err
	}
	s, err := readLink(ctx, tx, id, session)
	if err != nil {
		return nil, err
	}
	if !s.Import {
		return nil, fileError(403, "IMPORT_DISABLED", "此链接未开放导入")
	}
	var raw string
	err = tx.QueryRowContext(ctx, `SELECT files FROM share_link_imports WHERE link=? AND target=?`, id, target).Scan(&raw)
	if err == nil {
		var files []FileResult
		err = json.Unmarshal([]byte(raw), &files)
		return files, err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if placeSingleFileHere && len(s.Files) == 1 {
		s.Files[0].Path = path.Base(s.Files[0].Path)
	}
	files, _, err := r.importSnapshot(ctx, tx, s.Vault, target, folder, user, s.Snapshot)
	if err != nil {
		return nil, err
	}
	data, err := json.Marshal(files)
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO share_link_imports VALUES(?,?,?)`, id, target, string(data)); err != nil {
		return nil, err
	}
	if s.legacyLimited {
		if _, err = tx.ExecContext(ctx, `UPDATE share_links SET downloads=downloads+1 WHERE id=?`, id); err != nil {
			return nil, err
		}
	}
	return files, tx.Commit()
}
func (r *Repository) WriteLinkArchive(ctx context.Context, w io.Writer, s LinkSnapshot) error {
	z := zip.NewWriter(w)
	for _, f := range s.Files {
		if err := r.writeExportEntry(ctx, z, s.Vault, exportEntry{Path: "notes/" + f.Path, Hash: f.Hash, Size: f.Size}); err != nil {
			return err
		}
	}
	for _, a := range s.Assets {
		name := path.Base(strings.ReplaceAll(a.Name, `\`, "/"))
		if !PortablePath(name) {
			name = "attachment"
		}
		if err := r.writeExportEntry(ctx, z, s.Vault, exportEntry{Path: "assets/" + a.ID + "/" + name, Hash: a.Hash, Size: a.Size, StorageKey: a.StorageKey}); err != nil {
			return err
		}
	}
	w, err := z.Create("manifest.json")
	if err != nil {
		return err
	}
	if err = json.NewEncoder(w).Encode(s.Snapshot); err != nil {
		return err
	}
	return z.Close()
}
func (r *Repository) LinkText(ctx context.Context, s LinkSnapshot, version string) (string, error) {
	for _, f := range s.Files {
		if f.Version == version && !strings.EqualFold(path.Ext(f.Path), ".xmind") {
			b, err := r.readNoteBlob(ctx, s.Vault, f.Hash, f.Size)
			return string(b), err
		}
	}
	return "", ErrNotFound
}
