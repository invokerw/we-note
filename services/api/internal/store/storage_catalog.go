package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/weifei/we-note/services/api/internal/blob"
)

// The catalogue and the resolved settings used by the running server are committed together.
// Historical backups retain their own encrypted location snapshots.
type StorageProfile struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	StorageConfig
}
type StorageCatalog struct {
	Revision int              `json:"revision"`
	Profiles []StorageProfile `json:"profiles"`
	Online   string           `json:"online"`
	Backup   string           `json:"backup"`
}

func (c StorageCatalog) profile(id string) *StorageProfile {
	for i := range c.Profiles {
		if c.Profiles[i].ID == id {
			return &c.Profiles[i]
		}
	}
	return nil
}
func (c StorageCatalog) public() StorageCatalog {
	c.Profiles = slices.Clone(c.Profiles)
	for i := range c.Profiles {
		p := &c.Profiles[i]
		p.HasSecret = p.Secret != ""
		p.Secret = ""
	}
	return c
}

func (r *Repository) readCatalog(ctx context.Context) (StorageCatalog, error) {
	var cat StorageCatalog
	raw, err := r.Setting(ctx, "storage_catalog")
	if err == nil {
		plain, err := r.decryptSetting(raw)
		if err != nil {
			return cat, err
		}
		if err = json.Unmarshal([]byte(plain), &cat); err != nil {
			return cat, err
		}
		if cat.profile(cat.Online) == nil || cat.profile(cat.Backup) == nil {
			return cat, errors.New("找不到当前使用的存储位置")
		}
		return cat, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return cat, err
	}
	online, err := r.currentStorage(ctx, "online")
	if err != nil {
		return cat, err
	}
	backup, err := r.currentStorage(ctx, "backup")
	if err != nil {
		return cat, err
	}
	root, err := r.Setting(ctx, "backup_root")
	if err != nil {
		return cat, err
	}
	backup.Directory = root
	cat.Online = "initial-online"
	cat.Backup = "initial-backup"
	name := "在线存储"
	if online.Kind == "startup" {
		name = "服务启动配置"
	}
	cat.Profiles = []StorageProfile{{cat.Online, name, online}}
	if online == backup {
		cat.Backup = cat.Online
	} else {
		cat.Profiles = append(cat.Profiles, StorageProfile{cat.Backup, "备份存储", backup})
	}
	return cat, nil
}
func (r *Repository) StorageCatalog(ctx context.Context) (StorageCatalog, error) {
	cat, err := r.readCatalog(ctx)
	return cat.public(), err
}

func normalizeProfile(ctx context.Context, c, old StorageConfig, allowStartup bool) (StorageConfig, error) {
	c.HasSecret = false
	c.Directory = strings.TrimSpace(c.Directory)
	c.Endpoint = strings.TrimSpace(c.Endpoint)
	c.Username = strings.TrimSpace(c.Username)
	if c.Secret == "" && c.Kind == old.Kind && c.Endpoint == old.Endpoint && c.Username == old.Username && c.Region == old.Region {
		c.Secret = old.Secret
	}
	switch c.Kind {
	case "startup":
		if allowStartup {
			return StorageConfig{Kind: "startup"}, nil
		}
	case "local":
		if c.Directory == "" {
			return c, errors.New("请填写本地目录")
		}
		return StorageConfig{Kind: "local", Directory: c.Directory}, nil
	case "webdav":
		c.Bucket = ""
		c.Region = ""
		c.Prefix = ""
		if c.Secret == "" && old.Kind == c.Kind && old.Username == c.Username && old.Endpoint == c.Endpoint {
			c.Secret = old.Secret
		}
		fallthrough
	case "s3":
		if _, err := c.remote(ctx); err != nil {
			return c, err
		}
		return c, nil
	}
	return c, errors.New("不支持的存储类型")
}

func (r *Repository) encryptedJSON(value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return r.encryptSetting(string(raw))
}

