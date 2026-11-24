package httpapi

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/weifei/we-note/services/api/internal/blob"
	"github.com/weifei/we-note/services/api/internal/sqlite"
	"github.com/weifei/we-note/services/api/internal/store"
)

func TestStorageLocationCatalog(t *testing.T) {
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
	bs, err := blob.NewLocalStore(filepath.Join(root, "original"))
	if err != nil {
		t.Fatal(err)
	}
	repo := store.NewRepository(db, bs)
	mux := NewMux(repo)
	t.Setenv("WENOTE_SETUP_TOKEN", "setup")
	owner := "owner@test.example"
	pw := "owner password"
	if got := requestJSON(t, mux, "POST", "/api/v1/admin/bootstrap", "", map[string]string{"email": owner, "password": pw, "setup_token": "setup"}); got.Code != 201 {
		t.Fatal(got.Body.String())
	}
	token := loginUser(t, mux, owner, pw)
	path := "/api/v1/admin/storage-catalog"
	type profile struct{ ID, Name, Kind, Directory string }
	var catalog struct {
		Profiles       []profile
		Online, Backup string
		Revision       int
	}
	if got := requestJSON(t, mux, "GET", path, "", nil); got.Code != http.StatusUnauthorized {
		t.Fatalf("expected admin-only catalog, got %d", got.Code)
	}
	call := func(method, suffix string, body map[string]any, code int) {
		t.Helper()
		if body != nil {
			body["revision"] = catalog.Revision
		}
		res := requestJSON(t, mux, method, path+suffix, token, body)
		if res.Code != code {
			t.Fatalf("%s %s: %d %s", method, suffix, res.Code, res.Body.String())
		}
		if code == 200 {
			decodeResponse(t, res, &catalog)
		}
	}
	legacy := filepath.Join(root, "legacy")
	if _, err = db.Exec(`UPDATE system_settings SET value=? WHERE key='backup_root'`, legacy); err != nil {
		t.Fatal(err)
	}
	call("GET", "", nil, 200)
	if len(catalog.Profiles) != 2 || catalog.Profiles[1].Directory != legacy {
		t.Fatal("missing existing settings", catalog)
	}
	origOnline, origBackup := catalog.Online, catalog.Backup
	dir := filepath.Join(root, "shared")
	input := map[string]any{"name": "NAS", "kind": "local", "directory": dir}
	call("POST", "/profiles", input, 200)
	id := catalog.Profiles[2].ID
	if catalog.Online != origOnline || catalog.Backup != origBackup {
		t.Fatal("adding changed active storage")
	}
	call("PUT", "/bindings/backup", map[string]any{"profile_id": id}, 200)
	if catalog.Online != origOnline || catalog.Backup != id {
		t.Fatal(catalog)
	}
	call("PUT", "/bindings/online", map[string]any{"profile_id": id}, 200)
	dir2 := filepath.Join(root, "second")
	input["directory"] = dir2
	input["name"] = "新 NAS"
	call("PUT", "/profiles/"+id, input, 200)
	for _, scope := range []string{"backup", "online"} {
		cfg, err := repo.StorageSettings(ctx, scope)
		if err != nil || cfg.Directory != dir2 {
			t.Fatalf("%s did not follow shared profile: %+v %v", scope, cfg, err)
		}
	}
	badPath := filepath.Join(root, "file")
	if err = os.WriteFile(badPath, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	input["directory"] = badPath
	call("PUT", "/profiles/"+id, input, 400)
	call("GET", "", nil, 200)
	if catalog.Profiles[2].Directory != dir2 {
		t.Fatal("failed edit was published")
	}
	call("DELETE", "/profiles/"+id, map[string]any{}, 409)
	oldRevision := catalog.Revision
	call("POST", "/profiles", map[string]any{"name": "临时盘", "kind": "local", "directory": filepath.Join(root, "other")}, 200)
	last := catalog.Profiles[3].ID
	stale := requestJSON(t, mux, "PUT", path+"/bindings/backup", token, map[string]any{"revision": oldRevision, "profile_id": last})
	if stale.Code != 409 {
		t.Fatal("stale edit accepted", stale.Code)
	}
	call("DELETE", "/profiles/"+last, map[string]any{}, 200)
	clientRoot := filepath.Join(root, "legacy-client")
	user, _, err := repo.UserByEmail(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	if err = repo.SaveAdminSettings(ctx, user.ID, map[string]string{"backup_root": clientRoot}, store.SMTPConfig{}); err != nil {
		t.Fatal(err)
	}
	call("GET", "", nil, 200)
	if catalog.Online != id || catalog.Backup == id || catalog.Profiles[len(catalog.Profiles)-1].Directory != clientRoot {
		t.Fatalf("legacy client changed shared location: %+v", catalog)
	}

}
