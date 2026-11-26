package store

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/weifei/we-note/services/api/internal/blob"
	"github.com/weifei/we-note/services/api/internal/sqlite"
)

func TestNoteHistoryRetention(t *testing.T) {
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
	storage, err := blob.NewLocalStore(root)
	if err != nil {
		t.Fatal(err)
	}
	r := NewRepository(db, storage)
	u, err := r.CreateUser(ctx, "history@test.invalid", "hash")
	if err != nil {
		t.Fatal(err)
	}
	vault, err := r.CreateVault(ctx, u.ID, "notes")
	if err != nil {
		t.Fatal(err)
	}
	var current FileResult
	var versions []FileResult
	var link ShareLink
	// Several saves around the cutoff, two on a previous day and a burst today.
	days := []int{40, 30, 29, 29, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}
	now := time.Now().In(time.FixedZone("UTC+8", 8*3600))
	noon := time.Date(now.Year(), now.Month(), now.Day(), 12, 0, 0, 0, now.Location())
	for i, daysAgo := range days {
		op := "update_file_content"
		if i == 0 {
			op = "create_file"
		}
		current, err = r.WriteFile(ctx, u.ID, vault.ID, current.FileID, op, "", FileWrite{Path: "history.md", BaseVersion: current.Version, Content: []byte(fmt.Sprintf("version %d", i))})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = db.Exec(`UPDATE file_versions SET created_at=? WHERE id=?`, formatTime(noon.AddDate(0, 0, -daysAgo)), current.Version); err != nil {
			t.Fatal(err)
		}
		versions = append(versions, current)
		if i == 0 {
			link, err = r.CreateLink(ctx, u.ID, "", LinkOptions{Vault: vault.ID, TokenHash: secretHash("public-history"), DurationDays: new(int), Paths: []string{"history.md"}, Download: true})
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	check := func() {
		t.Helper()
		list, err := r.ListFileVersions(ctx, vault.ID, current.FileID)
		if err != nil {
			t.Fatal(err)
		}
		want := []int{18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 5, 3}
		if len(list) != len(want) {
			t.Fatalf("listed %d versions, want %d", len(list), len(want))
		}
		for i, idx := range want {
			if list[i].ID != versions[idx].Version {
				t.Fatalf("entry %d = %s, want %d", i, list[i].ID, idx)
			}
		}
	}
	check()
	if err = r.PublishVaults(ctx); err != nil {
		t.Fatal(err)
	}
	check()
	// Compaction can drop the parent bytes, but keeps the creation metadata of a retained version.
	survivor, err := r.FileVersion(ctx, vault.ID, current.FileID, versions[3].Version)
	if err != nil || survivor.ParentVersionID == nil || *survivor.ParentVersionID != versions[2].Version {
		t.Fatal("retained version lost parent metadata", survivor, err)
	}
	var count int
	if err = db.QueryRow(`SELECT count(*) FROM file_versions WHERE file_id=?`, current.FileID).Scan(&count); err != nil || count != 14 {
		t.Fatal("stored versions", count, err)
	}
	oldPath := filepath.Join(root, "users", u.ID, "vaults", vault.ID, "notes", current.FileID, "versions", versions[1].Version+".md")
	if _, err = os.Stat(oldPath); !os.IsNotExist(err) {
		t.Fatal("expired version object", err)
	}

	// A live share protects its bytes without adding an entry to the history UI.
	session, err := r.ExchangeLink(ctx, link.ID, "public-history", "")
	if err != nil {
		t.Fatal(err)
	}
	_, shared, err := r.DownloadLinkFile(ctx, link.ID, session, versions[0].Version)
	if err != nil || string(shared) != "version 0" {
		t.Fatal("shared snapshot", string(shared), err)
	}
	if _, err = r.PullSyncChanges(ctx, vault.ID, "", 0); err == nil {
		t.Fatal("stale cursor unexpectedly usable")
	} else {
		var conflict *SyncError
		if !errors.As(err, &conflict) || conflict.Code != "CURSOR_TOO_OLD" {
			t.Fatal(err)
		}
	}
	input := FileWrite{BaseVersion: current.Version, SourceVersion: versions[3].Version}
	restored, err := r.WriteFile(ctx, u.ID, vault.ID, current.FileID, "update_file_content", "restore-once", input)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := r.WriteFile(ctx, u.ID, vault.ID, current.FileID, "update_file_content", "restore-once", input)
	if err != nil || replay.Version != restored.Version {
		t.Fatal("restore replay", replay, err)
	}
	if restored.Version == versions[3].Version || restored.Hash != versions[3].Hash {
		t.Fatal("restore should create a new version with the original bytes")
	}
	meta, reader, err := r.OpenFileContent(ctx, vault.ID, current.FileID)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(reader)
	reader.Close()
	if err != nil || string(data) != "version 3" || meta.ParentVersionID == nil || *meta.ParentVersionID != current.Version {
		t.Fatal(meta, string(data), err)
	}
	if _, err = r.WriteFile(ctx, u.ID, vault.ID, current.FileID, "update_file_content", "", input); err == nil {
		t.Fatal("stale base accepted")
	} else {
		var conflict *SyncError
		if !errors.As(err, &conflict) || conflict.Code != "FILE_VERSION_CONFLICT" {
			t.Fatal(err)
		}
	}
	if err = r.RevokeLink(ctx, u.ID, link.ID); err != nil {
		t.Fatal(err)
	}
	if err = r.PublishVaults(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = r.FileVersion(ctx, vault.ID, current.FileID, versions[0].Version); !errors.Is(err, ErrNotFound) {
		t.Fatal("released share was not collected", err)
	}
	// Reevaluate the daily window even for a clean vault. The newest ten remain regardless of age.
	if _, err = db.Exec(`UPDATE file_versions SET created_at=? WHERE file_id=?; UPDATE history_sweeps SET day='2000-01-01' WHERE vault=?`, formatTime(noon.AddDate(0, 0, -40)), current.FileID, vault.ID); err != nil {
		t.Fatal(err)
	}
	if err = r.PublishVaults(ctx); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRow(`SELECT count(*) FROM file_versions WHERE file_id=?`, current.FileID).Scan(&count); err != nil || count != 11 {
		t.Fatal("idle vault should retain current plus ten old versions", count, err)
	}

}
