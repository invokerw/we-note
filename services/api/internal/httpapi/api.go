package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/weifei/we-note/services/api/internal/model"
	"github.com/weifei/we-note/services/api/internal/password"
	"github.com/weifei/we-note/services/api/internal/store"
)

type API struct {
	repository *store.Repository
	mailer     Mailer
}

func NewAPI(repository *store.Repository) *API {
	return &API{repository: repository, mailer: SMTPMailer{}}
}

func NewMux(repository *store.Repository) *http.ServeMux {
	api := NewAPI(repository)
	mux := http.NewServeMux()
	mux.Handle("GET /healthz", HealthHandler{})
	mux.HandleFunc("POST /api/v1/auth/register", api.register)
	mux.HandleFunc("POST /api/v1/auth/login", api.login)
	mux.HandleFunc("POST /api/v1/auth/refresh", api.refresh)
	mux.HandleFunc("POST /api/v1/auth/logout", api.logout)
	mux.HandleFunc("GET /api/v1/me", api.me)
	mux.HandleFunc("GET /api/v1/me/plugin-settings", api.pluginSettings)
	mux.HandleFunc("PUT /api/v1/me/plugin-settings/{plugin_id}", api.updatePluginSettings)
	mux.HandleFunc("GET /api/v1/vaults", api.listVaults)
	mux.HandleFunc("POST /api/v1/vaults", api.createVault)
	mux.HandleFunc("GET /api/v1/vaults/{vault_id}", api.getVault)
	mux.HandleFunc("GET /api/v1/vaults/{vault_id}/files", api.listFiles)
	mux.HandleFunc("GET /api/v1/vaults/{vault_id}/files/{file_id}", api.getFile)
	mux.HandleFunc("GET /api/v1/vaults/{vault_id}/files/{file_id}/content", api.getFileContent)
	mux.HandleFunc("GET /api/v1/vaults/{vault_id}/files/{file_id}/versions", api.listFileVersions)
	mux.HandleFunc("GET /api/v1/vaults/{vault_id}/files/{file_id}/versions/{version_id}", api.getFileVersion)
	mux.HandleFunc("/api/v1/vaults/{vault_id}/sync/changes", api.syncChanges)
	mux.HandleFunc("/api/v1/vaults/{vault_id}/sync/manifest", api.syncManifest)
	mux.HandleFunc("/api/v1/vaults/{vault_id}/sync/upload-sessions", api.createUploadSession)
	mux.HandleFunc("/api/v1/vaults/{vault_id}/sync/upload-sessions/{upload_id}", api.getUploadSession)
	mux.HandleFunc("/api/v1/vaults/{vault_id}/sync/upload-sessions/{upload_id}/complete", api.completeUploadSession)
	mux.HandleFunc("POST /api/v1/vaults/{vault_id}/entry", api.changeEntry)
	mux.HandleFunc("POST /api/v1/vaults/{vault_id}/files", api.writeFile("create_file"))
	mux.HandleFunc("PUT /api/v1/vaults/{vault_id}/files/{file_id}/content", api.writeFile("update_file_content"))
	mux.HandleFunc("PATCH /api/v1/vaults/{vault_id}/files/{file_id}", api.writeFile("move_file"))
	mux.HandleFunc("DELETE /api/v1/vaults/{vault_id}/files/{file_id}", api.writeFile("delete_file"))
	mux.HandleFunc("POST /api/v1/vaults/{vault_id}/files/{file_id}/restore", api.writeFile("restore_file"))
	mux.HandleFunc("POST /api/v1/vaults/{vault_id}/trash", api.manageTrash)
	mux.HandleFunc("GET /api/v1/vaults/{vault_id}/trash", api.trash)
	mux.HandleFunc("GET /api/v1/vaults/{vault_id}/files/{file_id}/versions/{version_id}/content", api.versionContent)
	mux.HandleFunc("POST /api/v1/vaults/{vault_id}/assets/uploads", api.createAsset)
	mux.HandleFunc("GET /api/v1/vaults/{vault_id}/assets/{asset_id}", api.asset)
	mux.HandleFunc("POST /api/v1/vaults/{vault_id}/assets/{asset_id}/complete", api.asset)
	mux.HandleFunc("GET /api/v1/vaults/{vault_id}/assets/{asset_id}/parts", api.assetParts)
	mux.HandleFunc("PUT /api/v1/vaults/{vault_id}/assets/{asset_id}/parts/{number}", api.assetParts)
	mux.HandleFunc("POST /api/v1/vaults/{vault_id}/assets/{asset_id}/assemble", api.assetParts)
	mux.HandleFunc("DELETE /api/v1/vaults/{vault_id}/assets/{asset_id}", api.asset)
	mux.HandleFunc("GET /assets/{owner}/{asset_vault}/{year}/{month}/{day}/{hash}", api.asset)
	mux.HandleFunc("GET /assets/{year}/{month}/{day}/{hash}", api.asset)
	mux.HandleFunc("GET /assets/{asset_id}", api.asset)
	mux.HandleFunc("GET /api/v1/devices", api.listDevices)
	mux.HandleFunc("POST /api/v1/devices", api.createDevice)
	mux.HandleFunc("DELETE /api/v1/devices/{device_id}", api.deleteDevice)
	mux.HandleFunc("GET /api/v1/config", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"public_url": repository.PublicBase()})
	})
	for _, route := range []string{"assets", "search", "tags", "outline", "links/backlinks"} {
		mux.HandleFunc("GET /api/v1/vaults/{vault_id}/"+route, api.knowledge)
	}
	api.exportRoutes(mux)
	api.shareRoutes(mux)
	api.linkRoutes(mux)
	api.securityRoutes(mux)
	api.adminRoutes(mux)
	return api.maintenanceMux(mux)
}

