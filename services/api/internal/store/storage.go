package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/weifei/we-note/services/api/internal/blob"
)

type StorageConfig struct {
	Kind      string `json:"kind"`
	Directory string `json:"directory,omitempty"`
	Endpoint  string `json:"endpoint,omitempty"`
	Bucket    string `json:"bucket,omitempty"`
	Region    string `json:"region,omitempty"`
	Prefix    string `json:"prefix,omitempty"`
	Username  string `json:"username,omitempty"`
	Secret    string `json:"secret,omitempty"`
	HasSecret bool   `json:"has_secret,omitempty"`
}

func (r *Repository) decodeStorage(raw string) (StorageConfig, error) {
	var c StorageConfig
	v, err := r.decryptSetting(raw)
	if err != nil {
		return c, err
	}
	err = json.Unmarshal([]byte(v), &c)
	return c, err
}
func (r *Repository) currentStorage(ctx context.Context, scope string) (StorageConfig, error) {
	if scope != "backup" && scope != "online" {
		return StorageConfig{}, errors.New("未知存储用途")
	}
	v, err := r.Setting(ctx, "storage_"+scope)
	if errors.Is(err, ErrNotFound) {
		if scope == "online" {
			return StorageConfig{Kind: "startup"}, nil
		}
		return StorageConfig{Kind: "local"}, nil
	}
	if err != nil {
		return StorageConfig{}, err
	}
	return r.decodeStorage(v)
}
func (r *Repository) StorageSettings(ctx context.Context, scope string) (StorageConfig, error) {
	c, err := r.currentStorage(ctx, scope)
	if scope == "backup" && err == nil {
		c.Directory, err = r.Setting(ctx, "backup_root")
	}
	c.HasSecret = c.Secret != ""
	c.Secret = ""
	return c, err
}
func (c StorageConfig) remote(ctx context.Context) (blob.Objects, error) {
	var base *url.URL
	if c.Endpoint != "" {
		u, err := url.Parse(c.Endpoint)
		if err != nil || u.Hostname() == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return nil, errors.New("请输入 HTTP 或 HTTPS 地址，凭据请单独填写")
		}
		base = u
	}
	switch c.Kind {
	case "webdav":
		if base == nil {
			return nil, errors.New("请填写已有 WebDAV 目录的地址")
		}
		return blob.WebDAV{Base: base, Username: c.Username, Password: c.Secret}, nil
	case "s3":
		if c.Username == "" || c.Secret == "" {
			return nil, errors.New("请填写 S3 Access Key 和 Secret Key")
		}
		return blob.NewS3WithCredentials(ctx, c.Bucket, c.Prefix, c.Endpoint, c.Region, c.Username, c.Secret)
	default:
		return nil, errors.New("未知远程存储类型")
	}
}
func (r *Repository) onlineStore(ctx context.Context, c StorageConfig) (blob.Store, error) {
	switch c.Kind {
	case "startup":
		return r.startupStore, nil
	case "local":
		return blob.NewLocalStore(c.Directory)
	default:
		remote, err := c.remote(ctx)
		return blob.RemoteStore{Objects: remote}, err
	}
}
func (r *Repository) LoadOnlineStorage(ctx context.Context) error {
	c, err := r.currentStorage(ctx, "online")
	if err != nil {
		return err
	}
	s, err := r.onlineStore(ctx, c)
	if err != nil {
		return err
	}
	return r.bindOwners(ctx, s)
}

const backedUpObjects = `SELECT vault_id,content_hash,content_size FROM blobs UNION SELECT vault_id,hash,size FROM export_jobs WHERE status='completed' UNION SELECT vault_id,hash,size FROM encrypted_objects ORDER BY 1,2`

// Multiple sessions may store the same hash under different upload dates.
const storedObjects = `SELECT vault_id,content_hash,content_size,storage_key FROM blobs
 UNION SELECT vault_id,content_hash,content_size,COALESCE(storage_key,'') FROM upload_sessions WHERE status='completed'
 UNION SELECT vault_id,hash,size,COALESCE(storage_key,'') FROM export_jobs WHERE status='completed'
 UNION SELECT vault_id,hash,size,'' FROM encrypted_objects ORDER BY 1,2`

