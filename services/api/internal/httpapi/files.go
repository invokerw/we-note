package httpapi

import (
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/weifei/we-note/services/api/internal/model"
	"github.com/weifei/we-note/services/api/internal/store"
)

func (a *API) listFiles(w http.ResponseWriter, r *http.Request) {
	if !a.canReadFiles(w, r) {
		return
	}
	vaultID := r.PathValue("vault_id")
	files, err := a.repository.ListFiles(r.Context(), vaultID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not list files")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"files": files})
}

func (a *API) getFile(w http.ResponseWriter, r *http.Request) {
	if !a.canReadFiles(w, r) {
		return
	}
	vaultID := r.PathValue("vault_id")
	file, err := a.repository.File(r.Context(), vaultID, r.PathValue("file_id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "file not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not load file")
		return
	}
	writeJSON(w, http.StatusOK, file)
}

func (a *API) fileContent(deleted bool) http.HandlerFunc {
	open := a.repository.OpenFileContent
	if deleted {
		open = a.repository.OpenTrashFileContent
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if !a.canReadFiles(w, r) {
			return
		}
		vaultID := r.PathValue("vault_id")
		version, reader, err := open(r.Context(), vaultID, r.PathValue("file_id"))
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "NOT_FOUND", "file content not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not open file content")
			return
		}
		defer reader.Close()
		writeContentHeaders(w, version)
		if r.Method != http.MethodHead {
			if _, err := io.Copy(w, reader); err != nil {
				panic(http.ErrAbortHandler)
			}
		}
	}

}

func (a *API) listFileVersions(w http.ResponseWriter, r *http.Request) {
	if !a.canReadFiles(w, r) {
		return
	}
	vaultID := r.PathValue("vault_id")
	fileID := r.PathValue("file_id")
	if _, err := a.repository.File(r.Context(), vaultID, fileID); errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "file not found")
		return
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not load file")
		return
	}
	versions, err := a.repository.ListFileVersions(r.Context(), vaultID, fileID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not list file versions")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"versions": versions})
}

func (a *API) getFileVersion(w http.ResponseWriter, r *http.Request) {
	if !a.canReadFiles(w, r) {
		return
	}
	vaultID := r.PathValue("vault_id")
	version, err := a.repository.FileVersion(r.Context(), vaultID, r.PathValue("file_id"), r.PathValue("version_id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "file version not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not load file version")
		return
	}
	writeJSON(w, http.StatusOK, version)
}

func (a *API) canReadFiles(w http.ResponseWriter, r *http.Request) bool {
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return false
	}
	canAccess, err := a.repository.UserCanAccessVault(r.Context(), user.ID, r.PathValue("vault_id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not validate file access")
		return false
	}
	if !canAccess {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Vault not found")
		return false
	}
	return true
}

func writeContentHeaders(w http.ResponseWriter, version model.FileVersion) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Type", contentTypeForFormat(version.Metadata.Format))
	w.Header().Set("Content-Length", fmt.Sprintf("%d", version.ContentSize))
	w.Header().Set("ETag", fmt.Sprintf("\"%s\"", version.ContentHash))
	w.Header().Set("X-Content-Hash", version.ContentHash)
	w.Header().Set("X-Version-Id", version.ID)
}

func contentTypeForFormat(format string) string {
	switch format {
	case "md":
		return "text/markdown; charset=utf-8"
	case "xmind":
		return "application/vnd.xmind.workbook"
	case "json":
		return "application/json; charset=utf-8"
	default:
		return "text/plain; charset=utf-8"
	}
}
