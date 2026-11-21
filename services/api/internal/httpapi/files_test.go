package httpapi

import (
	"bytes"
	"context"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/weifei/we-note/services/api/internal/blob"
	"github.com/weifei/we-note/services/api/internal/model"
	"github.com/weifei/we-note/services/api/internal/sqlite"
	"github.com/weifei/we-note/services/api/internal/store"
)

func TestFileReadEndpoints(t *testing.T) {
	ctx := context.Background()
	database, err := sqlite.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if err := database.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	blobStore, err := blob.NewLocalStore(filepath.Join(t.TempDir(), "storage"))
	if err != nil {
		t.Fatal(err)
	}
	repository := store.NewRepository(database, blobStore)
	mux := NewMux(repository)

	user := registerUser(t, mux, "alice@example.com", "alice password")
	authorization := loginUser(t, mux, "alice@example.com", "alice password")
	vault, err := repository.CreateVault(ctx, user.ID, "Alice Notes")
	if err != nil {
		t.Fatal(err)
	}
	base := []byte("# Roadmap v1\n")
	latest := []byte("# Roadmap v2\n\n- read endpoint\n")
	baseHash := digest(base)
	latestHash := digest(latest)
	for _, content := range [][]byte{base, latest} {
		hash := digest(content)
		storageKey, err := blobStore.Put(ctx, vault.ID, hash, int64(len(content)), bytes.NewReader(content))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := database.ExecContext(ctx, `
			INSERT INTO blobs(id, vault_id, content_hash, content_size, storage_key, created_at)
			VALUES (?, ?, ?, ?, ?, ?)`,
			"blob_"+hash[len("sha256:"):], vault.ID, hash, len(content),
			storageKey,
			"2026-11-21T09:00:00Z"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := database.ExecContext(ctx, `
		INSERT INTO files(id, vault_id, path, format, current_version_id, current_content_hash,
			current_content_size, current_blob_id, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		"file_roadmap", vault.ID, "projects/roadmap.md", "md", "ver_roadmap_02", latestHash,
		len(latest), "blob_"+latestHash[len("sha256:"):], "2026-11-21T09:00:00Z",
		"2026-11-21T09:05:00Z"); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `
		INSERT INTO file_versions(id, vault_id, file_id, blob_id, content_hash, content_size,
			created_by_device_id, metadata_format, metadata_line_ending, vault_revision, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		"ver_roadmap_01", vault.ID, "file_roadmap", "blob_"+baseHash[len("sha256:"):], baseHash,
		len(base), "device_mac", "md", "lf", 1, "2026-11-21T09:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `
		INSERT INTO file_versions(id, vault_id, file_id, blob_id, content_hash, content_size,
			parent_version_id, created_by_device_id, metadata_format, metadata_line_ending,
			vault_revision, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		"ver_roadmap_02", vault.ID, "file_roadmap", "blob_"+latestHash[len("sha256:"):], latestHash,
		len(latest), "ver_roadmap_01", "device_web", "md", "lf", 2, "2026-11-21T09:05:00Z"); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE vaults SET current_revision = 2 WHERE id = ?`, vault.ID); err != nil {
		t.Fatal(err)
	}

	listResponse := requestJSON(t, mux, http.MethodGet, "/api/v1/vaults/"+vault.ID+"/files", authorization, nil)
	if listResponse.Code != http.StatusOK {
		t.Fatalf("list files status = %d, body = %s", listResponse.Code, listResponse.Body.String())
	}
	var fileList struct {
		Files []model.File `json:"files"`
	}
	decodeResponse(t, listResponse, &fileList)
	if len(fileList.Files) != 1 || fileList.Files[0].CurrentContentHash != latestHash {
		t.Fatalf("file list = %#v", fileList)
	}

	fileResponse := requestJSON(t, mux, http.MethodGet, "/api/v1/vaults/"+vault.ID+"/files/file_roadmap", authorization, nil)
	if fileResponse.Code != http.StatusOK {
		t.Fatalf("get file status = %d, body = %s", fileResponse.Code, fileResponse.Body.String())
	}
	var file model.File
	decodeResponse(t, fileResponse, &file)
	if file.Path != "projects/roadmap.md" || file.CurrentVersionID == nil || *file.CurrentVersionID != "ver_roadmap_02" {
		t.Fatalf("file = %#v", file)
	}

	contentResponse := requestJSON(t, mux, http.MethodGet, "/api/v1/vaults/"+vault.ID+"/files/file_roadmap/content", authorization, nil)
	if contentResponse.Code != http.StatusOK {
		t.Fatalf("get content status = %d, body = %s", contentResponse.Code, contentResponse.Body.String())
	}
	if !bytes.Equal(contentResponse.Body.Bytes(), latest) {
		t.Fatalf("content = %q", contentResponse.Body.Bytes())
	}
	if got := contentResponse.Header().Get("X-Content-Hash"); got != latestHash {
		t.Fatalf("content hash header = %q", got)
	}
	if got := contentResponse.Header().Get("X-Version-Id"); got != "ver_roadmap_02" {
		t.Fatalf("version header = %q", got)
	}
	if got := contentResponse.Header().Get("Content-Type"); got != "text/markdown; charset=utf-8" {
		t.Fatalf("content type = %q", got)
	}

	versionsResponse := requestJSON(t, mux, http.MethodGet, "/api/v1/vaults/"+vault.ID+"/files/file_roadmap/versions", authorization, nil)
	if versionsResponse.Code != http.StatusOK {
		t.Fatalf("list versions status = %d, body = %s", versionsResponse.Code, versionsResponse.Body.String())
	}
	var versionList struct {
		Versions []model.FileVersion `json:"versions"`
	}
	decodeResponse(t, versionsResponse, &versionList)
	if len(versionList.Versions) != 2 || versionList.Versions[0].ID != "ver_roadmap_02" || versionList.Versions[1].ID != "ver_roadmap_01" {
		t.Fatalf("versions = %#v", versionList)
	}
	if versionList.Versions[0].ParentVersionID == nil || *versionList.Versions[0].ParentVersionID != "ver_roadmap_01" {
		t.Fatalf("latest parent = %#v", versionList.Versions[0].ParentVersionID)
	}

	versionResponse := requestJSON(t, mux, http.MethodGet, "/api/v1/vaults/"+vault.ID+"/files/file_roadmap/versions/ver_roadmap_01", authorization, nil)
	if versionResponse.Code != http.StatusOK {
		t.Fatalf("get version status = %d, body = %s", versionResponse.Code, versionResponse.Body.String())
	}
	var version model.FileVersion
	decodeResponse(t, versionResponse, &version)
	if version.ID != "ver_roadmap_01" || version.ContentHash != baseHash || version.Metadata.Format != "md" {
		t.Fatalf("version = %#v", version)
	}

	missingResponse := requestJSON(t, mux, http.MethodGet, "/api/v1/vaults/"+vault.ID+"/files/missing", authorization, nil)
	if missingResponse.Code != http.StatusNotFound {
		t.Fatalf("missing file status = %d, body = %s", missingResponse.Code, missingResponse.Body.String())
	}
	registerUser(t, mux, "bob@example.com", "bob password")
	bobToken := loginUser(t, mux, "bob@example.com", "bob password")
	for _, suffix := range []string{"", "/file_roadmap", "/file_roadmap/content", "/file_roadmap/versions", "/file_roadmap/versions/ver_roadmap_01"} {
		path := "/api/v1/vaults/" + vault.ID + "/files" + suffix
		if status := requestJSON(t, mux, http.MethodGet, path, "", nil).Code; status != http.StatusUnauthorized {
			t.Errorf("anonymous GET %s returned %d", path, status)
		}
		if status := requestJSON(t, mux, http.MethodGet, path, bobToken, nil).Code; status != http.StatusNotFound {
			t.Errorf("non-member GET %s returned %d", path, status)
		}
	}
	if _, err := database.ExecContext(ctx, `UPDATE files SET is_deleted = 1 WHERE id = 'file_roadmap'`); err != nil {
		t.Fatal(err)
	}
	deletedList := requestJSON(t, mux, http.MethodGet, "/api/v1/vaults/"+vault.ID+"/files", authorization, nil)
	decodeResponse(t, deletedList, &fileList)
	if deletedList.Code != http.StatusOK || fileList.Files == nil || len(fileList.Files) != 0 {
		t.Fatalf("file tree after soft deletion = %#v, status %d", fileList, deletedList.Code)
	}
	deletedContent := requestJSON(t, mux, http.MethodGet, "/api/v1/vaults/"+vault.ID+"/files/file_roadmap/content", authorization, nil)
	if deletedContent.Code != http.StatusNotFound {
		t.Fatalf("content after soft deletion returned %d", deletedContent.Code)
	}
}
