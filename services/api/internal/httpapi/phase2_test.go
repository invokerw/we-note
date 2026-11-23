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
	"strings"
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
	enableOpenRegistration(t, db)
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
	original = append(original, []byte("\r\n![sample]("+a.URL+")\r\n")...)
	from, e = repo.WriteFile(ctx, u.ID, v.ID, from.FileID, "update_file_content", "", store.FileWrite{BaseVersion: from.Version, Content: original})
	if e != nil {
		t.Fatal(e)
	}
	for _, opts := range []store.ExportOptions{{Scope: "notes", Mode: "portable"}, {Scope: "all", Mode: "unknown"}} {
		res := requestJSON(t, mux, "POST", base+"/exports", token, opts)
		if res.Code != 400 {
			t.Fatalf("invalid options: %d", res.Code)
		}
	}
	portable := store.ExportOptions{Scope: "all", Mode: "portable"}
	if _, e = repo.CreateExport(ctx, u.ID, v.ID, "portable", portable); e != nil {
		t.Fatal(e)
	}
	if _, e = repo.CreateExport(ctx, u.ID, v.ID, "portable", store.ExportOptions{Scope: "all"}); e == nil {
		t.Fatal("accepted same key with changed link mode")
	}
	for _, scope := range []string{"notes", "assets", "all"} {
		if _, e := repo.CreateExport(ctx, u.ID, v.ID, "key"+scope, store.ExportOptions{Scope: scope}); e != nil {
			t.Fatal(e)
		}
	}
	// Reproduce a pending job from the previous release.
	if _, e = db.Exec(`UPDATE export_jobs SET snapshot=json_remove(snapshot,'$.mode','$.layout') WHERE operation_key='keyall'`); e != nil {
		t.Fatal(e)
	}
	if e = repo.DeleteAsset(ctx, u.ID, v.ID, a.ID); e != nil {
		t.Fatal(e)
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
		ready := len(jobs) == 4
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
		want := original
		if j.Mode == "portable" {
			want = bytes.Replace(original, []byte(a.URL), []byte("../../assets/"+a.ID+"/sample.bin"), 1)
		} else if j.Mode != "online" {
			t.Fatalf("unexpected mode %q", j.Mode)
		}
		if (j.Scope != "assets") != bytes.Equal(file, want) || (j.Scope != "notes") != bytes.Equal(asset, body) || !json.Valid(entries["manifest.json"]) {
			t.Fatalf("wrong %s archive", j.Scope)
		}
		if get("/exports/"+j.ID+"/download", guest).Code != 403 {
			t.Fatal("private export disclosed")
		}
		var manifest struct {
			Layout, Mode string
			Files        []struct {
				Path   string
				Hash   string `json:"content_hash"`
				Source string `json:"source_content_hash"`
				Size   int    `json:"content_size"`
			}
		}
		if e = json.Unmarshal(entries["manifest.json"], &manifest); e != nil || manifest.Layout != "notes-assets" || manifest.Mode != j.Mode {
			t.Fatal(manifest, e)
		}
		for _, f := range manifest.Files {
			b := entries[f.Path]
			if f.Size != len(b) || f.Hash != digest(b) {
				t.Fatal("manifest bytes", f.Path)
			}
			if j.Mode == "portable" && f.Path == "notes/目录/首页.md" && f.Source != digest(original) {
				t.Fatal("source hash")
			}
		}
		checks := strings.Split(strings.TrimSuffix(string(entries["checksums.sha256"]), "\n"), "\n")
		verified := map[string]bool{}
		for _, line := range checks {
			hash, p, ok := strings.Cut(line, "  ")
			b, found := entries[p]
			if !ok || !found || verified[p] || "sha256:"+hash != digest(b) || p == "checksums.sha256" {
				t.Fatal("bad checksum", line)
			}
			verified[p] = true
		}
		if len(verified) != len(entries)-1 {
			t.Fatal("incomplete checksum file")
		}
		key := "key" + j.Scope
		if j.Mode == "portable" {
			key = "portable"
		}
		again, e := repo.CreateExport(ctx, u.ID, v.ID, key, store.ExportOptions{Scope: j.Scope, Mode: j.Mode})
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
