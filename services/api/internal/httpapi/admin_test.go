package httpapi

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/weifei/we-note/services/api/internal/sqlite"
	"github.com/weifei/we-note/services/api/internal/store"
)

func TestAdminBootstrapEnablesInviteOnlyRegistration(t *testing.T) {
	db, err := sqlite.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := db.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	repo := store.NewRepository(db)
	mux := NewMux(repo)
	t.Setenv("WENOTE_SETUP_TOKEN", "test-setup-token")

	status := requestJSON(t, mux, http.MethodGet, "/api/v1/admin/bootstrap", "", nil)
	if status.Code != http.StatusOK || status.Body.String() == "" {
		t.Fatalf("bootstrap status = %d, body = %s", status.Code, status.Body.String())
	}
	if denied := requestJSON(t, mux, "POST", "/api/v1/admin/bootstrap", "", map[string]string{"email": "other@example.com", "password": "unused password"}); denied.Code != 403 {
		t.Fatalf("bootstrap without deployment secret: %d", denied.Code)
	}
	created := requestJSON(t, mux, http.MethodPost, "/api/v1/admin/bootstrap", "", map[string]string{"setup_token": "test-setup-token",
		"email": "owner@example.com", "password": "owner password",
	})
	if created.Code != http.StatusCreated {
		t.Fatalf("bootstrap create status = %d, body = %s", created.Code, created.Body.String())
	}
	adminToken := loginUser(t, mux, "owner@example.com", "owner password")

	overview := requestJSON(t, mux, http.MethodGet, "/api/v1/admin/overview", adminToken, nil)
	if overview.Code != http.StatusOK {
		t.Fatalf("admin overview status = %d, body = %s", overview.Code, overview.Body.String())
	}
	regular := requestJSON(t, mux, http.MethodPost, "/api/v1/auth/register", "", map[string]string{
		"email": "user@example.com", "password": "user password",
	})
	if regular.Code != http.StatusForbidden {
		t.Fatalf("open registration status = %d, want %d, body = %s", regular.Code, http.StatusForbidden, regular.Body.String())
	}
	unauthorized := requestJSON(t, mux, http.MethodGet, "/api/v1/admin/users", "", nil)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized admin status = %d, want %d", unauthorized.Code, http.StatusUnauthorized)
	}
}

