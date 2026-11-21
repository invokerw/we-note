CREATE TABLE new_blobs (
    id TEXT NOT NULL,
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    content_hash TEXT NOT NULL,
    content_size INTEGER NOT NULL CHECK (content_size >= 0),
    storage_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (vault_id, id),
    UNIQUE (vault_id, content_hash)
);
INSERT INTO new_blobs (id, vault_id, content_hash, content_size, storage_key, created_at)
    SELECT id, vault_id, content_hash, content_size, storage_key, created_at FROM blobs;
DROP TABLE blobs;
ALTER TABLE new_blobs RENAME TO blobs;

CREATE TABLE new_files (
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
    updated_at TEXT NOT NULL
);
INSERT INTO new_files (id, vault_id, path, format, current_version_id, current_content_hash, current_content_size, current_blob_id, is_deleted, created_at, updated_at)
    SELECT id, vault_id, path, format, current_version_id, current_content_hash, current_content_size, current_blob_id, is_deleted, created_at, updated_at FROM files;
DROP TABLE files;
ALTER TABLE new_files RENAME TO files;

CREATE TABLE new_file_versions (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    blob_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    content_size INTEGER NOT NULL CHECK (content_size >= 0),
    parent_version_id TEXT REFERENCES file_versions(id),
    created_by_device_id TEXT NOT NULL DEFAULT '',
    metadata_format TEXT NOT NULL DEFAULT '',
    metadata_line_ending TEXT,
    vault_revision INTEGER NOT NULL CHECK (vault_revision > 0),
    created_at TEXT NOT NULL,
    FOREIGN KEY (vault_id, blob_id) REFERENCES blobs(vault_id, id)
);
INSERT INTO new_file_versions (id, vault_id, file_id, blob_id, content_hash, content_size, parent_version_id, created_by_device_id, metadata_format, metadata_line_ending, vault_revision, created_at)
    SELECT id, vault_id, file_id, blob_id, content_hash, content_size, parent_version_id, created_by_device_id, metadata_format, metadata_line_ending, vault_revision, created_at FROM file_versions;
DROP TABLE file_versions;
ALTER TABLE new_file_versions RENAME TO file_versions;

CREATE UNIQUE INDEX idx_files_active_path ON files(vault_id, path) WHERE is_deleted = 0;
CREATE INDEX idx_files_vault_path ON files(vault_id, path);
CREATE INDEX idx_file_versions_file_revision ON file_versions(file_id, vault_revision);
CREATE TABLE file_requests (
    vault_id TEXT NOT NULL REFERENCES vaults(id), operation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(vault_id,operation_id)
);
