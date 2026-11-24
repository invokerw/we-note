package store

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type backupManifest struct {
	Version   int       `json:"version"`
	CreatedAt time.Time `json:"created_at"`
	Blobs     int       `json:"blobs"`
}

func (r *Repository) CreateBackup(ctx context.Context, actor string) (BackupJob, error) {
	return r.createBackup(ctx, actor, "")
}
func (r *Repository) createBackup(ctx context.Context, actor, purpose string) (BackupJob, error) {
	if !r.backupMu.TryLock() {
		return BackupJob{}, ErrConflict
	}
	defer r.backupMu.Unlock()
	root, err := r.Setting(ctx, "backup_root")
	if errors.Is(err, ErrNotFound) || root == "" {
		root = "./data/backups"
	}
	if err != nil && !errors.Is(err, ErrNotFound) {
		return BackupJob{}, err
	}
	id, err := newID("backup")
	if err != nil {
		return BackupJob{}, err
	}
	now := time.Now().UTC()
	job := BackupJob{ID: id, Status: "running", CreatedAt: now}
	if err := r.SaveBackupJob(ctx, job, actor); err != nil {
		return BackupJob{}, err
	}
	if err := os.MkdirAll(root, 0o750); err != nil {
		return r.failBackup(ctx, job, actor, nil, nil, nil, err)
	}
	path := filepath.Join(root, id+".tar.gz")
	temporary, err := os.CreateTemp(root, ".wenote-backup-*.tmp")
	if err != nil {
		job.Status = "failed"
		job.Error = err.Error()
		_, _ = r.db.ExecContext(context.WithoutCancel(ctx), `UPDATE backup_jobs SET status=?,error=?,completed_at=? WHERE id=?`, job.Status, job.Error, formatTime(time.Now().UTC()), job.ID)
		return job, err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)

	gzipWriter := gzip.NewWriter(temporary)
	tarWriter := tar.NewWriter(gzipWriter)
	manifest := backupManifest{Version: 1, CreatedAt: now}
	dir, err := os.MkdirTemp("", "wenote-snapshot-")
	if err != nil {
		return r.failBackup(ctx, job, actor, temporary, gzipWriter, tarWriter, err)
	}
	defer os.RemoveAll(dir)
	snapshot := filepath.Join(dir, "wenote.db")
	if err := r.writeDatabaseSnapshot(ctx, tarWriter, snapshot); err != nil {
		return r.failBackup(ctx, job, actor, temporary, gzipWriter, tarWriter, err)
	}
	db, err := sql.Open("sqlite3", snapshot)
	if err != nil {
		return r.failBackup(ctx, job, actor, temporary, gzipWriter, tarWriter, err)
	}
	defer db.Close()
	rows, err := db.QueryContext(ctx, `SELECT vault_id,content_hash,content_size,MAX(storage_key) FROM (`+storedObjects+`) GROUP BY vault_id,content_hash,content_size`)
	if err != nil {
		return r.failBackup(ctx, job, actor, temporary, gzipWriter, tarWriter, err)
	}
	for rows.Next() {
		var vault, hash, key string
		var size int64
		if err := rows.Scan(&vault, &hash, &size, &key); err != nil {
			rows.Close()
			return r.failBackup(ctx, job, actor, temporary, gzipWriter, tarWriter, err)
		}
		reader, err := r.blobStore.OpenContext(ctx, vault, hash, key)
		if err != nil {
			rows.Close()
			return r.failBackup(ctx, job, actor, temporary, gzipWriter, tarWriter, err)
		}
		digest := strings.TrimPrefix(hash, "sha256:")
		if len(digest) != 64 {
			rows.Close()
			reader.Close()
			return r.failBackup(ctx, job, actor, temporary, gzipWriter, tarWriter, errors.New("invalid blob hash"))
		}
		name := filepath.ToSlash(filepath.Join("storage", "blobs", vault, digest[:2], digest))
		header := &tar.Header{Name: name, Mode: 0o640, Size: size, ModTime: now}
		if err := tarWriter.WriteHeader(header); err != nil {
			reader.Close()
			rows.Close()
			return r.failBackup(ctx, job, actor, temporary, gzipWriter, tarWriter, err)
		}
		hasher := sha256.New()
		written, err := io.Copy(io.MultiWriter(tarWriter, hasher), reader)
		if err == nil && (size != written || hex.EncodeToString(hasher.Sum(nil)) != digest) {
			err = errors.New("备份对象校验失败")
		}
		if err != nil {
			reader.Close()
			rows.Close()
			return r.failBackup(ctx, job, actor, temporary, gzipWriter, tarWriter, err)
		}
		if err := reader.Close(); err != nil {
			rows.Close()
			return r.failBackup(ctx, job, actor, temporary, gzipWriter, tarWriter, err)
		}
		manifest.Blobs++
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return r.failBackup(ctx, job, actor, temporary, gzipWriter, tarWriter, err)
	}
	rows.Close()
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		return r.failBackup(ctx, job, actor, temporary, gzipWriter, tarWriter, err)
	}
	if err := writeTarBytes(tarWriter, "manifest.json", manifestBytes, now); err != nil {
		return r.failBackup(ctx, job, actor, temporary, gzipWriter, tarWriter, err)
	}
	if err := tarWriter.Close(); err != nil {
		return r.failBackup(ctx, job, actor, temporary, gzipWriter, tarWriter, err)
	}
	if err := gzipWriter.Close(); err != nil {
		return r.failBackup(ctx, job, actor, temporary, gzipWriter, nil, err)
	}
	if err := temporary.Sync(); err != nil {
		return r.failBackup(ctx, job, actor, temporary, nil, nil, err)
	}
	if err := temporary.Close(); err != nil {
		return r.failBackup(ctx, job, actor, temporary, nil, nil, err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return r.failBackup(ctx, job, actor, temporary, nil, nil, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		return r.failBackup(ctx, job, actor, temporary, nil, nil, err)
	}
	checksum, err := fileChecksum(path)
	if err != nil {
		return r.failBackup(ctx, job, actor, temporary, nil, nil, err)
	}
	completed := time.Now().UTC()
	job.Status = "completed"
	job.Path = path
	job.Size = info.Size()
	job.Checksum = checksum
	job.CompletedAt = &completed
	if err := r.publishBackup(ctx, job, purpose); err != nil {
		return r.failBackup(ctx, job, actor, nil, nil, nil, err)
	}
	if _, err := r.db.ExecContext(context.WithoutCancel(ctx), `UPDATE backup_jobs SET status=?,path=?,size=?,checksum=?,completed_at=? WHERE id=?`, job.Status, job.Path, job.Size, job.Checksum, formatTime(completed), job.ID); err != nil {
		return job, err
	}
	return job, nil
}

func (r *Repository) writeDatabaseSnapshot(ctx context.Context, writer *tar.Writer, path string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, err := r.db.ExecContext(ctx, `VACUUM INTO ?`, path); err != nil {
		return fmt.Errorf("create database snapshot: %w", err)
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return err
	}
	if err := writer.WriteHeader(&tar.Header{Name: "wenote.db", Mode: 0o640, Size: info.Size(), ModTime: time.Now().UTC()}); err != nil {
		file.Close()
		return err
	}
	_, copyErr := io.Copy(writer, file)
	closeErr := file.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func writeTarBytes(writer *tar.Writer, name string, data []byte, modified time.Time) error {
	if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0o640, Size: int64(len(data)), ModTime: modified}); err != nil {
		return err
	}
	_, err := writer.Write(data)
	return err
}

