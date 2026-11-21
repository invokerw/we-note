package httpapi

import (
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
)

func (a *API) createAsset(w http.ResponseWriter, r *http.Request) {
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	var req struct {
		Name string `json:"name"`
		Type string `json:"media_type"`
		Hash string `json:"content_hash"`
		Size int64  `json:"content_size"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, 400, "INVALID_REQUEST", err.Error())
		return
	}
	asset, err := a.repository.CreateAsset(r.Context(), user.ID, r.PathValue("vault_id"), req.Name, req.Type, req.Hash, r.Header.Get("Idempotency-Key"), req.Size)
	if err != nil {
		resourceError(w, err)
		return
	}
	writeJSON(w, 201, asset)
}
func (a *API) asset(w http.ResponseWriter, r *http.Request) {
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	id, vault := r.PathValue("asset_id"), r.PathValue("vault_id")
	asset, err := a.repository.AssetForUser(r.Context(), user.ID, vault, id)
	if err != nil {
		resourceError(w, err)
		return
	}
	switch r.Method {
	case http.MethodDelete:
		if err := a.repository.DeleteAsset(r.Context(), user.ID, vault, id); err != nil {
			resourceError(w, err)
			return
		}
		w.WriteHeader(204)
		return
	case http.MethodPost:
		allowed, err := a.repository.UserCanWriteVault(r.Context(), user.ID, vault)
		if err != nil {
			resourceError(w, err)
			return
		}
		if !allowed {
			writeError(w, 403, "FORBIDDEN", "write access required")
			return
		}
		u, err := a.repository.CompleteUploadSession(r.Context(), vault, asset.Upload, http.MaxBytesReader(w, r.Body, asset.Size+1))
		if err != nil {
			writeError(w, 409, "UPLOAD_FAILED", "asset bytes could not be verified")
			return
		}
		asset.Status = u.Status
		writeJSON(w, 200, asset)
		return
	}
	if vault != "" {
		writeJSON(w, 200, asset)
		return
	}
	body, err := a.repository.OpenAsset(r.Context(), asset)
	if err != nil {
		resourceError(w, err)
		return
	}
	defer body.Close()
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Type", asset.Type)
	disposition := "attachment"
	if strings.HasPrefix(asset.Type, "image/") && asset.Type != "image/svg+xml" {
		disposition = "inline"
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": asset.Name}))
	w.Header().Set("Content-Length", fmt.Sprint(asset.Size))
	if r.Method != http.MethodHead {
		if _, err := io.Copy(w, body); err != nil {
			panic(http.ErrAbortHandler)
		}
	}
}
