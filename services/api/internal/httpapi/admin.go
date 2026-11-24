package httpapi

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"net/mail"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/weifei/we-note/services/api/internal/model"
	"github.com/weifei/we-note/services/api/internal/password"
	"github.com/weifei/we-note/services/api/internal/store"
)

func (a *API) adminRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/auth/registration", func(w http.ResponseWriter, r *http.Request) {
		policy, err := a.repository.RegistrationPolicy(r.Context())
		if err != nil {
			resourceError(w, err)
			return
		}
		writeJSON(w, 200, policy)
	})
	m.HandleFunc("GET /api/v1/admin/bootstrap", a.adminBootstrapStatus)
	m.HandleFunc("POST /api/v1/admin/bootstrap", a.adminBootstrap)
	m.HandleFunc("GET /api/v1/admin/overview", a.adminOverview)
	m.HandleFunc("GET /api/v1/admin/users", a.adminUsers)
	m.HandleFunc("POST /api/v1/admin/assets/{asset_id}/restore", a.adminDeleteAsset)
	m.HandleFunc("POST /api/v1/admin/users/{user_id}/logout", a.adminLogoutUser)
	m.HandleFunc("GET /api/v1/admin/storage", a.adminStorage)
	m.HandleFunc("POST /api/v1/admin/assets/batch", a.adminBatchAssets)
	m.HandleFunc("GET /api/v1/admin/assets", a.adminAssets)
	m.HandleFunc("POST /api/v1/admin/assets/{asset_id}/delete", a.adminDeleteAsset)
	for _, action := range []string{"disable", "enable", "delete", "restore"} {
		m.HandleFunc("POST /api/v1/admin/users/{user_id}/"+action, a.adminChangeUserStatus(action))
	}
	m.HandleFunc("POST /api/v1/admin/users/{user_id}/reset-password", a.adminResetPassword)
	m.HandleFunc("GET /api/v1/admin/invitations", a.adminInvitations)
	m.HandleFunc("POST /api/v1/admin/invitations", a.adminCreateInvitation)
	m.HandleFunc("POST /api/v1/admin/invitations/{invitation_id}/revoke", a.adminRevokeInvitation)
	m.HandleFunc("POST /api/v1/admin/invitations/{invitation_id}/resend", a.adminResendInvitation)
	m.HandleFunc("GET /api/v1/admin/settings", a.adminSettings)
	m.HandleFunc("PUT /api/v1/admin/settings", a.adminSettings)
	m.HandleFunc("POST /api/v1/admin/smtp/test", a.adminSMTPTest)
	m.HandleFunc("GET /api/v1/admin/mail", a.adminMail)
	m.HandleFunc("GET /api/v1/admin/audit", a.adminAudit)
	m.HandleFunc(applyPattern, a.adminApplyBackup)
	m.HandleFunc(storagePattern, a.adminStorageConfig)
	m.HandleFunc("GET /api/v1/admin/storage/{scope}", a.adminStorageConfig)
	m.HandleFunc("GET /api/v1/admin/backups", a.adminBackups)
	m.HandleFunc("POST /api/v1/admin/backups", a.adminCreateBackup)
	m.HandleFunc("POST /api/v1/admin/backups/{backup_id}/verify", a.adminVerifyBackup)
	m.HandleFunc("POST /api/v1/admin/backups/{backup_id}/restore", a.adminRestoreBackup)
	m.HandleFunc("POST /api/v1/auth/invitations/{token}/register", a.registerInvitation)
	m.HandleFunc("POST /api/v1/auth/verify-email/resend", a.resendVerification)
	m.HandleFunc("POST /api/v1/auth/verify-email", a.verifyEmail)
	m.HandleFunc("POST /api/v1/auth/password/change", a.changePassword)
	m.HandleFunc("POST /api/v1/auth/password/reset/request", a.requestPasswordReset)
	m.HandleFunc("POST /api/v1/auth/password/reset", a.resetPassword)
}

func (a *API) adminBootstrapStatus(w http.ResponseWriter, r *http.Request) {
	available, err := a.repository.HasAdmin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not inspect admin bootstrap")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"available": !available})
}

