package model

import "time"

type User struct {
	ID              string     `json:"id"`
	Email           string     `json:"email"`
	Role            string     `json:"role,omitempty"`
	Status          string     `json:"status,omitempty"`
	EmailVerifiedAt *time.Time `json:"email_verified_at,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
}

type Vault struct {
	ID                   string    `json:"id"`
	OwnerUserID          string    `json:"owner_user_id"`
	Name                 string    `json:"name"`
	CurrentRevision      int64     `json:"current_revision"`
	MinAvailableRevision int64     `json:"min_available_revision"`
	CreatedAt            time.Time `json:"created_at"`
}

type Device struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id"`
	Name      string    `json:"name"`
	PublicKey string    `json:"public_key,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

type File struct {
	ID                 string    `json:"file_id"`
	VaultID            string    `json:"vault_id"`
	Path               string    `json:"path"`
	Format             string    `json:"format"`
	CurrentVersionID   *string   `json:"current_version_id,omitempty"`
	CurrentContentHash string    `json:"current_content_hash,omitempty"`
	CurrentContentSize int64     `json:"current_content_size"`
	CurrentBlobID      string    `json:"current_blob_id,omitempty"`
	IsDeleted          bool      `json:"is_deleted"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}

type FileVersion struct {
	ID                string    `json:"version_id"`
	FileID            string    `json:"file_id"`
	VaultID           string    `json:"vault_id"`
	BlobID            string    `json:"blob_id"`
	ContentHash       string    `json:"content_hash"`
	ContentSize       int64     `json:"content_size"`
	ParentVersionID   *string   `json:"parent_version_id,omitempty"`
	CreatedByDeviceID string    `json:"created_by_device_id,omitempty"`
	Metadata          Metadata  `json:"metadata,omitempty"`
	VaultRevision     int64     `json:"vault_revision"`
	CreatedAt         time.Time `json:"created_at"`
}

type Change struct {
	ID              string    `json:"change_id"`
	VaultID         string    `json:"vault_id"`
	VaultRevision   int64     `json:"vault_revision"`
	FileID          string    `json:"file_id"`
	VersionID       string    `json:"version_id"`
	OperationID     string    `json:"operation_id"`
	Operation       string    `json:"operation"`
	Path            string    `json:"path"`
	ParentVersionID *string   `json:"parent_version_id,omitempty"`
	DeviceID        string    `json:"device_id"`
	ClientTimestamp string    `json:"client_timestamp"`
	ContentHash     string    `json:"content_hash"`
	ContentSize     int64     `json:"content_size"`
	RequestID       string    `json:"request_id"`
	CreatedAt       time.Time `json:"created_at"`
}

type Metadata struct {
	Format     string `json:"format"`
	LineEnding string `json:"line_ending,omitempty"`
}

type ChangeRequest struct {
	Mode            string   `json:"mode"`
	VaultID         string   `json:"vault_id"`
	DeviceID        string   `json:"device_id"`
	OperationID     string   `json:"operation_id"`
	BaseRevision    int64    `json:"base_revision"`
	BaseVersionID   string   `json:"base_version_id,omitempty"`
	BaseContentHash string   `json:"base_content_hash,omitempty"`
	FileID          string   `json:"file_id"`
	Operation       string   `json:"operation"`
	Path            string   `json:"path"`
	ContentHash     string   `json:"content_hash"`
	ContentSize     int64    `json:"content_size"`
	BlobReference   string   `json:"blob_reference"`
	ClientTimestamp string   `json:"client_timestamp"`
	Metadata        Metadata `json:"metadata"`
}

type Manifest struct {
	VaultID              string `json:"vault_id"`
	SnapshotRevision     int64  `json:"snapshot_revision"`
	MinAvailableRevision int64  `json:"min_available_revision"`
	Files                []File `json:"files"`
}

type RegisterRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type LoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type Session struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token,omitempty"`
	TokenType    string    `json:"token_type"`
	ExpiresAt    time.Time `json:"expires_at"`
	User         User      `json:"user"`
}

type CreateVaultRequest struct {
	Name string `json:"name"`
}

type CreateDeviceRequest struct {
	Name      string `json:"name"`
	PublicKey string `json:"public_key"`
}

type ManifestFile struct {
	ID                 string  `json:"file_id"`
	VaultID            string  `json:"vault_id,omitempty"`
	Path               string  `json:"path"`
	Format             string  `json:"format"`
	CurrentVersionID   *string `json:"current_version_id,omitempty"`
	CurrentContentHash string  `json:"current_content_hash,omitempty"`
	ContentSize        int64   `json:"content_size"`
	BlobID             string  `json:"blob_id,omitempty"`
	IsDeleted          bool    `json:"is_deleted"`
}

type UploadSession struct {
	ID            string     `json:"upload_id"`
	BlobReference string     `json:"blob_reference"`
	VaultID       string     `json:"vault_id"`
	ContentHash   string     `json:"content_hash"`
	ContentSize   int64      `json:"content_size"`
	Status        string     `json:"status"`
	BlobID        string     `json:"blob_id,omitempty"`
	StorageKey    string     `json:"-"`
	CreatedAt     time.Time  `json:"created_at"`
	CompletedAt   *time.Time `json:"completed_at,omitempty"`
}
