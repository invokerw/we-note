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

func TestAdminBootstrapRespectsInviteOnlyRegistration(t *testing.T) {
	db, err := sqlite.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := db.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE system_settings SET value='invite_only' WHERE key='registration_mode'`); err != nil {
		t.Fatal(err)
	}
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
		t.Fatalf("invite-only registration status = %d, want %d, body = %s", regular.Code, http.StatusForbidden, regular.Body.String())
	}
	unauthorized := requestJSON(t, mux, http.MethodGet, "/api/v1/admin/users", "", nil)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized admin status = %d, want %d", unauthorized.Code, http.StatusUnauthorized)
	}
}

func TestDefaultRegistrationAndLoginWithoutAdmin(t *testing.T) {
	mux := testMux(t)
	user := registerUser(t, mux, "user@example.com", "user password")
	if user.Role != "user" || user.EmailVerifiedAt != nil {
		t.Fatalf("unexpected first account: %#v", user)
	}
	token := loginUser(t, mux, user.Email, "user password")
	if got := requestJSON(t, mux, http.MethodGet, "/api/v1/vaults", token, nil); got.Code != http.StatusOK {
		t.Fatalf("vaults status = %d, body = %s", got.Code, got.Body.String())
	}
	if got := requestJSON(t, mux, http.MethodGet, "/api/v1/admin/users", token, nil); got.Code != http.StatusForbidden {
		t.Fatalf("regular user admin status = %d, want 403", got.Code)
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
	if _, err := db.Exec(`UPDATE system_settings SET value='true' WHERE key='require_email_verification'`); err != nil {
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
	if _, err := db.Exec(`UPDATE system_settings SET value='invite_only' WHERE key='registration_mode'`); err != nil {
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
	apply := "/api/v1/admin/backups/" + job.ID + "/apply"
	if got := requestJSON(t, mux, "POST", apply, token, map[string]string{"confirm": "wrong"}); got.Code != 400 {
		t.Fatalf("missing confirmation: %d", got.Code)
	}
	if _, err := db.Exec(`UPDATE system_settings SET value='open' WHERE key='registration_mode'`); err != nil {
		t.Fatal(err)
	}
	got := requestJSON(t, mux, "POST", apply, token, map[string]string{"confirm": job.ID})
	if got.Code != 200 {
		t.Fatalf("apply: %d %s", got.Code, got.Body.String())
	}
	var result struct {
		Safety string `json:"safety_backup_id"`
	}
	decodeResponse(t, got, &result)
	if result.Safety == "" || repo.VerifyBackup(context.Background(), result.Safety) != nil {
		t.Fatal("missing safety backup")
	}
	policy, err := repo.RegistrationPolicy(context.Background())
	if err != nil || policy.RegistrationMode != "invite_only" {
		t.Fatal(policy, err)
	}
	if got := requestJSON(t, mux, "GET", "/api/v1/me", token, nil); got.Code != 401 {
		t.Fatal("old session survived restore")
	}
	token = loginUser(t, mux, "owner@example.com", "owner password")
	got = requestJSON(t, mux, "POST", "/api/v1/admin/backups/"+result.Safety+"/apply", token, map[string]string{"confirm": result.Safety})
	if got.Code != 200 {
		t.Fatal(got.Body.String())
	}
	policy, err = repo.RegistrationPolicy(context.Background())
	if err != nil || policy.RegistrationMode != "open" {
		t.Fatal("safety rollback", policy, err)
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

func TestAdminUserTrashLifecycle(t *testing.T) {
	mux := testMux(t)
	t.Setenv("WENOTE_SETUP_TOKEN", "lifecycle-test-token")
	owner := requestJSON(t, mux, "POST", "/api/v1/admin/bootstrap", "", map[string]string{"setup_token": "lifecycle-test-token", "email": "owner@example.test", "password": "owner password"})
	if owner.Code != 201 {
		t.Fatal(owner.Code)
	}
	var admin struct{ ID string }
	decodeResponse(t, owner, &admin)
	adminToken := loginUser(t, mux, "owner@example.test", "owner password")
	user := registerUser(t, mux, "member@example.test", "member password")
	login := func() int {
		return requestJSON(t, mux, "POST", "/api/v1/auth/login", "", map[string]string{"email": user.Email, "password": "member password"}).Code
	}
	var session struct {
		Access  string `json:"access_token"`
		Refresh string `json:"refresh_token"`
	}
	decodeResponse(t, requestJSON(t, mux, "POST", "/api/v1/auth/login", "", map[string]string{"email": user.Email, "password": "member password"}), &session)
	token := "Bearer " + session.Access
	change := func(actor, id, action string, input any, want int) {
		t.Helper()
		got := requestJSON(t, mux, "POST", "/api/v1/admin/users/"+id+"/"+action, actor, input)
		if got.Code != want {
			t.Fatalf("%s: got %d want %d", action, got.Code, want)
		}
	}
	confirm := map[string]string{"confirm_email": user.Email}
	change(token, user.ID, "delete", confirm, 403)
	change(adminToken, user.ID, "delete", map[string]string{"confirm_email": "other@example.test"}, 400)
	change(adminToken, admin.ID, "delete", map[string]string{"confirm_email": "owner@example.test"}, 403)
	change(adminToken, user.ID, "delete", confirm, 204)
	if login() != 403 {
		t.Fatal("deleted account could log in")
	}
	if got := requestJSON(t, mux, "GET", "/api/v1/me", token, nil).Code; got != 401 {
		t.Fatal("old session active after deletion")
	}
	change(adminToken, user.ID, "enable", nil, 409)
	change(adminToken, user.ID, "reset-password", nil, 409)
	change(adminToken, user.ID, "restore", nil, 204)
	if got := requestJSON(t, mux, "POST", "/api/v1/auth/refresh", "", map[string]string{"refresh_token": session.Refresh}).Code; got != 401 {
		t.Fatalf("restored account reused revoked refresh token: %d", got)
	}
	if login() != 200 {
		t.Fatal("restore should reactivate formerly active account")
	}
	if got := requestJSON(t, mux, "GET", "/api/v1/me", token, nil).Code; got != 401 {
		t.Fatal("restore revived old session")
	}
	change(adminToken, user.ID, "disable", map[string]string{"reason": "停用测试"}, 204)
	change(adminToken, user.ID, "delete", confirm, 204)
	change(adminToken, user.ID, "restore", nil, 204)
	if login() != 403 {
		t.Fatal("restore should preserve previous suspension")
	}
	users := requestJSON(t, mux, "GET", "/api/v1/admin/users", adminToken, nil)
	if !strings.Contains(users.Body.String(), "停用测试") {
		t.Fatal("missing suspension reason")
	}
	change(adminToken, user.ID, "enable", nil, 204)
	if login() != 200 {
		t.Fatal("enable did not restore access")
	}
	events := requestJSON(t, mux, "GET", "/api/v1/admin/audit", adminToken, nil)
	for _, action := range []string{"user.delete", "user.restore", "user.disable", "user.enable"} {
		if !strings.Contains(events.Body.String(), action) {
			t.Fatal("missing audit event", action)
		}
	}
}

func TestAdminAssetBatchAtomic(t *testing.T) {
	ctx := context.Background()
	db, err := sqlite.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	enableOpenRegistration(t, db)
	repo := store.NewRepository(db)
	mux := NewMux(repo)
	t.Setenv("WENOTE_SETUP_TOKEN", "batch-test-token")
	r := requestJSON(t, mux, "POST", "/api/v1/admin/bootstrap", "", map[string]string{"setup_token": "batch-test-token", "email": "admin@example.test", "password": "admin password"})
	if r.Code != 201 {
		t.Fatal(r.Code)
	}
	admin := loginUser(t, mux, "admin@example.test", "admin password")
	member := registerUser(t, mux, "member@example.test", "user password")
	user := loginUser(t, mux, member.Email, "user password")
	v, err := repo.CreateVault(ctx, member.ID, "vault")
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, name := range []string{"a.txt", "b.txt"} {
		a, err := repo.CreateAsset(ctx, member.ID, v.ID, name, "text/plain", "sha256:"+strings.Repeat("0", 64), name, 3)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, a.ID)
	}
	batch := func(token, operation string, items []string, want int) {
		t.Helper()
		r := requestJSON(t, mux, "POST", "/api/v1/admin/assets/batch", token, map[string]any{"operation": operation, "asset_ids": items})
		if r.Code != want {
			t.Fatalf("%s: got %d want %d", operation, r.Code, want)
		}
	}
	count := func(want int) {
		t.Helper()
		var n int
		if err := db.QueryRow(`SELECT COUNT(*) FROM assets WHERE is_deleted=1`).Scan(&n); err != nil || n != want {
			t.Fatalf("trashed %d want %d: %v", n, want, err)
		}
	}
	batch(user, "delete", ids, 403)
	batch(admin, "delete", nil, 400)
	batch(admin, "purge", ids, 400)
	batch(admin, "delete", []string{ids[0], ids[0]}, 400)
	batch(admin, "delete", []string{ids[0], "missing"}, 404)
	count(0)
	batch(admin, "delete", ids, 204)
	count(2)
	batch(admin, "restore", []string{ids[0]}, 204)
	batch(admin, "restore", []string{ids[1], ids[0]}, 409)
	count(1)
	batch(admin, "restore", []string{ids[1]}, 204)
	count(0)
	var events int
	if err = db.QueryRow(`SELECT COUNT(*) FROM admin_audit_events WHERE action IN ('asset.delete','asset.restore')`).Scan(&events); err != nil || events != 4 {
		t.Fatalf("expected four committed audit rows, got %d", events)
	}
}
