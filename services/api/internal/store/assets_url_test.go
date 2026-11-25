package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"path"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/weifei/we-note/services/api/internal/blob"
	"github.com/weifei/we-note/services/api/internal/sqlite"
)

func TestCanonicalAssetURLUsesDateAndURLKey(t *testing.T) {
	key := strings.Repeat("ab", 8)
	createdAt := time.Date(2026, 11, 23, 23, 59, 59, 0, time.UTC)
	got := canonicalAssetURL("https://localhost:8443", "user_a", "vault_a", createdAt, key)
	want := "https://localhost:8443/assets/user_a/vault_a/2026/11/23/" + strings.Repeat("ab", 8)
	if got != want {
		t.Fatalf("canonical URL = %q, want %q", got, want)
	}
}

func TestShortImageURLCollision(t *testing.T) {
	ctx := context.Background()
	db, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	blobs, err := blob.NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	repo := NewRepository(db, blobs)
	user, err := repo.CreateUser(ctx, "image@local.test", "hash")
	if err != nil {
		t.Fatal(err)
	}
	vault, err := repo.CreateVault(ctx, user.ID, "Images")
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("\x89PNG\r\n\x1a\nimage")
	hash := fmt.Sprintf("sha256:%x", sha256.Sum256(data))
	prefix := hash[7:23]
	create := func(hash string) Asset {
		t.Helper()
		a, err := repo.CreateAsset(ctx, user.ID, vault.ID, "image.png", "image/png", hash, "", int64(len(data)))
		if err != nil {
			t.Fatal(err)
		}
		return a
	}
	// Reserve the real image's prefix with a different declared digest.
	first := create("sha256:" + prefix + strings.Repeat("0", 48))
	second := create(hash)
	if path.Base(first.URL) != prefix || path.Base(second.URL) == prefix || !shortAssetKey.MatchString(path.Base(second.URL)) {
		t.Fatal(first.URL, second.URL)
	}
	if duplicate := create(hash); duplicate.URL != second.URL {
		t.Fatalf("same content changed URL: %s", duplicate.URL)
	}
	if _, err := repo.CompleteUploadSession(ctx, vault.ID, first.Upload, bytes.NewReader(data)); err == nil {
		t.Fatal("accepted bytes matching only the first 64 bits")
	}
	if _, err := repo.CompleteUploadSession(ctx, vault.ID, second.Upload, bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.assetForReference(ctx, db, user.ID, vault.ID, first.URL); err != ErrNotFound {
		t.Fatalf("pending URL resolved to completed image: %v", err)
	}
	found, err := repo.assetForReference(ctx, db, user.ID, vault.ID, second.URL)
	if err != nil || found.Hash != hash {
		t.Fatalf("wrong full digest: %s, %v", found.Hash, err)
	}
	body, err := repo.OpenAsset(ctx, found)
	if err != nil {
		t.Fatal(err)
	}
	defer body.Close()
	got, err := io.ReadAll(body)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("wrong resolved bytes: %x, %v", got, err)
	}
}
