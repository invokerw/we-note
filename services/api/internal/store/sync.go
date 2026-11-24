package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/weifei/we-note/services/api/internal/model"
)

const (
	maxRequestSequence = int64(999999)
	maxSafeRevision    = int64(9007199254740991)
)

var syncHashPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

type SyncError struct {
	Status  int
	Code    string
	Message string
	Fields  map[string]any
}

func (e *SyncError) Error() string {
	return e.Code + ": " + e.Message
}

type SyncSubmitRequest struct {
	VaultID         string
	DeviceID        string
	OperationID     string
	FileID          string
	Operation       string
	Path            string
	BaseRevision    int64
	BaseVersionID   *string
	BaseContentHash *string
	BlobReference   string
	ContentHash     string
	ContentSize     int64
	ClientTimestamp string
	Metadata        model.Metadata
	Fingerprint     string
	RequestJSON     string
	RequestID       string
}

type SyncSubmitResult struct {
	Mode              string  `json:"mode"`
	Replayed          bool    `json:"replayed"`
	VaultID           string  `json:"vault_id"`
	DeviceID          string  `json:"device_id"`
	OperationID       string  `json:"operation_id"`
	FileID            string  `json:"file_id"`
	Path              string  `json:"path"`
	VersionID         string  `json:"version_id"`
	ParentVersionID   *string `json:"parent_version_id"`
	ChangeID          string  `json:"change_id"`
	BlobID            string  `json:"blob_id"`
	ContentHash       string  `json:"content_hash"`
	ContentSize       int64   `json:"content_size"`
	VaultRevision     int64   `json:"vault_revision"`
	OriginalRequestID string  `json:"-"`
}

type SyncPullResult struct {
	Mode                 string         `json:"mode"`
	VaultID              string         `json:"vault_id"`
	DeviceID             string         `json:"device_id"`
	FromRevision         int64          `json:"from_revision"`
	ToRevision           int64          `json:"to_revision"`
	MinAvailableRevision int64          `json:"min_available_revision"`
	HasMore              bool           `json:"has_more"`
	Changes              []model.Change `json:"changes"`
}

type SyncManifestResult struct {
	Mode                 string               `json:"mode"`
	VaultID              string               `json:"vault_id"`
	DeviceID             string               `json:"device_id"`
	SnapshotRevision     int64                `json:"snapshot_revision"`
	MinAvailableRevision int64                `json:"min_available_revision"`
	Files                []model.ManifestFile `json:"files"`
}

func (r *Repository) UserCanAccessVault(ctx context.Context, userID, vaultID string) (bool, error) {
	var found int
	err := r.db.QueryRowContext(ctx, `SELECT 1 FROM workspace_members WHERE user_id = ? AND vault_id = ?`, userID, vaultID).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("check user vault access: %w", err)
	}
	return found == 1, nil
}

func (r *Repository) UserCanWriteVault(ctx context.Context, userID, vaultID string) (bool, error) {
	var role string
	err := r.db.QueryRowContext(ctx, `SELECT role FROM workspace_members WHERE user_id = ? AND vault_id = ?`, userID, vaultID).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("check user vault write access: %w", err)
	}
	return role == "owner" || role == "editor", nil
}

func (r *Repository) DeviceCanAccessVault(ctx context.Context, userID, vaultID, deviceID string) (bool, error) {
	var found int
	err := r.db.QueryRowContext(ctx, `
		SELECT 1
		FROM devices d
		JOIN workspace_members m ON m.user_id = d.user_id
		WHERE d.id = ? AND d.user_id = ? AND m.vault_id = ?`, deviceID, userID, vaultID).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("check device vault access: %w", err)
	}
	return found == 1, nil
}

func (r *Repository) DeviceCanWriteVault(ctx context.Context, userID, vaultID, deviceID string) (bool, error) {
	var role string
	err := r.db.QueryRowContext(ctx, `
		SELECT m.role
		FROM devices d
		JOIN workspace_members m ON m.user_id = d.user_id
		WHERE d.id = ? AND d.user_id = ? AND m.vault_id = ?`, deviceID, userID, vaultID).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("check device vault write access: %w", err)
	}
	return role == "owner" || role == "editor", nil
}