func verifyReader(reader io.ReadCloser, hash string, size int64) error {
	defer reader.Close()
	digest := sha256.New()
	n, err := io.Copy(digest, io.LimitReader(reader, size+1))
	if err != nil {
		return err
	}
	if n != size || "sha256:"+hex.EncodeToString(digest.Sum(nil)) != hash {
		return errors.New("读回对象的大小或 SHA-256 与原件不符")
	}
	return nil
}
func copyObjects(ctx context.Context, db *sql.DB, source, target blob.Store, fromArchive bool) error {
	owners, err := readOwners(ctx, db)
	if err != nil {
		return err
	}
	if source != nil && !fromArchive {
		source = ownedStore{unwrap(source), owners}
	}
	if target != nil {
		target = ownedStore{unwrap(target), owners}
	}
	rows, err := db.QueryContext(ctx, storedObjects)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var vault, hash, stored string
		var size int64
		if err := rows.Scan(&vault, &hash, &size, &stored); err != nil {
			return err
		}
		if source == nil || target == nil {
			return errors.New("缺少内容存储位置")
		}
		var date time.Time
		var resource bool
		if stored != "" {
			parts := strings.Split(stored, "/")
			if len(parts) == 9 && parts[4] == "assets" {
				resource = true
				parts = parts[1:]
			}
			if len(parts) != 8 {
				return errors.New("invalid dated storage key")
			}
			date, err = time.Parse("2006/01/02", strings.Join(parts[4:7], "/"))
			if err != nil {
				return fmt.Errorf("invalid dated storage key %q: %w", stored, err)
			}
		}
		sourceKey := stored
		if fromArchive {
			sourceKey = ""
		}
		in, err := source.OpenContext(ctx, vault, hash, sourceKey)
		if err != nil {
			return err
		}
		var key string
		if resource {
			key, err = putResource(ctx, target, vault, hash, size, date, in)
		} else {
			key, err = target.PutAt(ctx, vault, hash, size, date, in)
		}
		in.Close()
		if err != nil {
			return err
		}
		out, err := target.OpenContext(ctx, vault, hash, key)
		if err != nil {
			return err
		}
		if err = verifyReader(out, hash, size); err != nil {
			return err
		}
	}
	return rows.Err()
}
func probeStorage(ctx context.Context, s blob.Store) error {
	if s == nil {
		return errors.New("未配置在线存储")
	}
	data := []byte("WeNote storage check v1\n")
	hash := fmt.Sprintf("sha256:%x", sha256.Sum256(data))
	size := int64(len(data))
	key, err := s.PutAt(ctx, "wenote-check", hash, size, time.Time{}, bytes.NewReader(data))
	if err != nil {
		return err
	}
	out, err := s.OpenContext(ctx, "wenote-check", hash, key)
	if err != nil {
		return err
	}
	return verifyReader(out, hash, size)
}

func (r *Repository) publishBackup(ctx context.Context, job BackupJob, purpose string) error {
	cfg, err := r.currentStorage(ctx, "backup")
	if err != nil {
		return err
	}
	cipher := ""
	if cfg.Kind != "local" {
		remote, err := cfg.remote(ctx)
		if err != nil {
			return err
		}
		file, err := os.Open(job.Path)
		if err != nil {
			return err
		}
		defer file.Close()
		sum, err := hex.DecodeString(strings.TrimPrefix(job.Checksum, "sha256:"))
		if err != nil {
			return err
		}
		key := job.ID + ".tar.gz"
		if err = remote.PutFile(ctx, key, file, job.Size, sum); err != nil {
			return err
		}
		out, err := remote.GetFile(ctx, key)
		if err != nil {
			return err
		}
		if err = verifyReader(out, job.Checksum, job.Size); err != nil {
			return err
		}
		cipher, err = r.Setting(ctx, "storage_backup")
		if err != nil {
			return err
		}
	}
	_, err = r.db.ExecContext(ctx, `INSERT INTO backup_locations(backup_id,kind,config,purpose) VALUES(?,?,?,?)`, job.ID, cfg.Kind, cipher, purpose)
	return err
}

// Rebuild a missing local archive from the destination recorded when it was created.
func (r *Repository) archivePath(ctx context.Context, id string) (string, error) {
	var path, expected, cipher string
	var size int64
	err := r.db.QueryRowContext(ctx, `SELECT j.path,j.checksum,j.size,COALESCE(l.config,'') FROM backup_jobs j LEFT JOIN backup_locations l ON l.backup_id=j.id WHERE j.id=? AND j.status='completed'`, id).Scan(&path, &expected, &size, &cipher)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	actual, err := fileChecksum(path)
	if err == nil && actual == expected {
		return path, nil
	}
	if cipher == "" {
		if err != nil {
			return "", err
		}
		return "", errors.New("备份 SHA-256 校验失败")
	}
	cfg, err := r.decodeStorage(cipher)
	if err != nil {
		return "", err
	}
	remote, err := cfg.remote(ctx)
	if err != nil {
		return "", err
	}
	out, err := remote.GetFile(ctx, id+".tar.gz")
	if err != nil {
		return "", err
	}
	defer out.Close()
	if err = os.MkdirAll(filepath.Dir(path), 0750); err != nil {
		return "", err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".download-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	digest := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, digest), io.LimitReader(out, size+1))
	closeErr := f.Close()
	if err != nil {
		return "", err
	}
	if closeErr != nil {
		return "", closeErr
	}
	if n != size || fmt.Sprintf("sha256:%x", digest.Sum(nil)) != expected {
		return "", errors.New("远程备份校验失败")
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return "", err
	}
	return path, nil
}
