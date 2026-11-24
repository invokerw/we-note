package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/weifei/we-note/services/api/internal/store"
)

const applyPattern = "POST /api/v1/admin/backups/{backup_id}/apply"
const storagePattern = "PUT /api/v1/admin/storage/{scope}"

func (a *API) maintenanceMux(inner *http.ServeMux) *http.ServeMux {
	outer := http.NewServeMux()
	outer.Handle("/healthz", inner)
	outer.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		gate := &a.repository.Maintenance
		if a.repository.Cleaning.Load() {
			gate.RLock()
		} else if !gate.TryRLock() {
			w.Header().Set("Retry-After", "5")
			writeError(w, 503, "MAINTENANCE", "正在迁移存储或恢复备份，请稍后重试")
			return
		}
		_, pattern := inner.Handler(r)
		if pattern == applyPattern || pattern == storagePattern || (r.Method != "GET" && strings.Contains(pattern, " /api/v1/admin/storage-catalog/")) {
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

func (a *API) adminStorageCatalog(w http.ResponseWriter, r *http.Request) {
	admin, ok := a.adminUser(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	if r.Method != "GET" {
		var input struct {
			store.StorageConfig
			Revision  *int   `json:"revision"`
			ProfileID string `json:"profile_id"`
			Name      string `json:"name"`
		}
		if err := decodeJSON(w, r, &input); err != nil || input.Revision == nil || *input.Revision < 0 {
			writeError(w, 400, "INVALID_REQUEST", "请加载当前存储配置后重试")
			return
		}
		id := r.PathValue("id")
		scope := r.PathValue("scope")
		var err error
		action := "storage.profile.save"
		detail := input.Name
		switch {
		case scope != "":
			action = "storage.bind"
			id = input.ProfileID
			detail = scope
			err = a.repository.BindStorageProfile(ctx, admin.ID, scope, id, *input.Revision)
		case r.Method == "DELETE":
			action = "storage.profile.delete"
			err = a.repository.DeleteStorageProfile(ctx, admin.ID, id, *input.Revision)
		default:
			err = a.repository.SaveStorageProfile(ctx, admin.ID, id, input.Name, input.StorageConfig, *input.Revision)
		}
		if err != nil {
			switch {
			case errors.Is(err, store.ErrConflict):
				writeError(w, 409, "CONFLICT", err.Error())
			case errors.Is(err, store.ErrNotFound):
				writeError(w, 404, "NOT_FOUND", "存储位置不存在")
			default:
				writeError(w, 400, "STORAGE_FAILED", err.Error())
			}
			return
		}
		_ = a.repository.RecordAdminAudit(ctx, admin.ID, action, "storage", id, detail)
	}
	catalog, err := a.repository.StorageCatalog(ctx)
	if err != nil {
		resourceError(w, err)
		return
	}
	writeJSON(w, 200, catalog)
}