func (r *Repository) NextSyncRequestID(ctx context.Context, vaultID string) (string, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return "", fmt.Errorf("begin request id transaction: %w", err)
	}
	defer tx.Rollback()

	var sequence int64
	if err := tx.QueryRowContext(ctx, `SELECT request_sequence FROM vaults WHERE id = ?`, vaultID).Scan(&sequence); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", fmt.Errorf("load request sequence: %w", err)
	}
	if sequence >= maxRequestSequence {
		return "", &SyncError{
			Status:  503,
			Code:    "REQUEST_ID_EXHAUSTED",
			Message: "request_id 序号已经用尽。",
			Fields:  map[string]any{"request_id": nil},
		}
	}
	sequence++
	if _, err := tx.ExecContext(ctx, `UPDATE vaults SET request_sequence = ? WHERE id = ?`, sequence, vaultID); err != nil {
		return "", fmt.Errorf("advance request sequence: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return "", fmt.Errorf("commit request id transaction: %w", err)
	}
	return fmt.Sprintf("req_%06d", sequence), nil
}

func (r *Repository) CreateUploadSession(ctx context.Context, vaultID string, contentHash string, contentSize int64) (model.UploadSession, error) {
	if !syncHashPattern.MatchString(contentHash) {
		return model.UploadSession{}, fmt.Errorf("invalid content hash")
	}
	if contentSize < 0 {
		return model.UploadSession{}, fmt.Errorf("content size cannot be negative")
	}
	id, err := newID("upload")
	if err != nil {
		return model.UploadSession{}, err
	}
	createdAt := time.Now().UTC()
	_, err = r.db.ExecContext(ctx, `
		INSERT INTO upload_sessions(id, vault_id, content_hash, content_size, status, created_at)
		VALUES (?, ?, ?, ?, 'pending', ?)`, id, vaultID, contentHash, contentSize, formatTime(createdAt))
	if err != nil {
		return model.UploadSession{}, fmt.Errorf("create upload session: %w", err)
	}
	return model.UploadSession{
		ID:            id,
		BlobReference: id,
		VaultID:       vaultID,
		ContentHash:   contentHash,
		ContentSize:   contentSize,
		Status:        "pending",
		CreatedAt:     createdAt,
	}, nil
}