func (a *API) register(w http.ResponseWriter, r *http.Request) {
	var request model.RegisterRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	if !validEmail(request.Email) || len(request.Password) < 8 {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", "email and a password of at least 8 characters are required")
		return
	}
	settings, err := a.repository.RegistrationPolicy(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not load registration policy")
		return
	}
	if settings.RegistrationMode != "open" {
		writeError(w, http.StatusForbidden, "REGISTRATION_DISABLED", "registration requires an invitation")
		return
	}
	hash, err := password.Hash(request.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not hash password")
		return
	}
	user, err := a.repository.CreatePendingUser(r.Context(), request.Email, hash)
	if errors.Is(err, store.ErrConflict) {
		writeError(w, http.StatusConflict, "EMAIL_ALREADY_REGISTERED", "email is already registered")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not create user")
		return
	}
	if settings.RequireEmailVerification {
		verificationToken, tokenErr := a.repository.CreateEmailVerificationToken(r.Context(), user.ID, 24*time.Hour)
		if tokenErr != nil {
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not create email verification")
			return
		}
		delivery := a.deliverEmail(r.Context(), "verification", user.Email, "验证你的 WeNote 邮箱", "请打开以下地址验证邮箱。\n\n"+a.repository.MailBase()+"/#verify="+verificationToken)
		writeJSON(w, 201, map[string]any{"verification_required": true, "delivery_status": delivery})
		return
	}
	writeJSON(w, http.StatusCreated, user)
}

func (a *API) login(w http.ResponseWriter, r *http.Request) {
	var request model.LoginRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	user, hash, err := a.repository.UserByEmail(r.Context(), request.Email)
	if err != nil || !password.Compare(hash, request.Password) {
		writeError(w, http.StatusUnauthorized, "INVALID_CREDENTIALS", "email or password is incorrect")
		return
	}
	if user.Status == "deleted" {
		writeError(w, 403, "ACCOUNT_DELETED", "账户已移入回收站，请联系管理员")
		return
	}
	if user.Status == "disabled" {
		writeError(w, http.StatusForbidden, "ACCOUNT_DISABLED", "account is disabled")
		return
	}
	settings, settingsErr := a.repository.RegistrationPolicy(r.Context())
	if settingsErr != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not load account policy")
		return
	}
	if settings.RequireEmailVerification && user.EmailVerifiedAt == nil {
		writeError(w, http.StatusForbidden, "EMAIL_NOT_VERIFIED", "email verification is required")
		return
	}
	session, err := a.repository.CreateLoginSession(r.Context(), user.ID, hash, 30*time.Minute)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not create session")
		return
	}
	_ = a.repository.MarkLogin(r.Context(), user.ID)
	writeJSON(w, http.StatusOK, session)
}

