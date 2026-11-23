package blob

import (
	"strings"
	"testing"
	"time"
)

func TestS3KeyUsesDateAndContentHash(t *testing.T) {
	store := &S3Store{prefix: "wenote"}
	hash := "sha256:" + strings.Repeat("ab", 32)
	createdAt := time.Date(2026, 11, 23, 1, 2, 3, 0, time.UTC)
	got, err := store.keyAt("vault_1", hash, createdAt)
	if err != nil {
		t.Fatal(err)
	}
	want := "wenote/blobs/vault_1/2026/11/23/" + strings.Repeat("ab", 32)
	if got != want {
		t.Fatalf("S3 key = %q, want %q", got, want)
	}
}
