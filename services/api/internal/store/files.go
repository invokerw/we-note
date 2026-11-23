package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"

	"github.com/weifei/we-note/services/api/internal/model"
)

const activeFileQuery = `
	SELECT f.id, f.vault_id, f.path, f.format, f.current_version_id,
		COALESCE(v.content_hash, f.current_content_hash), COALESCE(v.content_size, f.current_content_size),
		COALESCE(v.blob_id, f.current_blob_id), COALESCE(b.storage_key, ''), f.is_deleted, f.created_at, f.updated_at
	FROM files f
	LEFT JOIN file_versions v ON v.id = f.current_version_id AND v.file_id = f.id AND v.vault_id = f.vault_id
	LEFT JOIN blobs b ON b.id = COALESCE(v.blob_id, f.current_blob_id) AND b.vault_id = f.vault_id
	WHERE f.vault_id = ? AND f.is_deleted = 0`

const fileVersionQuery = `
	SELECT v.id, v.vault_id, v.file_id, v.blob_id, COALESCE(b.storage_key, ''), v.content_hash, v.content_size, v.parent_version_id,
		v.created_by_device_id, COALESCE(NULLIF(v.metadata_format, ''), f.format), v.metadata_line_ending,
		v.vault_revision, v.created_at
	FROM file_versions v JOIN files f ON f.id = v.file_id AND f.vault_id = v.vault_id
	LEFT JOIN blobs b ON b.id = v.blob_id AND b.vault_id = v.vault_id
	WHERE f.vault_id = ? AND f.id = ? AND f.is_deleted = 0`

func (r *Repository) ListFiles(ctx context.Context, vaultID string) ([]model.File, error) {
	rows, err := r.db.QueryContext(ctx, activeFileQuery+` ORDER BY f.path, f.id`, vaultID)
	if err != nil {
		return nil, fmt.Errorf("list files: %w", err)
	}
	defer rows.Close()

	files := make([]model.File, 0)
	for rows.Next() {
		file, err := scanFile(rows)
		if err != nil {
			return nil, err
		}
		files = append(files, file)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate files: %w", err)
	}
	return files, nil
}

func (r *Repository) File(ctx context.Context, vaultID, fileID string) (model.File, error) {
	return scanFile(r.db.QueryRowContext(ctx, activeFileQuery+` AND f.id = ?`, vaultID, fileID))
}

func (r *Repository) ListFileVersions(ctx context.Context, vaultID, fileID string) ([]model.FileVersion, error) {
	rows, err := r.db.QueryContext(ctx, fileVersionQuery+` ORDER BY v.vault_revision DESC, v.id`, vaultID, fileID)
	if err != nil {
		return nil, fmt.Errorf("list file versions: %w", err)
	}
	defer rows.Close()

	versions := make([]model.FileVersion, 0)
	for rows.Next() {
		version, err := scanFileVersion(rows)
		if err != nil {
			return nil, err
		}
		versions = append(versions, version)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate file versions: %w", err)
	}
	return versions, nil
}

func (r *Repository) FileVersion(ctx context.Context, vaultID, fileID, versionID string) (model.FileVersion, error) {
	return scanFileVersion(r.db.QueryRowContext(ctx, fileVersionQuery+` AND v.id = ?`, vaultID, fileID, versionID))
}

func (r *Repository) OpenFileContent(ctx context.Context, vaultID, fileID string) (model.FileVersion, io.ReadCloser, error) {
	version, err := scanFileVersion(r.db.QueryRowContext(ctx, fileVersionQuery+` AND v.id = f.current_version_id`, vaultID, fileID))
	if err != nil {
		return model.FileVersion{}, nil, err
	}
	if r.blobStore == nil {
		return model.FileVersion{}, nil, errors.New("blob store is not configured")
	}
	reader, err := r.blobStore.OpenContext(ctx, vaultID, version.ContentHash, version.StorageKey)
	if err != nil {
		return model.FileVersion{}, nil, fmt.Errorf("open file content: %w", err)
	}
	return version, reader, nil
}

func scanFile(row scanner) (model.File, error) {
	var file model.File
	var currentVersionID sql.NullString
	var isDeleted int
	var createdAt, updatedAt string
	if err := row.Scan(
		&file.ID, &file.VaultID, &file.Path, &file.Format, &currentVersionID,
		&file.CurrentContentHash, &file.CurrentContentSize, &file.CurrentBlobID, &file.CurrentStorageKey, &isDeleted,
		&createdAt, &updatedAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return model.File{}, ErrNotFound
		}
		return model.File{}, fmt.Errorf("scan file: %w", err)
	}
	if currentVersionID.Valid {
		file.CurrentVersionID = &currentVersionID.String
	}
	file.IsDeleted = isDeleted != 0
	var err error
	file.CreatedAt, err = parseTime(createdAt)
	if err != nil {
		return model.File{}, err
	}
	file.UpdatedAt, err = parseTime(updatedAt)
	if err != nil {
		return model.File{}, err
	}
	return file, nil
}

func scanFileVersion(row scanner) (model.FileVersion, error) {
	var version model.FileVersion
	var parentVersionID, lineEnding sql.NullString
	var createdAt string
	if err := row.Scan(
		&version.ID, &version.VaultID, &version.FileID, &version.BlobID, &version.StorageKey, &version.ContentHash,
		&version.ContentSize, &parentVersionID, &version.CreatedByDeviceID,
		&version.Metadata.Format, &lineEnding, &version.VaultRevision, &createdAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return model.FileVersion{}, ErrNotFound
		}
		return model.FileVersion{}, fmt.Errorf("scan file version: %w", err)
	}
	if parentVersionID.Valid {
		version.ParentVersionID = &parentVersionID.String
	}
	if lineEnding.Valid {
		version.Metadata.LineEnding = lineEnding.String
	}
	var err error
	version.CreatedAt, err = parseTime(createdAt)
	if err != nil {
		return model.FileVersion{}, err
	}
	return version, nil
}

func (r *Repository) OpenVersion(ctx context.Context, vault, file, version string) (model.FileVersion, io.ReadCloser, error) {
	v, err := r.FileVersion(ctx, vault, file, version)
	if err != nil {
		return v, nil, err
	}
	if r.blobStore == nil {
		return v, nil, errors.New("blob store not configured")
	}
	body, err := r.blobStore.OpenContext(ctx, vault, v.ContentHash, v.StorageKey)
	return v, body, err
}
