package httpapi

import (
	"github.com/weifei/we-note/services/api/internal/store"
	"net/http"
)

func (a *API) shareRoutes(m *http.ServeMux) {
	m.HandleFunc("POST /api/v1/shares", a.createShare)
	m.HandleFunc("GET /api/v1/shares/inbox", a.shares(true))
	m.HandleFunc("GET /api/v1/shares/sent", a.shares(false))
	m.HandleFunc("POST /api/v1/shares/{share_id}/accept", a.acceptShare)
	m.HandleFunc("POST /api/v1/shares/{share_id}/reject", a.closeShare)
	m.HandleFunc("DELETE /api/v1/shares/{share_id}", a.closeShare)
}
func (a *API) createShare(w http.ResponseWriter, r *http.Request) {
	u, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	var req store.ShareRequest
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, 400, "INVALID_REQUEST", err.Error())
		return
	}
	s, err := a.repository.ShareFiles(r.Context(), u.ID, r.Header.Get("Idempotency-Key"), req)
	if err != nil {
		resourceError(w, err)
		return
	}
	writeJSON(w, 201, s)
}
func (a *API) shares(inbox bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := a.authenticatedUser(w, r)
		if !ok {
			return
		}
		shares, err := a.repository.ListShares(r.Context(), u.ID, inbox)
		if err != nil {
			resourceError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"shares": shares})
	}
}
func (a *API) acceptShare(w http.ResponseWriter, r *http.Request) {
	u, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	var req struct {
		Vault  string `json:"vault_id"`
		Folder string `json:"folder"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		writeError(w, 400, "INVALID_REQUEST", err.Error())
		return
	}
	files, err := a.repository.AcceptShare(r.Context(), u.ID, r.PathValue("share_id"), req.Vault, req.Folder)
	if err != nil {
		resourceError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"files": files})
}
func (a *API) closeShare(w http.ResponseWriter, r *http.Request) {
	u, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	if err := a.repository.CloseShare(r.Context(), u.ID, r.PathValue("share_id"), r.Method == http.MethodDelete); err != nil {
		resourceError(w, err)
		return
	}
	w.WriteHeader(204)
}