func validEmail(raw string) bool {
	addr, err := mail.ParseAddress(raw)
	return err == nil && addr.Address == raw && !strings.ContainsAny(raw, "\r\n")
}

func (a *API) adminBootstrap(w http.ResponseWriter, r *http.Request) {
	var input struct {
		SetupToken string `json:"setup_token"`
		Email      string `json:"email"`
		Password   string `json:"password"`
	}
	if err := decodeJSON(w, r, &input); err != nil || !validEmail(input.Email) || len(input.Password) < 8 {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "email and a password of at least 8 characters are required")
		return
	}
	secret := os.Getenv("WENOTE_SETUP_TOKEN")
	if secret == "" || subtle.ConstantTimeCompare([]byte(secret), []byte(input.SetupToken)) != 1 {
		writeError(w, 403, "SETUP_TOKEN_REQUIRED", "请输入服务器上的初始化令牌")
		return
	}
	hash, err := password.Hash(input.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not hash password")
		return
	}
	user, err := a.repository.BootstrapAdmin(r.Context(), input.Email, hash)
	if errors.Is(err, store.ErrConflict) {
		writeError(w, http.StatusConflict, "ADMIN_ALREADY_INITIALIZED", "admin bootstrap is already complete")
		return
	}
	if err != nil {
		resourceError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, user)
}

func (a *API) adminUser(w http.ResponseWriter, r *http.Request) (model.User, bool) {
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return model.User{}, false
	}
	if user.Role != "system_admin" {
		writeError(w, http.StatusForbidden, "ADMIN_REQUIRED", "administrator access is required")
		return model.User{}, false
	}
	return user, true
}

func (a *API) adminOverview(w http.ResponseWriter, r *http.Request) {
	_, ok := a.adminUser(w, r)
	if !ok {
		return
	}
	out, err := a.repository.AdminOverview(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not load admin overview")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *API) adminUsers(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.adminUser(w, r); !ok {
		return
	}
	users, err := a.repository.ListAdminUsers(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not list users")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": users})
}

func (a *API) adminStorage(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.adminUser(w, r); !ok {
		return
	}
	storage, err := a.repository.AdminStorage(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not load storage usage")
		return
	}
	writeJSON(w, http.StatusOK, storage)
}

func (a *API) adminAssets(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.adminUser(w, r); !ok {
		return
	}
	assets, err := a.repository.ListAdminAssets(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not list assets")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"assets": assets})
}

func (a *API) adminDeleteAsset(w http.ResponseWriter, r *http.Request) {
	admin, ok := a.adminUser(w, r)
	if !ok {
		return
	}
	operation := "delete"
	if strings.HasSuffix(r.Pattern, "/restore") {
		operation = "restore"
	}
	if err := a.repository.ChangeAdminAssets(r.Context(), admin.ID, operation, []string{r.PathValue("asset_id")}, false); err != nil {
		resourceError(w, err)
		return
	}
	w.WriteHeader(204)
}
func (a *API) adminBatchAssets(w http.ResponseWriter, r *http.Request) {
	admin, ok := a.adminUser(w, r)
	if !ok {
		return
	}
	var input struct {
		Operation string   `json:"operation"`
		IDs       []string `json:"asset_ids"`
	}
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, 400, "INVALID_REQUEST", err.Error())
		return
	}
	if err := a.repository.ChangeAdminAssets(r.Context(), admin.ID, input.Operation, input.IDs, true); err != nil {
		resourceError(w, err)
		return
	}
	w.WriteHeader(204)
}

func (a *API) adminChangeUserStatus(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		admin, ok := a.adminUser(w, r)
		if !ok {
			return
		}
		var input struct {
			Reason       string `json:"reason"`
			ConfirmEmail string `json:"confirm_email"`
		}
		if r.ContentLength != 0 {
			if err := decodeJSON(w, r, &input); err != nil {
				writeError(w, 400, "INVALID_REQUEST", err.Error())
				return
			}
		}
		reason := strings.TrimSpace(input.Reason)
		if len([]rune(reason)) > 500 {
			writeError(w, 400, "INVALID_REQUEST", "原因最多 500 字")
			return
		}
		if err := a.repository.ChangeUserStatus(r.Context(), admin.ID, r.PathValue("user_id"), action, reason, input.ConfirmEmail); err != nil {
			resourceError(w, err)
			return
		}
		w.WriteHeader(204)
	}
}

