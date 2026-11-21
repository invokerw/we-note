package httpapi

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/weifei/we-note/services/api/internal/blob"
	"github.com/weifei/we-note/services/api/internal/sqlite"
	"github.com/weifei/we-note/services/api/internal/store"
)

func TestKnowledgeAndFrozenExport(t *testing.T) {
	ctx := context.Background()
	db, err := sqlite.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if e := db.Migrate(ctx); e != nil {
		t.Fatal(e)
	}
	blobs, e := blob.NewLocalStore(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	repo := store.NewRepository(db, blobs)
	mux := NewMux(repo)
	u := registerUser(t, mux, "author@test.invalid", "long password")
	token := loginUser(t, mux, u.Email, "long password")
	other := registerUser(t, mux, "guest@test.invalid", "another password")
	guest := loginUser(t, mux, other.Email, "another password")
	v, e := repo.CreateVault(ctx, u.ID, "Notes")
	if e != nil {
		t.Fatal(e)
	}
	base := "/api/v1/vaults/" + v.ID
	original := []byte("\xef\xbb\xbf---\r\ntags: [日常]\r\nowner: Me\r\n---\r\n# 中文\r\n\r\n[[目标|别名]] #待办\r\n\r\n`[[不存在]]`\r\n\r\n```md\r\n#伪标签\r\n```\r\n")
	from, e := repo.WriteFile(ctx, u.ID, v.ID, "", "create_file", "", store.FileWrite{Path: "目录/首页.md", Content: original})
	if e != nil {
		t.Fatal(e)
	}
	target, e := repo.WriteFile(ctx, u.ID, v.ID, "", "create_file", "", store.FileWrite{Path: "目录/目标.md", Content: []byte("目的地")})
	if e != nil {
		t.Fatal(e)
	}
	get := func(path, auth string) *httptest.ResponseRecorder {
		return requestJSON(t, mux, "GET", base+path, auth, nil)
	}
	var hits []store.NoteHit
	decodeResponse(t, get("/search?q=中文&tag=待办", token), &hits)
	if len(hits) != 1 || hits[0].ID != from.FileID {
		t.Fatal(hits)
	}
	var meta store.Metadata
	decodeResponse(t, get("/outline?file_id="+from.FileID, token), &meta)
	if len(meta.Headings) != 1 || meta.Headings[0].Title != "中文" || len(meta.Tags) != 2 || meta.Properties["owner"] != "Me" || len(meta.Links) != 1 {
		t.Fatalf("metadata = %#v", meta)
	}
	decodeResponse(t, get("/links/backlinks?file_id="+target.FileID, token), &hits)
	if len(hits) != 1 || hits[0].ID != from.FileID {
		t.Fatal(hits)
	}
	body := []byte{0, 1, 2, 255}
	hash := fmt.Sprintf("sha256:%x", sha256.Sum256(body))
	a, e := repo.CreateAsset(ctx, u.ID, v.ID, "../../sample.bin", "application/octet-stream", hash, "", int64(len(body)))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = repo.CompleteUploadSession(ctx, v.ID, a.Upload, bytes.NewReader(body)); e != nil {
		t.Fatal(e)
	}
	for _, scope := range []string{"notes", "assets", "all"} {
		if _, e := repo.CreateExport(ctx, u.ID, v.ID, "key"+scope, scope); e != nil {
			t.Fatal(e)
		}
	}
	// A restarted worker must still use the revision pinned at enqueue time.
	if _, e := repo.WriteFile(ctx, u.ID, v.ID, from.FileID, "update_file_content", "", store.FileWrite{BaseVersion: from.Version, Content: []byte("changed")}); e != nil {
		t.Fatal(e)
	}
	repo = store.NewRepository(db, blobs)
	mux = NewMux(repo)
	repo.RunExports()
	var jobs []store.Export
	deadline := time.Now().Add(6 * time.Second)
	for {
		decodeResponse(t, get("/exports", token), &jobs)
		ready := len(jobs) == 3
		for _, j := range jobs {
			ready = ready && j.Status == "completed"
		}
		if ready {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal(jobs)
		}
		time.Sleep(5 * time.Millisecond)
	}
	for _, j := range jobs {
		res := get("/exports/"+j.ID+"/download", token)
		if res.Code != 200 {
			t.Fatal(res.Code, res.Body.String())
		}
		data := res.Body.Bytes()
		if fmt.Sprintf("sha256:%x", sha256.Sum256(data)) != j.Hash {
			t.Fatal("wrong ZIP hash")
		}
		z, e := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if e != nil {
			t.Fatal(e)
		}
		entries := map[string][]byte{}
		for _, f := range z.File {
			r, e := f.Open()
			if e != nil {
				t.Fatal(e)
			}
			b, e := io.ReadAll(r)
			r.Close()
			if e != nil {
				t.Fatal(e)
			}
			entries[f.Name] = b
		}
		file := entries["notes/目录/首页.md"]
		asset := entries["assets/"+a.ID+"/sample.bin"]
		if (j.Scope != "assets") != bytes.Equal(file, original) || (j.Scope != "notes") != bytes.Equal(asset, body) || !json.Valid(entries["manifest.json"]) {
			t.Fatalf("wrong %s archive", j.Scope)
		}
		if get("/exports/"+j.ID+"/download", guest).Code != 403 {
			t.Fatal("private export disclosed")
		}
		again, e := repo.CreateExport(ctx, u.ID, v.ID, "key"+j.Scope, j.Scope)
		if e != nil || again.ID != j.ID {
			t.Fatal("duplicate export")
		}
	}
	for _, route := range []string{"/assets", "/tags", "/search", "/outline?file_id=" + from.FileID, "/links/backlinks?file_id=" + target.FileID} {
		if get(route, guest).Code == 200 {
			t.Fatal("cross-vault read", route)
		}
	}
	decodeResponse(t, get("/search?tag=待办", token), &hits)
	if len(hits) != 0 {
		t.Fatal("stale tag")
	}
	decodeResponse(t, get("/links/backlinks?file_id="+target.FileID, token), &hits)
	if len(hits) != 0 {
		t.Fatal("stale link")
	}
}
