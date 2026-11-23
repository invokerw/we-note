package store

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/weifei/we-note/services/api/internal/model"
)

type AdminOverview struct {
	Users          int64 `json:"users"`
	ActiveUsers    int64 `json:"active_users"`
	PendingInvites int64 `json:"pending_invites"`
	Vaults         int64 `json:"vaults"`
	Files          int64 `json:"files"`
	Assets         int64 `json:"assets"`
	StorageBytes   int64 `json:"storage_bytes"`
}

type AdminUser struct {
	model.User
	Vaults       int64 `json:"vaults"`
	Files        int64 `json:"files"`
	Assets       int64 `json:"assets"`
	StorageBytes int64 `json:"storage_bytes"`
}

type Invitation struct {
	ID        string     `json:"id"`
	Email     string     `json:"email"`
	Token     string     `json:"token,omitempty"`
	ExpiresAt time.Time  `json:"expires_at"`
	UsedAt    *time.Time `json:"used_at,omitempty"`
	RevokedAt *time.Time `json:"revoked_at,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
}

type SMTPConfig struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Security string `json:"security"`
	Username string `json:"username"`
	Password string `json:"-"`
	FromName string `json:"from_name"`
	From     string `json:"from"`
	ReplyTo  string `json:"reply_to"`
}

type storedSMTPConfig struct {
	Host               string `json:"host"`
	Port               int    `json:"port"`
	Security           string `json:"security"`
	Username           string `json:"username"`
	PasswordCiphertext string `json:"password_ciphertext,omitempty"`
	FromName           string `json:"from_name"`
	From               string `json:"from"`
	ReplyTo            string `json:"reply_to"`
}

type PublicSMTPConfig struct {
	Host        string `json:"host"`
	Port        int    `json:"port"`
	Security    string `json:"security"`
	Username    string `json:"username"`
	FromName    string `json:"from_name"`
	From        string `json:"from"`
	ReplyTo     string `json:"reply_to"`
	HasPassword bool   `json:"has_password"`
}

type AdminSettings struct {
	RegistrationMode         string           `json:"registration_mode"`
	RequireEmailVerification bool             `json:"require_email_verification"`
	BackupSchedule           string           `json:"backup_schedule"`
	BackupRoot               string           `json:"backup_root"`
	SMTP                     PublicSMTPConfig `json:"smtp"`
}

type BackupJob struct {
	ID          string     `json:"id"`
	Status      string     `json:"status"`
	Path        string     `json:"path,omitempty"`
	Size        int64      `json:"size"`
	Checksum    string     `json:"checksum,omitempty"`
	Error       string     `json:"error,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	CompletedAt *time.Time `json:"completed_at,omitempty"`
}

type AdminAuditEvent struct {
	ID        int64     `json:"id"`
	Actor     string    `json:"actor_user_id"`
	Action    string    `json:"action"`
	Object    string    `json:"object_id"`
	Type      string    `json:"object_type"`
	Detail    string    `json:"detail,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

func (r *Repository) HasAdmin(ctx context.Context) (bool, error) {
	var exists bool
	err := r.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE role='system_admin')`).Scan(&exists)
	return exists, err
}

func (r *Repository) BootstrapAdmin(ctx context.Context, email, passwordHash string) (model.User, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return model.User{}, err
	}
	defer tx.Rollback()
	var exists bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE role='system_admin')`).Scan(&exists); err != nil {
		return model.User{}, err
	}
	if exists {
		return model.User{}, ErrConflict
	}
	normalized := strings.ToLower(strings.TrimSpace(email))
	if normalized == "" || passwordHash == "" {
		return model.User{}, errors.New("email and password are required")
	}
	var id, created string
	rowErr := tx.QueryRowContext(ctx, `SELECT id,created_at FROM users WHERE email=?`, normalized).Scan(&id, &created)
	now := time.Now().UTC()
	if errors.Is(rowErr, sql.ErrNoRows) {
		id, err = newID("user")
		if err != nil {
			return model.User{}, err
		}
		created = formatTime(now)
		_, err = tx.ExecContext(ctx, `INSERT INTO users(id,email,password_hash,created_at,role,status,email_verified_at,password_changed_at) VALUES(?,?,?,?,'system_admin','active',?,?)`, id, normalized, passwordHash, created, formatTime(now), formatTime(now))
	} else if rowErr == nil {
		return model.User{}, fileError(409, "EMAIL_IN_USE", "请选择独立的管理员邮箱")
	} else {
		return model.User{}, rowErr
	}
	if err != nil {
		return model.User{}, err
	}
	if err := tx.Commit(); err != nil {
		return model.User{}, err
	}
	createdAt, err := parseTime(created)
	if err != nil {
		return model.User{}, err
	}
	return model.User{ID: id, Email: normalized, Role: "system_admin", Status: "active", EmailVerifiedAt: &now, CreatedAt: createdAt}, nil
}

func (r *Repository) Setting(ctx context.Context, key string) (string, error) {
	var value string
	err := r.db.QueryRowContext(ctx, `SELECT value FROM system_settings WHERE key=?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return value, err
}