func (a *API) adminResetPassword(w http.ResponseWriter, r *http.Request) {
	admin, ok := a.adminUser(w, r)
	if !ok {
		return
	}
	user, err := a.repository.UserByID(r.Context(), r.PathValue("user_id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "user not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not load user")
		return
	}
	token, err := a.repository.CreatePasswordResetToken(r.Context(), user.ID, time.Hour)
	if err != nil {
		resourceError(w, err)
		return
	}
	status := a.deliverEmail(r.Context(), "password_reset", user.Email, "重置你的 WeNote 密码", "请打开以下地址设置密码。\n\n"+a.repository.MailBase()+"/#reset="+token)
	_ = a.repository.RecordAdminAudit(r.Context(), admin.ID, "user.password_reset", "user", user.ID, status)
	writeJSON(w, http.StatusAccepted, map[string]string{"delivery_status": status})
}

func (a *API) adminInvitations(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.adminUser(w, r); !ok {
		return
	}
	items, err := a.repository.ListInvitations(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not list invitations")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"invitations": items})
}

func (a *API) adminCreateInvitation(w http.ResponseWriter, r *http.Request) {
	admin, ok := a.adminUser(w, r)
	if !ok {
		return
	}
	var input struct {
		Email        string `json:"email"`
		ExpiresHours int    `json:"expires_hours"`
	}
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	lifetime := 72 * time.Hour
	if input.ExpiresHours > 0 {
		lifetime = time.Duration(input.ExpiresHours) * time.Hour
	}
	item, err := a.repository.CreateInvitation(r.Context(), input.Email, admin.ID, lifetime)
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	status := a.deliverEmail(r.Context(), "invitation", item.Email, "加入 WeNote", "请打开以下地址接受邀请。\n\n"+a.repository.MailBase()+"/#invite="+item.Token)
	_ = a.repository.RecordAdminAudit(r.Context(), admin.ID, "invitation.create", "invitation", item.ID, status)
	writeJSON(w, http.StatusCreated, map[string]any{"invitation": item, "delivery_status": status})
}

func (a *API) adminRevokeInvitation(w http.ResponseWriter, r *http.Request) {
	admin, ok := a.adminUser(w, r)
	if !ok {
		return
	}
	id := r.PathValue("invitation_id")
	if err := a.repository.RevokeInvitation(r.Context(), id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "invitation not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not revoke invitation")
		return
	}
	_ = a.repository.RecordAdminAudit(r.Context(), admin.ID, "invitation.revoke", "invitation", id, "")
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) adminResendInvitation(w http.ResponseWriter, r *http.Request) {
	admin, ok := a.adminUser(w, r)
	if !ok {
		return
	}
	item, err := a.repository.RenewInvitation(r.Context(), r.PathValue("invitation_id"))
	if err != nil {
		resourceError(w, err)
		return
	}
	status := a.deliverEmail(r.Context(), "invitation", item.Email, "加入 WeNote", "请打开以下地址接受邀请。\n\n"+a.repository.MailBase()+"/#invite="+item.Token)
	_ = a.repository.RecordAdminAudit(r.Context(), admin.ID, "invitation.resend", "invitation", item.ID, status)
	writeJSON(w, http.StatusCreated, map[string]any{"invitation": item, "delivery_status": status})
}

func (a *API) adminSettings(w http.ResponseWriter, r *http.Request) {
	admin, ok := a.adminUser(w, r)
	if !ok {
		return
	}
	if r.Method == http.MethodGet {
		settings, err := a.repository.AdminSettings(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not load settings")
			return
		}
		writeJSON(w, http.StatusOK, settings)
		return
	}
	var input struct {
		RegistrationMode         string `json:"registration_mode"`
		RequireEmailVerification bool   `json:"require_email_verification"`
		BackupSchedule           string `json:"backup_schedule"`
		BackupRoot               string `json:"backup_root"`
		SMTP                     struct {
			Host     string `json:"host"`
			Port     int    `json:"port"`
			Security string `json:"security"`
			Username string `json:"username"`
			Password string `json:"password"`
			FromName string `json:"from_name"`
			From     string `json:"from"`
			ReplyTo  string `json:"reply_to"`
		} `json:"smtp"`
	}
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	if input.RegistrationMode != "open" && input.RegistrationMode != "invite_only" && input.RegistrationMode != "closed" {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "registration_mode must be open, invite_only or closed")
		return
	}
	smtp := store.SMTPConfig{
		Host: input.SMTP.Host, Port: input.SMTP.Port, Security: input.SMTP.Security,
		Username: input.SMTP.Username, Password: input.SMTP.Password,
		FromName: input.SMTP.FromName, From: input.SMTP.From, ReplyTo: input.SMTP.ReplyTo,
	}
	if smtp.Password == "" {
		current, err := a.repository.SMTPConfig(r.Context())
		if err != nil {
			resourceError(w, err)
			return
		}
		smtp.Password = current.Password
	}
	if input.BackupSchedule == "" {
		input.BackupSchedule = "off"
	}
	if input.BackupSchedule != "off" && input.BackupSchedule != "daily" && input.BackupSchedule != "weekly" {
		writeError(w, 400, "INVALID_REQUEST", "无效的备份周期")
		return
	}
	if smtp.Host != "" && (smtp.Port < 1 || smtp.Port > 65535 || !validEmail(smtp.From) || (smtp.ReplyTo != "" && !validEmail(smtp.ReplyTo)) || (smtp.Security != "tls" && smtp.Security != "starttls" && smtp.Security != "plain") || (smtp.Security == "plain" && (smtp.Password != "" || smtp.Username != ""))) {
		writeError(w, 400, "INVALID_REQUEST", "请检查 SMTP 端口、加密方式和邮箱地址")
		return
	}
	values := map[string]string{"registration_mode": input.RegistrationMode, "require_email_verification": strconv.FormatBool(input.RequireEmailVerification), "backup_schedule": input.BackupSchedule}
	if input.BackupRoot != "" {
		values["backup_root"] = input.BackupRoot
	}
	if err := a.repository.SaveAdminSettings(r.Context(), admin.ID, values, smtp); err != nil {
		resourceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "saved"})
}

