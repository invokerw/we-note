package httpapi

import (
	"fmt"
	"github.com/weifei/we-note/services/api/internal/store"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
)

func (a *API) createAsset(w http.ResponseWriter, r *http.Request) {
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	var req struct {
		Note string `json:"file_id"`
		Name string `json:"name"`
		Type string `json:"media_type"`
		Hash string `json:"content_hash"`
		Size int64  `json:"content_size"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, 400, "INVALID_REQUEST", err.Error())
		return
	}
	if !store.PictureType(req.Type) {
		writeError(w, 415, "IMAGE_TYPE_REQUIRED", "请选择 PNG、JPEG、GIF 或 WebP 图片")
		return
	}
	asset, err := a.repository.CreateNoteImage(r.Context(), user.ID, r.PathValue("vault_id"), req.Note, req.Name, req.Type, req.Hash, r.Header.Get("Idempotency-Key"), req.Size)
	if err != nil {
		resourceError(w, err)
		return
	}
	writeJSON(w, 201, asset)
}
func (a *API) allowAssetRead(w http.ResponseWriter, r *http.Request) bool {
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	w.Header().Set("Cache-Control", "private, no-store")
	site := r.Header.Get("Sec-Fetch-Site")
	origin := r.Header.Get("Origin")
	if site == "same-site" || site == "cross-site" || (origin != "" && origin != a.repository.PublicBase()) {
		writeError(w, http.StatusForbidden, "INVALID_ORIGIN", "cross-origin resource access denied")
		return false
	}
	return true
}

func (a *API) asset(w http.ResponseWriter, r *http.Request) {
	if r.PathValue("vault_id") == "" && !a.allowAssetRead(w, r) {
		return
	}
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	id, vault := r.PathValue("asset_id"), r.PathValue("vault_id")
	var asset store.Asset
	var err error
	if r.PathValue("owner") != "" {
		asset, err = a.repository.AssetForScopedPath(r.Context(), user.ID, r.PathValue("owner"), r.PathValue("asset_vault"), r.PathValue("year"), r.PathValue("month"), r.PathValue("day"), r.PathValue("hash"))
	} else if r.PathValue("hash") != "" {
		asset, err = a.repository.AssetForPublicPath(r.Context(), user.ID, r.PathValue("year"), r.PathValue("month"), r.PathValue("day"), r.PathValue("hash"))
	} else {
		asset, err = a.repository.AssetForUser(r.Context(), user.ID, vault, id)
	}
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
	w.Header().Set("X-Content-Hash", asset.Hash)
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

func (a *API) assetParts(w http.ResponseWriter, r *http.Request) {
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	vault := r.PathValue("vault_id")
	allowed, err := a.repository.UserCanWriteVault(ctx, user.ID, vault)
	if err != nil {
		resourceError(w, err)
		return
	}
	if !allowed {
		resourceError(w, store.ErrNotFound)
		return
	}
	asset, err := a.repository.AssetForUser(ctx, user.ID, vault, r.PathValue("asset_id"))
	if err != nil {
		resourceError(w, err)
		return
	}
	switch r.Method {
	case http.MethodGet:
		parts, err := a.repository.AssetParts(ctx, asset)
		if err != nil {
			resourceError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"part_size": store.PartSize, "completed_parts": parts, "status": asset.Status})
		return
	case http.MethodPut:
		number, e := strconv.Atoi(r.PathValue("number"))
		if e != nil {
			writeError(w, 400, "INVALID_PART", "invalid part number")
			return
		}
		err = a.repository.PutAssetPart(ctx, asset, number, r.Header.Get("Content-Range"), r.Header.Get("X-Part-Hash"), r.Body)
	case http.MethodPost:
		err = a.repository.AssembleAsset(ctx, asset)
	}
	if err != nil {
		resourceError(w, err)
		return
	}
	w.WriteHeader(204)
}
