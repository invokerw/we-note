package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/weifei/we-note/services/api/internal/blob"
	"github.com/weifei/we-note/services/api/internal/model"
	"github.com/weifei/we-note/services/api/internal/sqlite"
)

var (
	ErrConflict     = errors.New("resource conflict")
	ErrNotFound     = errors.New("resource not found")
	ErrUnauthorized = errors.New("unauthorized")
)

type Repository struct {
	managedOnline bool
	db            *sqlite.Database
	blobStore     blob.Store
	publicBase    string
	settingsKey   []byte
	Maintenance   sync.RWMutex
	startupStore  blob.Store
	backupMu      sync.Mutex
	mailBase      string
	exportMu      sync.Mutex
	exportRunning bool
}

func NewRepository(db *sqlite.Database, blobStores ...blob.Store) *Repository {
	var blobStore blob.Store
	if len(blobStores) > 0 {
		blobStore = blobStores[0]
	}
	key := make([]byte, 32)
	_, _ = rand.Read(key)
	return &Repository{db: db, blobStore: blobStore, startupStore: blobStore, publicBase: "https://localhost:8443", settingsKey: key}
}

func (r *Repository) SetSettingsKey(key []byte) error {
	if len(key) != 32 {
		return errors.New("settings key must be 32 bytes")
	}
	r.settingsKey = append([]byte(nil), key...)
	return nil
}

func (r *Repository) CreateUser(ctx context.Context, email, passwordHash string) (model.User, error) {
	return r.createUser(ctx, email, passwordHash, "user", "active", time.Now().UTC())
}

