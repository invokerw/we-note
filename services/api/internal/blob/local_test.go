package blob

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLocalStorePutIsAtomicAndContentAddressed(t *testing.T) {
	root := t.TempDir()
	store, err := NewLocalStore(root)
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("# Hello\n")
	digest := sha256.Sum256(content)
	hash := "sha256:" + hex.EncodeToString(digest[:])

	createdAt := time.Date(2026, 11, 23, 1, 2, 3, 0, time.UTC)
	key, err := store.PutAt(context.Background(), "vault_1", hash, int64(len(content)), createdAt, strings.NewReader(string(content)))
	if err != nil {
		t.Fatal(err)
	}
	if key != filepath.Join("blobs", "vault_1", "2026", "11", "23", hash[len("sha256:"):]) {
		t.Fatalf("storage key = %q", key)
	}

	reader, err := store.Open("vault_1", hash)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(reader)
	reader.Close()
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(content) {
		t.Fatalf("content = %q, want %q", got, content)
	}

	entries, err := os.ReadDir(filepath.Join(root, "blobs", "vault_1", "2026", "11", "23"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != hash[len("sha256:"):] {
		t.Fatalf("unexpected blob directory entries: %v", entries)
	}
}

func TestLocalStoreRejectsHashAndSizeMismatch(t *testing.T) {
	store, err := NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	content := "hello"
	validDigest := sha256.Sum256([]byte(content))
	validHash := "sha256:" + hex.EncodeToString(validDigest[:])

	if _, err := store.Put(context.Background(), "vault_1", validHash, 99, strings.NewReader(content)); err == nil {
		t.Fatal("expected size mismatch")
	}
	if _, err := store.Put(context.Background(), "vault_1", "sha256:"+strings.Repeat("0", 64), int64(len(content)), strings.NewReader(content)); err == nil {
		t.Fatal("expected hash mismatch")
	}
}

func TestLocalStoreHonorsCanceledContext(t *testing.T) {
	store, err := NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	content := []byte("hello")
	digest := sha256.Sum256(content)
	hash := "sha256:" + hex.EncodeToString(digest[:])
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := store.Put(ctx, "vault_1", hash, int64(len(content)), strings.NewReader(string(content))); err == nil {
		t.Fatal("expected canceled context error")
	}
}
