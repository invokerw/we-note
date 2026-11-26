package store

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"github.com/weifei/we-note/services/api/internal/blob"
	"github.com/weifei/we-note/services/api/internal/sqlite"
	"io"
	"strings"
	"testing"
)

func TestPortableVaultImport(t *testing.T) {
	ctx := context.Background()
	db, err := sqlite.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	blobs, err := blob.NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	r := NewRepository(db, blobs)
	user, err := r.CreateUser(ctx, "import@local.test", "hash")
	if err != nil {
		t.Fatal(err)
	}
	source, err := r.CreateVault(ctx, user.ID, "原库")
	if err != nil {
		t.Fatal(err)
	}
	target, err := r.CreateVault(ctx, user.ID, "新库")
	if err != nil {
		t.Fatal(err)
	}
	image := []byte("\x89PNG\r\n\x1a\nshared")
	asset, err := r.CreateAsset(ctx, user.ID, source.ID, "diagram.png", "image/png", fmt.Sprintf("sha256:%x", sha256.Sum256(image)), "", int64(len(image)))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = r.CompleteUploadSession(ctx, source.ID, asset.Upload, bytes.NewReader(image)); err != nil {
		t.Fatal(err)
	}
	note := FileWrite{Path: "项目/周报.md", Content: []byte("![图](" + asset.URL + "#a)\r\n`literal` `" + asset.URL + "`")}
	if _, err = r.WriteFile(ctx, user.ID, source.ID, "", "create_file", "", note); err != nil {
		t.Fatal(err)
	}
	job, err := r.CreateExport(ctx, user.ID, source.ID, "", ExportOptions{Scope: "all", Mode: "portable"})
	if err != nil {
		t.Fatal(err)
	}
	r.processExports()
	job, err = r.Export(ctx, user.ID, source.ID, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	reader, err := r.OpenExport(ctx, user.ID, source.ID, job, false)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"manifest.json", "asset-manifest.json", "checksums.sha256", "notes/项目/周报.md"} {
		damaged := changeImportEntry(t, data, name)
		if _, err := r.PreviewImport(ctx, user.ID, target.ID, bytes.NewReader(damaged)); err == nil {
			t.Fatal("accepted invalid archive", name)
		}
	}
	guest, err := r.CreateUser(ctx, "viewer@local.test", "hash")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO workspace_members VALUES(?,?,'viewer',CURRENT_TIMESTAMP)`, target.ID, guest.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = r.PreviewImport(ctx, guest.ID, target.ID, bytes.NewReader(data)); err == nil {
		t.Fatal("viewer obtained preview")
	}
	preview, err := r.PreviewImport(ctx, user.ID, target.ID, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if len(preview.Files) != 1 || preview.Assets != 1 || preview.Folder != "" {
		t.Fatal(preview)
	}
	if _, err = r.WriteFile(ctx, user.ID, target.ID, "", "create_file", "", FileWrite{Path: note.Path, Content: []byte("keep")}); err != nil {
		t.Fatal(err)
	}
	changed, err := r.ConfirmImport(ctx, user.ID, target.ID, preview.ID, preview.Folder)
	if err != nil || changed.Folder == "" || changed.Status != "preview" {
		t.Fatal(changed, err)
	}
	if _, err = r.ConfirmImport(ctx, guest.ID, target.ID, preview.ID, changed.Folder); err == nil {
		t.Fatal("viewer confirmed import")
	}
	if _, err = db.Exec(`CREATE TRIGGER deny_import BEFORE INSERT ON changes BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err = r.ConfirmImport(ctx, user.ID, target.ID, preview.ID, changed.Folder); err == nil {
		t.Fatal("expected rollback")
	}
	existing, err := r.ListFiles(ctx, target.ID)
	if err != nil || len(existing) != 1 {
		t.Fatal(existing, err)
	}
	resources, err := r.ListAssets(ctx, target.ID)
	if err != nil || len(resources) != 0 {
		t.Fatal(resources, err)
	}
	if _, err = db.Exec(`DROP TRIGGER deny_import`); err != nil {
		t.Fatal(err)
	}
	done, err := r.ConfirmImport(ctx, user.ID, target.ID, preview.ID, changed.Folder)
	if err != nil || done.Status != "completed" {
		t.Fatal(done, err)
	}
	if _, err = r.ConfirmImport(ctx, user.ID, target.ID, preview.ID, changed.Folder); err != nil {
		t.Fatal(err)
	}
	files, err := r.ListFiles(ctx, target.ID)
	if err != nil || len(files) != 2 {
		t.Fatal(files, err)
	}
	for _, f := range files {
		if f.Path == note.Path {
			continue
		}
		_, body, err := r.OpenFileContent(ctx, target.ID, f.ID)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(body)
		body.Close()
		if err != nil || !strings.Contains(string(data), "/"+target.ID+"/") || !strings.Contains(string(data), "#a)\r\n`literal`") {
			t.Fatal(string(data), err)
		}
	}
}

func TestImportLinkDestinations(t *testing.T) {
	file := "notes/项目/周报.md"
	notes := map[string]bool{"项目/周报.md": true, "资料.md": true, "A/照片.md": true, "B/照片.md": true}
	assetPath := "assets/旧附件/a 图.pdf"
	assets := map[string]string{assetPath: "https://target/assets/new"}
	used, warnings := map[string]bool{}, map[string]bool{}
	source := "\ufeff---\r\n原文: ../../assets/旧附件/a 图.pdf\r\n---\r\n[截图][a]\r\n\r\n[a]: <../../assets/旧附件/a%20图.pdf#page=2>\r\n\r\n`[[/资料]]` [根笔记](/资料.md#标题) [[/资料|目录]] [[照片]]\r\n"
	result := string(importMarkdown([]byte(source), file, "副本", assets, notes, used, warnings))
	expected := strings.NewReplacer("<../../assets/旧附件/a%20图.pdf#page=2>", "<https://target/assets/new#page=2>", "(/资料.md#标题)", "(/%E5%89%AF%E6%9C%AC/%E8%B5%84%E6%96%99.md#标题)", "[[/资料|目录]]", "[[/副本/资料.md|目录]]").Replace(source)
	if result != expected || !used[assetPath] || len(warnings) != 1 {
		t.Fatalf("unexpected rewrite %q warnings %v", result, warnings)
	}
}

func changeImportEntry(t *testing.T, raw []byte, name string) []byte {
	t.Helper()
	z, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	w := zip.NewWriter(&out)
	for _, f := range z.File {
		if f.Name != name {
			if err = w.Copy(f); err != nil {
				t.Fatal(err)
			}
			continue
		}
		entry, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = entry.Write([]byte("invalid")); err != nil {
			t.Fatal(err)
		}
	}
	if err = w.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}