func (r *Repository) CompleteUploadSession(ctx context.Context, vaultID, uploadID string, source io.Reader) (model.UploadSession, error) {
	if r.blobStore == nil {
		return model.UploadSession{}, fmt.Errorf("blob store is not configured")
	}
	session, err := r.uploadSession(ctx, vaultID, uploadID)
	if err != nil {
		return model.UploadSession{}, err
	}
	if session.Status == "completed" {
		return session, nil
	}
	if session.Status != "pending" {
		return model.UploadSession{}, fmt.Errorf("upload session is not pending")
	}
	storageKey, err := r.blobStore.PutAt(ctx, vaultID, session.ContentHash, session.ContentSize, session.CreatedAt, source)
	if err != nil {
		return model.UploadSession{}, err
	}
	blobID := blobIDForHash(session.ContentHash)
	now := time.Now().UTC()
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return model.UploadSession{}, fmt.Errorf("begin upload completion transaction: %w", err)
	}
	defer tx.Rollback()
	if err := ensureBlobTx(ctx, tx, vaultID, blobID, session.ContentHash, session.ContentSize, storageKey, now); err != nil {
		return model.UploadSession{}, err
	}
	result, err := tx.ExecContext(ctx, `
		UPDATE upload_sessions
		SET blob_id = ?, storage_key = ?, status = 'completed', completed_at = ?
		WHERE id = ? AND vault_id = ? AND status = 'pending'`, blobID, storageKey, formatTime(now), uploadID, vaultID)
	if err != nil {
		return model.UploadSession{}, fmt.Errorf("complete upload session: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return model.UploadSession{}, fmt.Errorf("check upload completion: %w", err)
	}
	if rows == 0 {
		_ = tx.Rollback()
		return r.uploadSession(ctx, vaultID, uploadID)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM upload_part_leases WHERE upload_id=?`, uploadID); err != nil {
		return model.UploadSession{}, err
	}
	if err := tx.Commit(); err != nil {
		return model.UploadSession{}, fmt.Errorf("commit upload completion: %w", err)
	}
	session.Status = "completed"
	session.BlobID = blobID
	session.CompletedAt = &now
	return session, nil
}

func (r *Repository) UploadSession(ctx context.Context, vaultID, uploadID string) (model.UploadSession, error) {
	return r.uploadSession(ctx, vaultID, uploadID)
}

func (r *Repository) SubmitSyncChange(ctx context.Context, request SyncSubmitRequest) (SyncSubmitResult, error) {
	if request.RequestID == "" || request.Fingerprint == "" {
		return SyncSubmitResult{}, fmt.Errorf("sync request tracking fields are required")
	}
	if r.blobStore == nil {
		return SyncSubmitResult{}, fmt.Errorf("blob store is not configured")
	}

	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return SyncSubmitResult{}, fmt.Errorf("begin sync transaction: %w", err)
	}
	defer tx.Rollback()

	var currentRevision int64
	if err := tx.QueryRowContext(ctx, `SELECT current_revision FROM vaults WHERE id = ?`, request.VaultID).Scan(&currentRevision); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return SyncSubmitResult{}, ErrNotFound
		}
		return SyncSubmitResult{}, fmt.Errorf("load vault revision: %w", err)
	}

	if request.BaseRevision > currentRevision {
		return SyncSubmitResult{}, &SyncError{
			Status:  400,
			Code:    "INVALID_REQUEST",
			Message: "base_revision 不能晚于服务端当前 revision。",
			Fields:  map[string]any{"base_revision": request.BaseRevision, "current_vault_revision": currentRevision},
		}
	}

	var storedFingerprint, storedRequestID, storedResultJSON string
	err = tx.QueryRowContext(ctx, `
		SELECT fingerprint, request_id, result_json
		FROM sync_operations WHERE vault_id = ? AND operation_id = ?`, request.VaultID, request.OperationID).
		Scan(&storedFingerprint, &storedRequestID, &storedResultJSON)
	if err == nil {
		if storedFingerprint != request.Fingerprint {
			var storedResult SyncSubmitResult
			if err := json.Unmarshal([]byte(storedResultJSON), &storedResult); err != nil {
				return SyncSubmitResult{}, fmt.Errorf("decode stored sync result: %w", err)
			}
			return SyncSubmitResult{}, &SyncError{
				Status:  409,
				Code:    "IDEMPOTENCY_KEY_REUSED",
				Message: "operation_id 已用于另一份请求内容。",
				Fields: map[string]any{
					"operation_id":        request.OperationID,
					"change_id":           storedResult.ChangeID,
					"original_request_id": storedRequestID,
					"replayable":          true,
					"version_id":          storedResult.VersionID,
					"file_id":             storedResult.FileID,
					"vault_revision":      storedResult.VaultRevision,
				},
			}
		}
		var result SyncSubmitResult
		if err := json.Unmarshal([]byte(storedResultJSON), &result); err != nil {
			return SyncSubmitResult{}, fmt.Errorf("decode stored sync result: %w", err)
		}
		result.Replayed = true
		result.OriginalRequestID = storedRequestID
		if err := tx.Commit(); err != nil {
			return SyncSubmitResult{}, fmt.Errorf("close replay transaction: %w", err)
		}
		return result, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return SyncSubmitResult{}, fmt.Errorf("load sync operation: %w", err)
	}

	var existingChangeID, existingFileID, existingVersionID string
	var existingRevision int64
	err = tx.QueryRowContext(ctx, `
		SELECT id, file_id, version_id, vault_revision
		FROM changes WHERE vault_id = ? AND operation_id = ?`, request.VaultID, request.OperationID).
		Scan(&existingChangeID, &existingFileID, &existingVersionID, &existingRevision)
	if err == nil {
		return SyncSubmitResult{}, &SyncError{
			Status:  409,
			Code:    "IDEMPOTENCY_KEY_REUSED",
			Message: "operation_id 已被历史变更占用，无法复用。",
			Fields: map[string]any{
				"operation_id":        request.OperationID,
				"change_id":           existingChangeID,
				"original_request_id": nil,
				"replayable":          false,
				"file_id":             existingFileID,
				"version_id":          existingVersionID,
				"vault_revision":      existingRevision,
			},
		}
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return SyncSubmitResult{}, fmt.Errorf("load historical operation: %w", err)
	}

	file, err := loadSyncFile(ctx, tx, request.VaultID, request.FileID)
	if errors.Is(err, sql.ErrNoRows) {
		return SyncSubmitResult{}, &SyncError{
			Status:  404,
			Code:    "FILE_NOT_FOUND",
			Message: "文件不存在。",
			Fields:  map[string]any{"file_id": request.FileID},
		}
	}
	if err != nil {
		return SyncSubmitResult{}, fmt.Errorf("load sync file: %w", err)
	}
	if file.Path != request.Path {
		return SyncSubmitResult{}, &SyncError{
			Status:  400,
			Code:    "PATH_MISMATCH",
			Message: "请求路径与文件当前路径不一致。",
			Fields:  map[string]any{"path": request.Path, "current_path": file.Path},
		}
	}
	if file.Format != request.Metadata.Format {
		return SyncSubmitResult{}, &SyncError{
			Status:  400,
			Code:    "FORMAT_MISMATCH",
			Message: "请求格式与文件格式不一致。",
			Fields:  map[string]any{"format": request.Metadata.Format, "current_format": file.Format},
		}
	}
	currentVersionID := file.CurrentVersionID
	currentHash := file.CurrentContentHash
	currentSize := file.CurrentContentSize
	currentBlobID := file.CurrentBlobID
	if currentVersionID != nil && (currentHash == "" || currentBlobID == "") {
		var versionHash, versionBlob string
		var versionSize int64
		if err := tx.QueryRowContext(ctx, `SELECT content_hash, content_size, blob_id FROM file_versions WHERE id = ?`, *currentVersionID).
			Scan(&versionHash, &versionSize, &versionBlob); err != nil {
			return SyncSubmitResult{}, fmt.Errorf("load current file version: %w", err)
		}
		if currentHash == "" {
			currentHash = versionHash
		}
		if currentSize == 0 {
			currentSize = versionSize
		}
		if currentBlobID == "" {
			currentBlobID = versionBlob
		}
	}
	versionMatches := request.BaseVersionID != nil && currentVersionID != nil && *request.BaseVersionID == *currentVersionID
	hashMatches := request.BaseContentHash != nil && *request.BaseContentHash == currentHash
	if (request.BaseVersionID != nil && !versionMatches) || (request.BaseContentHash != nil && !hashMatches) {
		return SyncSubmitResult{}, &SyncError{
			Status:  409,
			Code:    "FILE_VERSION_CONFLICT",
			Message: "目标文件已被修改，提交基准落后于服务端当前版本。",
			Fields: map[string]any{
				"file_id":              request.FileID,
				"path":                 file.Path,
				"base_version_id":      nullableString(request.BaseVersionID),
				"base_content_hash":    nullableString(request.BaseContentHash),
				"current_version_id":   nullableString(currentVersionID),
				"current_content_hash": currentHash,
				"current_content_size": currentSize,
				"current_blob_id":      currentBlobID,
				"conflict_resolution":  "fetch_current_version_then_three_way_merge",
			},
		}
	}
	upload, err := loadUploadSessionTx(ctx, tx, request.VaultID, request.BlobReference)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return SyncSubmitResult{}, fmt.Errorf("load upload session: %w", err)
	}
	if errors.Is(err, ErrNotFound) || upload.Status != "completed" {
		return SyncSubmitResult{}, &SyncError{
			Status:  409,
			Code:    "UPLOAD_NOT_READY",
			Message: "上传内容尚未完成。",
			Fields:  map[string]any{"blob_reference": request.BlobReference},
		}
	}
	if err != nil {
		return SyncSubmitResult{}, fmt.Errorf("load upload session for submit: %w", err)
	}
	if upload.ContentSize != request.ContentSize {
		return SyncSubmitResult{}, &SyncError{
			Status:  409,
			Code:    "CONTENT_SIZE_MISMATCH",
			Message: "请求内容大小与上传会话不一致。",
			Fields: map[string]any{
				"content_size":        request.ContentSize,
				"actual_content_size": upload.ContentSize,
				"upload_content_size": upload.ContentSize,
			},
		}
	}
	if upload.ContentHash != request.ContentHash {
		return SyncSubmitResult{}, &SyncError{
			Status:  409,
			Code:    "CONTENT_HASH_MISMATCH",
			Message: "请求内容哈希与上传会话不一致。",
			Fields: map[string]any{
				"content_hash":        request.ContentHash,
				"actual_content_hash": upload.ContentHash,
				"upload_content_hash": upload.ContentHash,
			},
		}
	}
	actualSize, actualHash, err := r.verifyBlob(ctx, tx, request.VaultID, request.ContentHash)
	if err != nil {
		return SyncSubmitResult{}, &SyncError{
			Status:  409,
			Code:    "UPLOAD_NOT_READY",
			Message: "上传内容不可读取。",
			Fields:  map[string]any{"blob_reference": request.BlobReference},
		}
	}
	if actualSize != request.ContentSize || actualSize != upload.ContentSize {
		return SyncSubmitResult{}, &SyncError{
			Status:  409,
			Code:    "CONTENT_SIZE_MISMATCH",
			Message: "请求内容大小与实际上传字节不一致。",
			Fields: map[string]any{
				"content_size":        request.ContentSize,
				"actual_content_size": actualSize,
				"upload_content_size": upload.ContentSize,
			},
		}
	}
	if actualHash != request.ContentHash || actualHash != upload.ContentHash {
		return SyncSubmitResult{}, &SyncError{
			Status:  409,
			Code:    "CONTENT_HASH_MISMATCH",
			Message: "请求内容哈希与实际上传字节不一致。",
			Fields: map[string]any{
				"content_hash":        request.ContentHash,
				"actual_content_hash": actualHash,
				"upload_content_hash": upload.ContentHash,
			},
		}
	}

	if request.Metadata.Format == "md" {
		data, err := r.readNoteBlobWithQuery(ctx, tx, request.VaultID, request.ContentHash, request.ContentSize)
		if err != nil {
			return SyncSubmitResult{}, err
		}
		if err := r.validateAssetReferences(ctx, tx, request.VaultID, data); err != nil {
			return SyncSubmitResult{}, err
		}
	}
	if currentRevision >= maxSafeRevision {
		return SyncSubmitResult{}, &SyncError{
			Status:  503,
			Code:    "REVISION_EXHAUSTED",
			Message: "Vault revision 已达到可安全表示的上限。",
			Fields:  map[string]any{"vault_revision": currentRevision, "max_safe_revision": maxSafeRevision},
		}
	}
	newRevision := currentRevision + 1
	versionID, err := newID("ver")
	if err != nil {
		return SyncSubmitResult{}, err
	}
	changeID, err := newID("change")
	if err != nil {
		return SyncSubmitResult{}, err
	}
	blobID := blobIDForHash(request.ContentHash)
	createdAt, err := parseClientTimestamp(request.ClientTimestamp)
	if err != nil {
		return SyncSubmitResult{}, fmt.Errorf("parse client timestamp: %w", err)
	}
	storageKey := upload.StorageKey
	if storageKey == "" {
		storageKey = storageKeyForHash(request.VaultID, request.ContentHash, upload.CreatedAt)
	}
	if err := ensureBlobTx(ctx, tx, request.VaultID, blobID, request.ContentHash, request.ContentSize, storageKey, time.Now().UTC()); err != nil {
		return SyncSubmitResult{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO file_versions(
			id, vault_id, file_id, blob_id, content_hash, content_size, parent_version_id,
			created_by_device_id, metadata_format, metadata_line_ending, vault_revision, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		versionID, request.VaultID, request.FileID, blobID, request.ContentHash, request.ContentSize,
		nullableString(currentVersionID), request.DeviceID, request.Metadata.Format,
		nullableLineEnding(request.Metadata.LineEnding), newRevision, formatTime(createdAt)); err != nil {
		return SyncSubmitResult{}, fmt.Errorf("create file version: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE files
		SET current_version_id = ?, current_content_hash = ?, current_content_size = ?, current_blob_id = ?,
			is_deleted = 0, updated_at = ?
		WHERE id = ? AND vault_id = ?`,
		versionID, request.ContentHash, request.ContentSize, blobID, formatTime(createdAt), request.FileID, request.VaultID); err != nil {
		return SyncSubmitResult{}, fmt.Errorf("update current file: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO changes(
			id, vault_id, vault_revision, file_id, version_id, operation_id, operation, path,
			parent_version_id, device_id, client_timestamp, content_hash, content_size, request_id, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		changeID, request.VaultID, newRevision, request.FileID, versionID, request.OperationID, request.Operation,
		request.Path, nullableString(currentVersionID), request.DeviceID, request.ClientTimestamp,
		request.ContentHash, request.ContentSize, request.RequestID, formatTime(createdAt)); err != nil {
		return SyncSubmitResult{}, fmt.Errorf("create sync change: %w", err)
	}
	parentVersionID := currentVersionID
	result := SyncSubmitResult{
		Mode:            "submit",
		Replayed:        false,
		VaultID:         request.VaultID,
		DeviceID:        request.DeviceID,
		OperationID:     request.OperationID,
		FileID:          request.FileID,
		Path:            request.Path,
		VersionID:       versionID,
		ParentVersionID: parentVersionID,
		ChangeID:        changeID,
		BlobID:          blobID,
		ContentHash:     request.ContentHash,
		ContentSize:     request.ContentSize,
		VaultRevision:   newRevision,
	}
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return SyncSubmitResult{}, fmt.Errorf("encode sync result: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO sync_operations(
			vault_id, operation_id, fingerprint, request_id, request_json, result_json,
			change_id, version_id, file_id, path, vault_revision, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		request.VaultID, request.OperationID, request.Fingerprint, request.RequestID, request.RequestJSON,
		string(resultJSON), changeID, versionID, request.FileID, request.Path, newRevision, formatTime(time.Now().UTC())); err != nil {
		return SyncSubmitResult{}, fmt.Errorf("record sync operation: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE vaults SET current_revision = ? WHERE id = ?`, newRevision, request.VaultID); err != nil {
		return SyncSubmitResult{}, fmt.Errorf("advance vault revision: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return SyncSubmitResult{}, fmt.Errorf("commit sync transaction: %w", err)
	}
	return result, nil
}

func (r *Repository) PullSyncChanges(ctx context.Context, vaultID, deviceID string, cursor int64) (SyncPullResult, error) {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return SyncPullResult{}, err
	}
	defer tx.Rollback()
	var currentRevision, minRevision int64
	if err := tx.QueryRowContext(ctx, `SELECT current_revision, min_available_revision FROM vaults WHERE id = ?`, vaultID).
		Scan(&currentRevision, &minRevision); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return SyncPullResult{}, ErrNotFound
		}
		return SyncPullResult{}, fmt.Errorf("load sync cursor: %w", err)
	}
	if cursor < minRevision {
		return SyncPullResult{}, &SyncError{
			Status:  409,
			Code:    "CURSOR_TOO_OLD",
			Message: "拉取游标早于服务端仍可增量提供的下界，需要先获取 manifest 快照。",
			Fields: map[string]any{
				"vault_id":               vaultID,
				"device_id":              deviceID,
				"requested_revision":     cursor,
				"min_available_revision": minRevision,
				"current_vault_revision": currentRevision,
				"manifest_endpoint":      "/api/v1/vaults/" + vaultID + "/sync/manifest",
			},
		}
	}
	rows, err := tx.QueryContext(ctx, `
		SELECT id, vault_id, vault_revision, file_id, version_id, operation_id, operation, path,
			parent_version_id, device_id, client_timestamp, content_hash, content_size, created_at
		FROM changes
		WHERE vault_id = ? AND vault_revision > ?
		ORDER BY vault_revision`, vaultID, cursor)
	if err != nil {
		return SyncPullResult{}, fmt.Errorf("list sync changes: %w", err)
	}
	defer rows.Close()
	changes := make([]model.Change, 0)
	for rows.Next() {
		change, err := scanSyncChange(rows)
		if err != nil {
			return SyncPullResult{}, err
		}
		changes = append(changes, change)
	}
	if err := rows.Err(); err != nil {
		return SyncPullResult{}, fmt.Errorf("iterate sync changes: %w", err)
	}
	return SyncPullResult{
		Mode:                 "pull",
		VaultID:              vaultID,
		DeviceID:             deviceID,
		FromRevision:         cursor,
		ToRevision:           currentRevision,
		MinAvailableRevision: minRevision,
		HasMore:              false,
		Changes:              changes,
	}, nil
}

