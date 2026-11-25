package store

import (
	"strings"
	"testing"
	"time"
)

func TestCanonicalAssetURLUsesDateAndContentHash(t *testing.T) {
	hash := "sha256:" + strings.Repeat("ab", 32)
	createdAt := time.Date(2026, 11, 23, 23, 59, 59, 0, time.UTC)
	got := canonicalAssetURL("https://localhost:8443", "user_a", "vault_a", createdAt, hash)
	want := "https://localhost:8443/assets/user_a/vault_a/2026/11/23/" + strings.Repeat("ab", 32)
	if got != want {
		t.Fatalf("canonical URL = %q, want %q", got, want)
	}
}
