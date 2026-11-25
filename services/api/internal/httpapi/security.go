package httpapi

import (
	"net/http"
	"strconv"

	"github.com/weifei/we-note/services/api/internal/store"
)

func (a *API) securityRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/audit", a.security)
	m.HandleFunc("GET /api/v1/encrypted-vaults", a.security)
	m.HandleFunc("GET /api/v1/encrypted-vaults/{id}", a.security)
	m.HandleFunc("PUT /api/v1/encrypted-vaults/{id}", a.security)

}
func (a *API) security(w http.ResponseWriter, r *http.Request) {
	u, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	id := r.PathValue("id")
	var out any
	var err error
	w.Header().Set("Cache-Control", "no-store")
	switch r.Pattern {
	case "GET /api/v1/audit":
		var before int64
		if cursor := r.URL.Query().Get("before"); cursor != "" {
			before, err = strconv.ParseInt(cursor, 10, 64)
			if err != nil || before < 1 {
				writeError(w, 400, "INVALID_CURSOR", "invalid audit cursor")
				return
			}
		}
		out, err = a.repository.Audit(ctx, u.ID, before)
	case "GET /api/v1/encrypted-vaults":
		out, err = a.repository.EncryptedVaults(ctx, u.ID)
	case "GET /api/v1/encrypted-vaults/{id}":
		out, err = a.repository.EncryptedVault(ctx, u.ID, id)
	case "PUT /api/v1/encrypted-vaults/{id}":
		var q store.Envelope
		if err = decodeJSONLimit(w, r, &q, 23<<20); err != nil {
			writeError(w, 400, "INVALID_REQUEST", err.Error())
			return
		}
		out, err = a.repository.SaveEncrypted(ctx, u.ID, id, q)

	}
	if err != nil {
		resourceError(w, err)
		return
	}
	if out == nil {
		w.WriteHeader(204)
		return
	}
	writeJSON(w, 200, out)
}
