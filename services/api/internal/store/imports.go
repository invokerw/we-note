package store

import (
	"bufio"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

type ImportJob struct {
	ID        string   `json:"id"`
	Status    string   `json:"status"`
	Folder    string   `json:"folder"`
	Exported  string   `json:"exported"`
	Completed string   `json:"completed,omitempty"`
	Files     []string `json:"files"`
	Conflicts []string `json:"conflicts"`
	Warnings  []string `json:"warnings"`
	Assets    int      `json:"assets"`
	Unused    int      `json:"unused"`
}

func checkImportAccess(ctx context.Context, tx *sql.Tx, user, vault string) error {
	var ok bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM workspace_members WHERE user_id=? AND vault_id=? AND role IN ('owner','editor'))`, user, vault).Scan(&ok)
	if err == nil && !ok {
		return fileError(403, "FORBIDDEN", "需要当前笔记库的写入权限")
	}
	return err
}
func (j *ImportJob) plan(ctx context.Context, tx *sql.Tx, vault string, a *importArchive) error {
	existing, err := stringList(ctx, tx, `SELECT path FROM files WHERE vault_id=? AND is_deleted=0`, vault)
	if err != nil {
		return err
	}
	files, dirs := map[string]bool{}, map[string]bool{}
	for _, p := range existing {
		k := pathKey(p)
		files[k] = true
		for d := path.Dir(k); d != "."; d = path.Dir(d) {
			dirs[d] = true
		}
	}
	j.Files = []string{}
	j.Conflicts = nil
	j.Folder = ""
	notes := map[string]bool{}
	for _, f := range a.Files {
		p := strings.TrimPrefix(f.Path, "notes/")
		j.Files = append(j.Files, p)
		notes[p] = true
		k := pathKey(p)
		conflict := dirs[k]
		for d := k; d != "."; d = path.Dir(d) {
			conflict = conflict || files[d]
		}
		if conflict {
			j.Conflicts = append(j.Conflicts, p)
		}
	}
	if len(j.Conflicts) > 0 {
		base := "导入 " + time.Now().Format(time.DateOnly)
		j.Folder = base
		for n := 2; files[pathKey(j.Folder)] || dirs[pathKey(j.Folder)]; n++ {
			j.Folder = fmt.Sprintf("%s (%d)", base, n)
		}
	}
	assets := map[string]string{}
	for _, f := range a.Assets {
		assets[f.Path] = f.Path
	}
	used, warnings := map[string]bool{}, map[string]bool{}
	for _, f := range a.Files {
		if strings.EqualFold(path.Ext(f.Path), ".md") {
			data, e := readEntry(a.entries[f.Path], maxNoteBytes)
			if e != nil {
				return e
			}
			importMarkdown(data, f.Path, j.Folder, assets, notes, used, warnings)
		}
	}
	j.Assets = len(assets)
	j.Unused = j.Assets - len(used)
	j.Warnings = sortedImportKeys(warnings)
	return nil
}
func (r *Repository) PreviewImport(ctx context.Context, user, vault string, body io.Reader) (j ImportJob, err error) {
	ok, err := r.UserCanWriteVault(ctx, user, vault)
	if err != nil {
		return j, err
	}
	if !ok {
		return j, fileError(403, "FORBIDDEN", "需要当前笔记库的写入权限")
	}
	f, err := os.CreateTemp("", "wenote-portable-*.zip")
	if err != nil {
		return j, err
	}
	defer f.Close()
	defer func() {
		if err != nil {
			os.Remove(f.Name())
		}
	}()
	h := sha256.New()
	size, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(body, maxImportZip+1))
	if err != nil {
		return j, err
	}
	if size > maxImportZip {
		return j, fileError(413, "IMPORT_TOO_LARGE", "ZIP 最大为 256 MiB")
	}
	a, err := inspectArchive(f, size)
	if err != nil {
		return j, err
	}
	digest := fmt.Sprintf("%x", h.Sum(nil))
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return j, err
	}
	defer tx.Rollback()
	if err = checkImportAccess(ctx, tx, user, vault); err != nil {
		return j, err
	}
	j.ID, err = newID("import")
	if err != nil {
		return j, err
	}
	j.Status = "preview"
	j.Exported = a.Created
	if err = j.plan(ctx, tx, vault, a); err != nil {
		return j, err
	}
	data, err := json.Marshal(j)
	if err != nil {
		return j, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO portable_imports(id,vault,user,digest,summary,staged) VALUES(?,?,?,?,?,?)`, j.ID, vault, user, digest, string(data), filepath.Base(f.Name()))
	if err != nil {
		return j, err
	}
	return j, tx.Commit()
}
func (r *Repository) Imports(ctx context.Context, user, vault string) ([]ImportJob, error) {
	list, err := stringList(ctx, r.db.DB, `SELECT summary FROM portable_imports WHERE vault=? AND user=? AND staged<>'' ORDER BY created DESC,rowid DESC LIMIT 50`, vault, user)
	out := []ImportJob{}
	for _, s := range list {
		var j ImportJob
		if e := json.Unmarshal([]byte(s), &j); e != nil {
			return nil, e
		}
		out = append(out, j)
	}
	return out, err
}
func stagedImportPath(name string) (string, error) {
	if name != filepath.Base(name) || !strings.HasPrefix(name, "wenote-portable-") || !strings.HasSuffix(name, ".zip") {
		return "", ErrNotFound
	}
	return filepath.Join(os.TempDir(), name), nil
}
func (r *Repository) ConfirmImport(ctx context.Context, user, vault, id, folder string) (j ImportJob, err error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return j, err
	}
	defer tx.Rollback()
	if err = checkImportAccess(ctx, tx, user, vault); err != nil {
		return j, err
	}
	var raw, name, digest string
	err = tx.QueryRowContext(ctx, `SELECT summary,staged,digest FROM portable_imports WHERE id=? AND vault=? AND user=? AND staged<>''`, id, vault, user).Scan(&raw, &name, &digest)
	if errors.Is(err, sql.ErrNoRows) {
		return j, fileError(http.StatusGone, "IMPORT_PREVIEW_GONE", "此预览已结束或过期，请到目标目录核对笔记。")
	}
	if err != nil {
		return j, err
	}
	if err = json.Unmarshal([]byte(raw), &j); err != nil {
		return j, err
	}
	filename, err := stagedImportPath(name)
	if err != nil {
		return j, err
	}
	f, err := os.Open(filename)
	if err != nil {
		return j, importError("暂存包已失效，请重新选择 ZIP")
	}
	defer f.Close()
	h := sha256.New()
	size, err := io.Copy(h, io.LimitReader(f, maxImportZip+1))
	if err != nil {
		return j, err
	}
	if fmt.Sprintf("%x", h.Sum(nil)) != digest {
		return j, importError("暂存文件校验失败")
	}
	a, err := inspectArchive(f, size)
	if err != nil {
		return j, err
	}
	priorFolder := j.Folder
	if err = j.plan(ctx, tx, vault, a); err != nil {
		return j, err
	}
	if j.Folder == folder && priorFolder == folder {
		if err = r.installArchive(ctx, tx, vault, user, a, j); err != nil {
			return j, err
		}
		j.Status = "completed"
		j.Completed = formatTime(time.Now().UTC())
		_, err = tx.ExecContext(ctx, `DELETE FROM portable_imports WHERE id=?`, id)
	} else {
		data, marshalErr := json.Marshal(j)
		if marshalErr != nil {
			return j, marshalErr
		}
		_, err = tx.ExecContext(ctx, `UPDATE portable_imports SET summary=? WHERE id=?`, string(data), id)
	}
	if err != nil {
		return j, err
	}
	err = tx.Commit()
	if err == nil && j.Status == "completed" {
		os.Remove(filename)
	}
	return j, err
}
func (r *Repository) installArchive(ctx context.Context, tx *sql.Tx, vault, user string, a *importArchive, j ImportJob) error {
	urls := map[string]string{}
	for _, entry := range a.Assets {
		if urls[entry.Path] != "" {
			continue
		}
		f := a.entries[entry.Path]
		body, e := f.Open()
		if e != nil {
			return e
		}
		b := bufio.NewReader(body)
		header, _ := b.Peek(512)
		media := http.DetectContentType(header)
		if !PictureType(media) {
			media = mime.TypeByExtension(path.Ext(entry.Name))
			if media == "" || PictureType(media) {
				media = "application/octet-stream"
			}
		}
		url, e := r.storeCopiedAsset(ctx, tx, vault, Asset{Name: path.Base(entry.Name), Hash: entry.Hash, Size: entry.Size, Type: media}, b)
		body.Close()
		if e != nil {
			return e
		}
		urls[entry.Path] = url
	}
	notes := map[string]bool{}
	for _, p := range j.Files {
		notes[p] = true
	}
	for i, entry := range a.Files {
		data, e := readEntry(a.entries[entry.Path], maxNoteBytes)
		if e != nil {
			return e
		}
		p := path.Join(j.Folder, j.Files[i])
		if strings.EqualFold(path.Ext(p), ".md") {
			data = importMarkdown(data, entry.Path, j.Folder, urls, notes, map[string]bool{}, map[string]bool{})
		}
		if len(data) > maxNoteBytes {
			return importError("笔记超过大小限制：" + p)
		}
		if needsTextContent(p) {
			if e = validateTextContent(data); e != nil {
				return e
			}
		}
		ref, e := r.putBytes(ctx, vault, data)
		if e != nil {
			return e
		}
		if _, e = r.writeFileTx(ctx, tx, vault, "", "create_file", fmt.Sprintf("%s-%d", j.ID, i), FileWrite{Path: p, Content: data, Device: "web_" + user}, ref); e != nil {
			return e
		}
	}
	return nil
}
func (r *Repository) CancelImport(ctx context.Context, user, vault, id string) error {
	var staged string
	err := r.db.QueryRowContext(ctx, `DELETE FROM portable_imports WHERE user=? AND vault=? AND id=? AND staged<>'' RETURNING staged`, user, vault, id).Scan(&staged)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err == nil {
		if p, e := stagedImportPath(staged); e == nil {
			os.Remove(p)
		}
	}
	return err
}

func (r *Repository) expireImports(ctx context.Context) error {
	names, err := stringList(ctx, r.db.DB, `DELETE FROM portable_imports WHERE staged<>'' AND created<unixepoch()-86400 RETURNING staged`)
	if err != nil {
		return err
	}
	for _, name := range names {
		if p, e := stagedImportPath(name); e == nil {
			os.Remove(p)
		}
	}
	return nil
}
