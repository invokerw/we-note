package httpapi

import (
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/weifei/we-note/services/api/internal/store"
)

func (a *API) exportRoutes(m *http.ServeMux) {
	for _, route := range []string{"POST /api/v1/vaults/{vault_id}/exports", "GET /api/v1/vaults/{vault_id}/exports", "GET /api/v1/vaults/{vault_id}/exports/{job_id}", "GET /api/v1/vaults/{vault_id}/exports/{job_id}/download"} {
		m.HandleFunc(route, a.exports)
	}
}
func (a *API) exports(w http.ResponseWriter, r *http.Request) {
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	ctx, vault, id := r.Context(), r.PathValue("vault_id"), r.PathValue("job_id")
	allowed, err := a.repository.CanExport(ctx, user.ID, vault)
	if err != nil {
		resourceError(w, err)
		return
	}
	if !allowed {
		writeError(w, 403, "FORBIDDEN", "export permission required")
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	if r.Method == http.MethodPost {
		var in store.ExportOptions
		if err := decodeJSON(w, r, &in); err != nil {
			writeError(w, 400, "INVALID_REQUEST", err.Error())
			return
		}
		j, err := a.repository.CreateExport(ctx, user.ID, vault, r.Header.Get("Idempotency-Key"), in)
		if err != nil {
			resourceError(w, err)
			return
		}
		a.repository.RunExports()
		writeJSON(w, 202, j)
		return
	}
	if id == "" {
		jobs, e := a.repository.Exports(ctx, user.ID, vault)
		if e != nil {
			resourceError(w, e)
			return
		}
		writeJSON(w, 200, jobs)
		return
	}
	j, e := a.repository.Export(ctx, user.ID, vault, id)
	if e != nil {
		resourceError(w, e)
		return
	}
	if !strings.HasSuffix(r.URL.Path, "/download") {
		writeJSON(w, 200, j)
		return
	}
	body, e := a.repository.OpenExport(ctx, user.ID, vault, j, r.Method != http.MethodHead)
	if e != nil {
		resourceError(w, e)
		return
	}
	defer body.Close()
	w.Header().Set("Content-Type", "application/zip")
	name := j.Scope
	if j.Mode == "portable" {
		name += "-portable"
	}
	w.Header().Set("Content-Disposition", `attachment; filename="wenote-`+name+`.zip"`)
	w.Header().Set("Content-Length", fmt.Sprint(j.Size))
	if r.Method != http.MethodHead {
		if _, e = io.Copy(w, body); e != nil {
			panic(http.ErrAbortHandler)
		}
	}
}
