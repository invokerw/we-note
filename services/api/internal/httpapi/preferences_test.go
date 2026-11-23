package httpapi

import (
	"net/http"
	"testing"
)

func TestPluginSettingsArePersistentAndUserScoped(t *testing.T) {
	mux := testMux(t)
	alice := registerUser(t, mux, "preferences-alice@example.com", "alice password")
	aliceToken := loginUser(t, mux, alice.Email, "alice password")
	bob := registerUser(t, mux, "preferences-bob@example.com", "bob password")
	bobToken := loginUser(t, mux, bob.Email, "bob password")

	var empty struct {
		Plugins map[string]any `json:"plugins"`
	}
	response := requestJSON(t, mux, http.MethodGet, "/api/v1/me/plugin-settings", aliceToken, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("initial settings status = %d", response.Code)
	}
	decodeResponse(t, response, &empty)
	if len(empty.Plugins) != 0 {
		t.Fatalf("initial settings = %#v, want empty", empty.Plugins)
	}

	settings := map[string]any{
		"theme":            "paper",
		"defaultMode":      "split",
		"rememberNoteMode": true,
	}
	response = requestJSON(t, mux, http.MethodPut, "/api/v1/me/plugin-settings/com.wenote.md", aliceToken, settings)
	if response.Code != http.StatusNoContent {
		t.Fatalf("save settings status = %d, body = %s", response.Code, response.Body.String())
	}

	var saved struct {
		Plugins map[string]map[string]any `json:"plugins"`
	}
	response = requestJSON(t, mux, http.MethodGet, "/api/v1/me/plugin-settings", aliceToken, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("saved settings status = %d", response.Code)
	}
	decodeResponse(t, response, &saved)
	if saved.Plugins["com.wenote.md"]["theme"] != "paper" || saved.Plugins["com.wenote.md"]["defaultMode"] != "split" {
		t.Fatalf("saved settings = %#v", saved.Plugins)
	}

	response = requestJSON(t, mux, http.MethodGet, "/api/v1/me/plugin-settings", bobToken, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("other user settings status = %d", response.Code)
	}
	decodeResponse(t, response, &empty)
	if len(empty.Plugins) != 0 {
		t.Fatalf("other user settings = %#v, want empty", empty.Plugins)
	}
}

func TestPluginSettingsRejectNonObjectJSON(t *testing.T) {
	mux := testMux(t)
	user := registerUser(t, mux, "preferences-invalid@example.com", "alice password")
	token := loginUser(t, mux, user.Email, "alice password")
	response := requestRaw(t, mux, http.MethodPut, "/api/v1/me/plugin-settings/com.wenote.md", token, []byte(`["paper"]`))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("array settings status = %d, want %d", response.Code, http.StatusBadRequest)
	}
}