func (a *API) me(w http.ResponseWriter, r *http.Request) {
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, user)
}

func (a *API) pluginSettings(w http.ResponseWriter, r *http.Request) {
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	settings, err := a.repository.PluginSettings(r.Context(), user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not load plugin settings")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"plugins": settings})
}

func (a *API) updatePluginSettings(w http.ResponseWriter, r *http.Request) {
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	var settings json.RawMessage
	if err := decodeJSONLimit(w, r, &settings, 64<<10); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	if err := a.repository.SetPluginSettings(
		r.Context(),
		user.ID,
		r.PathValue("plugin_id"),
		settings,
	); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) listVaults(w http.ResponseWriter, r *http.Request) {
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	vaults, err := a.repository.ListVaults(r.Context(), user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not list vaults")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"vaults": vaults})
}

func (a *API) createVault(w http.ResponseWriter, r *http.Request) {
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	var request model.CreateVaultRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	vault, err := a.repository.CreateVault(r.Context(), user.ID, request.Name)
	if err != nil {
		if strings.Contains(err.Error(), "vault name is required") {
			writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not create vault")
		return
	}
	writeJSON(w, http.StatusCreated, vault)
}

func (a *API) getVault(w http.ResponseWriter, r *http.Request) {
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	vault, err := a.repository.VaultForUser(r.Context(), user.ID, r.PathValue("vault_id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "vault not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not load vault")
		return
	}
	writeJSON(w, http.StatusOK, vault)
}

func (a *API) listDevices(w http.ResponseWriter, r *http.Request) {
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	devices, err := a.repository.ListDevices(r.Context(), user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not list devices")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": devices})
}

func (a *API) createDevice(w http.ResponseWriter, r *http.Request) {
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	var request model.CreateDeviceRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	device, err := a.repository.CreateDevice(r.Context(), user.ID, request.Name, request.PublicKey)
	if err != nil {
		if strings.Contains(err.Error(), "device name is required") {
			writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not create device")
		return
	}
	writeJSON(w, http.StatusCreated, device)
}

func (a *API) deleteDevice(w http.ResponseWriter, r *http.Request) {
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	if err := a.repository.DeleteDevice(r.Context(), user.ID, r.PathValue("device_id")); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "device not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not delete device")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) authenticatedUser(w http.ResponseWriter, r *http.Request) (model.User, bool) {
	const prefix = "Bearer "
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, prefix) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="wenote"`)
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Bearer access token is required")
		return model.User{}, false
	}
	user, err := a.repository.UserByAccessToken(r.Context(), strings.TrimSpace(strings.TrimPrefix(header, prefix)))
	if errors.Is(err, store.ErrUnauthorized) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="wenote"`)
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "access token is invalid or expired")
		return model.User{}, false
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not validate access token")
		return model.User{}, false
	}
	return user, true
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) error {
	return decodeJSONLimit(w, r, target, 1<<20)
}
func decodeJSONLimit(w http.ResponseWriter, r *http.Request, target any, size int64) error {
	if r.Body == nil {
		return fmt.Errorf("request body is required")
	}
	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, size))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("invalid JSON body: %w", err)
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{
			"code":    code,
			"message": message,
		},
	})
}

func (a *API) refresh(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token string `json:"refresh_token"`
	}
	if err := decodeJSON(w, r, &in); err != nil {
		writeError(w, 400, "INVALID_REQUEST", "refresh token required")
		return
	}
	out, err := a.repository.Refresh(r.Context(), in.Token)
	if errors.Is(err, store.ErrUnauthorized) {
		writeError(w, 401, "UNAUTHORIZED", "session expired")
		return
	}
	if err != nil {
		resourceError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, out)
}
func (a *API) logout(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.authenticatedUser(w, r); !ok {
		return
	}
	if err := a.repository.Logout(r.Context(), strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")); err != nil {
		resourceError(w, err)
		return
	}
	w.WriteHeader(204)
}
