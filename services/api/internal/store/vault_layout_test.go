package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"github.com/weifei/we-note/services/api/internal/blob"
	"github.com/weifei/we-note/services/api/internal/sqlite"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestVaultDirectoryContainsRecoverableNoteHistory(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	db, err := sqlite.Open(ctx, filepath.Join(root, "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	raw, err := blob.NewLocalStore(root)
	if err != nil {
		t.Fatal(err)
	}
	r := NewRepository(db, raw)
	u, err := r.CreateUser(ctx, "notes@local.test", "hash")
	if err != nil {
		t.Fatal(err)
	}
	v, err := r.CreateVault(ctx, u.ID, "Notes")
	if err != nil {
		t.Fatal(err)
	}
	first, err := r.WriteFile(ctx, u.ID, v.ID, "", "create_file", "", FileWrite{Path: "daily/note.md", Content: []byte("first")})
	if err != nil {
		t.Fatal(err)
	}
	_, err = r.WriteFile(ctx, u.ID, v.ID, first.FileID, "update_file_content", "", FileWrite{BaseVersion: first.Version, Content: []byte("second")})
	if err != nil {
		t.Fatal(err)
	}
	immutable := filepath.Join(root, "users", u.ID, "vaults", v.ID, "notes", first.FileID, "versions", first.Version+".md")
	if body, e := os.ReadFile(immutable); e != nil || string(body) != "first" {
		t.Fatal("committed version missing from note directory", e)
	}
	image := []byte("\x89PNG\r\n\x1a\nimage-data")
	hash := fmt.Sprintf("sha256:%x", sha256.Sum256(image))
	asset, err := r.CreateAsset(ctx, u.ID, v.ID, "old.png", "image/png", hash, "", int64(len(image)))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = r.CompleteUploadSession(ctx, v.ID, asset.Upload, bytes.NewReader(image)); err != nil {
		t.Fatal(err)
	}
	key, err := r.blobStore.PutAt(ctx, v.ID, hash, int64(len(image)), asset.CreatedAt, bytes.NewReader(image))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`UPDATE upload_sessions SET storage_key=? WHERE id=?`, key, asset.Upload); err != nil {
		t.Fatal(err)
	}
	oldNote, err := r.WriteFile(ctx, u.ID, v.ID, "", "create_file", "", FileWrite{Path: "old.md", Content: []byte(asset.LegacyURL)})
	if err != nil {
		t.Fatal(err)
	}
	for _, stmt := range []string{`DELETE FROM version_image_refs`, `DELETE FROM image_lifetimes`, `DELETE FROM vault_publications`} {
		if _, err = db.Exec(stmt); err != nil {
			t.Fatal(err)
		}
	}
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT OR REPLACE INTO system_settings(key,value,updated_at) VALUES('backup_root',?,CURRENT_TIMESTAMP)`, filepath.Join(root, "backups")); err != nil {
		t.Fatal(err)
	}

	if err = r.PublishVaults(ctx); err != nil {
		t.Fatal(err)
	}
	base := filepath.Join(root, "users", u.ID, "vaults", v.ID)
	report, err := os.ReadFile(filepath.Join(base, "migration-report.json"))
	if err != nil {
		t.Fatal(err)
	}
	var rec struct {
		Backup string `json:"backup_id"`
	}
	if err = json.Unmarshal(report, &rec); err != nil || rec.Backup == "" {
		t.Fatal(string(report), err)
	}
	if err = r.VerifyBackup(ctx, rec.Backup); err != nil {
		t.Fatal(err)
	}
	var refs int
	if err = db.QueryRow(`SELECT count(*) FROM version_image_refs WHERE version_id=? AND asset_id=?`, oldNote.Version, asset.ID).Scan(&refs); err != nil || refs != 1 {
		t.Fatal(refs, err)
	}
	for key, want := range map[string]string{"notes/" + first.FileID + "/current.md": "second", "notes/" + first.FileID + "/versions/" + first.Version + ".md": "first", "manifest.json": "daily/note.md"} {
		data, err := os.ReadFile(filepath.Join(base, key))
		if err != nil || !strings.Contains(string(data), want) {
			t.Fatal(key, string(data), err)
		}
	}
	copyDir := filepath.Join(t.TempDir(), "copy")
	if err = os.CopyFS(copyDir, os.DirFS(base)); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(t.TempDir(), "recovered")
	output, err := exec.Command("python3", "../../../../scripts/recover_vault.py", copyDir, dest).CombinedOutput()
	if err != nil {
		t.Fatal(err, string(output))
	}
	content, err := os.ReadFile(filepath.Join(dest, "notes", "daily", "note.md"))
	if err != nil || string(content) != "second" {
		t.Fatal(string(content), err)
	}

}
