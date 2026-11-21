package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/weifei/we-note/services/api/internal/model"
	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
)

const maxNoteBytes = 16 << 20

// Content contains the original bytes, including any BOM and CRLF sequences.
type FileWrite struct {
	Path        string `json:"path,omitempty"`
	BasePath    string `json:"base_path,omitempty"`
	BaseVersion string `json:"base_version_id,omitempty"`
	BaseHash    string `json:"base_content_hash,omitempty"`
	Content     []byte `json:"content"`
	Device      string `json:"device_id,omitempty"`
}
type FileResult struct {
	FileID   string `json:"file_id"`
	Path     string `json:"path"`
	Version  string `json:"version_id"`
	Hash     string `json:"content_hash"`
	Revision int64  `json:"vault_revision"`
}

func fileError(status int, code, message string) error {
	return &SyncError{Status: status, Code: code, Message: message}
}
func PortablePath(p string) bool {
	if p == "" || len(p) > 2048 || !utf8.ValidString(p) || strings.ContainsAny(p, `\:*?"<>|`) || strings.IndexFunc(p, unicode.IsControl) >= 0 {
		return false
	}
	for _, part := range strings.Split(p, "/") {
		if part == "" || part == "." || part == ".." || strings.EqualFold(part, ".wenote") || strings.EqualFold(part, ".git") || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") || len(part) > 255 {
			return false
		}
		name := strings.ToUpper(strings.SplitN(part, ".", 2)[0])
		switch name {
		case "CON", "NUL", "PRN", "AUX", "CONIN$", "CONOUT$":
			return false
		}
		if len(name) == 4 && (strings.HasPrefix(name, "COM") || strings.HasPrefix(name, "LPT")) && name[3] >= '1' && name[3] <= '9' {
			return false
		}
	}
	return true
}
func fileFormat(p string) (string, error) {
	ext := strings.ToLower(strings.TrimPrefix(path.Ext(p), "."))
	if !PortablePath(p) || (ext != "md" && ext != "txt" && ext != "json" && ext != "xmind") {
		return "", fileError(400, "INVALID_PATH", "expected a portable relative Markdown, TXT, JSON or XMind path")
	}
	return ext, nil
}
func checkAvailablePath(ctx context.Context, tx *sql.Tx, vault, id, p string) error {
	rows, err := tx.QueryContext(ctx, `SELECT path FROM files WHERE vault_id=? AND id<>? AND is_deleted=0`, vault, id)
	if err != nil {
		return err
	}
	defer rows.Close()
	fold := cases.Fold()
	key := fold.String(norm.NFC.String(p))
	for rows.Next() {
		var other string
		if err := rows.Scan(&other); err != nil {
			return err
		}
		other = fold.String(norm.NFC.String(other))
		if other == key || strings.HasPrefix(key, other+"/") || strings.HasPrefix(other, key+"/") {
			return fileError(409, "PATH_CONFLICT", "another file occupies the requested path")
		}
	}
	return rows.Err()
}

type storedContent struct {
	Hash, Key string
	Size      int64
}

func (r *Repository) putBytes(ctx context.Context, vault string, data []byte) (storedContent, error) {
	if r.blobStore == nil {
		return storedContent{}, errors.New("blob store is not configured")
	}
	ref := storedContent{Hash: fmt.Sprintf("sha256:%x", sha256.Sum256(data)), Size: int64(len(data))}
	var err error
	ref.Key, err = r.blobStore.Put(ctx, vault, ref.Hash, ref.Size, bytes.NewReader(data))
	return ref, err
}