func (r *Repository) Manifest(ctx context.Context, vaultID, deviceID string) (SyncManifestResult, error) {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return SyncManifestResult{}, err
	}
	defer tx.Rollback()
	var currentRevision, minRevision int64
	if err := tx.QueryRowContext(ctx, `SELECT current_revision, min_available_revision FROM vaults WHERE id = ?`, vaultID).
		Scan(&currentRevision, &minRevision); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return SyncManifestResult{}, ErrNotFound
		}
		return SyncManifestResult{}, fmt.Errorf("load manifest revision: %w", err)
	}
	rows, err := tx.QueryContext(ctx, `
		SELECT f.id, f.vault_id, f.path, f.format, f.current_version_id,
			COALESCE(NULLIF(f.current_content_hash, ''), v.content_hash, ''),
			COALESCE(NULLIF(f.current_content_size, 0), v.content_size, 0),
			COALESCE(NULLIF(f.current_blob_id, ''), v.blob_id, ''), f.is_deleted
		FROM files f
		LEFT JOIN file_versions v ON v.id = f.current_version_id AND v.vault_id=f.vault_id AND v.file_id=f.id
		WHERE f.vault_id = ?
		ORDER BY f.path, f.id`, vaultID)
	if err != nil {
		return SyncManifestResult{}, fmt.Errorf("list manifest files: %w", err)
	}
	defer rows.Close()
	files := make([]model.ManifestFile, 0)
	for rows.Next() {
		var file model.ManifestFile
		var currentVersionID sql.NullString
		var isDeleted int
		if err := rows.Scan(&file.ID, &file.VaultID, &file.Path, &file.Format, &currentVersionID,
			&file.CurrentContentHash, &file.ContentSize, &file.BlobID, &isDeleted); err != nil {
			return SyncManifestResult{}, fmt.Errorf("scan manifest file: %w", err)
		}
		if currentVersionID.Valid {
			file.CurrentVersionID = &currentVersionID.String
		}
		file.IsDeleted = isDeleted != 0
		files = append(files, file)
	}
	if err := rows.Err(); err != nil {
		return SyncManifestResult{}, fmt.Errorf("iterate manifest files: %w", err)
	}
	return SyncManifestResult{
		Mode:                 "manifest",
		VaultID:              vaultID,
		DeviceID:             deviceID,
		SnapshotRevision:     currentRevision,
		MinAvailableRevision: minRevision,
		Files:                files,
	}, nil
}