func (r *Repository) failBackup(ctx context.Context, job BackupJob, actor string, file *os.File, gzipWriter *gzip.Writer, tarWriter *tar.Writer, err error) (BackupJob, error) {
	if tarWriter != nil {
		_ = tarWriter.Close()
	}
	if gzipWriter != nil {
		_ = gzipWriter.Close()
	}
	if file != nil {
		_ = file.Close()
	}
	job.Status = "failed"
	job.Error = err.Error()
	_, _ = r.db.ExecContext(context.WithoutCancel(ctx), `UPDATE backup_jobs SET status=?,error=?,completed_at=? WHERE id=?`, job.Status, job.Error, formatTime(time.Now().UTC()), job.ID)
	_ = actor
	return job, err
}

func fileChecksum(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return "", err
	}
	return "sha256:" + hex.EncodeToString(hasher.Sum(nil)), nil
}

func (r *Repository) VerifyBackup(ctx context.Context, id string) error {
	path, err := r.archivePath(ctx, id)
	if err != nil {
		return err
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	gzipReader, err := gzip.NewReader(file)
	if err != nil {
		return err
	}
	defer gzipReader.Close()
	tarReader := tar.NewReader(gzipReader)
	foundDatabase := false
	foundManifest := false
	for {
		header, readErr := tarReader.Next()
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return readErr
		}
		switch header.Name {
		case "wenote.db":
			foundDatabase = true
		case "manifest.json":
			foundManifest = true
			var manifest backupManifest
			if err := json.NewDecoder(tarReader).Decode(&manifest); err != nil {
				return err
			}
			if manifest.Version != 1 {
				return errors.New("不支持的备份格式版本")
			}
		}
	}
	if !foundDatabase || !foundManifest {
		return errors.New("backup is missing the database snapshot or manifest")
	}
	return nil
}

