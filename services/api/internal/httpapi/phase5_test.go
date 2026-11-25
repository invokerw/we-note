package httpapi

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"github.com/weifei/we-note/services/api/internal/blob"
	"github.com/weifei/we-note/services/api/internal/sqlite"
	"github.com/weifei/we-note/services/api/internal/store"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
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
	q := store.LinkOptions{Vault: v.ID, Paths: []string{"shared/"}, Password: "link-only password", Expires: time.Now().Unix() + 60, MaxDownloads: 1, Download: true}
	secret := "test-link-capability"
	q.TokenHash = strings.TrimPrefix(digest([]byte(secret)), "sha256:")
	link, e := repo.CreateLink(ctx, user.ID, "one", q)
	if e != nil {
		t.Fatal(e)
	}
	replay, e := repo.CreateLink(ctx, user.ID, "one", q)
	if e != nil || replay.ID != link.ID {
		t.Fatal("link replay", e)
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
		q.MaxDownloads = 0
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
func TestEncryptedEnvelopeIsolationAndRevision(t *testing.T) {
	m := testMux(t)
	registerUser(t, m, "alice@test.invalid", "alice password")
	registerUser(t, m, "bob@test.invalid", "bob password")
	a := loginUser(t, m, "alice@test.invalid", "alice password")
	b := loginUser(t, m, "bob@test.invalid", "bob password")
	const id = "b4r8n2qy"
	path := "/api/v1/encrypted-vaults/" + id
	q := store.Envelope{IV: make([]byte, 12), Ciphertext: bytes.Repeat([]byte{3}, 50)}
	put := func(token string, want int) {
		r := requestJSON(t, m, "PUT", path, token, q)
		if r.Code != want {
			t.Fatalf("save %d: %s", r.Code, r.Body.String())
		}
	}
	put(a, 200)
	put(a, 200)
	q.Ciphertext[0]++
	put(a, 409)
	q.Base = 1
	q.IV[0]++
	put(b, 409)
	put(a, 200)
	for _, p := range []string{path, "/api/v1/vaults/" + id + "/files"} {
		if r := requestJSON(t, m, "GET", p, b, nil); r.Code != 404 {
			t.Fatalf("%s %d", p, r.Code)
		}
	}
	r := requestJSON(t, m, "GET", "/api/v1/encrypted-vaults", b, nil)
	if strings.TrimSpace(r.Body.String()) != "[]" {
		t.Fatal(r.Body.String())
	}
	r = requestJSON(t, m, "GET", "/api/v1/audit", b, nil)
	var events []store.AuditEvent
	if json.Unmarshal(r.Body.Bytes(), &events) != nil || len(events) == 0 || strings.Contains(r.Body.String(), id) {
		t.Fatal("audit isolation", r.Body.String())
	}
	r = requestJSON(t, m, "GET", path, a, nil)
	var saved store.EncryptedVault
	decodeResponse(t, r, &saved)
	if saved.Revision != 2 || !bytes.Equal(saved.Ciphertext, q.Ciphertext) {
		t.Fatal(saved.Revision)
	}
}