func (a *API) adminSMTPTest(w http.ResponseWriter, r *http.Request) {
	admin, ok := a.adminUser(w, r)
	if !ok {
		return
	}
	var input struct {
		Recipient string `json:"recipient"`
	}
	if err := decodeJSON(w, r, &input); err != nil || !strings.Contains(input.Recipient, "@") {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "recipient email is required")
		return
	}
	config, err := a.repository.SMTPConfig(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not load SMTP settings")
		return
	}
	status := "sent"
	if err := a.mailer.Send(r.Context(), config, input.Recipient, "WeNote SMTP 测试邮件", "SMTP 配置测试成功。"); err != nil {
		status = "failed"
		_ = a.repository.RecordEmailDelivery(r.Context(), "smtp_test", input.Recipient, status, err.Error())
		writeJSON(w, http.StatusBadGateway, map[string]string{"status": status, "message": err.Error()})
		return
	}
	_ = a.repository.RecordEmailDelivery(r.Context(), "smtp_test", input.Recipient, status, "")
	_ = a.repository.RecordAdminAudit(r.Context(), admin.ID, "smtp.test", "system", "smtp", input.Recipient)
	writeJSON(w, http.StatusOK, map[string]string{"status": status})
}

func (a *API) adminAudit(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.adminUser(w, r); !ok {
		return
	}
	items, err := a.repository.AdminAudit(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not load audit log")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": items})
}

