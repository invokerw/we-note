package sqlite

import (
	"context"
	"database/sql"
	"testing"
)

func TestMigrateCreatesCoreTablesAndEnablesForeignKeys(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	var enabled int
	if err := db.QueryRowContext(ctx, `PRAGMA foreign_keys`).Scan(&enabled); err != nil {
		t.Fatal(err)
	}
	if enabled != 1 {
		t.Fatalf("foreign keys are disabled: %d", enabled)
	}

	for _, table := range []string{"users", "vaults", "devices", "blobs", "files", "file_versions", "changes", "upload_sessions", "sessions", "sync_operations"} {
		var name string
		err := db.QueryRowContext(ctx, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, table).Scan(&name)
		if err != nil {
			t.Fatalf("table %s missing: %v", table, err)
		}
		if name != table {
			t.Fatalf("unexpected table name %q", name)
		}
	}

	var version int
	if err := db.QueryRowContext(ctx, `SELECT version FROM schema_migrations`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != 1 && version != 2 {
		t.Fatalf("migration version = %d, want 1 or 2", version)
	}
}

func TestMigrateIsIdempotent(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	var count int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM schema_migrations`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("migration row count = %d, want 2", count)
	}
}

func TestForeignKeyRejectsUnknownVaultOwner(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	_, err = db.ExecContext(ctx, `INSERT INTO vaults(id, owner_user_id, name, created_at) VALUES ('vault_1', 'missing', 'Notes', CURRENT_TIMESTAMP)`)
	if err == nil {
		t.Fatal("expected foreign-key violation")
	}
	if err == sql.ErrNoRows {
		t.Fatal("unexpected query error")
	}
}
