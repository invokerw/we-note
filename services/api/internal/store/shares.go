package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

type SnapshotFile struct {
	Path    string `json:"path"`
	Version string `json:"version_id"`
	Hash    string `json:"content_hash"`
	Size    int64  `json:"content_size"`
}
type Snapshot struct {
	Files  []SnapshotFile `json:"files"`
	Assets []Asset        `json:"assets"`
}
type Share struct {
	ID        string   `json:"share_id"`
	Sender    string   `json:"sender"`
	Recipient string   `json:"recipient"`
	Status    string   `json:"status"`
	Created   string   `json:"created_at"`
	Snapshot  Snapshot `json:"snapshot"`
}
type ShareRequest struct {
	Vault     string   `json:"vault_id"`
	Recipient string   `json:"recipient"`
	Paths     []string `json:"paths"`
}

const shareSelect = `SELECT s.id,u.email,v.email,s.status,s.created_at,s.snapshot FROM shares s JOIN users u ON s.sender=u.id JOIN users v ON s.recipient=v.id `

func scanShare(row scanner) (Share, error) {
	var s Share
	var raw string
	err := row.Scan(&s.ID, &s.Sender, &s.Recipient, &s.Status, &s.Created, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return s, ErrNotFound
	}
	if err != nil {
		return s, err
	}
	err = json.Unmarshal([]byte(raw), &s.Snapshot)
	return s, err
}
func (r *Repository) readNoteBlob(ctx context.Context, vault, hash string, size int64) ([]byte, error) {
	if size > 16<<20 {
		return nil, fileError(413, "NOTE_TOO_LARGE", "note exceeds 16 MiB")
	}
	reader, err := r.blobStore.OpenContext(ctx, vault, hash)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, size+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) != size || fmt.Sprintf("sha256:%x", sha256.Sum256(data)) != hash {
		return nil, errors.New("stored note failed integrity check")
	}
	return data, nil
}
func (r *Repository) ShareFiles(ctx context.Context, user, key string, request ShareRequest) (Share, error) {
	var out Share
	recipient, _, err := r.UserByEmail(ctx, request.Recipient)
	if err != nil {
		return out, err
	}
	if recipient.ID == user || len(request.Paths) == 0 {
		return out, fileError(400, "INVALID_SHARE", "choose files and another recipient")
	}
	for _, p := range request.Paths {
		if !PortablePath(strings.TrimSuffix(p, "/")) {
			return out, fileError(400, "INVALID_PATH", "invalid snapshot path")
		}
	}
	fingerprint, err := FingerprintRequest(request)
	if err != nil {
		return out, err
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	var owner string
	err = tx.QueryRowContext(ctx, `SELECT owner_user_id FROM vaults WHERE id=?`, request.Vault).Scan(&owner)
	if errors.Is(err, sql.ErrNoRows) || err == nil && owner != user {
		return out, ErrNotFound
	}
	if err != nil {
		return out, err
	}
	if key != "" {
		var id, fp string
		err = tx.QueryRowContext(ctx, `SELECT id,fingerprint FROM shares WHERE sender=? AND operation_key=?`, user, key).Scan(&id, &fp)
		if err == nil {
			if fp != fingerprint {
				return out, fileError(409, "IDEMPOTENCY_KEY_REUSED", "share key reused")
			}
			return scanShare(tx.QueryRowContext(ctx, shareSelect+`WHERE s.id=?`, id))
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return out, err
		}
	}
	rows, err := tx.QueryContext(ctx, activeFileQuery+` ORDER BY f.path`, request.Vault)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	snap := Snapshot{Files: []SnapshotFile{}, Assets: []Asset{}}
	found := make(map[string]bool)
	for rows.Next() {
		f, err := scanFile(rows)
		if err != nil {
			return out, err
		}
		selected := false
		for _, p := range request.Paths {
			dir := strings.TrimSuffix(p, "/")
			if f.Path == p || strings.HasPrefix(f.Path, dir+"/") {
				selected = true
				found[p] = true
			}
		}
		if selected && f.CurrentVersionID != nil {
			snap.Files = append(snap.Files, SnapshotFile{f.Path, *f.CurrentVersionID, f.CurrentContentHash, f.CurrentContentSize})
		}
	}
	if err = rows.Err(); err != nil {
		return out, err
	}
	rows.Close()
	for _, p := range request.Paths {
		if !found[p] {
			return out, ErrNotFound
		}
	}
	seen := map[string]bool{}
	for _, f := range snap.Files {
		if !strings.HasSuffix(strings.ToLower(f.Path), ".md") {
			continue
		}
		data, err := r.readNoteBlob(ctx, request.Vault, f.Hash, f.Size)
		if err != nil {
			return out, err
		}
		for _, id := range r.assetReferences(data) {
			if seen[id] {
				continue
			}
			a, err := r.scanAsset(tx.QueryRowContext(ctx, assetSelect+`WHERE a.id=? AND a.vault_id=? AND a.is_deleted=0 AND u.status='completed'`, id, request.Vault))
			if err != nil {
				return out, err
			}
			snap.Assets = append(snap.Assets, a)
			seen[id] = true
		}
	}
	id, err := newID("share")
	if err != nil {
		return out, err
	}
	raw, err := json.Marshal(snap)
	if err != nil {
		return out, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO shares(id,vault_id,sender,recipient,snapshot,created_at,operation_key,fingerprint) VALUES(?,?,?,?,?,?,NULLIF(?,''),?)`, id, request.Vault, user, recipient.ID, string(raw), formatTime(time.Now().UTC()), key, fingerprint)
	if err != nil {
		return out, err
	}
	out, err = scanShare(tx.QueryRowContext(ctx, shareSelect+`WHERE s.id=?`, id))
	if err != nil {
		return out, err
	}
	return out, tx.Commit()
}
func (r *Repository) ListShares(ctx context.Context, user string, inbox bool) ([]Share, error) {
	field := "s.sender"
	if inbox {
		field = "s.recipient"
	}
	rows, err := r.db.QueryContext(ctx, shareSelect+`WHERE `+field+`=? ORDER BY s.created_at DESC`, user)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Share{}
	for rows.Next() {
		s, err := scanShare(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, s)
	}
	return list, rows.Err()
}
func (r *Repository) CloseShare(ctx context.Context, user, id string, revoke bool) error {
	field, status := "recipient", "rejected"
	if revoke {
		field, status = "sender", "revoked"
	}
	res, err := r.db.ExecContext(ctx, `UPDATE shares SET status=? WHERE id=? AND `+field+`=? AND status IN ('pending',?)`, status, id, user, status)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return err
}
func (r *Repository) copyAsset(ctx context.Context, tx *sql.Tx, target string, a Asset) (string, error) {
	body, err := r.blobStore.OpenContext(ctx, a.Vault, a.Hash)
	if err != nil {
		return "", err
	}
	defer body.Close()
	key, err := r.blobStore.Put(ctx, target, a.Hash, a.Size, body)
	if err != nil {
		return "", err
	}
	now := time.Now().UTC()
	blobID := blobIDForHash(a.Hash)
	if err = ensureBlobTx(ctx, tx, target, blobID, a.Hash, a.Size, key, now); err != nil {
		return "", err
	}
	upload, err := newID("upload")
	if err != nil {
		return "", err
	}
	id, err := newID("asset")
	if err != nil {
		return "", err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO upload_sessions(id,vault_id,blob_id,content_hash,content_size,status,storage_key,created_at,completed_at) VALUES(?,?,?,?,?,'completed',?,?,?)`, upload, target, blobID, a.Hash, a.Size, key, formatTime(now), formatTime(now))
	if err != nil {
		return "", err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO assets(id,vault_id,name,media_type,upload_id,created_at) VALUES(?,?,?,?,?,?)`, id, target, a.Name, a.Type, upload, formatTime(now))
	return r.publicBase + "/assets/" + id, err
}
func (r *Repository) AcceptShare(ctx context.Context, user, id, target, folder string) ([]FileResult, error) {
	if folder != "" && !PortablePath(folder) {
		return nil, fileError(400, "INVALID_PATH", "invalid import folder")
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var raw, status, source, originalTarget, saved string
	err = tx.QueryRowContext(ctx, `SELECT s.snapshot,s.status,s.vault_id,COALESCE(s.target_vault,''),COALESCE(s.accepted_files,'') FROM shares s JOIN vaults v ON v.id=? AND v.owner_user_id=? WHERE s.id=? AND s.recipient=?`, target, user, id, user).Scan(&raw, &status, &source, &originalTarget, &saved)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	results := []FileResult{}
	if status == "accepted" && originalTarget == target {
		err = json.Unmarshal([]byte(saved), &results)
		return results, err
	}
	if status != "pending" {
		return nil, fileError(409, "SHARE_CLOSED", "share has already been handled")
	}
	var snap Snapshot
	if err = json.Unmarshal([]byte(raw), &snap); err != nil {
		return nil, err
	}
	links := make(map[string]string)
	for _, a := range snap.Assets {
		dest, err := r.copyAsset(ctx, tx, target, a)
		if err != nil {
			return nil, err
		}
		links[a.URL] = dest
	}
	for _, file := range snap.Files {
		p := file.Path
		if folder != "" {
			p = folder + "/" + p
		}
		data, err := r.readNoteBlob(ctx, source, file.Hash, file.Size)
		if err != nil {
			return nil, err
		}
		if strings.HasSuffix(strings.ToLower(file.Path), ".md") {
			for old, newURL := range links {
				data = bytes.ReplaceAll(data, []byte(old), []byte(newURL))
			}
		}
		ref, err := r.putBytes(ctx, target, data)
		if err != nil {
			return nil, err
		}
		op, err := newID("op")
		if err != nil {
			return nil, err
		}
		result, err := writeFileTx(ctx, tx, target, "", "create_file", op, FileWrite{Device: "web_" + user, Path: p}, ref)
		if err != nil {
			return nil, err
		}
		results = append(results, result)
	}
	rawResult, err := json.Marshal(results)
	if err != nil {
		return nil, err
	}
	_, err = tx.ExecContext(ctx, `UPDATE shares SET status='accepted',accepted_files=?,target_vault=? WHERE id=?`, string(rawResult), target, id)
	if err != nil {
		return nil, err
	}
	return results, tx.Commit()
}
