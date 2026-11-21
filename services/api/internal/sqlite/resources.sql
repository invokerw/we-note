CREATE TABLE IF NOT EXISTS assets (
 id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id), name TEXT NOT NULL,
 media_type TEXT NOT NULL, upload_id TEXT NOT NULL REFERENCES upload_sessions(id),
 is_deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, operation_key TEXT, fingerprint TEXT,
 UNIQUE(vault_id,operation_key)
);
CREATE TABLE IF NOT EXISTS shares (
 id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id),
 sender TEXT NOT NULL REFERENCES users(id), recipient TEXT NOT NULL REFERENCES users(id),
 snapshot TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
 accepted_files TEXT, target_vault TEXT, operation_key TEXT, fingerprint TEXT,
 UNIQUE(sender,operation_key)
);
CREATE INDEX IF NOT EXISTS idx_shares_inbox ON shares(recipient,created_at);
CREATE TABLE IF NOT EXISTS refresh_sessions (
 session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL
);
