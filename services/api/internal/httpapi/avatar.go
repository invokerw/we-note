package httpapi

import (
	"bytes"
	"encoding/base64"
	"image/png"
	"net/http"
	"strings"
)

func validAvatar(value string) bool {
	if value == "" {
		return true
	}
	encoded, ok := strings.CutPrefix(value, "data:image/png;base64,")
	if !ok {
		return false
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return false
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width > 256 || cfg.Height > 256 {
		return false
	}
	_, err = png.Decode(bytes.NewReader(data))
	return err == nil
}

func (a *API) avatar(w http.ResponseWriter, r *http.Request) {
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodGet {
		value, err := a.repository.Avatar(r.Context(), user.ID)
		if err != nil {
			resourceError(w, err)
			return
		}
		writeJSON(w, 200, map[string]string{"avatar": value})
		return
	}
	var profile struct {
		Avatar *string `json:"avatar"`
	}
	if err := decodeJSONLimit(w, r, &profile, 512<<10); err != nil || profile.Avatar == nil || !validAvatar(*profile.Avatar) {
		writeError(w, 400, "INVALID_AVATAR", "头像图片无效，请重新选择")
		return
	}
	if err := a.repository.SetAvatar(r.Context(), user.ID, *profile.Avatar); err != nil {
		resourceError(w, err)
		return
	}
	w.WriteHeader(204)
}