func (r *Repository) verifyBlob(ctx context.Context, queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, vaultID, contentHash string) (int64, string, error) {
	var storageKey string
	if err := queryer.QueryRowContext(ctx, `SELECT storage_key FROM blobs WHERE vault_id=? AND content_hash=?`, vaultID, contentHash).Scan(&storageKey); err != nil {
		return 0, "", err
	}
	reader, err := r.blobStore.OpenContext(ctx, vaultID, contentHash, storageKey)
	if err != nil {
		return 0, "", err
	}
	defer reader.Close()
	hasher := sha256.New()
	size, err := io.Copy(hasher, reader)
	if err != nil {
		return 0, "", err
	}
	return size, "sha256:" + hex.EncodeToString(hasher.Sum(nil)), nil
}

func (r *Repository) uploadSession(ctx context.Context, vaultID, uploadID string) (model.UploadSession, error) {
	return loadUploadSession(ctx, r.db, vaultID, uploadID)
}

func loadUploadSession(ctx context.Context, db interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, vaultID, uploadID string) (model.UploadSession, error) {
	return scanUploadSession(db.QueryRowContext(ctx, `
		SELECT id, vault_id, blob_id, content_hash, content_size, status, created_at, completed_at, storage_key
		FROM upload_sessions WHERE id = ? AND vault_id = ?`, uploadID, vaultID))
}

