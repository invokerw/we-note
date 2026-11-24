package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/weifei/we-note/services/api/internal/blob"
	"github.com/weifei/we-note/services/api/internal/sqlite"
	"github.com/weifei/we-note/services/api/internal/store"
)

func TestMultipartResumeAcrossRestart(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	filename := filepath.Join(dir, "db")
	open := func() (*sqlite.Database, *store.Repository) {
		db, err := sqlite.Open(ctx, filename)
		if err != nil {
			t.Fatal(err)
		}
		if err = db.Migrate(ctx); err != nil {
			t.Fatal(err)
		}
		enableOpenRegistration(t, db)
		b, err := blob.NewLocalStore(filepath.Join(dir, "blobs"))
		if err != nil {
			t.Fatal(err)
		}
		return db, store.NewRepository(db, b)
	}
	db, repo := open()
	defer func() { db.Close() }()
	mux := NewMux(repo)
	alice := registerUser(t, mux, "parts@test.invalid", "long password")
	token := loginUser(t, mux, alice.Email, "long password")
	bob := registerUser(t, mux, "other@test.invalid", "long password")
	other := loginUser(t, mux, bob.Email, "long password")
	v, err := repo.CreateVault(ctx, alice.ID, "v")
	if err != nil {
		t.Fatal(err)
	}
	big := bytes.Repeat([]byte("x"), store.PartSize)
	last := []byte("tail")
	data := append(bytes.Clone(big), last...)
	hash := func(b []byte) string { return fmt.Sprintf("sha256:%x", sha256.Sum256(b)) }
	asset, err := repo.CreateAsset(ctx, alice.ID, v.ID, "big.dat", "application/octet-stream", hash(data), "stable", int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	base := "/api/v1/vaults/" + v.ID + "/assets/" + asset.ID
	part := func(number int, body []byte, rng, sum, auth string, code int) {
		t.Helper()
		r := httptest.NewRequest("PUT", fmt.Sprintf("%s/parts/%d", base, number), bytes.NewReader(body))
		r.Header.Set("Authorization", auth)
		r.Header.Set("Content-Range", rng)
		r.Header.Set("X-Part-Hash", sum)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != code {
			t.Fatalf("part %d: %d %s", number, w.Code, w.Body.String())
		}
	}
	firstRange := fmt.Sprintf("bytes 0-%d/%d", len(big)-1, len(data))
	lastRange := fmt.Sprintf("bytes %d-%d/%d", len(big), len(data)-1, len(data))
	part(1, last, lastRange, hash(last), other, 404)
	part(1, last, "", hash(last), token, 400)
	part(1, last, lastRange, hash(big), token, 400)
	part(1, last, lastRange, hash(last), token, 204)
	part(1, last, lastRange, hash(last), token, 204)
	part(1, []byte("oops"), lastRange, hash([]byte("oops")), token, 409)
	assemble := func(code int) {
		t.Helper()
		w := requestJSON(t, mux, "POST", base+"/assemble", token, nil)
		if w.Code != code {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	assemble(409)
	if w := requestJSON(t, mux, "GET", "/assets/"+asset.ID, token, nil); w.Code != 404 {
		t.Fatal("partial asset visible")
	}
	db.Close()
	db, repo = open()
	mux = NewMux(repo)
	parts := requestJSON(t, mux, "GET", base+"/parts", token, nil)
	var state struct {
		Parts []int `json:"completed_parts"`
	}
	decodeResponse(t, parts, &state)
	if len(state.Parts) != 1 || state.Parts[0] != 1 {
		t.Fatalf("resume: %+v", state)
	}
	part(0, big, firstRange, hash(big), token, 204)
	assemble(204)
	assemble(204)
	w := requestJSON(t, mux, http.MethodGet, "/assets/"+asset.ID, token, nil)
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), data) {
		t.Fatal("wrong assembled bytes", w.Code)
	}
	wantURL := "https://localhost:8443/assets/" + asset.CreatedAt.UTC().Format("2006/01/02") + "/" + strings.TrimPrefix(asset.Hash, "sha256:")
	if asset.URL != wantURL {
		t.Fatalf("asset URL = %q, want %q", asset.URL, wantURL)
	}
	newURL := strings.TrimPrefix(asset.URL, "https://localhost:8443")
	if w = requestJSON(t, mux, http.MethodGet, newURL, token, nil); w.Code != 200 || !bytes.Equal(w.Body.Bytes(), data) {
		t.Fatalf("wrong date-hash URL bytes: %d %q", w.Code, w.Body.Bytes())
	}
	var storageKey string
	if err := db.QueryRow(`SELECT storage_key FROM upload_sessions WHERE id=?`, asset.Upload).Scan(&storageKey); err != nil {
		t.Fatal(err)
	}
	digest := strings.TrimPrefix(asset.Hash, "sha256:")
	wantKey := filepath.Join("users", alice.ID, "vaults", v.ID, asset.CreatedAt.UTC().Format("2006/01/02"), digest)
	if storageKey != wantKey {
		t.Fatalf("storage key = %q, want %q", storageKey, wantKey)
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM upload_parts`).Scan(&n); err != nil || n != 0 {
		t.Fatal("staging leak", n, err)
	}

	// Expired staging can be restarted under the same asset ID. A verified part
	// from the wrong file must still fail whole-file verification.
	broken, err := repo.CreateAsset(ctx, alice.ID, v.ID, "retry.dat", "application/octet-stream", hash(data), "retry", int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	base = "/api/v1/vaults/" + v.ID + "/assets/" + broken.ID
	part(0, big, firstRange, hash(big), token, 204)
	wrong := []byte("oops")
	part(1, wrong, lastRange, hash(wrong), token, 204)
	assemble(409)
	if _, err = db.Exec(`UPDATE upload_part_leases SET expires=0 WHERE upload_id=?`, broken.Upload); err != nil {
		t.Fatal(err)
	}
	decodeResponse(t, requestJSON(t, mux, "GET", base+"/parts", token, nil), &state)
	if len(state.Parts) != 0 {
		t.Fatal("expired parts listed")
	}
	part(1, last, lastRange, hash(last), token, 204)
	assemble(409)
	part(0, big, firstRange, hash(big), token, 204)
	assemble(204)
}
