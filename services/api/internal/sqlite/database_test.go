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
	if count != 3 {
		t.Fatalf("migration row count = %d, want 3", count)
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

func TestFileMigrationPreservesPopulatedVersionChain(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	// Exercise the rebuild with the same references and rows an existing installation holds.
	_, err = db.Exec(`INSERT INTO users VALUES ('u','a@b','hash','now');INSERT INTO vaults(id,owner_user_id,name,created_at) VALUES('v','u','one','now'),('w','u','two','now');INSERT INTO blobs VALUES('b','v','hash',0,'key','now');INSERT INTO files(id,vault_id,path,format,current_version_id,created_at,updated_at) VALUES('f','v','a.md','md','a','now','now');INSERT INTO file_versions(id,vault_id,file_id,blob_id,content_hash,content_size,vault_revision,created_at) VALUES('a','v','f','b','hash',0,1,'now');DELETE FROM schema_migrations WHERE version=3; DROP TABLE file_requests;`)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO blobs VALUES('b','w','hash',0,'key2','now')`); err != nil {
		t.Fatal("cross-vault identical blob", err)
	}
	var n int
	if err = db.QueryRow(`SELECT count(*) FROM files f JOIN file_versions v ON v.id=f.current_version_id JOIN blobs b ON b.id=v.blob_id AND b.vault_id=v.vault_id`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("lost version chain: %d %v", n, err)
	}
	if _, err = db.Exec(`DELETE FROM blobs WHERE vault_id='v'`); err == nil {
		t.Fatal("foreign key enforcement disabled after rebuild")
	}
}