func loadUploadSessionTx(ctx context.Context, tx *sql.Tx, vaultID, uploadID string) (model.UploadSession, error) {
	return loadUploadSession(ctx, tx, vaultID, uploadID)
}

func scanUploadSession(scanner interface{ Scan(...any) error }) (model.UploadSession, error) {
	var session model.UploadSession
	var blobID, storageKey, completedAt sql.NullString
	var createdAt string
	err := scanner.Scan(&session.ID, &session.VaultID, &blobID, &session.ContentHash, &session.ContentSize,
		&session.Status, &createdAt, &completedAt, &storageKey)
	if errors.Is(err, sql.ErrNoRows) {
		return model.UploadSession{}, ErrNotFound
	}
	if err != nil {
		return model.UploadSession{}, fmt.Errorf("load upload session: %w", err)
	}
	session.BlobReference = session.ID
	if blobID.Valid {
		session.BlobID = blobID.String
	}
	if storageKey.Valid {
		session.StorageKey = storageKey.String
	}
	if session.CreatedAt, err = parseTime(createdAt); err != nil {
		return model.UploadSession{}, err
	}
	if completedAt.Valid {
		parsed, err := parseTime(completedAt.String)
		if err != nil {
			return model.UploadSession{}, err
		}
		session.CompletedAt = &parsed
	}
	return session, nil
}

