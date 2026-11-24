package httpapi

import (
	"net/http"

	"github.com/weifei/we-note/services/api/internal/store"
)

const applyPattern = "POST /api/v1/admin/backups/{backup_id}/apply"
const storagePattern = "PUT /api/v1/admin/storage/{scope}"

func (a *API) maintenanceMux(inner *http.ServeMux) *http.ServeMux {
	outer := http.NewServeMux()
	outer.Handle("/healthz", inner)
	outer.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		gate := &a.repository.Maintenance
		if !gate.TryRLock() {
			w.Header().Set("Retry-After", "5")
			writeError(w, 503, "MAINTENANCE", "正在迁移存储或恢复备份，请稍后重试")
			return
		}
		_, pattern := inner.Handler(r)
		if pattern == applyPattern || pattern == storagePattern {
			_, ok := a.adminUser(w, r)
			gate.RUnlock()
			if !ok {
				return
			}
			gate.Lock()
			defer gate.Unlock()
		} else {
			defer gate.RUnlock()
		}
		inner.ServeHTTP(w, r)
	})
	return outer
}
func (a *API) adminStorageConfig(w http.ResponseWriter, r *http.Request) {
	admin, ok := a.adminUser(w, r)
	if !ok {
		return
	}
	scope := r.PathValue("scope")
	if scope != "online" && scope != "backup" {
		writeError(w, 404, "NOT_FOUND", "未知存储用途")
		return
	}
	if r.Method == "PUT" {
		var input store.StorageConfig
		if err := decodeJSON(w, r, &input); err != nil {
			writeError(w, 400, "INVALID_REQUEST", err.Error())
			return
		}
		if err := a.repository.ConfigureStorage(r.Context(), admin.ID, scope, input); err != nil {
			writeError(w, 400, "STORAGE_FAILED", err.Error())
			return
		}
		_ = a.repository.RecordAdminAudit(r.Context(), admin.ID, "storage.configure", "storage", scope, input.Kind)
	}
	out, err := a.repository.StorageSettings(r.Context(), scope)
	if err != nil {
		resourceError(w, err)
		return
	}
	writeJSON(w, 200, out)
}
func (a *API) adminApplyBackup(w http.ResponseWriter, r *http.Request) {
	admin, ok := a.adminUser(w, r)
	if !ok {
		return
	}
	id := r.PathValue("backup_id")
	var input struct {
		Confirm string `json:"confirm"`
	}
	if err := decodeJSON(w, r, &input); err != nil || input.Confirm != id {
		writeError(w, 400, "CONFIRM_REQUIRED", "请确认要恢复的备份")
		return
	}
	safety, err := a.repository.ApplyBackup(r.Context(), admin.ID, id)
	if err != nil {
		writeError(w, 400, "RESTORE_FAILED", err.Error())
		return
	}
	a.repository.RunExports()
	writeJSON(w, 200, map[string]string{"safety_backup_id": safety})
}