func (r *Repository) WriteFile(ctx context.Context, user, vault, id, operation, key string, input FileWrite) (FileResult, error) {
	var result FileResult
	input.Path = norm.NFC.String(input.Path)
	if key == "" {
		var err error
		key, err = newID("op")
		if err != nil {
			return result, err
		}
	}
	fingerprint, err := FingerprintRequest([]any{user, id, operation, input})
	if err != nil {
		return result, err
	}
	allowed, err := r.UserCanWriteVault(ctx, user, vault)
	if err != nil {
		return result, err
	}
	if !allowed {
		return result, ErrNotFound
	}
	var ref storedContent
	if operation == "create_file" || operation == "update_file_content" {
		if input.Content == nil {
			return result, fileError(400, "INVALID_REQUEST", "content is required")
		}
		if len(input.Content) > maxNoteBytes {
			return result, fileError(413, "NOTE_TOO_LARGE", "note exceeds 16 MiB")
		}
		ref, err = r.putBytes(ctx, vault, input.Content)
		if err != nil {
			return result, err
		}
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	if input.Device != "" {
		var exists bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM devices WHERE id=? AND user_id=?)`, input.Device, user).Scan(&exists); err != nil {
			return result, err
		}
		if !exists {
			return result, ErrNotFound
		}
	} else {
		input.Device = "web_" + user
	}
	var original, encoded string
	err = tx.QueryRowContext(ctx, `SELECT fingerprint,response FROM file_requests WHERE vault_id=? AND operation_id=?`, vault, key).Scan(&original, &encoded)
	if err == nil {
		if original != fingerprint {
			return result, fileError(409, "IDEMPOTENCY_KEY_REUSED", "operation already used")
		}
		err = json.Unmarshal([]byte(encoded), &result)
		return result, err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return result, err
	}
	var used bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM changes WHERE vault_id=? AND operation_id=?)`, vault, key).Scan(&used); err != nil {
		return result, err
	}
	if used {
		return result, fileError(409, "IDEMPOTENCY_KEY_REUSED", "operation already used")
	}
	result, err = writeFileTx(ctx, tx, vault, id, operation, key, input, ref)
	if err != nil {
		return result, err
	}
	if !strings.EqualFold(path.Ext(result.Path), ".xmind") {
		if err := r.validateAssetReferences(ctx, tx, vault, input.Content); err != nil {
			return result, err
		}
	}
	out, err := json.Marshal(result)
	if err != nil {
		return result, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO file_requests VALUES(?,?,?,?)`, vault, key, fingerprint, string(out)); err != nil {
		return result, err
	}
	return result, tx.Commit()
}

func writeFileTx(ctx context.Context, tx *sql.Tx, vault, id, op, key string, input FileWrite, ref storedContent) (FileResult, error) {
	var result FileResult
	now := time.Now().UTC()
	stamp := formatTime(now)
	var parent, version, format, p string
	if op == "create_file" {
		var err error
		id, err = newID("file")
		if err != nil {
			return result, err
		}
		p = input.Path
	} else {
		var deleted bool
		err := tx.QueryRowContext(ctx, `SELECT f.path,f.format,v.id,v.content_hash,v.content_size,f.is_deleted FROM files f JOIN file_versions v ON v.id=f.current_version_id AND v.file_id=f.id AND v.vault_id=f.vault_id WHERE f.vault_id=? AND f.id=?`, vault, id).Scan(&p, &format, &parent, &result.Hash, &ref.Size, &deleted)
		if errors.Is(err, sql.ErrNoRows) {
			return result, ErrNotFound
		}
		if err != nil {
			return result, err
		}
		if deleted != (op == "restore_file") {
			return result, ErrNotFound
		}
		if input.BaseVersion == "" && input.BaseHash == "" {
			return result, fileError(400, "BASE_REQUIRED", "base_version_id or base_content_hash required")
		}
		if (input.BaseVersion != "" && input.BaseVersion != parent) || (input.BaseHash != "" && input.BaseHash != result.Hash) || (input.BasePath != "" && input.BasePath != p) {
			return result, fileError(409, "FILE_VERSION_CONFLICT", "file changed since last read")
		}
		if op == "move_file" || op == "restore_file" && input.Path != "" {
			p = input.Path
		}
		if op == "update_file_content" {
			ref.Size = int64(len(input.Content))
		} else {
			ref.Hash = result.Hash
		}
	}
	if op == "create_file" || op == "move_file" || op == "restore_file" {
		var err error
		format, err = fileFormat(p)
		if err != nil {
			return result, err
		}
		if err = checkAvailablePath(ctx, tx, vault, id, p); err != nil {
			return result, err
		}
	}
	var revision int64
	err := tx.QueryRowContext(ctx, `UPDATE vaults SET current_revision=current_revision+1 WHERE id=? AND current_revision<? RETURNING current_revision`, vault, maxSafeRevision).Scan(&revision)
	if err != nil {
		return result, err
	}
	if op == "create_file" {
		_, err = tx.ExecContext(ctx, `INSERT INTO files(id,vault_id,path,format,created_at,updated_at) VALUES(?,?,?,?,?,?)`, id, vault, p, format, stamp, stamp)
		if err != nil {
			return result, err
		}
	}
	version = parent
	blobID := blobIDForHash(ref.Hash)
	if op == "create_file" || op == "update_file_content" || op == "restore_file" {
		if ref.Key != "" {
			if err := ensureBlobTx(ctx, tx, vault, blobID, ref.Hash, ref.Size, ref.Key, now); err != nil {
				return result, err
			}
		}
		version, err = newID("ver")
		if err != nil {
			return result, err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO file_versions(id,vault_id,file_id,blob_id,content_hash,content_size,parent_version_id,created_by_device_id,metadata_format,vault_revision,created_at) VALUES(?,?,?,?,?,?,NULLIF(?,''),?,?,?,?)`, version, vault, id, blobID, ref.Hash, ref.Size, parent, input.Device, format, revision, stamp)
		if err != nil {
			return result, err
		}
	}
	_, err = tx.ExecContext(ctx, `UPDATE files SET path=?,format=?,current_version_id=?,current_content_hash=?,current_content_size=?,current_blob_id=?,is_deleted=?,updated_at=? WHERE vault_id=? AND id=?`, p, format, version, ref.Hash, ref.Size, blobID, op == "delete_file", stamp, vault, id)
	if err != nil {
		return result, err
	}
	change, err := newID("chg")
	if err != nil {
		return result, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO changes(id,vault_id,vault_revision,file_id,version_id,operation_id,operation,path,parent_version_id,device_id,client_timestamp,content_hash,content_size,request_id,created_at) VALUES(?,?,?,?,?,?,?,?,NULLIF(?,''),?,?,?,?,?,?)`, change, vault, revision, id, version, key, op, p, parent, input.Device, stamp, ref.Hash, ref.Size, change, stamp)
	if err != nil {
		return result, err
	}
	return FileResult{id, p, version, ref.Hash, revision}, nil
}

func (r *Repository) Trash(ctx context.Context, vault string) ([]model.File, error) {
	rows, err := r.db.QueryContext(ctx, strings.Replace(activeFileQuery, "f.is_deleted = 0", "f.is_deleted = 1", 1)+` ORDER BY f.updated_at DESC`, vault)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	files := []model.File{}
	for rows.Next() {
		f, err := scanFile(rows)
		if err != nil {
			return nil, err
		}
		files = append(files, f)
	}
	return files, rows.Err()
}
