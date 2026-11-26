package httpapi

import (
	"archive/zip"
	"bytes"
	"context"

	"github.com/weifei/we-note/services/api/internal/blob"
	"github.com/weifei/we-note/services/api/internal/sqlite"
	"github.com/weifei/we-note/services/api/internal/store"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestLinkLifetimeScopeAndDownloadLimit(t *testing.T) {
	ctx := context.Background()
	db, e := sqlite.Open(ctx, ":memory:")
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	if e = db.Migrate(ctx); e != nil {
		t.Fatal(e)
	}
	enableOpenRegistration(t, db)
	blobs, e := blob.NewLocalStore(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	repo := store.NewRepository(db, blobs)
	mux := NewMux(repo)
	user := registerUser(t, mux, "share@test.invalid", "link password")
	v, e := repo.CreateVault(ctx, user.ID, "source")
	if e != nil {
		t.Fatal(e)
	}
	for _, p := range []string{"shared/note.txt", "other.txt"} {
		if _, e = repo.WriteFile(ctx, user.ID, v.ID, "", "create_file", p, store.FileWrite{Path: p, Content: []byte(p)}); e != nil {
			t.Fatal(e)
		}
	}
	q := store.LinkOptions{Vault: v.ID, Paths: []string{"shared/note.txt"}, Password: "link-only password", Expires: time.Now().Unix() + 60, Download: true}
	secret := "test-link-capability"
	q.TokenHash = strings.TrimPrefix(digest([]byte(secret)), "sha256:")
	for _, paths := range [][]string{{"shared/"}, {"shared"}, {"shared/note.txt", "other.txt"}} {
		batch := q
		batch.Paths = paths
		if _, err := repo.CreateLink(ctx, user.ID, "", batch); err == nil {
			t.Errorf("created batch link for %v", paths)
		}
	}
	link, e := repo.CreateLink(ctx, user.ID, "one", q)
	if e != nil {
		t.Fatal(e)
	}
	replay, e := repo.CreateLink(ctx, user.ID, "one", q)
	if e != nil || replay.ID != link.ID {
		t.Fatal("link replay", e)
	}
	// Simulate a link that was issued before download limits were retired.
	if _, e = db.Exec(`UPDATE share_links SET max_downloads=1 WHERE id=?`, link.ID); e != nil {
		t.Fatal(e)
	}
	path := "/s/" + link.ID + "/"
	exchange := func(p string) *httptest.ResponseRecorder {
		return requestJSON(t, mux, "POST", path+"session", "", map[string]string{"token": secret, "password": p})
	}
	if r := exchange("different"); r.Code != 403 {
		t.Fatal(r.Code)
	}
	r := exchange(q.Password)
	cookies := r.Result().Cookies()
	if r.Code != 204 || len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode || cookies[0].Path != path {
		t.Fatalf("session %d", r.Code)
	}
	get := func(method, tail string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path+tail, nil)
		r.AddCookie(cookies[0])
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	r = get("GET", "snapshot")
	if r.Code != 200 || strings.Contains(r.Body.String(), "other.txt") {
		t.Fatal(r.Code, r.Body.String())
	}
	var snap store.LinkSnapshot
	decodeResponse(t, r, &snap)
	if r = get("GET", "files/"+snap.Files[0].Version); r.Code != 200 || !strings.Contains(r.Body.String(), "shared/note.txt") {
		t.Fatal(r.Code)
	}
	if r = get("GET", "files/unlisted"); r.Code != 404 {
		t.Fatal(r.Code)
	}
	results := make(chan *httptest.ResponseRecorder, 2)
	for range 2 {
		go func() { results <- get("POST", "download") }()
	}
	var codes []int
	for range 2 {
		r = <-results
		codes = append(codes, r.Code)
		if r.Code == 200 {
			archive, e := zip.NewReader(bytes.NewReader(r.Body.Bytes()), int64(r.Body.Len()))
			if e != nil {
				t.Fatal(e)
			}
			f, e := archive.Open("notes/shared/note.txt")
			if e != nil {
				t.Fatal(e)
			}
			b, e := io.ReadAll(f)
			f.Close()
			if e != nil || string(b) != "shared/note.txt" {
				t.Fatal(string(b), e)
			}
		}
	}
	slices.Sort(codes)
	if !slices.Equal(codes, []int{200, 404}) || get("GET", "snapshot").Code != 404 {
		t.Fatal(codes)
	}
	for _, kind := range []string{"revoke", "expire", "session"} {
		q.Download = false
		q.Password = ""
		token := kind + secret
		q.TokenHash = strings.TrimPrefix(digest([]byte(token)), "sha256:")
		l, e := repo.CreateLink(ctx, user.ID, kind, q)
		if e != nil {
			t.Fatal(e)
		}
		session, e := repo.ExchangeLink(ctx, l.ID, token, "")
		if e != nil {
			t.Fatal(e)
		}
		if _, e = repo.LinkSnapshot(ctx, l.ID, session, true); e == nil {
			t.Fatal("disabled download")
		}
		switch kind {
		case "revoke":
			e = repo.RevokeLink(ctx, user.ID, l.ID)
		case "expire":
			_, e = db.Exec(`UPDATE share_links SET expires=unixepoch()-1 WHERE id=?`, l.ID)
		default:
			_, e = db.Exec(`UPDATE share_link_sessions SET expires=unixepoch()-1 WHERE link=?`, l.ID)
		}
		if e != nil {
			t.Fatal(e)
		}
		if _, e = repo.LinkSnapshot(ctx, l.ID, session, false); e == nil {
			t.Fatal(kind)
		}
	}
}
func TestSharedSourceDownload(t *testing.T) {
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
	repo := store.NewRepository(db, blobs)
	mux := NewMux(repo)
	u, err := repo.CreateUser(ctx, "source@test.invalid", "hash")
	if err != nil {
		t.Fatal(err)
	}
	v, err := repo.CreateVault(ctx, u.ID, "source")
	if err != nil {
		t.Fatal(err)
	}
	raw := []byte{0x50, 0x4b, 0, 255, 13, 10}
	const name = "图谱.xmind"
	file, err := repo.WriteFile(ctx, u.ID, v.ID, "", "create_file", "write", store.FileWrite{Path: "目录/" + name, Content: raw})
	if err != nil {
		t.Fatal(err)
	}
	for _, allow := range []bool{false, true} {
		secret := "source-token-" + strconv.FormatBool(allow)
		l, err := repo.CreateLink(ctx, u.ID, "", store.LinkOptions{Vault: v.ID, Paths: []string{"目录/" + name}, Expires: time.Now().Add(time.Hour).Unix(), TokenHash: strings.TrimPrefix(digest([]byte(secret)), "sha256:"), Download: allow})
		if err != nil {
			t.Fatal(err)
		}
		session, err := repo.ExchangeLink(ctx, l.ID, secret, "")
		if err != nil {
			t.Fatal(err)
		}
		download := func(version string) *httptest.ResponseRecorder {
			req := httptest.NewRequest("POST", "/s/"+l.ID+"/files/"+version+"/download", nil)
			req.AddCookie(&http.Cookie{Name: "wenote_share", Value: session})
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, req)
			return w
		}
		if !allow {
			if w := download(file.Version); w.Code != 403 {
				t.Fatalf("disabled source download: %d", w.Code)
			}
			continue
		}
		if w := download("unlisted"); w.Code != 404 {
			t.Fatal(w.Code)
		}
		w := download(file.Version)
		disposition, params, err := mime.ParseMediaType(w.Header().Get("Content-Disposition"))
		if err != nil || w.Code != 200 || disposition != "attachment" || params["filename"] != name || !bytes.Equal(w.Body.Bytes(), raw) {
			t.Fatalf("source: %d %v %v", w.Code, params, err)
		}
		if w = download(file.Version); w.Code != 200 {
			t.Fatalf("repeat download: %d", w.Code)
		}
		var downloads, events int
		if err := db.QueryRow(`SELECT downloads, (SELECT count(*) FROM audit_events WHERE object_id=? AND action='link.download') FROM share_links WHERE id=?`, l.ID, l.ID).Scan(&downloads, &events); err != nil || downloads != 0 || events != 2 {
			t.Fatalf("counter %d, download events %d: %v", downloads, events, err)
		}
	}
}
func TestEncryptedVaultRoutesRetired(t *testing.T) {
	m := testMux(t)
	registerUser(t, m, "alice@test.invalid", "alice password")
	token := loginUser(t, m, "alice@test.invalid", "alice password")
	for _, route := range []struct{ method, path string }{{"GET", "/api/v1/encrypted-vaults"}, {"GET", "/api/v1/encrypted-vaults/b4r8n2qy"}, {"PUT", "/api/v1/encrypted-vaults/b4r8n2qy"}} {
		if r := requestJSON(t, m, route.method, route.path, token, nil); r.Code != 404 {
			t.Errorf("%s %s: %d", route.method, route.path, r.Code)
		}
	}
}

func TestShareDurationsAndActiveList(t *testing.T) {
	ctx := context.Background()
	db, err := sqlite.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	enableOpenRegistration(t, db)
	blobs, err := blob.NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	repo := store.NewRepository(db, blobs)
	mux := NewMux(repo)
	owner := registerUser(t, mux, "duration@test.invalid", "link password")
	token := loginUser(t, mux, owner.Email, "link password")
	vault, err := repo.CreateVault(ctx, owner.ID, "work")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.WriteFile(ctx, owner.ID, vault.ID, "", "create_file", "write", store.FileWrite{Path: "note.md", Content: []byte("saved")}); err != nil {
		t.Fatal(err)
	}
	const endpoint = "/api/v1/share-links"
	capped := requestJSON(t, mux, "POST", endpoint, token, map[string]any{"vault_id": vault.ID, "paths": []string{"note.md"}, "token_hash": strings.TrimPrefix(digest([]byte("limited")), "sha256:"), "duration_days": 3, "max_downloads": 1})
	if capped.Code != 400 {
		t.Errorf("new capped link: %d", capped.Code)
	}
	ids := map[int]string{}
	for _, days := range []int{1, 3, 7, 0, 2} {
		secret := strconv.Itoa(days)
		before := time.Now().Unix()
		r := requestJSON(t, mux, "POST", endpoint, token, map[string]any{"vault_id": vault.ID, "paths": []string{"note.md"}, "token_hash": strings.TrimPrefix(digest([]byte(secret)), "sha256:"), "duration_days": days})
		if days == 2 {
			if r.Code != 400 {
				t.Fatal("unsupported duration", r.Code)
			}
			continue
		}
		if r.Code != 201 {
			t.Fatalf("%d days: %d %s", days, r.Code, r.Body.String())
		}
		if strings.Contains(r.Body.String(), `"downloads"`) || strings.Contains(r.Body.String(), `"max_downloads"`) {
			t.Error("create returned quota fields")
		}
		var link store.ShareLink
		decodeResponse(t, r, &link)
		ids[days] = link.ID
		if days == 0 {
			if link.Expires != 0 {
				t.Fatal(link.Expires)
			}
		} else if offset := link.Expires - int64(days)*86400; offset < before || offset > time.Now().Unix() {
			t.Fatal("wrong expiration", days, link.Expires)
		}
		session, err := repo.ExchangeLink(ctx, link.ID, secret, "")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := repo.LinkSnapshot(ctx, link.ID, session, false); err != nil {
			t.Fatal(err)
		}
	}
	if err := repo.RevokeLink(ctx, owner.ID, ids[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE share_links SET expires=unixepoch() WHERE id=?`, ids[1]); err != nil {
		t.Fatal(err)
	}
	for _, days := range []int{0, 1} {
		if _, err := repo.ExchangeLink(ctx, ids[days], strconv.Itoa(days), ""); err == nil {
			t.Fatal("inactive link opened", days)
		}
	}
	for _, query := range []string{"", "?vault_id=" + vault.ID} {
		r := requestJSON(t, mux, "GET", endpoint+query, token, nil)
		if strings.Contains(r.Body.String(), `"downloads"`) || strings.Contains(r.Body.String(), `"max_downloads"`) {
			t.Error("list returned quota fields")
		}
		var links []struct {
			ID    string
			Vault string `json:"vault_id"`
		}
		decodeResponse(t, r, &links)
		if len(links) != 2 || links[0].ID != ids[7] || links[1].ID != ids[3] || links[0].Vault != vault.ID {
			t.Fatalf("unexpected active list: %+v", links)
		}
	}
	other := registerUser(t, mux, "other-duration@test.invalid", "other password")
	otherToken := loginUser(t, mux, other.Email, "other password")
	r := requestJSON(t, mux, "GET", endpoint, otherToken, nil)
	var others []store.ShareLink
	decodeResponse(t, r, &others)
	if len(others) != 0 {
		t.Fatal(others)
	}
}
