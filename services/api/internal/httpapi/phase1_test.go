package httpapi

import (
	"context"
	"github.com/weifei/we-note/services/api/internal/blob"
	"github.com/weifei/we-note/services/api/internal/sqlite"
	"github.com/weifei/we-note/services/api/internal/store"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestSnapshotImportIsAtomicIsolatedAndReplayable(t *testing.T) {
	ctx := context.Background()
	db, err := sqlite.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	enableOpenRegistration(t, db)
	blobs, err := blob.NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	repo := store.NewRepository(db, blobs)
	mux := NewMux(repo)
	alice := registerUser(t, mux, "alice@test.invalid", "alice password")
	bob := registerUser(t, mux, "bob@test.invalid", "bob password")
	a, err := repo.CreateVault(ctx, alice.ID, "Source")
	if err != nil {
		t.Fatal(err)
	}
	b, err := repo.CreateVault(ctx, bob.ID, "Target")
	if err != nil {
		t.Fatal(err)
	}
	const pathA = "folder/a.md"
	const pathB = "folder/b.md"
	for _, p := range []string{pathA, pathB} {
		input := store.FileWrite{Path: p, Content: []byte("same bytes")}
		first, err := repo.WriteFile(ctx, alice.ID, a.ID, "", "create_file", p, input)
		if err != nil {
			t.Fatal(err)
		}
		again, err := repo.WriteFile(ctx, alice.ID, a.ID, "", "create_file", p, input)
		if err != nil || !reflect.DeepEqual(again, first) {
			t.Fatalf("create replay = %v %v", again, err)
		}
	}
	share, err := repo.ShareFiles(ctx, alice.ID, "share-key", store.ShareRequest{Vault: a.ID, Recipient: bob.Email, Paths: []string{"folder/"}})
	if err != nil {
		t.Fatal(err)
	}
	existing, err := repo.WriteFile(ctx, bob.ID, b.ID, "", "create_file", "local", store.FileWrite{Path: pathB, Content: []byte("same bytes")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.AcceptShare(ctx, alice.ID, share.ID, b.ID, ""); err == nil {
		t.Fatal("sender accepted as recipient")
	}
	if _, err := repo.AcceptShare(ctx, bob.ID, share.ID, b.ID, ""); err == nil {
		t.Fatal("expected path collision")
	}
	files, err := repo.ListFiles(ctx, b.ID)
	if err != nil || len(files) != 1 {
		t.Fatalf("partial import = %v %v", files, err)
	}
	if _, err := repo.WriteFile(ctx, bob.ID, b.ID, existing.FileID, "delete_file", "trash", store.FileWrite{BaseVersion: existing.Version}); err != nil {
		t.Fatal(err)
	}
	first, err := repo.AcceptShare(ctx, bob.ID, share.ID, b.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	again, err := repo.AcceptShare(ctx, bob.ID, share.ID, b.ID, "")
	if err != nil || !reflect.DeepEqual(first, again) {
		t.Fatal("import replay", err)
	}
	files, err = repo.ListFiles(ctx, b.ID)
	if err != nil || len(files) != 2 {
		t.Fatal("imported count", len(files), err)
	}
	if _, err := repo.WriteFile(ctx, bob.ID, b.ID, files[0].ID, "update_file_content", "badasset", store.FileWrite{BaseVersion: *files[0].CurrentVersionID, Content: []byte("![](https://localhost:8443/assets/asset_missing)")}); err == nil {
		t.Fatal("unavailable asset accepted")
	}
}

func TestRefreshRotationAndRevocation(t *testing.T) {
	mux := testMux(t)
	registerUser(t, mux, "s@test.invalid", "long password")
	response := requestJSON(t, mux, http.MethodPost, "/api/v1/auth/login", "", map[string]string{"email": "s@test.invalid", "password": "long password"})
	var first, second struct {
		Access  string `json:"access_token"`
		Refresh string `json:"refresh_token"`
	}
	decodeResponse(t, response, &first)
	renew := func(token string) *httptest.ResponseRecorder {
		return requestJSON(t, mux, http.MethodPost, "/api/v1/auth/refresh", "", map[string]string{"refresh_token": token})
	}
	response = renew(first.Refresh)
	decodeResponse(t, response, &second)
	if response.Code != 200 || second.Access == first.Access || second.Refresh == first.Refresh || renew(first.Refresh).Code != 401 {
		t.Fatal("refresh rotation failed")
	}
	if requestJSON(t, mux, http.MethodPost, "/api/v1/auth/logout", "Bearer "+second.Access, nil).Code != 204 || renew(second.Refresh).Code != 401 {
		t.Fatal("revoked session renewed")
	}
}
