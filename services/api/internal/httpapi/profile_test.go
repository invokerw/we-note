package httpapi

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/png"
	"testing"
)

func TestPersonalAvatar(t *testing.T) {
	mux := testMux(t)
	tokenFor := func(email string) string {
		u := registerUser(t, mux, email, "test password")
		return loginUser(t, mux, u.Email, "test password")
	}
	alice, bob := tokenFor("a@example.org"), tokenFor("b@example.org")
	var img bytes.Buffer
	if err := png.Encode(&img, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	avatar := "data:image/png;base64," + base64.StdEncoding.EncodeToString(img.Bytes())
	const url = "/api/v1/me/avatar"
	save := func(value string, want int) {
		t.Helper()
		r := requestJSON(t, mux, "PUT", url, alice, map[string]string{"avatar": value})
		if r.Code != want {
			t.Fatalf("save: %d %s", r.Code, r.Body.String())
		}
	}
	check := func(token, want string) {
		t.Helper()
		r := requestJSON(t, mux, "GET", url, token, nil)
		var result struct{ Avatar string }
		decodeResponse(t, r, &result)
		if r.Code != 200 || result.Avatar != want {
			t.Fatal("unexpected account avatar", r.Code)
		}
	}
	save(avatar, 204)
	save("not an image", 400)
	check(alice, avatar)
	check(bob, "")
	save("", 204)
	check(alice, "")
}

func TestMailboxRetired(t *testing.T) {
	mux := testMux(t)
	for _, route := range []struct{ method, path string }{{"POST", "/api/v1/shares"}, {"GET", "/api/v1/shares/inbox"}, {"GET", "/api/v1/shares/sent"}, {"POST", "/api/v1/shares/old/accept"}} {
		if r := requestJSON(t, mux, route.method, route.path, "", nil); r.Code != 404 {
			t.Errorf("%s returned %d", route.path, r.Code)
		}
	}
}