func (r *Repository) RestoreBackup(ctx context.Context, id string) (string, error) {
	if err := r.VerifyBackup(ctx, id); err != nil {
		return "", err
	}
	var archivePath, root string
	if err := r.db.QueryRowContext(ctx, `SELECT path FROM backup_jobs WHERE id=? AND status='completed'`, id).Scan(&archivePath); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}
	root, err := r.Setting(ctx, "backup_root")
	if errors.Is(err, ErrNotFound) || root == "" {
		root = "./data/backups"
	}
	if err != nil && !errors.Is(err, ErrNotFound) {
		return "", err
	}
	if err := os.MkdirAll(root, 0750); err != nil {
		return "", err
	}
	staging, err := os.MkdirTemp(root, "restore-"+id+"-")
	if err != nil {
		return "", err
	}
	complete := false
	defer func() {
		if !complete {
			os.RemoveAll(staging)
		}
	}()
	file, err := os.Open(archivePath)
	if err != nil {
		return "", err
	}
	defer file.Close()
	gzipReader, err := gzip.NewReader(file)
	if err != nil {
		return "", err
	}
	defer gzipReader.Close()
	tarReader := tar.NewReader(gzipReader)
	for {
		header, readErr := tarReader.Next()
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return "", readErr
		}
		if !filepath.IsLocal(header.Name) || (header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeDir) {
			return "", errors.New("备份包含无效的文件路径或类型")
		}
		target := filepath.Join(staging, filepath.Clean(header.Name))
		if !strings.HasPrefix(target, filepath.Clean(staging)+string(os.PathSeparator)) {
			return "", errors.New("backup contains an unsafe path")
		}
		if header.Typeflag == tar.TypeDir {
			if err := os.MkdirAll(target, 0o750); err != nil {
				return "", err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
			return "", err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o640)
		if err != nil {
			return "", err
		}
		_, copyErr := io.Copy(out, tarReader)
		closeErr := out.Close()
		if copyErr != nil {
			return "", copyErr
		}
		if closeErr != nil {
			return "", closeErr
		}
	}
	complete = true
	return staging, nil
}

// RunDueBackup starts at most one archive per configured interval on this instance.
func (r *Repository) RunDueBackup(ctx context.Context, now time.Time) error {
	r.Maintenance.RLock()
	defer r.Maintenance.RUnlock()
	var schedule string
	var actor, last sql.NullString
	err := r.db.QueryRowContext(ctx, `SELECT value,updated_by,(SELECT MAX(created_at) FROM backup_jobs) FROM system_settings WHERE key='backup_schedule'`).Scan(&schedule, &actor, &last)
	if err != nil {
		return err
	}
	if schedule == "off" || !actor.Valid {
		return nil
	}
	interval := 24 * time.Hour
	if schedule == "weekly" {
		interval *= 7
	}
	if last.Valid {
		start, err := parseTime(last.String)
		if err != nil {
			return err
		}
		if now.Before(start.Add(interval)) {
			return nil
		}
	}
	job, err := r.CreateBackup(ctx, actor.String)
	if errors.Is(err, ErrConflict) {
		return nil
	}
	if err != nil {
		return err
	}
	return r.RecordAdminAudit(ctx, actor.String, "backup.scheduled", "backup", job.ID, "")
}
