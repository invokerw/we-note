package sqlite

import (
	"context"
	"database/sql"
	"fmt"

	_ "github.com/mattn/go-sqlite3"
)

type Database struct {
	*sql.DB
}

func Open(ctx context.Context, filename string) (*Database, error) {
	db, err := sql.Open("sqlite3", filename)
	if err != nil {
		return nil, fmt.Errorf("open sqlite database: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	for _, statement := range []string{
		`PRAGMA foreign_keys = ON`,
		`PRAGMA busy_timeout = 5000`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			db.Close()
			return nil, fmt.Errorf("configure sqlite database: %w", err)
		}
	}
	return &Database{DB: db}, nil
}

func (db *Database) Migrate(ctx context.Context) error {
	const schema = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vaults (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    current_revision INTEGER NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
    min_available_revision INTEGER NOT NULL DEFAULT 0 CHECK (min_available_revision >= 0),
    request_sequence INTEGER NOT NULL DEFAULT 0 CHECK (request_sequence >= 0),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_members (
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer', 'exporter')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (vault_id, user_id)
);

CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    public_key TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blobs (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    content_hash TEXT NOT NULL,
    content_size INTEGER NOT NULL CHECK (content_size >= 0),
    storage_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (vault_id, content_hash)
);

CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    format TEXT NOT NULL,
    current_version_id TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (vault_id, path)
);

CREATE TABLE IF NOT EXISTS file_versions (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    blob_id TEXT NOT NULL REFERENCES blobs(id),
    content_hash TEXT NOT NULL,
    content_size INTEGER NOT NULL CHECK (content_size >= 0),
    parent_version_id TEXT REFERENCES file_versions(id),
    vault_revision INTEGER NOT NULL CHECK (vault_revision > 0),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS changes (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    vault_revision INTEGER NOT NULL CHECK (vault_revision > 0),
    file_id TEXT NOT NULL REFERENCES files(id),
    version_id TEXT NOT NULL REFERENCES file_versions(id),
    operation_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    content_size INTEGER NOT NULL CHECK (content_size >= 0),
    request_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (vault_id, vault_revision),
    UNIQUE (vault_id, operation_id),
    UNIQUE (vault_id, request_id)
);

CREATE TABLE IF NOT EXISTS upload_sessions (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    blob_id TEXT,
    content_hash TEXT NOT NULL,
    content_size INTEGER NOT NULL CHECK (content_size >= 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
    created_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_files_vault_path ON files(vault_id, path);
CREATE INDEX IF NOT EXISTS idx_file_versions_file_revision ON file_versions(file_id, vault_revision);
CREATE INDEX IF NOT EXISTS idx_changes_vault_revision ON changes(vault_id, vault_revision);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
`

	if _, err := db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("apply schema: %w", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT OR IGNORE INTO schema_migrations(version) VALUES (1)`); err != nil {
		return fmt.Errorf("record schema migration: %w", err)
	}
	return nil
}
