package httpapi

import (
	"net/http"
	"strconv"
)

func (a *API) audit(w http.ResponseWriter, r *http.Request) {
	u, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	var before int64
	if cursor := r.URL.Query().Get("before"); cursor != "" {
		n, err := strconv.ParseInt(cursor, 10, 64)
		if err != nil || n < 1 {
			writeError(w, 400, "INVALID_CURSOR", "invalid audit cursor")
			return
		}
		before = n
	}
	events, err := a.repository.Audit(r.Context(), u.ID, before)
	if err != nil {
		resourceError(w, err)
		return
	}
	writeJSON(w, 200, events)
}
