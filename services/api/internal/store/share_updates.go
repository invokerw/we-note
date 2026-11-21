package store

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

// Publishing follows only file identities present in the original immutable grant.
func (r *Repository) PublishShare(ctx context.Context, user, id string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var vault, raw string
	err = tx.QueryRowContext(ctx, `SELECT vault_id,snapshot FROM shares WHERE id=? AND sender=? AND status='accepted'`, id, user).Scan(&vault, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	var original Snapshot
	if err = json.Unmarshal([]byte(raw), &original); err != nil {
		return err
	}
	next := Snapshot{Files: append([]SnapshotFile(nil), original.Files...), Assets: []Asset{}}
	for i, old := range original.Files {
		f := &next.Files[i]
		err := tx.QueryRowContext(ctx, `SELECT f.path,f.current_version_id,f.current_content_hash,f.current_content_size FROM file_versions v JOIN files f ON f.id=v.file_id AND f.vault_id=v.vault_id WHERE v.id=? AND f.vault_id=? AND f.is_deleted=0`, old.Version, vault).Scan(&f.Path, &f.Version, &f.Hash, &f.Size)
		if errors.Is(err, sql.ErrNoRows) {
			*f = SnapshotFile{Path: old.Path}
			continue
		}
		if err != nil {
			return err
		}
	}
	next.Assets, err = r.snapshotAssets(ctx, tx, vault, next.Files, nil)
	if err != nil {
		return err
	}
	data, err := json.Marshal(next)
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT OR REPLACE INTO share_publications VALUES(?,?)`, id, string(data)); err != nil {
		return err
	}
	return tx.Commit()
}

type CopyState struct {
	File          string `json:"file_id"`
	SourceFile    string `json:"source_file_id"`
	Path          string `json:"path"`
	SourcePath    string `json:"source_path"`
	BaseSource    string `json:"base_source_version"`
	SourceVersion string `json:"source_version"`
	BaseLocal     string `json:"base_local_version"`
	LocalVersion  string `json:"local_version"`
	Deleted       bool   `json:"local_deleted"`
}
type copyRecord struct {
	CopyState
	source, target string
	latest         SnapshotFile
	assets         []Asset
}

func readCopies(ctx context.Context, tx *sql.Tx, user, id string) ([]copyRecord, error) {
	var initial, published, accepted, source, target string
	err := tx.QueryRowContext(ctx, `SELECT s.snapshot,coalesce(p.snapshot,s.snapshot),s.accepted_files,s.vault_id,s.target_vault FROM shares s LEFT JOIN share_publications p ON s.id=p.share_id WHERE s.id=? AND s.recipient=? AND s.status='accepted'`, id, user).Scan(&initial, &published, &accepted, &source, &target)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var first, next Snapshot
	var copies []FileResult
	for _, v := range []struct {
		raw  string
		dest any
	}{{initial, &first}, {published, &next}, {accepted, &copies}} {
		if err = json.Unmarshal([]byte(v.raw), v.dest); err != nil {
			return nil, err
		}
	}
	if len(copies) != len(first.Files) || len(copies) != len(next.Files) {
		return nil, errors.New("inconsistent share provenance")
	}
	out := make([]copyRecord, 0, len(copies))
	for i, f := range copies {
		src := next.Files[i]
		c := copyRecord{CopyState: CopyState{File: f.FileID, SourceVersion: src.Version, SourcePath: src.Path}, source: source, target: target, latest: src, assets: next.Assets}
		err = tx.QueryRowContext(ctx, `SELECT v.file_id,f.path,f.current_version_id,f.is_deleted,coalesce(h.source_version,?),coalesce(h.target_version,?) FROM files f JOIN file_versions v ON v.id=? AND v.vault_id=? LEFT JOIN share_copy_versions h ON h.share_id=? AND h.file_id=f.id WHERE f.id=? AND f.vault_id=?`, first.Files[i].Version, f.Version, first.Files[i].Version, source, id, f.FileID, target).Scan(&c.SourceFile, &c.Path, &c.LocalVersion, &c.Deleted, &c.BaseSource, &c.BaseLocal)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, nil
}
func (r *Repository) ShareCopies(ctx context.Context, user, id string) ([]CopyState, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	records, err := readCopies(ctx, tx, user, id)
	if err != nil {
		return nil, err
	}
	out := make([]CopyState, 0, len(records))
	for _, c := range records {
		out = append(out, c.CopyState)
	}
	return out, nil
}

type CopyDiff struct {
	CopyState
	Base, Local, Published *string `json:",omitempty"`
}

func getCopy(ctx context.Context, tx *sql.Tx, user, id, file string) (copyRecord, error) {
	records, err := readCopies(ctx, tx, user, id)
	if err != nil {
		return copyRecord{}, err
	}
	for _, c := range records {
		if c.File == file {
			return c, nil
		}
	}
	return copyRecord{}, ErrNotFound
}
func (r *Repository) CopyDiff(ctx context.Context, user, id, file string) (CopyDiff, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return CopyDiff{}, err
	}
	defer tx.Rollback()
	c, err := getCopy(ctx, tx, user, id, file)
	d := CopyDiff{CopyState: c.CopyState}
	if err != nil {
		return d, err
	}
	if strings.HasSuffix(strings.ToLower(c.Path), ".xmind") {
		return d, nil
	}
	for _, v := range []struct {
		vault, version string
		v              **string
	}{{c.target, c.BaseLocal, &d.Base}, {c.target, c.LocalVersion, &d.Local}, {c.source, c.SourceVersion, &d.Published}} {
		if v.version == "" {
			continue
		}
		var hash string
		var size int64
		err = tx.QueryRowContext(ctx, `SELECT content_hash,content_size FROM file_versions WHERE id=? AND vault_id=?`, v.version, v.vault).Scan(&hash, &size)
		if err != nil {
			return d, err
		}
		data, err := r.readNoteBlob(ctx, v.vault, hash, size)
		if err != nil {
			return d, err
		}
		text := string(data)
		*v.v = &text
	}
	return d, nil
}

type UpdateCopyRequest struct {
	SourceVersion string `json:"source_version"`
	LocalVersion  string `json:"local_version"`
}

func (r *Repository) UpdateCopy(ctx context.Context, user, id, file string, q UpdateCopyRequest) (FileResult, error) {
	var result FileResult
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	c, err := getCopy(ctx, tx, user, id, file)
	if err != nil {
		return result, err
	}
	if c.Deleted || c.SourceVersion == "" || q.SourceVersion != c.SourceVersion || q.LocalVersion != c.LocalVersion || c.BaseSource == c.SourceVersion {
		return result, fileError(409, "COPY_CHANGED", "版本已变化，请重新对比")
	}
	data, err := r.readNoteBlob(ctx, c.source, c.latest.Hash, c.latest.Size)
	if err != nil {
		return result, err
	}
	if strings.HasSuffix(strings.ToLower(c.latest.Path), ".md") {
		refs := map[string]bool{}
		for _, asset := range r.assetReferences(data) {
			refs[asset] = true
		}
		for _, a := range c.assets {
			if !refs[a.ID] {
				continue
			}
			var dest string
			err = tx.QueryRowContext(ctx, `SELECT c.target_url FROM share_asset_copies c JOIN assets a ON c.target_url=(? || '/assets/' || a.id) AND a.vault_id=? AND a.is_deleted=0 WHERE c.share_id=? AND c.source_url=?`, r.publicBase, c.target, id, a.URL).Scan(&dest)
			if errors.Is(err, sql.ErrNoRows) {
				dest, err = r.copyAsset(ctx, tx, c.target, a)
				if err != nil {
					return result, err
				}
				_, err = tx.ExecContext(ctx, `INSERT OR REPLACE INTO share_asset_copies VALUES(?,?,?)`, id, a.URL, dest)
			}
			if err != nil {
				return result, err
			}
			data = bytes.ReplaceAll(data, []byte(a.URL), []byte(dest))
		}
	}
	ref, err := r.putBytes(ctx, c.target, data)
	if err != nil {
		return result, err
	}
	op, err := newID("op")
	if err != nil {
		return result, err
	}
	result, err = writeFileTx(ctx, tx, c.target, file, "update_file_content", op, FileWrite{BaseVersion: c.LocalVersion, Content: data, Device: "web_" + user}, ref)
	if err != nil {
		return result, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT OR REPLACE INTO share_copy_versions VALUES(?,?,?,?)`, id, file, c.SourceVersion, result.Version); err != nil {
		return result, err
	}
	return result, tx.Commit()
}