func loadSyncFile(ctx context.Context, tx *sql.Tx, vaultID, fileID string) (syncFile, error) {
	var file syncFile
	var currentVersionID sql.NullString
	var isDeleted int
	err := tx.QueryRowContext(ctx, `
		SELECT id, path, format, current_version_id, current_content_hash, current_content_size, current_blob_id, is_deleted
		FROM files WHERE id = ? AND vault_id = ?`, fileID, vaultID).Scan(
		&file.ID, &file.Path, &file.Format, &currentVersionID, &file.CurrentContentHash,
		&file.CurrentContentSize, &file.CurrentBlobID, &isDeleted)
	if err != nil {
		return syncFile{}, err
	}
	if currentVersionID.Valid {
		file.CurrentVersionID = &currentVersionID.String
	}
	file.IsDeleted = isDeleted != 0
	return file, nil
}

type syncFile struct {
	ID                 string
	Path               string
	Format             string
	CurrentVersionID   *string
	CurrentContentHash string
	CurrentContentSize int64
	CurrentBlobID      string
	IsDeleted          bool
}

func scanSyncChange(scanner interface{ Scan(...any) error }) (model.Change, error) {
	var change model.Change
	var parentVersionID sql.NullString
	var createdAt string
	if err := scanner.Scan(&change.ID, &change.VaultID, &change.VaultRevision, &change.FileID, &change.VersionID,
		&change.OperationID, &change.Operation, &change.Path, &parentVersionID, &change.DeviceID,
		&change.ClientTimestamp, &change.ContentHash, &change.ContentSize, &createdAt); err != nil {
		return model.Change{}, fmt.Errorf("scan sync change: %w", err)
	}
	if parentVersionID.Valid {
		change.ParentVersionID = &parentVersionID.String
	}
	var err error
	change.CreatedAt, err = parseTime(createdAt)
	if err != nil {
		return model.Change{}, err
	}
	return change, nil
}

