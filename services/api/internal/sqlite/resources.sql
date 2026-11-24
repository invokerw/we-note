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
CREATE TABLE IF NOT EXISTS note_index (
 file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE, version_id TEXT NOT NULL,
 format TEXT NOT NULL, body TEXT NOT NULL, metadata TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS export_jobs (
 id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id), user_id TEXT NOT NULL REFERENCES users(id),
 operation_key TEXT, scope TEXT NOT NULL, created_at TEXT NOT NULL, snapshot TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', hash TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0,
 UNIQUE(user_id,vault_id,operation_key)
);

CREATE TABLE IF NOT EXISTS upload_part_leases (
 upload_id TEXT PRIMARY KEY REFERENCES upload_sessions(id) ON DELETE CASCADE, expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS upload_parts_expiry ON upload_part_leases(expires);
CREATE TABLE IF NOT EXISTS upload_parts (
 upload_id TEXT NOT NULL REFERENCES upload_part_leases(upload_id) ON DELETE CASCADE,
 number INTEGER NOT NULL, hash TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(upload_id,number)
);

CREATE TABLE IF NOT EXISTS share_links (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id), vault TEXT NOT NULL REFERENCES vaults(id),
 token_hash TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, snapshot TEXT NOT NULL, expires INTEGER NOT NULL,
 max_downloads INTEGER NOT NULL, downloads INTEGER NOT NULL DEFAULT 0, allow_download INTEGER NOT NULL,
 allow_import INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, operation_key TEXT, fingerprint TEXT NOT NULL,
 UNIQUE(owner,operation_key)
);
CREATE TABLE IF NOT EXISTS share_link_sessions (
 token_hash TEXT PRIMARY KEY, link TEXT NOT NULL REFERENCES share_links(id), expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_link_session_expiry ON share_link_sessions(expires);
CREATE TABLE IF NOT EXISTS share_link_imports (
 link TEXT NOT NULL REFERENCES share_links(id), target TEXT NOT NULL REFERENCES vaults(id),
 files TEXT NOT NULL, PRIMARY KEY(link,target)
);
CREATE TABLE IF NOT EXISTS share_asset_copies (
 share_id TEXT NOT NULL REFERENCES shares(id), source_url TEXT NOT NULL, target_url TEXT NOT NULL,
 PRIMARY KEY(share_id,source_url)
);
CREATE TABLE IF NOT EXISTS share_publications (
 share_id TEXT PRIMARY KEY REFERENCES shares(id), snapshot TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS share_copy_versions (
 share_id TEXT NOT NULL REFERENCES shares(id), file_id TEXT NOT NULL REFERENCES files(id),
 source_version TEXT NOT NULL REFERENCES file_versions(id), target_version TEXT NOT NULL REFERENCES file_versions(id),
 PRIMARY KEY(share_id,file_id)
);
CREATE TABLE IF NOT EXISTS encrypted_vaults (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id), revision INTEGER NOT NULL,
 ciphertext BLOB NOT NULL, iv BLOB NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_plugin_settings (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 plugin_id TEXT NOT NULL,
 settings_json TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(user_id, plugin_id)
);
CREATE INDEX IF NOT EXISTS idx_user_plugin_settings_user ON user_plugin_settings(user_id);
CREATE TABLE IF NOT EXISTS audit_events (
 id INTEGER PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, object_id TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_owner ON audit_events(owner,id DESC);
CREATE TRIGGER IF NOT EXISTS audit_login AFTER INSERT ON sessions BEGIN
 INSERT INTO audit_events(owner,action,object_id) VALUES(NEW.user_id,'login',NEW.user_id);
END;
CREATE TRIGGER IF NOT EXISTS audit_device_add AFTER INSERT ON devices BEGIN
 INSERT INTO audit_events(owner,action,object_id) VALUES(NEW.user_id,'device.add',NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS audit_device_remove AFTER DELETE ON devices BEGIN
 INSERT INTO audit_events(owner,action,object_id) VALUES(OLD.user_id,'device.remove',OLD.id);
END;
CREATE TRIGGER IF NOT EXISTS audit_export AFTER INSERT ON export_jobs BEGIN
 INSERT INTO audit_events(owner,action,object_id) VALUES(NEW.user_id,'export.create',NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS audit_share AFTER INSERT ON shares BEGIN
 INSERT INTO audit_events(owner,action,object_id) VALUES(NEW.sender,'share.send',NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS audit_received AFTER INSERT ON shares BEGIN
 INSERT INTO audit_events(owner,action,object_id) VALUES(NEW.recipient,'share.receive',NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS audit_status AFTER UPDATE OF status ON shares WHEN NEW.status<>OLD.status BEGIN
 INSERT INTO audit_events(owner,action,object_id) VALUES(NEW.sender,'share.' || NEW.status,NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS audit_inbox AFTER UPDATE OF status ON shares WHEN NEW.status<>OLD.status BEGIN
 INSERT INTO audit_events(owner,action,object_id) VALUES(NEW.recipient,'share.' || NEW.status,NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS audit_publish AFTER INSERT ON share_publications BEGIN
 INSERT INTO audit_events(owner,action,object_id) VALUES((SELECT sender FROM shares WHERE id=NEW.share_id),'share.publish',NEW.share_id);
END;
CREATE TRIGGER IF NOT EXISTS audit_copy AFTER INSERT ON share_copy_versions BEGIN
 INSERT INTO audit_events(owner,action,object_id) VALUES((SELECT recipient FROM shares WHERE id=NEW.share_id),'share.update',NEW.file_id);
END;
CREATE TRIGGER IF NOT EXISTS audit_link AFTER INSERT ON share_links BEGIN
 INSERT INTO audit_events(owner,action,object_id) VALUES(NEW.owner,'link.create',NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS audit_link_revoke AFTER UPDATE OF revoked ON share_links WHEN NEW.revoked<>OLD.revoked BEGIN
 INSERT INTO audit_events(owner,action,object_id) VALUES(NEW.owner,'link.revoke',NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS audit_link_download AFTER UPDATE OF downloads ON share_links BEGIN
 INSERT INTO audit_events(owner,action,object_id) VALUES(NEW.owner,'link.download',NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS audit_link_visit AFTER INSERT ON share_link_sessions BEGIN
 INSERT INTO audit_events(owner,action,object_id) VALUES((SELECT owner FROM share_links WHERE id=NEW.link),'link.open',NEW.link);
END;
CREATE TRIGGER IF NOT EXISTS audit_link_import AFTER INSERT ON share_link_imports BEGIN
 INSERT INTO audit_events(owner,action,object_id) VALUES((SELECT owner FROM share_links WHERE id=NEW.link),'link.import',NEW.link);
END;
CREATE TRIGGER IF NOT EXISTS audit_link_copy AFTER INSERT ON share_link_imports BEGIN
 INSERT INTO audit_events(owner,action,object_id) VALUES((SELECT owner_user_id FROM vaults WHERE id=NEW.target),'link.import',NEW.link);
END;
CREATE TRIGGER IF NOT EXISTS audit_delete_file AFTER UPDATE OF is_deleted ON files WHEN NEW.is_deleted=1 AND OLD.is_deleted=0 BEGIN
 INSERT INTO audit_events(owner,action,object_id) VALUES((SELECT owner_user_id FROM vaults WHERE id=NEW.vault_id),'file.delete',NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS audit_delete_asset AFTER UPDATE OF is_deleted ON assets WHEN NEW.is_deleted=1 AND OLD.is_deleted=0 BEGIN
 INSERT INTO audit_events(owner,action,object_id) VALUES((SELECT owner_user_id FROM vaults WHERE id=NEW.vault_id),'asset.delete',NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS audit_encrypted AFTER INSERT ON encrypted_vaults BEGIN
 INSERT INTO audit_events(owner,action,object_id) VALUES(NEW.owner,'encrypted.create',NEW.id);
END;

CREATE TABLE IF NOT EXISTS backup_locations (
 backup_id TEXT PRIMARY KEY REFERENCES backup_jobs(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, config TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS encrypted_objects (
 vault_id TEXT PRIMARY KEY REFERENCES encrypted_vaults(id) ON DELETE CASCADE,
 hash TEXT NOT NULL, size INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account_cleanup (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, bytes INTEGER NOT NULL, error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS cleanup_vaults (
 vault_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES account_cleanup(user_id) ON DELETE CASCADE
);
CREATE TRIGGER IF NOT EXISTS reserve_encrypted_vault_id BEFORE INSERT ON encrypted_vaults
 WHEN EXISTS(SELECT 1 FROM cleanup_vaults WHERE vault_id=NEW.id) BEGIN SELECT RAISE(ABORT,'vault cleanup in progress'); END;
CREATE TABLE IF NOT EXISTS garbage_objects (
 vault_id TEXT NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL,
 PRIMARY KEY(vault_id,hash)
);
CREATE TABLE IF NOT EXISTS trash_items (
 vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,kind TEXT NOT NULL,item TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT(unixepoch()), PRIMARY KEY(vault_id,kind,item)
);
CREATE INDEX IF NOT EXISTS trash_expiry ON trash_items(deleted);
INSERT OR IGNORE INTO system_settings(key,value,updated_at) VALUES('trash_retention_days','30',CURRENT_TIMESTAMP);
CREATE TRIGGER IF NOT EXISTS trash_files AFTER UPDATE OF is_deleted ON files WHEN NEW.is_deleted<>OLD.is_deleted BEGIN
 DELETE FROM trash_items WHERE vault_id=NEW.vault_id AND kind='file' AND item=NEW.id;
 INSERT INTO trash_items(vault_id,kind,item) SELECT NEW.vault_id,'file',NEW.id WHERE NEW.is_deleted=1;
END;
INSERT OR IGNORE INTO trash_items(vault_id,kind,item) SELECT vault_id,'file',id FROM files WHERE is_deleted=1;
CREATE TRIGGER IF NOT EXISTS trash_assets AFTER UPDATE OF is_deleted ON assets WHEN NEW.is_deleted<>OLD.is_deleted BEGIN
 DELETE FROM trash_items WHERE vault_id=NEW.vault_id AND kind='asset' AND item=NEW.id;
 INSERT INTO trash_items(vault_id,kind,item) SELECT NEW.vault_id,'asset',NEW.id WHERE NEW.is_deleted=1;
END;
INSERT OR IGNORE INTO trash_items(vault_id,kind,item) SELECT vault_id,'asset',id FROM assets WHERE is_deleted=1;
CREATE TRIGGER IF NOT EXISTS cancel_reclaimed_blob AFTER INSERT ON blobs BEGIN
 DELETE FROM garbage_objects WHERE vault_id=NEW.vault_id AND hash=NEW.content_hash;
END;

CREATE TRIGGER IF NOT EXISTS release_vault_garbage AFTER DELETE ON vaults BEGIN
 DELETE FROM garbage_objects WHERE vault_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS release_encrypted_garbage AFTER DELETE ON encrypted_vaults BEGIN
 DELETE FROM garbage_objects WHERE vault_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS replace_encrypted_object AFTER UPDATE OF hash ON encrypted_objects WHEN NEW.hash<>OLD.hash BEGIN
 INSERT OR IGNORE INTO garbage_objects VALUES(OLD.vault_id,OLD.hash,OLD.size);
 DELETE FROM garbage_objects WHERE vault_id=NEW.vault_id AND hash=NEW.hash;
END;
