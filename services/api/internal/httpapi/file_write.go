package httpapi

import (
	"errors"
	"github.com/weifei/we-note/services/api/internal/store"
	"io"
	"net/http"
)

func resourceError(w http.ResponseWriter, err error) {
	var specific *store.SyncError
	switch {
	case errors.As(err, &specific):
		writeError(w, specific.Status, specific.Code, specific.Message)
	case errors.Is(err, store.ErrNotFound):
		writeError(w, 404, "NOT_FOUND", "resource not found")
	default:
		writeError(w, 500, "INTERNAL_ERROR", "resource operation failed")
	}
}
func (a *API) writeFile(op string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := a.authenticatedUser(w, r)
		if !ok {
			return
		}
		var input store.FileWrite
		if err := decodeJSONLimit(w, r, &input, 24<<20); err != nil {
			writeError(w, 400, "INVALID_REQUEST", err.Error())
			return
		}
		result, err := a.repository.WriteFile(r.Context(), user.ID, r.PathValue("vault_id"), r.PathValue("file_id"), op, r.Header.Get("Idempotency-Key"), input)
		if err != nil {
			resourceError(w, err)
			return
		}
		status := 200
		if op == "create_file" {
			status = 201
		}
		writeJSON(w, status, result)
	}
}
func (a *API) trash(w http.ResponseWriter, r *http.Request) {
	if !a.canReadFiles(w, r) {
		return
	}
	files, err := a.repository.Trash(r.Context(), r.PathValue("vault_id"))
	if err != nil {
		resourceError(w, err)
		return
	}
	items, err := a.repository.TrashItems(r.Context(), r.PathValue("vault_id"))
	if err != nil {
		resourceError(w, err)
		return
	}
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	vault, err := a.repository.VaultForUser(r.Context(), user.ID, r.PathValue("vault_id"))
	if err != nil {
		resourceError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"files": files, "items": items, "can_manage": vault.OwnerUserID == user.ID})
}
func (a *API) versionContent(w http.ResponseWriter, r *http.Request) {
	if !a.canReadFiles(w, r) {
		return
	}
	v, reader, err := a.repository.OpenVersion(r.Context(), r.PathValue("vault_id"), r.PathValue("file_id"), r.PathValue("version_id"))
	if err != nil {
		resourceError(w, err)
		return
	}
	defer reader.Close()
	writeContentHeaders(w, v)
	if r.Method != http.MethodHead {
		if _, err := io.Copy(w, reader); err != nil {
			panic(http.ErrAbortHandler)
		}
	}
}

func (a *API) changeEntry(w http.ResponseWriter, r *http.Request) {
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	var input store.EntryChange
	if err := decodeJSONLimit(w, r, &input, 4<<20); err != nil {
		writeError(w, 400, "INVALID_REQUEST", err.Error())
		return
	}
	if err := a.repository.ChangeEntry(r.Context(), user.ID, r.PathValue("vault_id"), r.Header.Get("Idempotency-Key"), input); err != nil {
		resourceError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) manageTrash(w http.ResponseWriter, r *http.Request) {
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	var input struct {
		Operation string `json:"operation"`
		Kind      string `json:"kind"`
		ID        string `json:"id"`
	}
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, 400, "INVALID_REQUEST", "请选择回收站操作")
		return
	}
	held, err := a.repository.ManageTrash(r.Context(), user.ID, r.PathValue("vault_id"), input.Operation, input.Kind, input.ID)
	if err != nil {
		resourceError(w, err)
		return
	}
	if input.Operation != "restore" {
		go a.repository.CleanupInBackground()
	}
	writeJSON(w, 200, map[string]int{"retained": held})
}
