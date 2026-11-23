package sqlite

import (
	"context"
	"database/sql"
	_ "embed"
	"fmt"

	_ "github.com/mattn/go-sqlite3"
)

//go:embed 003.sql
var fileMigration string

//go:embed resources.sql
var resourcesSchema string

type Database struct {
	*sql.DB
	Filename string
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
	return &Database{DB: db, Filename: filename}, nil
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
    created_at TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'active',
    email_verified_at TEXT,
    last_login_at TEXT,
    password_changed_at TEXT,
    disabled_at TEXT,
    disabled_reason TEXT,
    deleted_at TEXT
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
    current_content_hash TEXT NOT NULL DEFAULT '',
    current_content_size INTEGER NOT NULL DEFAULT 0 CHECK (current_content_size >= 0),
    current_blob_id TEXT NOT NULL DEFAULT '',
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
    created_by_device_id TEXT NOT NULL DEFAULT '',
    metadata_format TEXT NOT NULL DEFAULT '',
    metadata_line_ending TEXT,
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
    parent_version_id TEXT,
    device_id TEXT NOT NULL DEFAULT '',
    client_timestamp TEXT NOT NULL DEFAULT '',
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
    storage_key TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS sync_operations (
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    change_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    path TEXT NOT NULL,
    vault_revision INTEGER NOT NULL CHECK (vault_revision > 0),
    created_at TEXT NOT NULL,
    PRIMARY KEY (vault_id, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_files_vault_path ON files(vault_id, path);
CREATE INDEX IF NOT EXISTS idx_file_versions_file_revision ON file_versions(file_id, vault_revision);
CREATE INDEX IF NOT EXISTS idx_changes_vault_revision ON changes(vault_id, vault_revision);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sync_operations_change ON sync_operations(vault_id, change_id);

CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_by TEXT REFERENCES users(id),
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    invited_by TEXT NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    used_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email,created_at DESC);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_deliveries (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    recipient TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    sent_at TEXT
);

CREATE TABLE IF NOT EXISTS admin_audit_events (
    id INTEGER PRIMARY KEY,
    actor_user_id TEXT NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_events(id DESC);

CREATE TABLE IF NOT EXISTS backup_jobs (
    id TEXT PRIMARY KEY,
    created_by TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL,
    path TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    checksum TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    completed_at TEXT
);
`

	if _, err := db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("apply schema: %w", err)
	}
	if err := ensureCompatibilityColumns(ctx, db); err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, `INSERT OR IGNORE INTO schema_migrations(version) VALUES (1), (2)`); err != nil {
		return fmt.Errorf("record schema migration: %w", err)
	}
	if err := db.migrateFileStorage(ctx); err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, resourcesSchema); err != nil {
		return err
	}
	_, err := db.ExecContext(ctx, `
INSERT OR IGNORE INTO system_settings(key,value,updated_at) VALUES
('registration_mode','invite_only',CURRENT_TIMESTAMP),
('require_email_verification','true',CURRENT_TIMESTAMP),
('backup_schedule','off',CURRENT_TIMESTAMP),('backup_root','./data/backups',CURRENT_TIMESTAMP)`)
	return err
}

func (db *Database) migrateFileStorage(ctx context.Context) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err = conn.ExecContext(ctx, `PRAGMA foreign_keys=OFF`); err != nil {
		return err
	}
	defer conn.ExecContext(context.Background(), `PRAGMA foreign_keys=ON`)
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var applied bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=3)`).Scan(&applied); err != nil {
		return err
	}
	if applied {
		return nil
	}
	if _, err := tx.ExecContext(ctx, fileMigration); err != nil {
		return fmt.Errorf("migrate file storage: %w", err)
	}
	var violations int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM pragma_foreign_key_check`).Scan(&violations); err != nil {
		return err
	}
	if violations != 0 {
		return fmt.Errorf("file migration found %d invalid references", violations)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations(version) VALUES (3)`); err != nil {
		return err
	}
	return tx.Commit()
}

func ensureCompatibilityColumns(ctx context.Context, db *Database) error {
	columns := []struct {
		table string
		name  string
		ddl   string
	}{
		{"files", "current_content_hash", `ALTER TABLE files ADD COLUMN current_content_hash TEXT NOT NULL DEFAULT ''`},
		{"files", "current_content_size", `ALTER TABLE files ADD COLUMN current_content_size INTEGER NOT NULL DEFAULT 0`},
		{"files", "current_blob_id", `ALTER TABLE files ADD COLUMN current_blob_id TEXT NOT NULL DEFAULT ''`},
		{"file_versions", "created_by_device_id", `ALTER TABLE file_versions ADD COLUMN created_by_device_id TEXT NOT NULL DEFAULT ''`},
		{"file_versions", "metadata_format", `ALTER TABLE file_versions ADD COLUMN metadata_format TEXT NOT NULL DEFAULT ''`},
		{"file_versions", "metadata_line_ending", `ALTER TABLE file_versions ADD COLUMN metadata_line_ending TEXT`},
		{"changes", "parent_version_id", `ALTER TABLE changes ADD COLUMN parent_version_id TEXT`},
		{"changes", "device_id", `ALTER TABLE changes ADD COLUMN device_id TEXT NOT NULL DEFAULT ''`},
		{"changes", "client_timestamp", `ALTER TABLE changes ADD COLUMN client_timestamp TEXT NOT NULL DEFAULT ''`},
		{"upload_sessions", "storage_key", `ALTER TABLE upload_sessions ADD COLUMN storage_key TEXT`},
		{"users", "role", `ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`},
		{"users", "status", `ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`},
		{"users", "email_verified_at", `ALTER TABLE users ADD COLUMN email_verified_at TEXT`},
		{"users", "last_login_at", `ALTER TABLE users ADD COLUMN last_login_at TEXT`},
		{"users", "password_changed_at", `ALTER TABLE users ADD COLUMN password_changed_at TEXT`},
		{"users", "deleted_at", `ALTER TABLE users ADD COLUMN deleted_at TEXT`},
		{"users", "disabled_at", `ALTER TABLE users ADD COLUMN disabled_at TEXT`},
		{"users", "disabled_reason", `ALTER TABLE users ADD COLUMN disabled_reason TEXT`},
	}
	for _, column := range columns {
		rows, err := db.QueryContext(ctx, `PRAGMA table_info(`+column.table+`)`)
		if err != nil {
			return fmt.Errorf("inspect %s columns: %w", column.table, err)
		}
		found := false
		for rows.Next() {
			var cid int
			var name, columnType string
			var notNull, primaryKey int
			var defaultValue sql.NullString
			if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
				rows.Close()
				return fmt.Errorf("scan %s columns: %w", column.table, err)
			}
			if name == column.name {
				found = true
			}
		}
		if err := rows.Close(); err != nil {
			return fmt.Errorf("close %s columns: %w", column.table, err)
		}
		if found {
			continue
		}
		if _, err := db.ExecContext(ctx, column.ddl); err != nil {
			return fmt.Errorf("add %s.%s: %w", column.table, column.name, err)
		}
	}
	return nil
}