func (r *Repository) SetSetting(ctx context.Context, actor, key, value string) error {
	_, err := r.db.ExecContext(ctx, `INSERT INTO system_settings(key,value,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at`, key, value, actor, formatTime(time.Now().UTC()))
	return err
}

type RegistrationPolicy struct {
	RegistrationMode         string `json:"registration_mode"`
	RequireEmailVerification bool   `json:"require_email_verification"`
}

func (r *Repository) RegistrationPolicy(ctx context.Context) (RegistrationPolicy, error) {
	var p RegistrationPolicy
	err := r.db.QueryRowContext(ctx, `SELECT (SELECT value FROM system_settings WHERE key='registration_mode'),(SELECT value='true' FROM system_settings WHERE key='require_email_verification')`).Scan(&p.RegistrationMode, &p.RequireEmailVerification)
	return p, err
}
func (r *Repository) AdminSettings(ctx context.Context) (AdminSettings, error) {
	policy, err := r.RegistrationPolicy(ctx)
	if err != nil {
		return AdminSettings{}, err
	}
	backupRoot, err := r.Setting(ctx, "backup_root")
	if errors.Is(err, ErrNotFound) {
		backupRoot = "./data/backups"
	} else if err != nil {
		return AdminSettings{}, err
	}
	schedule, err := r.Setting(ctx, "backup_schedule")
	if err != nil {
		return AdminSettings{}, err
	}
	smtp, err := r.SMTPConfig(ctx)
	if err != nil {
		return AdminSettings{}, err
	}
	return AdminSettings{
		RegistrationMode:         policy.RegistrationMode,
		RequireEmailVerification: policy.RequireEmailVerification,
		BackupRoot:               backupRoot, BackupSchedule: schedule,
		SMTP: PublicSMTPConfig{Host: smtp.Host, Port: smtp.Port, Security: smtp.Security, Username: smtp.Username, FromName: smtp.FromName, From: smtp.From, ReplyTo: smtp.ReplyTo, HasPassword: smtp.Password != ""},
	}, nil
}

func (r *Repository) SMTPConfig(ctx context.Context) (SMTPConfig, error) {
	raw, err := r.Setting(ctx, "smtp")
	if errors.Is(err, ErrNotFound) {
		return SMTPConfig{}, nil
	}
	if err != nil {
		return SMTPConfig{}, err
	}
	var stored storedSMTPConfig
	if err := json.Unmarshal([]byte(raw), &stored); err != nil {
		return SMTPConfig{}, err
	}
	out := SMTPConfig{Host: stored.Host, Port: stored.Port, Security: stored.Security, Username: stored.Username, FromName: stored.FromName, From: stored.From, ReplyTo: stored.ReplyTo}
	if stored.PasswordCiphertext != "" {
		password, err := r.decryptSetting(stored.PasswordCiphertext)
		if err != nil {
			return SMTPConfig{}, err
		}
		out.Password = password
	}
	return out, nil
}