func (r *Repository) editCatalog(ctx context.Context, actor string, revision int, edit func(*StorageCatalog) error) error {
	cat, err := r.readCatalog(ctx)
	if err != nil {
		return err
	}
	if revision >= 0 && cat.Revision != revision {
		return fmt.Errorf("%w：存储配置已更新，请核对后重试", ErrConflict)
	}
	oldOnline := cat.profile(cat.Online).StorageConfig
	oldBackup := cat.profile(cat.Backup).StorageConfig
	if err = edit(&cat); err != nil {
		return err
	}
	online := cat.profile(cat.Online).StorageConfig
	backup := cat.profile(cat.Backup).StorageConfig
	var target blob.Store
	if online != oldOnline {
		target, err = r.onlineStore(ctx, online)
		if err != nil {
			return err
		}
		if err = probeStorage(ctx, target); err != nil {
			return err
		}
		source := r.blobStore
		// After credential rotation the previous login may already have expired.
		if sameObjectLocation(online, oldOnline) {
			source = target
		}
		if err = copyObjects(ctx, r.db.DB, source, target); err != nil {
			return fmt.Errorf("在线内容迁移失败：%w", err)
		}
	}
	if backup != oldBackup {
		if backup.Kind != "local" {
			remote, err := backup.remote(ctx)
			if err != nil {
				return err
			}
			if err = probeStorage(ctx, blob.RemoteStore{Objects: remote}); err != nil {
				return err
			}
		}
		if backup.Directory != "" {
			if err = os.MkdirAll(backup.Directory, 0750); err != nil {
				return err
			}
		}
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	put := func(key, value string) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO system_settings(key,value,updated_by,updated_at) VALUES(?,?,?,strftime('%Y-%m-%dT%H:%M:%SZ','now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at`, key, value, actor)
		return err
	}
	if target != nil {
		if err = migrateEnvelopes(ctx, tx, target); err != nil {
			return err
		}
		value, err := r.encryptedJSON(online)
		if err != nil {
			return err
		}
		if err = put("storage_online", value); err != nil {
			return err
		}
	}
	if backup != oldBackup {
		value, err := r.encryptedJSON(backup)
		if err != nil {
			return err
		}
		if err = put("storage_backup", value); err != nil {
			return err
		}
		if backup.Directory != "" {
			if err = put("backup_root", backup.Directory); err != nil {
				return err
			}
		}
	}
	cat.Revision++
	value, err := r.encryptedJSON(cat)
	if err != nil {
		return err
	}
	if err = put("storage_catalog", value); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	if target != nil {
		r.blobStore = target
		r.managedOnline = true
	}
	return nil
}
func sameObjectLocation(a, b StorageConfig) bool {
	return a.Kind == b.Kind && a.Endpoint == b.Endpoint && a.Bucket == b.Bucket && a.Region == b.Region && a.Prefix == b.Prefix && a.Directory == b.Directory && a.Username == b.Username
}
func (r *Repository) SaveStorageProfile(ctx context.Context, actor, id, name string, config StorageConfig, revision int) error {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > 80 {
		return errors.New("名称需为 1 至 80 个字符")
	}
	return r.editCatalog(ctx, actor, revision, func(cat *StorageCatalog) error {
		var old StorageConfig
		if id != "" {
			p := cat.profile(id)
			if p == nil {
				return ErrNotFound
			}
			old = p.StorageConfig
		}
		for _, p := range cat.Profiles {
			if p.ID != id && strings.EqualFold(p.Name, name) {
				return errors.New("存储位置名称已被使用")
			}
		}
		c, err := normalizeProfile(ctx, config, old, old.Kind == "startup")
		if err != nil {
			return err
		}
		if id != "" {
			cat.profile(id).Name = name
			cat.profile(id).StorageConfig = c
			return nil
		}
		id, err = newID("storage")
		if err != nil {
			return err
		}
		cat.Profiles = append(cat.Profiles, StorageProfile{id, name, c})
		return nil
	})
}
func (r *Repository) DeleteStorageProfile(ctx context.Context, actor, id string, revision int) error {
	return r.editCatalog(ctx, actor, revision, func(cat *StorageCatalog) error {
		if cat.Online == id || cat.Backup == id {
			return fmt.Errorf("%w：请先切换正在使用该位置的用途", ErrConflict)
		}
		if cat.profile(id) == nil {
			return ErrNotFound
		}
		cat.Profiles = slices.DeleteFunc(cat.Profiles, func(p StorageProfile) bool { return p.ID == id })
		return nil
	})
}
func (cat *StorageCatalog) bind(scope, id string) error {
	p := cat.profile(id)
	if p == nil {
		return ErrNotFound
	}
	switch scope {
	case "online":
		cat.Online = id
	case "backup":
		if p.Kind == "startup" {
			return errors.New("服务启动配置仅用于在线内容")
		}
		cat.Backup = id
	default:
		return ErrNotFound
	}
	return nil
}
func (r *Repository) BindStorageProfile(ctx context.Context, actor, scope, id string, revision int) error {
	return r.editCatalog(ctx, actor, revision, func(cat *StorageCatalog) error { return cat.bind(scope, id) })
}

// Support earlier clients that submit a resolved location for a single purpose.
func (r *Repository) ConfigureStorage(ctx context.Context, actor, scope string, c StorageConfig) error {
	old, err := r.currentStorage(ctx, scope)
	if err != nil {
		return err
	}
	if scope == "backup" && c.Kind == "local" && c.Directory == "" {
		c.Directory, err = r.Setting(ctx, "backup_root")
		if err != nil {
			return err
		}
	}
	c, err = normalizeProfile(ctx, c, old, true)
	if err != nil {
		return err
	}
	return r.editCatalog(ctx, actor, -1, func(cat *StorageCatalog) error {
		return cat.bindConfig(scope, c)
	})
}

func (cat *StorageCatalog) bindConfig(scope string, c StorageConfig) error {
	for _, p := range cat.Profiles {
		if p.StorageConfig == c {
			return cat.bind(scope, p.ID)
		}
	}
	id, err := newID("storage")
	if err != nil {
		return err
	}
	cat.Profiles = append(cat.Profiles, StorageProfile{id, "存储位置 " + id[len(id)-8:], c})
	return cat.bind(scope, id)
}

// A legacy settings client can still change the local backup directory. Update
// only its backup binding, even when online content uses the same profile.
func (r *Repository) legacyBackupDirectory(ctx context.Context, tx *sql.Tx, values map[string]string) error {
	root := values["backup_root"]
	if root == "" {
		return nil
	}
	var current, encrypted string
	err := tx.QueryRowContext(ctx, `SELECT b.value,c.value FROM system_settings b JOIN system_settings c ON c.key='storage_catalog' WHERE b.key='backup_root'`).Scan(&current, &encrypted)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if current == root {
		return nil
	}
	plain, err := r.decryptSetting(encrypted)
	if err != nil {
		return err
	}
	var cat StorageCatalog
	if err = json.Unmarshal([]byte(plain), &cat); err != nil {
		return err
	}
	p := cat.profile(cat.Backup)
	if p == nil {
		return errors.New("备份位置不存在")
	}
	cfg := p.StorageConfig
	cfg.Directory = root
	if err = cat.bindConfig("backup", cfg); err != nil {
		return err
	}
	cat.Revision++
	values["storage_catalog"], err = r.encryptedJSON(cat)
	if err != nil {
		return err
	}
	values["storage_backup"], err = r.encryptedJSON(cfg)
	return err
}
