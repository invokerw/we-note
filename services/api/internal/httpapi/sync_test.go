package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/weifei/we-note/services/api/internal/blob"
	"github.com/weifei/we-note/services/api/internal/model"
	"github.com/weifei/we-note/services/api/internal/password"
	"github.com/weifei/we-note/services/api/internal/sqlite"
	"github.com/weifei/we-note/services/api/internal/store"
)

func TestSyncUploadSubmitPullReplayAndManifest(t *testing.T) {
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

	passwordHash, err := password.Hash("alice password")
	if err != nil {
		t.Fatal(err)
	}
	user, err := repository.CreateUser(ctx, "alice@example.com", passwordHash)
	if err != nil {
		t.Fatal(err)
	}
	vault, err := repository.CreateVault(ctx, user.ID, "Alice Notes")
	if err != nil {
		t.Fatal(err)
	}
	device, err := repository.CreateDevice(ctx, user.ID, "Alice Mac", "public-key")
	if err != nil {
		t.Fatal(err)
	}
	session, err := repository.CreateSession(ctx, user.ID, 30*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	authorization := session.TokenType + " " + session.AccessToken

	base := []byte("# Roadmap v1\n")
	baseHash := digest(base)
	ns, err := blob.VaultNamespace(user.ID, vault.ID)
	if err != nil {
		t.Fatal(err)
	}
	key, err := blobStore.Put(ctx, ns, baseHash, int64(len(base)), bytes.NewReader(base))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `
		INSERT INTO blobs(id, vault_id, content_hash, content_size, storage_key, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
		`, "blob_"+baseHash[len("sha256:"):], vault.ID, baseHash, len(base), key, "2026-11-21T09:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `
		INSERT INTO files(id, vault_id, path, format, current_version_id, current_content_hash, current_content_size, current_blob_id, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, "file_roadmap", vault.ID, "projects/roadmap.md", "md", "ver_roadmap_01", baseHash, len(base), "blob_"+baseHash[len("sha256:"):], "2026-11-21T09:00:00Z", "2026-11-21T09:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `
		INSERT INTO file_versions(id, vault_id, file_id, blob_id, content_hash, content_size, created_by_device_id, metadata_format, metadata_line_ending, vault_revision, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, "ver_roadmap_01", vault.ID, "file_roadmap", "blob_"+baseHash[len("sha256:"):], baseHash, len(base), device.ID, "md", "lf", 1, "2026-11-21T09:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `
		INSERT INTO changes(id, vault_id, vault_revision, file_id, version_id, operation_id, operation, path, device_id, client_timestamp, content_hash, content_size, request_id, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, "chg_000001", vault.ID, 1, "file_roadmap", "ver_roadmap_01", "op_create_roadmap", "create_file", "projects/roadmap.md", device.ID, "2026-11-21T09:00:00Z", baseHash, len(base), "req_000001", "2026-11-21T09:00:00Z"); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE vaults SET current_revision = 1, request_sequence = 1 WHERE id = ?`, vault.ID); err != nil {
		t.Fatal(err)
	}

	updated := []byte("# Roadmap v2\n\n- sync\n")
	updatedHash := digest(updated)
	createdUpload := requestJSONWithBody(t, mux, http.MethodPost, "/api/v1/vaults/"+vault.ID+"/sync/upload-sessions", authorization, map[string]any{
		"content_hash": updatedHash,
		"content_size": len(updated),
	})
	if createdUpload.Code != http.StatusCreated {
		t.Fatalf("create upload status = %d, body = %s", createdUpload.Code, createdUpload.Body.String())
	}
	var upload model.UploadSession
	decodeResponse(t, createdUpload, &upload)
	completedUpload := requestRaw(t, mux, http.MethodPost, "/api/v1/vaults/"+vault.ID+"/sync/upload-sessions/"+upload.ID+"/complete", authorization, updated)
	if completedUpload.Code != http.StatusOK {
		t.Fatalf("complete upload status = %d, body = %s", completedUpload.Code, completedUpload.Body.String())
	}

	requestBody := map[string]any{
		"mode":              "submit",
		"vault_id":          vault.ID,
		"device_id":         device.ID,
		"operation_id":      "op_roadmap_v2",
		"file_id":           "file_roadmap",
		"operation":         "update_file_content",
		"path":              "projects/roadmap.md",
		"base_revision":     1,
		"base_version_id":   "ver_roadmap_01",
		"base_content_hash": baseHash,
		"blob_reference":    upload.ID,
		"content_hash":      updatedHash,
		"content_size":      len(updated),
		"client_timestamp":  "2026-11-21T09:05:00Z",
		"metadata":          map[string]any{"format": "md", "line_ending": "lf"},
	}
	response := requestJSONWithBody(t, mux, http.MethodPost, "/api/v1/vaults/"+vault.ID+"/sync/changes", authorization, requestBody)
	if response.Code != http.StatusOK {
		t.Fatalf("submit status = %d, body = %s", response.Code, response.Body.String())
	}
	var submitted map[string]any
	decodeResponse(t, response, &submitted)
	if submitted["vault_revision"] != float64(2) || submitted["replayed"] != false {
		t.Fatalf("submit response = %#v", submitted)
	}

	pull := requestJSONWithBody(t, mux, http.MethodPost, "/api/v1/vaults/"+vault.ID+"/sync/changes", authorization, map[string]any{
		"mode": "pull", "vault_id": vault.ID, "device_id": device.ID, "last_server_revision": 1,
	})
	if pull.Code != http.StatusOK {
		t.Fatalf("pull status = %d, body = %s", pull.Code, pull.Body.String())
	}
	var pulled map[string]any
	decodeResponse(t, pull, &pulled)
	changes := pulled["changes"].([]any)
	if len(changes) != 1 || changes[0].(map[string]any)["operation_id"] != "op_roadmap_v2" {
		t.Fatalf("pull changes = %#v", changes)
	}

	replay := requestJSONWithBody(t, mux, http.MethodPost, "/api/v1/vaults/"+vault.ID+"/sync/changes", authorization, requestBody)
	if replay.Code != http.StatusOK {
		t.Fatalf("replay status = %d, body = %s", replay.Code, replay.Body.String())
	}
	var replayed map[string]any
	decodeResponse(t, replay, &replayed)
	if replayed["replayed"] != true || replayed["original_request_id"] != submitted["request_id"] {
		t.Fatalf("replay response = %#v", replayed)
	}

	staleRequestBody := make(map[string]any, len(requestBody))
	for key, value := range requestBody {
		staleRequestBody[key] = value
	}
	staleRequestBody["operation_id"] = "op_stale_roadmap"
	staleRequestBody["base_revision"] = 2
	stale := requestJSONWithBody(t, mux, http.MethodPost, "/api/v1/vaults/"+vault.ID+"/sync/changes", authorization, staleRequestBody)
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale base status = %d, body = %s", stale.Code, stale.Body.String())
	}
	var staleResult map[string]any
	decodeResponse(t, stale, &staleResult)
	if staleResult["code"] != "FILE_VERSION_CONFLICT" {
		t.Fatalf("stale base response = %#v", staleResult)
	}
	var versionCount, changeCount int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM file_versions WHERE vault_id = ?`, vault.ID).Scan(&versionCount); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM changes WHERE vault_id = ?`, vault.ID).Scan(&changeCount); err != nil {
		t.Fatal(err)
	}
	if versionCount != 2 || changeCount != 2 {
		t.Fatalf("stale base mutated history: versions=%d changes=%d", versionCount, changeCount)
	}

	wrongMethod := httptest.NewRequest(http.MethodGet, "/api/v1/vaults/"+vault.ID+"/sync/changes", nil)
	wrongMethodResponse := httptest.NewRecorder()
	mux.ServeHTTP(wrongMethodResponse, wrongMethod)
	if wrongMethodResponse.Code != http.StatusMethodNotAllowed {
		t.Fatalf("wrong method status = %d, want %d", wrongMethodResponse.Code, http.StatusMethodNotAllowed)
	}
	var wrongMethodResult map[string]any
	decodeResponse(t, wrongMethodResponse, &wrongMethodResult)
	if wrongMethodResult["code"] != "METHOD_NOT_ALLOWED" || wrongMethodResult["allowed_method"] != "POST" {
		t.Fatalf("wrong method response = %#v", wrongMethodResult)
	}

	manifestRequest := httptest.NewRequest(http.MethodGet, "/api/v1/vaults/"+vault.ID+"/sync/manifest", nil)
	manifestRequest.Header.Set("Authorization", authorization)
	manifestRequest.Header.Set("X-Device-Id", device.ID)
	manifestResponse := httptest.NewRecorder()
	mux.ServeHTTP(manifestResponse, manifestRequest)
	if manifestResponse.Code != http.StatusOK {
		t.Fatalf("manifest status = %d, body = %s", manifestResponse.Code, manifestResponse.Body.String())
	}
	var manifest struct {
		SnapshotRevision int64                `json:"snapshot_revision"`
		Files            []model.ManifestFile `json:"files"`
	}
	decodeResponse(t, manifestResponse, &manifest)
	if manifest.SnapshotRevision != 2 || len(manifest.Files) != 1 || manifest.Files[0].CurrentContentHash != updatedHash {
		t.Fatalf("manifest = %#v", manifest)
	}
}

func digest(content []byte) string {
	hash := sha256.Sum256(content)
	return "sha256:" + hex.EncodeToString(hash[:])
}

func requestJSONWithBody(t *testing.T, handler http.Handler, method, path, authorization string, payload any) *httptest.ResponseRecorder {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(encoded))
	request.Header.Set("Authorization", authorization)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func requestRaw(t *testing.T, handler http.Handler, method, path, authorization string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	request.Header.Set("Authorization", authorization)
	request.Header.Set("Content-Type", "application/octet-stream")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
