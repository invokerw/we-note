package httpapi

import (
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"

	"github.com/weifei/we-note/services/api/internal/store"
)

func (a *API) linkRoutes(m *http.ServeMux) {
	m.HandleFunc("POST /api/v1/share-links", a.manageLinks)
	m.HandleFunc("GET /api/v1/share-links", a.manageLinks)
	m.HandleFunc("DELETE /api/v1/share-links/{id}", a.manageLinks)
	for _, route := range []string{"POST /s/{id}/session", "GET /s/{id}/snapshot", "GET /s/{id}/files/{version}", "GET /s/{id}/assets/{asset}", "POST /s/{id}/download", "POST /s/{id}/files/{version}/download", "POST /s/{id}/import"} {
		m.HandleFunc(route, a.publicLink)
	}
}
func (a *API) manageLinks(w http.ResponseWriter, r *http.Request) {
	u, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	w.Header().Set("Cache-Control", "no-store")
	switch r.Method {
	case "GET":
		links, err := a.repository.Links(ctx, u.ID, r.URL.Query().Get("vault_id"))
		if err != nil {
			resourceError(w, err)
			return
		}
		writeJSON(w, 200, links)
	case "DELETE":
		if err := a.repository.RevokeLink(ctx, u.ID, r.PathValue("id")); err != nil {
			resourceError(w, err)
			return
		}
		w.WriteHeader(204)
	default:
		var q store.LinkOptions
		if err := decodeJSON(w, r, &q); err != nil {
			writeError(w, 400, "INVALID_REQUEST", err.Error())
			return
		}
		l, err := a.repository.CreateLink(ctx, u.ID, r.Header.Get("Idempotency-Key"), q)
		if err != nil {
			resourceError(w, err)
			return
		}
		writeJSON(w, 201, l)
	}
}
func (a *API) publicLink(w http.ResponseWriter, r *http.Request) {
	if r.PathValue("asset") != "" && !a.allowAssetRead(w, r) {
		return
	}
	ctx := r.Context()
	id := r.PathValue("id")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	if r.Method == "POST" {
		origin := r.Header.Get("Origin")
		if origin != "" {
			u, e := url.Parse(origin)
			if e != nil || !strings.EqualFold(u.Host, r.Host) {
				writeError(w, 403, "INVALID_ORIGIN", "cross-origin submission denied")
				return
			}
		}
		if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			writeError(w, 403, "INVALID_ORIGIN", "cross-site submission denied")
			return
		}
	}
	if r.Pattern == "POST /s/{id}/session" {
		var q struct{ Token, Password string }
		if err := decodeJSON(w, r, &q); err != nil {
			writeError(w, 400, "INVALID_REQUEST", err.Error())
			return
		}
		session, err := a.repository.ExchangeLink(ctx, id, q.Token, q.Password)
		if err != nil {
			resourceError(w, err)
			return
		}
		host := (&url.URL{Host: r.Host}).Hostname()
		secure := r.TLS != nil || (host != "localhost" && host != "127.0.0.1" && host != "::1")
		http.SetCookie(w, &http.Cookie{Name: "wenote_share", Value: session, Path: "/s/" + id + "/", HttpOnly: true, Secure: secure, SameSite: http.SameSiteStrictMode, MaxAge: store.LinkSessionSeconds})
		w.WriteHeader(204)
		return
	}
	cookie, err := r.Cookie("wenote_share")
	if err != nil {
		writeError(w, 401, "SHARE_SESSION_REQUIRED", "请使用原分享链接重新打开")
		return
	}
	if r.Pattern == "POST /s/{id}/import" {
		u, ok := a.authenticatedUser(w, r)
		if !ok {
			return
		}
		var q struct {
			Vault  string `json:"vault_id"`
			Folder string `json:"folder"`
			Direct bool   `json:"place_single_file_here"`
		}
		if err := decodeJSON(w, r, &q); err != nil {
			writeError(w, 400, "INVALID_REQUEST", err.Error())
			return
		}
		files, err := a.repository.ImportLink(ctx, u.ID, id, cookie.Value, q.Vault, q.Folder, q.Direct)
		if err != nil {
			resourceError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"files": files})
		return
	}
	if r.Pattern == "POST /s/{id}/files/{version}/download" {
		name, data, err := a.repository.DownloadLinkFile(ctx, id, cookie.Value, r.PathValue("version"))
		if err != nil {
			resourceError(w, err)
			return
		}
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write(data)
		return
	}
	download := r.Pattern == "POST /s/{id}/download"
	s, err := a.repository.LinkSnapshot(ctx, id, cookie.Value, download)
	if err != nil {
		resourceError(w, err)
		return
	}
	switch {
	case download:
		w.Header().Set("Content-Disposition", `attachment; filename="snapshot.zip"`)
		w.Header().Set("Content-Type", "application/zip")
		if err := a.repository.WriteLinkArchive(ctx, w, s); err != nil {
			panic(http.ErrAbortHandler)
		}
	case r.PathValue("version") != "":
		text, err := a.repository.LinkText(ctx, s, r.PathValue("version"))
		if err != nil {
			resourceError(w, err)
			return
		}
		writeJSON(w, 200, map[string]string{"text": text})
	case r.PathValue("asset") != "":
		for _, asset := range s.Assets {
			if asset.ID != r.PathValue("asset") {
				continue
			}
			switch asset.Type {
			case "image/png", "image/jpeg", "image/gif", "image/webp":
			default:
				resourceError(w, store.ErrNotFound)
				return
			}
			src, err := a.repository.OpenAsset(ctx, asset)
			if err != nil {
				resourceError(w, err)
				return
			}
			defer src.Close()
			w.Header().Set("Content-Type", asset.Type)
			if _, err = io.Copy(w, src); err != nil {
				panic(http.ErrAbortHandler)
			}
			return
		}
		resourceError(w, store.ErrNotFound)
	default:
		writeJSON(w, 200, s)
	}
}
