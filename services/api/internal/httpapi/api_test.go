package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/weifei/we-note/services/api/internal/model"
	"github.com/weifei/we-note/services/api/internal/sqlite"
	"github.com/weifei/we-note/services/api/internal/store"
)

func TestAccountVaultAndDeviceFlowIsIsolatedByUser(t *testing.T) {
	mux := testMux(t)

	alice := registerUser(t, mux, "alice@example.com", "alice password")
	registerUser(t, mux, "bob@example.com", "bob password")
	aliceToken := loginUser(t, mux, "alice@example.com", "alice password")
	bobToken := loginUser(t, mux, "bob@example.com", "bob password")

	duplicate := requestJSON(t, mux, http.MethodPost, "/api/v1/auth/register", "", map[string]string{
		"email": "ALICE@example.com", "password": "another password",
	})
	if duplicate.Code != http.StatusConflict {
		t.Fatalf("duplicate registration status = %d, want %d", duplicate.Code, http.StatusConflict)
	}

	me := requestJSON(t, mux, http.MethodGet, "/api/v1/me", aliceToken, nil)
	if me.Code != http.StatusOK {
		t.Fatalf("me status = %d, want %d", me.Code, http.StatusOK)
	}
	var meUser model.User
	decodeResponse(t, me, &meUser)
	if meUser.ID != alice.ID || meUser.Email != alice.Email {
		t.Fatalf("me user = %#v, want Alice", meUser)
	}

	createdVault := requestJSON(t, mux, http.MethodPost, "/api/v1/vaults", aliceToken, map[string]string{"name": "Alice Notes"})
	if createdVault.Code != http.StatusCreated {
		t.Fatalf("create vault status = %d, want %d", createdVault.Code, http.StatusCreated)
	}
	var vault model.Vault
	decodeResponse(t, createdVault, &vault)
	if vault.OwnerUserID != alice.ID || vault.CurrentRevision != 0 {
		t.Fatalf("created vault = %#v", vault)
	}

	aliceVaults := requestJSON(t, mux, http.MethodGet, "/api/v1/vaults", aliceToken, nil)
	if aliceVaults.Code != http.StatusOK {
		t.Fatalf("list Alice vaults status = %d, want %d", aliceVaults.Code, http.StatusOK)
	}
	var vaultList struct {
		Vaults []model.Vault `json:"vaults"`
	}
	decodeResponse(t, aliceVaults, &vaultList)
	if len(vaultList.Vaults) != 1 || vaultList.Vaults[0].ID != vault.ID {
		t.Fatalf("Alice vaults = %#v", vaultList.Vaults)
	}

	bobVault := requestJSON(t, mux, http.MethodGet, "/api/v1/vaults/"+vault.ID, bobToken, nil)
	if bobVault.Code != http.StatusNotFound {
		t.Fatalf("Bob access to Alice vault status = %d, want %d", bobVault.Code, http.StatusNotFound)
	}
	bobVaults := requestJSON(t, mux, http.MethodGet, "/api/v1/vaults", bobToken, nil)
	var bobVaultList struct {
		Vaults []model.Vault `json:"vaults"`
	}
	decodeResponse(t, bobVaults, &bobVaultList)
	if len(bobVaultList.Vaults) != 0 {
		t.Fatalf("Bob vaults = %#v, want empty", bobVaultList.Vaults)
	}

	createdDevice := requestJSON(t, mux, http.MethodPost, "/api/v1/devices", aliceToken, map[string]string{
		"name": "Alice Mac", "public_key": "ed25519-public-key",
	})
	if createdDevice.Code != http.StatusCreated {
		t.Fatalf("create device status = %d, want %d", createdDevice.Code, http.StatusCreated)
	}
	var device model.Device
	decodeResponse(t, createdDevice, &device)
	if device.UserID != alice.ID || device.Name != "Alice Mac" {
		t.Fatalf("created device = %#v", device)
	}

	bobDelete := requestJSON(t, mux, http.MethodDelete, "/api/v1/devices/"+device.ID, bobToken, nil)
	if bobDelete.Code != http.StatusNotFound {
		t.Fatalf("Bob delete Alice device status = %d, want %d", bobDelete.Code, http.StatusNotFound)
	}
	aliceDelete := requestJSON(t, mux, http.MethodDelete, "/api/v1/devices/"+device.ID, aliceToken, nil)
	if aliceDelete.Code != http.StatusNoContent {
		t.Fatalf("Alice delete device status = %d, want %d", aliceDelete.Code, http.StatusNoContent)
	}
}

func TestProtectedEndpointsRequireBearerToken(t *testing.T) {
	mux := testMux(t)
	response := requestJSON(t, mux, http.MethodGet, "/api/v1/vaults", "", nil)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusUnauthorized)
	}
	if response.Header().Get("WWW-Authenticate") == "" {
		t.Fatal("missing WWW-Authenticate header")
	}
}

func testMux(t *testing.T) http.Handler {
	t.Helper()
	database, err := sqlite.Open(context.Background(), ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	if err := database.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	return NewMux(store.NewRepository(database))
}

func registerUser(t *testing.T, handler http.Handler, email, plainTextPassword string) model.User {
	t.Helper()
	response := requestJSON(t, handler, http.MethodPost, "/api/v1/auth/register", "", map[string]string{
		"email": email, "password": plainTextPassword,
	})
	if response.Code != http.StatusCreated {
		t.Fatalf("register %s status = %d, body = %s", email, response.Code, response.Body.String())
	}
	var user model.User
	decodeResponse(t, response, &user)
	return user
}

func loginUser(t *testing.T, handler http.Handler, email, plainTextPassword string) string {
	t.Helper()
	response := requestJSON(t, handler, http.MethodPost, "/api/v1/auth/login", "", map[string]string{
		"email": email, "password": plainTextPassword,
	})
	if response.Code != http.StatusOK {
		t.Fatalf("login %s status = %d, body = %s", email, response.Code, response.Body.String())
	}
	var session model.Session
	decodeResponse(t, response, &session)
	if session.AccessToken == "" || session.TokenType != "Bearer" {
		t.Fatalf("invalid session = %#v", session)
	}
	return session.TokenType + " " + session.AccessToken
}

func requestJSON(t *testing.T, handler http.Handler, method, path, authorization string, payload any) *httptest.ResponseRecorder {
	t.Helper()
	var body *bytes.Reader
	if payload == nil {
		body = bytes.NewReader(nil)
	} else {
		encoded, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		body = bytes.NewReader(encoded)
	}
	request := httptest.NewRequest(method, path, body)
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func decodeResponse(t *testing.T, response *httptest.ResponseRecorder, target any) {
	t.Helper()
	if err := json.NewDecoder(response.Body).Decode(target); err != nil {
		t.Fatalf("decode response: %v, body = %s", err, response.Body.String())
	}
}