func (r *Repository) createUser(ctx context.Context, email, passwordHash, role, status string, verifiedAt time.Time) (model.User, error) {
	normalizedEmail := strings.ToLower(strings.TrimSpace(email))
	if normalizedEmail == "" || passwordHash == "" {
		return model.User{}, fmt.Errorf("email and password hash are required")
	}
	id, err := newID("user")
	if err != nil {
		return model.User{}, err
	}
	createdAt := time.Now().UTC()
	var verifiedValue any
	if !verifiedAt.IsZero() {
		verifiedValue = formatTime(verifiedAt)
	}
	_, err = r.db.ExecContext(ctx, `
		INSERT INTO users(id, email, password_hash, created_at, role, status, email_verified_at, password_changed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, normalizedEmail, passwordHash, formatTime(createdAt), role, status, verifiedValue, formatTime(createdAt))
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed: users.email") {
			return model.User{}, ErrConflict
		}
		return model.User{}, fmt.Errorf("create user: %w", err)
	}
	user := model.User{ID: id, Email: normalizedEmail, Role: role, Status: status, CreatedAt: createdAt}
	if !verifiedAt.IsZero() {
		user.EmailVerifiedAt = &verifiedAt
	}
	return user, nil
}

func (r *Repository) CreatePendingUser(ctx context.Context, email, passwordHash string) (model.User, error) {
	return r.createUser(ctx, email, passwordHash, "user", "active", time.Time{})
}

func (r *Repository) UserByEmail(ctx context.Context, email string) (model.User, string, error) {
	var user model.User
	var passwordHash, createdAt string
	var verifiedAt, disabledAt sql.NullString
	err := r.db.QueryRowContext(ctx, `
		SELECT id, email, password_hash, created_at, role, status, email_verified_at, disabled_at
		FROM users WHERE email = ?`, strings.ToLower(strings.TrimSpace(email))).Scan(
		&user.ID, &user.Email, &passwordHash, &createdAt, &user.Role, &user.Status, &verifiedAt, &disabledAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return model.User{}, "", ErrNotFound
	}
	if err != nil {
		return model.User{}, "", fmt.Errorf("load user by email: %w", err)
	}
	user.CreatedAt, err = parseTime(createdAt)
	if err != nil {
		return model.User{}, "", err
	}
	if verifiedAt.Valid {
		parsed, parseErr := parseTime(verifiedAt.String)
		if parseErr != nil {
			return model.User{}, "", parseErr
		}
		user.EmailVerifiedAt = &parsed
	}
	return user, passwordHash, nil
}

func (r *Repository) UserByID(ctx context.Context, userID string) (model.User, error) {
	var user model.User
	var createdAt string
	var verifiedAt sql.NullString
	err := r.db.QueryRowContext(ctx, `SELECT id, email, created_at, role, status, email_verified_at FROM users WHERE id = ?`, userID).Scan(
		&user.ID, &user.Email, &createdAt, &user.Role, &user.Status, &verifiedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return model.User{}, ErrNotFound
	}
	if err != nil {
		return model.User{}, fmt.Errorf("load user: %w", err)
	}
	user.CreatedAt, err = parseTime(createdAt)
	if err != nil {
		return model.User{}, err
	}
	if verifiedAt.Valid {
		parsed, parseErr := parseTime(verifiedAt.String)
		if parseErr != nil {
			return model.User{}, parseErr
		}
		user.EmailVerifiedAt = &parsed
	}
	return user, nil
}

func (r *Repository) CreateSession(ctx context.Context, userID string, lifetime time.Duration) (model.Session, error) {
	hash, err := r.PasswordHashByID(ctx, userID)
	if err != nil {
		return model.Session{}, err
	}
	return r.CreateLoginSession(ctx, userID, hash, lifetime)
}
func (r *Repository) CreateLoginSession(ctx context.Context, userID, passwordHash string, lifetime time.Duration) (model.Session, error) {
	user, err := r.UserByID(ctx, userID)
	if err != nil {
		return model.Session{}, err
	}
	rawToken := make([]byte, 32)
	if _, err := rand.Read(rawToken); err != nil {
		return model.Session{}, fmt.Errorf("generate access token: %w", err)
	}
	accessToken := base64.RawURLEncoding.EncodeToString(rawToken)
	tokenHash := sha256.Sum256([]byte(accessToken))
	sessionID, err := newID("sess")
	if err != nil {
		return model.Session{}, err
	}
	now := time.Now().UTC()
	expiresAt := now.Add(lifetime)
	refresh, refreshHash, err := sessionSecret()
	if err != nil {
		return model.Session{}, err
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return model.Session{}, err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) SELECT ?,id,?,?,? FROM users WHERE id=? AND password_hash=? AND status='active'`, sessionID, hex.EncodeToString(tokenHash[:]), formatTime(now), formatTime(expiresAt), user.ID, passwordHash)
	if err == nil {
		var n int64
		n, err = res.RowsAffected()
		if n == 0 && err == nil {
			return model.Session{}, ErrUnauthorized
		}
	}
	if err != nil {
		return model.Session{}, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO refresh_sessions VALUES(?,?,?)`, sessionID, refreshHash, formatTime(now.Add(30*24*time.Hour)))
	if err != nil {
		return model.Session{}, err
	}
	return model.Session{AccessToken: accessToken, RefreshToken: refresh, TokenType: "Bearer", ExpiresAt: expiresAt, User: user}, tx.Commit()
}

func (r *Repository) UserByAccessToken(ctx context.Context, accessToken string) (model.User, error) {
	if accessToken == "" {
		return model.User{}, ErrUnauthorized
	}
	tokenHash := sha256.Sum256([]byte(accessToken))
	var user model.User
	var createdAt string
	var verifiedAt sql.NullString
	err := r.db.QueryRowContext(ctx, `
		SELECT u.id, u.email, u.created_at, u.role, u.status, u.email_verified_at
		FROM sessions s
		JOIN users u ON u.id = s.user_id
		WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.status = 'active'`,
		hex.EncodeToString(tokenHash[:]), formatTime(time.Now().UTC())).Scan(&user.ID, &user.Email, &createdAt, &user.Role, &user.Status, &verifiedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return model.User{}, ErrUnauthorized
	}
	if err != nil {
		return model.User{}, fmt.Errorf("load session: %w", err)
	}
	user.CreatedAt, err = parseTime(createdAt)
	if err != nil {
		return model.User{}, err
	}
	if verifiedAt.Valid {
		parsed, parseErr := parseTime(verifiedAt.String)
		if parseErr != nil {
			return model.User{}, parseErr
		}
		user.EmailVerifiedAt = &parsed
	}
	return user, nil
}

func (r *Repository) CreateVault(ctx context.Context, ownerUserID, name string) (model.Vault, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return model.Vault{}, fmt.Errorf("vault name is required")
	}
	if _, err := r.UserByID(ctx, ownerUserID); err != nil {
		return model.Vault{}, err
	}
	id, err := newID("vault")
	if err != nil {
		return model.Vault{}, err
	}
	createdAt := time.Now().UTC()
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return model.Vault{}, fmt.Errorf("begin vault transaction: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO vaults(id, owner_user_id, name, created_at)
		VALUES (?, ?, ?, ?)`, id, ownerUserID, name, formatTime(createdAt)); err != nil {
		return model.Vault{}, fmt.Errorf("create vault: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO workspace_members(vault_id, user_id, role, created_at)
		VALUES (?, ?, 'owner', ?)`, id, ownerUserID, formatTime(createdAt)); err != nil {
		return model.Vault{}, fmt.Errorf("create vault owner membership: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return model.Vault{}, fmt.Errorf("commit vault transaction: %w", err)
	}
	return model.Vault{ID: id, OwnerUserID: ownerUserID, Name: name, CreatedAt: createdAt}, nil
}

func (r *Repository) ListVaults(ctx context.Context, userID string) ([]model.Vault, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT v.id, v.owner_user_id, v.name, v.current_revision, v.min_available_revision, v.created_at
		FROM vaults v
		JOIN workspace_members m ON m.vault_id = v.id
		WHERE m.user_id = ?
		ORDER BY v.created_at, v.id`, userID)
	if err != nil {
		return nil, fmt.Errorf("list vaults: %w", err)
	}
	defer rows.Close()
	vaults := make([]model.Vault, 0)
	for rows.Next() {
		vault, err := scanVault(rows)
		if err != nil {
			return nil, err
		}
		vaults = append(vaults, vault)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate vaults: %w", err)
	}
	return vaults, nil
}

func (r *Repository) VaultForUser(ctx context.Context, userID, vaultID string) (model.Vault, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT v.id, v.owner_user_id, v.name, v.current_revision, v.min_available_revision, v.created_at
		FROM vaults v
		JOIN workspace_members m ON m.vault_id = v.id
		WHERE v.id = ? AND m.user_id = ?`, vaultID, userID)
	vault, err := scanVault(row)
	if errors.Is(err, sql.ErrNoRows) {
		return model.Vault{}, ErrNotFound
	}
	if err != nil {
		return model.Vault{}, err
	}
	return vault, nil
}

func (r *Repository) CreateDevice(ctx context.Context, userID, name, publicKey string) (model.Device, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return model.Device{}, fmt.Errorf("device name is required")
	}
	if _, err := r.UserByID(ctx, userID); err != nil {
		return model.Device{}, err
	}
	id, err := newID("device")
	if err != nil {
		return model.Device{}, err
	}
	createdAt := time.Now().UTC()
	_, err = r.db.ExecContext(ctx, `
		INSERT INTO devices(id, user_id, name, public_key, created_at)
		VALUES (?, ?, ?, ?, ?)`, id, userID, name, publicKey, formatTime(createdAt))
	if err != nil {
		return model.Device{}, fmt.Errorf("create device: %w", err)
	}
	return model.Device{ID: id, UserID: userID, Name: name, PublicKey: publicKey, CreatedAt: createdAt}, nil
}

func (r *Repository) ListDevices(ctx context.Context, userID string) ([]model.Device, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, user_id, name, public_key, created_at
		FROM devices WHERE user_id = ? ORDER BY created_at, id`, userID)
	if err != nil {
		return nil, fmt.Errorf("list devices: %w", err)
	}
	defer rows.Close()
	devices := make([]model.Device, 0)
	for rows.Next() {
		var device model.Device
		var createdAt string
		if err := rows.Scan(&device.ID, &device.UserID, &device.Name, &device.PublicKey, &createdAt); err != nil {
			return nil, fmt.Errorf("scan device: %w", err)
		}
		device.CreatedAt, err = parseTime(createdAt)
		if err != nil {
			return nil, err
		}
		devices = append(devices, device)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate devices: %w", err)
	}
	return devices, nil
}