func TestAdminCannotBeAccessedByRegularUser(t *testing.T) {
	db, err := sqlite.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := db.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO system_settings(key,value,updated_at) VALUES('registration_mode','open',CURRENT_TIMESTAMP),('require_email_verification','false',CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`); err != nil {
		t.Fatal(err)
	}
	repo := store.NewRepository(db)
	mux := NewMux(repo)
	t.Setenv("WENOTE_SETUP_TOKEN", "test-setup-token")
	admin := requestJSON(t, mux, http.MethodPost, "/api/v1/admin/bootstrap", "", map[string]string{"setup_token": "test-setup-token",
		"email": "owner@example.com", "password": "owner password",
	})
	if admin.Code != http.StatusCreated {
		t.Fatalf("bootstrap status = %d, body = %s", admin.Code, admin.Body.String())
	}
	registerUser(t, mux, "user@example.com", "user password")
	userToken := loginUser(t, mux, "user@example.com", "user password")
	response := requestJSON(t, mux, http.MethodGet, "/api/v1/admin/users", userToken, nil)
	if response.Code != http.StatusForbidden {
		t.Fatalf("regular user admin status = %d, want %d, body = %s", response.Code, http.StatusForbidden, response.Body.String())
	}
}

func TestInvitationVerificationPasswordAndDisableFlow(t *testing.T) {
	db, err := sqlite.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := db.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	repo := store.NewRepository(db)
	mux := NewMux(repo)
	t.Setenv("WENOTE_SETUP_TOKEN", "test-setup-token")
	bootstrap := requestJSON(t, mux, http.MethodPost, "/api/v1/admin/bootstrap", "", map[string]string{"setup_token": "test-setup-token",
		"email": "owner@example.com", "password": "owner password",
	})
	if bootstrap.Code != http.StatusCreated {
		t.Fatalf("bootstrap status = %d, body = %s", bootstrap.Code, bootstrap.Body.String())
	}
	adminToken := loginUser(t, mux, "owner@example.com", "owner password")
	invite := requestJSON(t, mux, http.MethodPost, "/api/v1/admin/invitations", adminToken, map[string]any{
		"email":         "user@example.com",
		"expires_hours": 24,
	})
	if invite.Code != http.StatusCreated {
		t.Fatalf("invite status = %d, body = %s", invite.Code, invite.Body.String())
	}
	var inviteResponse struct {
		Invitation struct {
			Token string `json:"token"`
		} `json:"invitation"`
	}
	decodeResponse(t, invite, &inviteResponse)
	if inviteResponse.Invitation.Token == "" {
		t.Fatal("invitation token is empty")
	}
	registered := requestJSON(t, mux, http.MethodPost, "/api/v1/auth/invitations/"+inviteResponse.Invitation.Token+"/register", "", map[string]string{
		"password": "user password",
	})
	if registered.Code != http.StatusCreated {
		t.Fatalf("invitation registration status = %d, body = %s", registered.Code, registered.Body.String())
	}
	var registration struct {
		VerificationToken string `json:"verification_token"`
	}
	decodeResponse(t, registered, &registration)
	if registration.VerificationToken != "" {
		t.Fatal("verification proof was exposed outside email")
	}
	u, _, err := repo.UserByEmail(context.Background(), "user@example.com")
	if err != nil {
		t.Fatal(err)
	}
	registration.VerificationToken, err = repo.CreateEmailVerificationToken(context.Background(), u.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	unverified := requestJSON(t, mux, http.MethodPost, "/api/v1/auth/login", "", map[string]string{
		"email": "user@example.com", "password": "user password",
	})
	if unverified.Code != http.StatusForbidden {
		t.Fatalf("unverified login status = %d, want %d", unverified.Code, http.StatusForbidden)
	}
	verified := requestJSON(t, mux, http.MethodPost, "/api/v1/auth/verify-email", "", map[string]string{
		"token": registration.VerificationToken,
	})
	if verified.Code != http.StatusNoContent {
		t.Fatalf("verify email status = %d, body = %s", verified.Code, verified.Body.String())
	}
	userToken := loginUser(t, mux, "user@example.com", "user password")
	changed := requestJSON(t, mux, http.MethodPost, "/api/v1/auth/password/change", userToken, map[string]string{
		"current_password": "user password",
		"new_password":     "new user password",
	})
	if changed.Code != http.StatusNoContent {
		t.Fatalf("password change status = %d, body = %s", changed.Code, changed.Body.String())
	}
	if response := requestJSON(t, mux, http.MethodPost, "/api/v1/auth/login", "", map[string]string{
		"email": "user@example.com", "password": "user password",
	}); response.Code != http.StatusUnauthorized {
		t.Fatalf("old password login status = %d, want %d", response.Code, http.StatusUnauthorized)
	}
	newToken := loginUser(t, mux, "user@example.com", "new user password")
	users := requestJSON(t, mux, http.MethodGet, "/api/v1/admin/users", adminToken, nil)
	if users.Code != http.StatusOK {
		t.Fatalf("admin users status = %d, body = %s", users.Code, users.Body.String())
	}
	var list struct {
		Users []struct {
			ID    string `json:"id"`
			Email string `json:"email"`
		} `json:"users"`
	}
	decodeResponse(t, users, &list)
	if len(list.Users) != 2 {
		t.Fatalf("users = %#v, want 2 users", list.Users)
	}
	userID := ""
	for _, item := range list.Users {
		if item.Email == "user@example.com" {
			userID = item.ID
		}
	}
	if userID == "" {
		t.Fatal("user id is empty")
	}
	disabled := requestJSON(t, mux, http.MethodPost, "/api/v1/admin/users/"+userID+"/disable", adminToken, map[string]string{"reason": "test"})
	if disabled.Code != http.StatusNoContent {
		t.Fatalf("disable status = %d, body = %s", disabled.Code, disabled.Body.String())
	}
	if response := requestJSON(t, mux, http.MethodGet, "/api/v1/me", newToken, nil); response.Code != http.StatusUnauthorized {
		t.Fatalf("disabled token status = %d, want %d", response.Code, http.StatusUnauthorized)
	}
}

func TestAdminBackupCanCreateVerifyAndStageRestore(t *testing.T) {
	db, err := sqlite.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := db.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	backupRoot := t.TempDir()
	if _, err := db.Exec(`UPDATE system_settings SET value=? WHERE key='backup_root'`, backupRoot); err != nil {
		t.Fatal(err)
	}
	repo := store.NewRepository(db)
	mux := NewMux(repo)
	t.Setenv("WENOTE_SETUP_TOKEN", "test-setup-token")
	if response := requestJSON(t, mux, http.MethodPost, "/api/v1/admin/bootstrap", "", map[string]string{"setup_token": "test-setup-token",
		"email": "owner@example.com", "password": "owner password",
	}); response.Code != http.StatusCreated {
		t.Fatalf("bootstrap status = %d, body = %s", response.Code, response.Body.String())
	}
	token := loginUser(t, mux, "owner@example.com", "owner password")
	created := requestJSON(t, mux, http.MethodPost, "/api/v1/admin/backups", token, nil)
	if created.Code != http.StatusCreated {
		t.Fatalf("backup create status = %d, body = %s", created.Code, created.Body.String())
	}
	var job struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	decodeResponse(t, created, &job)
	if job.ID == "" || job.Status != "completed" {
		t.Fatalf("backup job = %#v", job)
	}
	verified := requestJSON(t, mux, http.MethodPost, "/api/v1/admin/backups/"+job.ID+"/verify", token, nil)
	if verified.Code != http.StatusNoContent {
		t.Fatalf("backup verify status = %d, body = %s", verified.Code, verified.Body.String())
	}
	restored := requestJSON(t, mux, http.MethodPost, "/api/v1/admin/backups/"+job.ID+"/restore", token, nil)
	if restored.Code != http.StatusAccepted {
		t.Fatalf("backup restore status = %d, body = %s", restored.Code, restored.Body.String())
	}
}

func TestDailyBackupRunsOnceAndMailHistoryRequiresAdmin(t *testing.T) {
	ctx := context.Background()
	db, err := sqlite.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	repo := store.NewRepository(db)
	admin, err := repo.BootstrapAdmin(ctx, "admin@example.test", "unused")
	if err != nil {
		t.Fatal(err)
	}
	if err = repo.SetSetting(ctx, admin.ID, "backup_root", t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if err = repo.SetSetting(ctx, admin.ID, "backup_schedule", "daily"); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	for i := 0; i < 2; i++ {
		if err = repo.RunDueBackup(ctx, now); err != nil {
			t.Fatal(err)
		}
	}
	jobs, err := repo.ListBackupJobs(ctx)
	if err != nil || len(jobs) != 1 || jobs[0].Status != "completed" {
		t.Fatalf("scheduled jobs: %v %v", jobs, err)
	}
	if got := requestJSON(t, NewMux(repo), "GET", "/api/v1/admin/mail", "", nil).Code; got != 401 {
		t.Fatalf("mail history status = %d", got)
	}
}

func TestAdminSMTPSettingsAreMaskedAndEncrypted(t *testing.T) {
	db, err := sqlite.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := db.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	repo := store.NewRepository(db)
	mux := NewMux(repo)
	t.Setenv("WENOTE_SETUP_TOKEN", "test-setup-token")
	if response := requestJSON(t, mux, http.MethodPost, "/api/v1/admin/bootstrap", "", map[string]string{"setup_token": "test-setup-token",
		"email": "owner@example.com", "password": "owner password",
	}); response.Code != http.StatusCreated {
		t.Fatalf("bootstrap status = %d, body = %s", response.Code, response.Body.String())
	}
	token := loginUser(t, mux, "owner@example.com", "owner password")
	secret := "smtp-secret-value"
	updated := requestJSON(t, mux, http.MethodPut, "/api/v1/admin/settings", token, map[string]any{
		"registration_mode":          "invite_only",
		"require_email_verification": true,
		"backup_root":                t.TempDir(),
		"smtp": map[string]any{
			"host": "smtp.example.com", "port": 587, "security": "starttls",
			"username": "mailer", "password": secret, "from": "notes@example.com",
		},
	})
	if updated.Code != http.StatusOK {
		t.Fatalf("settings update status = %d, body = %s", updated.Code, updated.Body.String())
	}
	settings := requestJSON(t, mux, http.MethodGet, "/api/v1/admin/settings", token, nil)
	if settings.Code != http.StatusOK {
		t.Fatalf("settings get status = %d, body = %s", settings.Code, settings.Body.String())
	}
	if strings.Contains(settings.Body.String(), secret) {
		t.Fatalf("SMTP password was returned in settings response: %s", settings.Body.String())
	}
	var stored string
	if err := db.QueryRow(`SELECT value FROM system_settings WHERE key='smtp'`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored, secret) {
		t.Fatalf("SMTP password was stored in plaintext: %s", stored)
	}
	config, err := repo.SMTPConfig(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if config.Password != secret {
		t.Fatalf("SMTP password = %q, want original value", config.Password)
	}
}

func TestOptionalVerificationDoesNotCertifyEmail(t *testing.T) {
	mux := testMux(t)
	user := registerUser(t, mux, "member@example.test", "member password")
	if user.EmailVerifiedAt != nil {
		t.Fatal("open registration certified an unverified mailbox")
	}
	response := requestJSON(t, mux, "GET", "/api/v1/auth/registration", "", nil)
	if response.Code != 200 {
		t.Fatalf("registration policy status %d", response.Code)
	}
}