func ensureBlobTx(ctx context.Context, tx *sql.Tx, vaultID, blobID, contentHash string, contentSize int64, storageKey string, createdAt time.Time) error {
	var existingHash string
	var existingSize int64
	var existingStorageKey string
	err := tx.QueryRowContext(ctx, `
		SELECT content_hash, content_size, storage_key FROM blobs WHERE vault_id = ? AND content_hash = ?`, vaultID, contentHash).
		Scan(&existingHash, &existingSize, &existingStorageKey)
	if err == nil {
		if existingHash != contentHash || existingSize != contentSize || existingStorageKey == "" {
			return &SyncError{
				Status:  409,
				Code:    "CONTENT_SIZE_MISMATCH",
				Message: "已有 Blob 的内容声明不一致。",
				Fields: map[string]any{
					"content_size":        contentSize,
					"actual_content_size": existingSize,
					"upload_content_size": existingSize,
				},
			}
		}
		// A repeated write on a later UTC date can leave two physical keys for this hash.
		if existingStorageKey != storageKey {
			_, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO retired_object_keys(vault_id,hash,storage_key) VALUES(?,?,?)`, vaultID, contentHash, storageKey)
			return err
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("load blob: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO blobs(id, vault_id, content_hash, content_size, storage_key, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`, blobID, vaultID, contentHash, contentSize, storageKey, formatTime(createdAt)); err != nil {
		return fmt.Errorf("record blob: %w", err)
	}
	return nil
}

func blobIDForHash(contentHash string) string {
	return "blob_" + strings.TrimPrefix(contentHash, "sha256:")
}

func storageKeyForHash(vaultID, contentHash string, createdAt time.Time) string {
	hexHash := strings.TrimPrefix(contentHash, "sha256:")
	return "blobs/" + vaultID + "/" + createdAt.UTC().Format("2006/01/02") + "/" + hexHash
}

func nullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableLineEnding(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func parseClientTimestamp(value string) (time.Time, error) {
	if !strings.HasSuffix(value, "Z") || len(value) < 20 {
		return time.Time{}, errors.New("client timestamp must be RFC3339 UTC")
	}
	return time.Parse(time.RFC3339Nano, value)
}

func FingerprintRequest(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(encoded)
	return "sha256:" + hex.EncodeToString(hash[:]), nil
}