func (a *API) adminBackups(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.adminUser(w, r); !ok {
		return
	}
	items, err := a.repository.ListBackupJobs(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not list backups")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"backups": items})
}

func (a *API) adminCreateBackup(w http.ResponseWriter, r *http.Request) {
	admin, ok := a.adminUser(w, r)
	if !ok {
		return
	}
	job, err := a.repository.CreateBackup(r.Context(), admin.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"backup": job, "error": map[string]string{"code": "BACKUP_FAILED", "message": err.Error()}})
		return
	}
	_ = a.repository.RecordAdminAudit(r.Context(), admin.ID, "backup.create", "backup", job.ID, job.Path)
	writeJSON(w, http.StatusCreated, job)
}

func (a *API) adminVerifyBackup(w http.ResponseWriter, r *http.Request) {
	admin, ok := a.adminUser(w, r)
	if !ok {
		return
	}
	if err := a.repository.VerifyBackup(r.Context(), r.PathValue("backup_id")); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "backup not found")
			return
		}
		writeError(w, http.StatusBadRequest, "BACKUP_INVALID", err.Error())
		return
	}
	_ = a.repository.RecordAdminAudit(r.Context(), admin.ID, "backup.verify", "backup", r.PathValue("backup_id"), "")
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) adminRestoreBackup(w http.ResponseWriter, r *http.Request) {
	admin, ok := a.adminUser(w, r)
	if !ok {
		return
	}
	staging, err := a.repository.RestoreBackup(r.Context(), r.PathValue("backup_id"))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "backup not found")
			return
		}
		writeError(w, http.StatusBadRequest, "RESTORE_FAILED", err.Error())
		return
	}
	_ = a.repository.RecordAdminAudit(r.Context(), admin.ID, "backup.restore", "backup", r.PathValue("backup_id"), staging)
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "staged", "path": staging})
}

func (a *API) registerInvitation(w http.ResponseWriter, r *http.Request) {
	policy, err := a.repository.RegistrationPolicy(r.Context())
	if err != nil {
		resourceError(w, err)
		return
	}
	if policy.RegistrationMode == "closed" {
		writeError(w, 403, "REGISTRATION_DISABLED", "注册已关闭")
		return
	}
	var input struct {
		Password string `json:"password"`
	}
	if err := decodeJSON(w, r, &input); err != nil || len(input.Password) < 8 {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "a password of at least 8 characters is required")
		return
	}
	hash, err := password.Hash(input.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not hash password")
		return
	}
	user, err := a.repository.RegisterInvitation(r.Context(), r.PathValue("token"), hash)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "INVITATION_INVALID", "invitation is invalid or expired")
		return
	}
	if errors.Is(err, store.ErrConflict) {
		writeError(w, http.StatusConflict, "INVITATION_USED", "invitation is expired or email is already registered")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not register invitation")
		return
	}
	if !policy.RequireEmailVerification {
		writeJSON(w, 201, map[string]any{"user": user, "verification_required": false})
		return
	}
	verificationToken, err := a.repository.CreateEmailVerificationToken(r.Context(), user.ID, 24*time.Hour)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not create email verification")
		return
	}
	status := a.deliverEmail(r.Context(), "verification", user.Email, "验证你的 WeNote 邮箱", "请打开以下地址验证邮箱。\n\n"+a.repository.MailBase()+"/#verify="+verificationToken)
	response := map[string]any{"user": user, "verification_required": true, "delivery_status": status}

	writeJSON(w, http.StatusCreated, response)
}