func (r *Repository) SaveAdminSettings(ctx context.Context, actor string, values map[string]string, config SMTPConfig) error {
	password, err := r.encryptSetting(config.Password)
	if err != nil {
		return err
	}
	data, err := json.Marshal(storedSMTPConfig{Host: config.Host, Port: config.Port, Security: config.Security, Username: config.Username, PasswordCiphertext: password, FromName: config.FromName, From: config.From, ReplyTo: config.ReplyTo})
	if err != nil {
		return err
	}
	values["smtp"] = string(data)
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := formatTime(time.Now().UTC())
	for key, value := range values {
		if _, err = tx.ExecContext(ctx, `INSERT INTO system_settings(key,value,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at`, key, value, actor, now); err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO admin_audit_events(actor_user_id,action,object_type,object_id,created_at) VALUES(?,'settings.update','system','settings',?)`, actor, now); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *Repository) encryptSetting(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	block, err := aes.NewCipher(r.settingsKey)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	ciphertext := gcm.Seal(nil, nonce, []byte(value), nil)
	return base64.RawStdEncoding.EncodeToString(append(nonce, ciphertext...)), nil
}

func (r *Repository) decryptSetting(value string) (string, error) {
	data, err := base64.RawStdEncoding.DecodeString(value)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(r.settingsKey)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(data) < gcm.NonceSize() {
		return "", errors.New("encrypted setting is truncated")
	}
	plaintext, err := gcm.Open(nil, data[:gcm.NonceSize()], data[gcm.NonceSize():], nil)
	if err != nil {
		return "", err
	}
	return string(plaintext), nil
}

func (r *Repository) AdminOverview(ctx context.Context) (AdminOverview, error) {
	var out AdminOverview
	queries := []struct {
		dest  *int64
		query string
	}{
		{&out.Users, `SELECT count(*) FROM users`},
		{&out.ActiveUsers, `SELECT count(*) FROM users WHERE status='active'`},
		{&out.PendingInvites, `SELECT count(*) FROM invitations WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at>?`},
		{&out.Vaults, `SELECT count(*) FROM vaults`},
		{&out.Files, `SELECT count(*) FROM files WHERE is_deleted=0`},
		{&out.Assets, `SELECT count(*) FROM assets WHERE is_deleted=0`},
		{&out.StorageBytes, `SELECT COALESCE(sum(content_size),0) FROM blobs`},
	}
	for i, item := range queries {
		if i == 2 {
			if err := r.db.QueryRowContext(ctx, item.query, formatTime(time.Now().UTC())).Scan(item.dest); err != nil {
				return out, err
			}
			continue
		}
		if err := r.db.QueryRowContext(ctx, item.query).Scan(item.dest); err != nil {
			return out, err
		}
	}
	return out, nil
}

func (r *Repository) ListAdminUsers(ctx context.Context) ([]AdminUser, error) {
	rows, err := r.db.QueryContext(ctx, `
SELECT u.id,u.email,u.created_at,u.role,u.status,u.email_verified_at,
       (SELECT count(*) FROM vaults WHERE owner_user_id=u.id),
 (SELECT count(*) FROM files f JOIN vaults v ON v.id=f.vault_id WHERE v.owner_user_id=u.id AND f.is_deleted=0),
 (SELECT count(*) FROM assets a JOIN vaults v ON v.id=a.vault_id WHERE v.owner_user_id=u.id AND a.is_deleted=0),
 (SELECT coalesce(sum(b.content_size),0) FROM blobs b JOIN vaults v ON v.id=b.vault_id WHERE v.owner_user_id=u.id)
 FROM users u ORDER BY u.created_at DESC,u.id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AdminUser{}
	for rows.Next() {
		var item AdminUser
		var created string
		var verified sql.NullString
		if err := rows.Scan(&item.ID, &item.Email, &created, &item.Role, &item.Status, &verified, &item.Vaults, &item.Files, &item.Assets, &item.StorageBytes); err != nil {
			return nil, err
		}
		item.CreatedAt, err = parseTime(created)
		if err != nil {
			return nil, err
		}
		if verified.Valid {
			parsed, parseErr := parseTime(verified.String)
			if parseErr != nil {
				return nil, parseErr
			}
			item.EmailVerifiedAt = &parsed
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (r *Repository) SetUserStatus(ctx context.Context, userID, status, reason string) error {
	if status != "active" && status != "disabled" {
		return errors.New("invalid user status")
	}
	var disabledAt any
	if status == "disabled" {
		disabledAt = formatTime(time.Now().UTC())
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `UPDATE users SET status=?,disabled_at=?,disabled_reason=? WHERE id=?`, status, disabledAt, reason, userID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err == nil && n == 0 {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if status == "disabled" {
		if _, err = tx.ExecContext(ctx, `UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL`, disabledAt, userID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (r *Repository) RevokeUserSessions(ctx context.Context, userID string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL`, formatTime(time.Now().UTC()), userID)
	return err
}

func (r *Repository) PasswordHashByID(ctx context.Context, userID string) (string, error) {
	var hash string
	err := r.db.QueryRowContext(ctx, `SELECT password_hash FROM users WHERE id=?`, userID).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return hash, err
}

func (r *Repository) SetPassword(ctx context.Context, userID, oldHash, newHash string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := formatTime(time.Now().UTC())
	res, err := tx.ExecContext(ctx, `UPDATE users SET password_hash=?,password_changed_at=? WHERE id=? AND status='active' AND password_hash=?`, newHash, now, userID, oldHash)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrUnauthorized
	}
	if _, err = tx.ExecContext(ctx, `UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL`, now, userID); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE password_reset_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL`, now, userID); err != nil {
		return err
	}
	return tx.Commit()
}

func randomToken() (string, string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	token := hex.EncodeToString(raw)
	hash := sha256.Sum256([]byte(token))
	return token, hex.EncodeToString(hash[:]), nil
}

func (r *Repository) CreateInvitation(ctx context.Context, email, actor string, lifetime time.Duration) (Invitation, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" || !strings.Contains(email, "@") {
		return Invitation{}, errors.New("valid email is required")
	}
	if lifetime <= 0 {
		lifetime = 72 * time.Hour
	}
	token, tokenHash, err := randomToken()
	if err != nil {
		return Invitation{}, err
	}
	id, err := newID("invite")
	if err != nil {
		return Invitation{}, err
	}
	now := time.Now().UTC()
	item := Invitation{ID: id, Email: email, Token: token, ExpiresAt: now.Add(lifetime), CreatedAt: now}
	_, err = r.db.ExecContext(ctx, `INSERT INTO invitations(id,email,token_hash,invited_by,expires_at,created_at) VALUES(?,?,?,?,?,?)`, id, email, tokenHash, actor, formatTime(item.ExpiresAt), formatTime(now))
	return item, err
}

func (r *Repository) ListInvitations(ctx context.Context) ([]Invitation, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT id,email,expires_at,COALESCE(used_at,''),COALESCE(revoked_at,''),created_at FROM invitations ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Invitation{}
	for rows.Next() {
		var item Invitation
		var expires, used, revoked, created string
		if err := rows.Scan(&item.ID, &item.Email, &expires, &used, &revoked, &created); err != nil {
			return nil, err
		}
		if item.ExpiresAt, err = parseTime(expires); err != nil {
			return nil, err
		}
		if item.CreatedAt, err = parseTime(created); err != nil {
			return nil, err
		}
		if used != "" {
			parsed, parseErr := parseTime(used)
			if parseErr != nil {
				return nil, parseErr
			}
			item.UsedAt = &parsed
		}
		if revoked != "" {
			parsed, parseErr := parseTime(revoked)
			if parseErr != nil {
				return nil, parseErr
			}
			item.RevokedAt = &parsed
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (r *Repository) RenewInvitation(ctx context.Context, id string) (Invitation, error) {
	token, hash, err := randomToken()
	if err != nil {
		return Invitation{}, err
	}
	expires := time.Now().UTC().Add(72 * time.Hour)
	item := Invitation{ID: id, Token: token, ExpiresAt: expires}
	var created string
	err = r.db.QueryRowContext(ctx, `UPDATE invitations SET token_hash=?,expires_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL RETURNING email,created_at`, hash, formatTime(expires), id).Scan(&item.Email, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return Invitation{}, ErrNotFound
	}
	if err != nil {
		return Invitation{}, err
	}
	item.CreatedAt, err = parseTime(created)
	return item, err
}

func (r *Repository) RevokeInvitation(ctx context.Context, id string) error {
	res, err := r.db.ExecContext(ctx, `UPDATE invitations SET revoked_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL`, formatTime(time.Now().UTC()), id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err == nil && n == 0 {
		return ErrNotFound
	}
	return err
}

func (r *Repository) RegisterInvitation(ctx context.Context, token, passwordHash string) (model.User, error) {
	_, tokenHash, err := hashToken(token)
	if err != nil {
		return model.User{}, err
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return model.User{}, err
	}
	defer tx.Rollback()
	var invitationID, email, expires string
	if err := tx.QueryRowContext(ctx, `SELECT id,email,expires_at FROM invitations WHERE token_hash=? AND used_at IS NULL AND revoked_at IS NULL`, tokenHash).Scan(&invitationID, &email, &expires); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return model.User{}, ErrNotFound
		}
		return model.User{}, err
	}
	expiresAt, err := parseTime(expires)
	if err != nil || time.Now().UTC().After(expiresAt) {
		return model.User{}, ErrConflict
	}
	var existing string
	if err := tx.QueryRowContext(ctx, `SELECT id FROM users WHERE email=?`, email).Scan(&existing); err == nil {
		return model.User{}, ErrConflict
	} else if !errors.Is(err, sql.ErrNoRows) {
		return model.User{}, err
	}
	id, err := newID("user")
	if err != nil {
		return model.User{}, err
	}
	now := time.Now().UTC()
	if _, err := tx.ExecContext(ctx, `INSERT INTO users(id,email,password_hash,created_at,role,status,password_changed_at) VALUES(?,?,?,?,'user','active',?)`, id, email, passwordHash, formatTime(now), formatTime(now)); err != nil {
		return model.User{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE invitations SET used_at=? WHERE id=?`, formatTime(now), invitationID); err != nil {
		return model.User{}, err
	}
	if err := tx.Commit(); err != nil {
		return model.User{}, err
	}
	return model.User{ID: id, Email: email, Role: "user", Status: "active", CreatedAt: now}, nil
}

func hashToken(token string) (string, string, error) {
	if strings.TrimSpace(token) == "" {
		return "", "", errors.New("token is required")
	}
	digest := sha256.Sum256([]byte(token))
	return token, hex.EncodeToString(digest[:]), nil
}

func (r *Repository) CreateEmailVerificationToken(ctx context.Context, userID string, lifetime time.Duration) (string, error) {
	token, tokenHash, err := randomToken()
	if err != nil {
		return "", err
	}
	id, err := newID("verify")
	if err != nil {
		return "", err
	}
	now := time.Now().UTC()
	_, err = r.db.ExecContext(ctx, `INSERT INTO email_verification_tokens(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)`, id, userID, tokenHash, formatTime(now.Add(lifetime)), formatTime(now))
	return token, err
}

func (r *Repository) VerifyEmail(ctx context.Context, token string) error {
	_, tokenHash, err := hashToken(token)
	if err != nil {
		return err
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var id, userID, expires string
	if err := tx.QueryRowContext(ctx, `SELECT id,user_id,expires_at FROM email_verification_tokens WHERE token_hash=? AND used_at IS NULL`, tokenHash).Scan(&id, &userID, &expires); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	until, err := parseTime(expires)
	if err != nil || time.Now().UTC().After(until) {
		return ErrConflict
	}
	now := time.Now().UTC()
	if _, err := tx.ExecContext(ctx, `UPDATE users SET email_verified_at=? WHERE id=?`, formatTime(now), userID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE email_verification_tokens SET used_at=? WHERE id=?`, formatTime(now), id); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *Repository) CreatePasswordResetToken(ctx context.Context, userID string, lifetime time.Duration) (string, error) {
	token, tokenHash, err := randomToken()
	if err != nil {
		return "", err
	}
	id, err := newID("reset")
	if err != nil {
		return "", err
	}
	now := time.Now().UTC()
	_, err = r.db.ExecContext(ctx, `INSERT INTO password_reset_tokens(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)`, id, userID, tokenHash, formatTime(now.Add(lifetime)), formatTime(now))
	return token, err
}

func (r *Repository) ConsumePasswordReset(ctx context.Context, token, passwordHash string) error {
	_, tokenHash, err := hashToken(token)
	if err != nil {
		return err
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var id, userID, expires string
	if err := tx.QueryRowContext(ctx, `SELECT id,user_id,expires_at FROM password_reset_tokens WHERE token_hash=? AND used_at IS NULL`, tokenHash).Scan(&id, &userID, &expires); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	until, err := parseTime(expires)
	if err != nil || time.Now().UTC().After(until) {
		return ErrConflict
	}
	now := time.Now().UTC()
	if _, err := tx.ExecContext(ctx, `UPDATE users SET password_hash=?,password_changed_at=? WHERE id=?`, passwordHash, formatTime(now), userID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL`, formatTime(now), userID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE password_reset_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL`, formatTime(now), userID); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *Repository) RecordAdminAudit(ctx context.Context, actor, action, objectType, objectID, detail string) error {
	_, err := r.db.ExecContext(ctx, `INSERT INTO admin_audit_events(actor_user_id,action,object_type,object_id,detail,created_at) VALUES(?,?,?,?,?,?)`, actor, action, objectType, objectID, detail, formatTime(time.Now().UTC()))
	return err
}

func (r *Repository) AdminAudit(ctx context.Context) ([]AdminAuditEvent, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT id,actor_user_id,action,object_type,object_id,detail,created_at FROM admin_audit_events ORDER BY id DESC LIMIT 200`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AdminAuditEvent{}
	for rows.Next() {
		var item AdminAuditEvent
		var created string
		if err := rows.Scan(&item.ID, &item.Actor, &item.Action, &item.Type, &item.Object, &item.Detail, &created); err != nil {
			return nil, err
		}
		item.CreatedAt, err = parseTime(created)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (r *Repository) SaveBackupJob(ctx context.Context, job BackupJob, actor string) error {
	_, err := r.db.ExecContext(ctx, `INSERT INTO backup_jobs(id,created_by,status,path,size,checksum,error,created_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?)`, job.ID, actor, job.Status, job.Path, job.Size, job.Checksum, job.Error, formatTime(job.CreatedAt), nullableTime(job.CompletedAt))
	return err
}

func (r *Repository) ListBackupJobs(ctx context.Context) ([]BackupJob, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT id,status,path,size,checksum,error,created_at,COALESCE(completed_at,'') FROM backup_jobs ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BackupJob{}
	for rows.Next() {
		var item BackupJob
		var created, completed string
		if err := rows.Scan(&item.ID, &item.Status, &item.Path, &item.Size, &item.Checksum, &item.Error, &created, &completed); err != nil {
			return nil, err
		}
		if item.CreatedAt, err = parseTime(created); err != nil {
			return nil, err
		}
		if completed != "" {
			parsed, parseErr := parseTime(completed)
			if parseErr != nil {
				return nil, parseErr
			}
			item.CompletedAt = &parsed
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func nullableTime(value *time.Time) any {
	if value == nil {
		return nil
	}
	return formatTime(*value)
}

func (r *Repository) MarkLogin(ctx context.Context, userID string) error {
	_, err := r.db.ExecContext(ctx, `UPDATE users SET last_login_at=? WHERE id=?`, formatTime(time.Now().UTC()), userID)
	return err
}

func (r *Repository) RecordEmailDelivery(ctx context.Context, kind, recipient, status, detail string) error {
	id, err := newID("mail")
	if err != nil {
		return err
	}
	var sentAt any
	if status == "sent" {
		sentAt = formatTime(time.Now().UTC())
	}
	_, err = r.db.ExecContext(ctx, `INSERT INTO email_deliveries(id,kind,recipient,status,error,created_at,sent_at) VALUES(?,?,?,?,?,?,?)`, id, kind, recipient, status, detail, formatTime(time.Now().UTC()), sentAt)
	return err
}

type AdminAsset struct {
	ID        string    `json:"asset_id"`
	VaultID   string    `json:"vault_id"`
	VaultName string    `json:"vault_name"`
	OwnerID   string    `json:"owner_id"`
	Owner     string    `json:"owner_email"`
	Name      string    `json:"name"`
	Type      string    `json:"media_type"`
	Status    string    `json:"status"`
	Hash      string    `json:"content_hash"`
	Size      int64     `json:"content_size"`
	Deleted   bool      `json:"deleted"`
	CreatedAt time.Time `json:"created_at"`
}

type AdminStorage struct {
	BlobBytes          int64 `json:"blob_bytes"`
	CurrentFileBytes   int64 `json:"current_file_bytes"`
	AssetBytes         int64 `json:"asset_bytes"`
	PendingUploadBytes int64 `json:"pending_upload_bytes"`
	HistoricalBytes    int64 `json:"historical_bytes"`
	ReclaimableBytes   int64 `json:"reclaimable_bytes"`
}

func (r *Repository) AdminStorage(ctx context.Context) (AdminStorage, error) {
	var out AdminStorage
	queries := []struct {
		dest  *int64
		query string
	}{
		{&out.BlobBytes, `SELECT COALESCE(sum(content_size),0) FROM blobs`},
		{&out.CurrentFileBytes, `SELECT COALESCE(sum(current_content_size),0) FROM files WHERE is_deleted=0`},
		{&out.AssetBytes, `SELECT COALESCE(sum(u.content_size),0) FROM assets a JOIN upload_sessions u ON u.id=a.upload_id WHERE a.is_deleted=0 AND u.status='completed'`},
		{&out.PendingUploadBytes, `SELECT COALESCE(sum(content_size),0) FROM upload_sessions WHERE status='pending'`},
		{&out.HistoricalBytes, `SELECT COALESCE(sum(content_size),0) FROM file_versions v WHERE NOT EXISTS(SELECT 1 FROM files f WHERE f.current_version_id=v.id AND f.is_deleted=0)`},
		{&out.ReclaimableBytes, `SELECT COALESCE(sum(u.content_size),0) FROM assets a JOIN upload_sessions u ON u.id=a.upload_id WHERE a.is_deleted=1 AND u.status='completed'`},
	}
	for _, item := range queries {
		if err := r.db.QueryRowContext(ctx, item.query).Scan(item.dest); err != nil {
			return out, err
		}
	}
	return out, nil
}

func (r *Repository) ListAdminAssets(ctx context.Context) ([]AdminAsset, error) {
	rows, err := r.db.QueryContext(ctx, `
SELECT a.id,a.vault_id,v.name,u2.id,u2.email,a.name,a.media_type,us.status,us.content_hash,us.content_size,a.is_deleted,a.created_at
FROM assets a
JOIN vaults v ON v.id=a.vault_id
JOIN users u2 ON u2.id=v.owner_user_id
JOIN upload_sessions us ON us.id=a.upload_id
ORDER BY a.created_at DESC,a.id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AdminAsset{}
	for rows.Next() {
		var item AdminAsset
		var deleted int
		var created string
		if err := rows.Scan(&item.ID, &item.VaultID, &item.VaultName, &item.OwnerID, &item.Owner, &item.Name, &item.Type, &item.Status, &item.Hash, &item.Size, &deleted, &created); err != nil {
			return nil, err
		}
		item.Deleted = deleted != 0
		item.CreatedAt, err = parseTime(created)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (r *Repository) SetAdminAssetDeleted(ctx context.Context, assetID string, deleted bool) error {
	value := 0
	if deleted {
		value = 1
	}
	res, err := r.db.ExecContext(ctx, `UPDATE assets SET is_deleted=? WHERE id=?`, value, assetID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err == nil && n == 0 {
		return ErrNotFound
	}
	return err
}

type EmailDelivery struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Recipient string `json:"recipient"`
	Status    string `json:"status"`
	Error     string `json:"error"`
	Created   string `json:"created_at"`
}

func (r *Repository) EmailDeliveries(ctx context.Context) ([]EmailDelivery, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT id,kind,recipient,status,error,created_at FROM email_deliveries ORDER BY created_at DESC LIMIT 200`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []EmailDelivery{}
	for rows.Next() {
		var d EmailDelivery
		if err = rows.Scan(&d.ID, &d.Kind, &d.Recipient, &d.Status, &d.Error, &d.Created); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}