func (r *Repository) DeleteDevice(ctx context.Context, userID, deviceID string) error {
	result, err := r.db.ExecContext(ctx, `DELETE FROM devices WHERE id = ? AND user_id = ?`, deviceID, userID)
	if err != nil {
		return fmt.Errorf("delete device: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("check deleted device: %w", err)
	}
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

type scanner interface {
	Scan(dest ...any) error
}

func scanVault(row scanner) (model.Vault, error) {
	var vault model.Vault
	var createdAt string
	if err := row.Scan(&vault.ID, &vault.OwnerUserID, &vault.Name, &vault.CurrentRevision, &vault.MinAvailableRevision, &createdAt); err != nil {
		return model.Vault{}, err
	}
	parsed, err := parseTime(createdAt)
	if err != nil {
		return model.Vault{}, err
	}
	vault.CreatedAt = parsed
	return vault, nil
}

func formatTime(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}

func parseTime(value string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse stored time %q: %w", value, err)
	}
	return parsed, nil
}

func newID(prefix string) (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("generate %s id: %w", prefix, err)
	}
	return prefix + "_" + hex.EncodeToString(bytes), nil
}

func sessionSecret() (string, string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	secret := base64.RawURLEncoding.EncodeToString(raw)
	return secret, fmt.Sprintf("%x", sha256.Sum256([]byte(secret))), nil
}
func (r *Repository) Refresh(ctx context.Context, secret string) (model.Session, error) {
	var out model.Session
	now := time.Now().UTC()
	access, accessHash, err := sessionSecret()
	if err != nil {
		return out, err
	}
	refresh, refreshHash, err := sessionSecret()
	if err != nil {
		return out, err
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	var id, created string
	var verifiedAt sql.NullString
	err = tx.QueryRowContext(ctx, `SELECT s.id,u.id,u.email,u.created_at,u.role,u.status,u.email_verified_at FROM refresh_sessions f JOIN sessions s ON s.id=f.session_id JOIN users u ON u.id=s.user_id WHERE f.token_hash=? AND f.expires_at>? AND s.revoked_at IS NULL AND u.status='active'`, fmt.Sprintf("%x", sha256.Sum256([]byte(secret))), formatTime(now)).Scan(&id, &out.User.ID, &out.User.Email, &created, &out.User.Role, &out.User.Status, &verifiedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return out, ErrUnauthorized
	}
	if err != nil {
		return out, err
	}
	out.User.CreatedAt, err = parseTime(created)
	if err != nil {
		return out, err
	}
	if verifiedAt.Valid {
		parsed, parseErr := parseTime(verifiedAt.String)
		if parseErr != nil {
			return out, parseErr
		}
		out.User.EmailVerifiedAt = &parsed
	}
	out.ExpiresAt = now.Add(30 * time.Minute)
	out.AccessToken = access
	out.RefreshToken = refresh
	out.TokenType = "Bearer"
	if _, err := tx.ExecContext(ctx, `UPDATE refresh_sessions SET token_hash=? WHERE session_id=?`, refreshHash, id); err != nil {
		return out, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE sessions SET token_hash=?,expires_at=? WHERE id=?`, accessHash, formatTime(out.ExpiresAt), id); err != nil {
		return out, err
	}
	return out, tx.Commit()
}
func (r *Repository) Logout(ctx context.Context, token string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE sessions SET revoked_at=? WHERE token_hash=?`, formatTime(time.Now().UTC()), fmt.Sprintf("%x", sha256.Sum256([]byte(token))))
	return err
}