func (a *API) verifyEmail(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Token string `json:"token"`
	}
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	if err := a.repository.VerifyEmail(r.Context(), input.Token); err != nil {
		if errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrConflict) {
			writeError(w, http.StatusBadRequest, "VERIFICATION_INVALID", "verification token is invalid or expired")
			return
		}
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not verify email")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) changePassword(w http.ResponseWriter, r *http.Request) {
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	var input struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if err := decodeJSON(w, r, &input); err != nil || len(input.NewPassword) < 8 {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "a new password of at least 8 characters is required")
		return
	}
	currentHash, err := a.repository.PasswordHashByID(r.Context(), user.ID)
	if err != nil || !password.Compare(currentHash, input.CurrentPassword) {
		writeError(w, http.StatusUnauthorized, "INVALID_PASSWORD", "current password is incorrect")
		return
	}
	hash, err := password.Hash(input.NewPassword)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not hash password")
		return
	}
	if err := a.repository.SetPassword(r.Context(), user.ID, currentHash, hash); err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not change password")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) requestPasswordReset(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Email string `json:"email"`
	}
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	user, _, err := a.repository.UserByEmail(r.Context(), input.Email)
	if err == nil && user.Status == "active" && user.EmailVerifiedAt != nil {
		token, tokenErr := a.repository.CreatePasswordResetToken(r.Context(), user.ID, time.Hour)
		if tokenErr == nil {
			a.deliverEmail(r.Context(), "password_reset", user.Email, "重置你的 WeNote 密码", "请打开以下地址设置密码。\n\n"+a.repository.MailBase()+"/#reset="+token)
		}
	}
	w.WriteHeader(http.StatusAccepted)
}

func (a *API) resetPassword(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Token       string `json:"token"`
		NewPassword string `json:"new_password"`
	}
	if err := decodeJSON(w, r, &input); err != nil || len(input.NewPassword) < 8 {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "token and a password of at least 8 characters are required")
		return
	}
	hash, err := password.Hash(input.NewPassword)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not hash password")
		return
	}
	if err := a.repository.ConsumePasswordReset(r.Context(), input.Token, hash); err != nil {
		if errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrConflict) {
			writeError(w, http.StatusBadRequest, "RESET_INVALID", "password reset token is invalid or expired")
			return
		}
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not reset password")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) deliverEmail(ctx context.Context, kind, recipient, subject, body string) string {
	config, err := a.repository.SMTPConfig(ctx)
	if err != nil || config.Host == "" || config.From == "" {
		_ = a.repository.RecordEmailDelivery(ctx, kind, recipient, "not_configured", "SMTP is not configured")
		return "not_configured"
	}
	if err := a.mailer.Send(ctx, config, recipient, subject, body); err != nil {
		_ = a.repository.RecordEmailDelivery(ctx, kind, recipient, "failed", err.Error())
		return "failed"
	}
	_ = a.repository.RecordEmailDelivery(ctx, kind, recipient, "sent", "")
	return "sent"
}

func (a *API) resendVerification(w http.ResponseWriter, r *http.Request) {
	var q model.LoginRequest
	if decodeJSON(w, r, &q) != nil {
		writeError(w, 400, "INVALID_REQUEST", "请输入邮箱和密码")
		return
	}
	u, h, err := a.repository.UserByEmail(r.Context(), q.Email)
	if err != nil || u.Status != "active" || !password.Compare(h, q.Password) {
		writeError(w, 401, "INVALID_CREDENTIALS", "邮箱或密码错误")
		return
	}
	if u.EmailVerifiedAt == nil {
		t, err := a.repository.CreateEmailVerificationToken(r.Context(), u.ID, time.Hour)
		if err != nil {
			resourceError(w, err)
			return
		}
		if a.deliverEmail(r.Context(), "verification", u.Email, "验证 WeNote 邮箱", a.repository.MailBase()+"/#verify="+t) != "sent" {
			writeError(w, 502, "MAIL_FAILED", "邮件发送失败，请联系管理员检查 SMTP")
			return
		}
	}
	w.WriteHeader(204)
}

func (a *API) adminLogoutUser(w http.ResponseWriter, r *http.Request) {
	u, ok := a.adminUser(w, r)
	if !ok {
		return
	}
	id := r.PathValue("user_id")
	if err := a.repository.RevokeUserSessions(r.Context(), id); err != nil {
		resourceError(w, err)
		return
	}
	if err := a.repository.RecordAdminAudit(r.Context(), u.ID, "user.logout_all", "user", id, ""); err != nil {
		resourceError(w, err)
		return
	}
	w.WriteHeader(204)
}

func (a *API) adminMail(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.adminUser(w, r); !ok {
		return
	}
	records, err := a.repository.EmailDeliveries(r.Context())
	if err != nil {
		resourceError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"deliveries": records})
}
