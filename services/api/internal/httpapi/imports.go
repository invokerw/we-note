package httpapi

import (
	"context"
	"net/http"
	"time"
)

func (a *API) importRoutes(m *http.ServeMux) {
	for _, route := range []string{"GET /api/v1/vaults/{vault_id}/imports", "POST /api/v1/vaults/{vault_id}/imports", "POST /api/v1/vaults/{vault_id}/imports/{id}/confirm", "DELETE /api/v1/vaults/{vault_id}/imports/{id}"} {
		m.HandleFunc(route, a.imports)
	}
}
func (a *API) imports(w http.ResponseWriter, r *http.Request) {
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	vault, id := r.PathValue("vault_id"), r.PathValue("id")
	allowed, err := a.repository.UserCanWriteVault(ctx, user.ID, vault)
	if err != nil {
		resourceError(w, err)
		return
	}
	if !allowed {
		writeError(w, 403, "FORBIDDEN", "需要当前笔记库的写入权限")
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	var result any
	switch {
	case r.Method == "GET":
		result, err = a.repository.Imports(ctx, user.ID, vault)
	case r.Method == "DELETE":
		err = a.repository.CancelImport(ctx, user.ID, vault, id)
		result = struct{}{}
	case id == "":
		result, err = a.repository.PreviewImport(ctx, user.ID, vault, r.Body)
	default:
		var in struct {
			Folder string `json:"folder"`
		}
		if e := decodeJSON(w, r, &in); e != nil {
			writeError(w, 400, "INVALID_REQUEST", e.Error())
			return
		}
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Minute)
		defer cancel()
		result, err = a.repository.ConfirmImport(ctx, user.ID, vault, id, in.Folder)
	}
	if err != nil {
		resourceError(w, err)
		return
	}
	writeJSON(w, 200, result)
}
