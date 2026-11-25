package store

import (
	"context"
	"errors"
	"path/filepath"
	"regexp"
	"testing"
	"testing/cryptotest"
	"time"

	"github.com/weifei/we-note/services/api/internal/sqlite"
)

func TestShortUserAndVaultIDs(t *testing.T) {
	ctx := context.Background()
	db, err := sqlite.Open(ctx, filepath.Join(t.TempDir(), "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	r := NewRepository(db)
	admin, err := r.BootstrapAdmin(ctx, "admin@local.test", "hash")
	if err != nil {
		t.Fatal(err)
	}
	invitation, err := r.CreateInvitation(ctx, "invite@local.test", admin.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	invited, err := r.RegisterInvitation(ctx, invitation.Token, "hash")
	if err != nil {
		t.Fatal(err)
	}
	cryptotest.SetGlobalRandom(t, 42)
	user, err := r.CreatePendingUser(ctx, "open@local.test", "hash")
	if err != nil {
		t.Fatal(err)
	}
	// Replay the first candidate to exercise the primary key conflict and retry.
	cryptotest.SetGlobalRandom(t, 42)
	second, err := r.CreateUser(ctx, "second@local.test", "hash")
	if err != nil || second.ID == user.ID {
		t.Fatalf("allocate after collision: %q, %v", second.ID, err)
	}
	vault, err := r.CreateVault(ctx, user.ID, "Notes")
	if err != nil {
		t.Fatal(err)
	}
	pattern := regexp.MustCompile(`^[0-9abcdefghjkmnpqrstvwxyz]{8}$`)
	for kind, id := range map[string]string{"admin": admin.ID, "invite": invited.ID, "open": user.ID, "vault": vault.ID} {
		if !pattern.MatchString(id) {
			t.Errorf("%s got ID %q", kind, id)
		}
	}
	if _, err := r.CreateUser(ctx, "open@local.test", "hash"); !errors.Is(err, ErrConflict) {
		t.Errorf("duplicate email: %v", err)
	}
	envelope := Envelope{IV: make([]byte, 12), Ciphertext: make([]byte, 16)}
	_, err = r.SaveEncrypted(ctx, invited.ID, vault.ID, envelope)
	var conflict *SyncError
	if !errors.As(err, &conflict) || conflict.Code != "VAULT_ID_TAKEN" {
		t.Errorf("ordinary vault collision: %v", err)
	}
}
