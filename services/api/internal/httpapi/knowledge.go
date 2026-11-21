package httpapi

import (
	"net/http"
	"strings"
)

func (a *API) knowledge(w http.ResponseWriter, r *http.Request) {
	if !a.canReadFiles(w, r) {
		return
	}
	vault, ctx := r.PathValue("vault_id"), r.Context()
	query := r.URL.Query()
	var data any
	var err error
	switch {
	case strings.HasSuffix(r.URL.Path, "/assets"):
		data, err = a.repository.ListAssets(ctx, vault)
	case strings.HasSuffix(r.URL.Path, "/search"):
		data, err = a.repository.Search(ctx, vault, query.Get("q"), query.Get("tag"))
	case strings.HasSuffix(r.URL.Path, "/tags"):
		data, err = a.repository.Tags(ctx, vault)
	default:
		meta, links, e := a.repository.Relations(ctx, vault, query.Get("file_id"))
		err = e
		if strings.HasSuffix(r.URL.Path, "/outline") {
			data = meta
		} else {
			data = links
		}
	}
	if err != nil {
		resourceError(w, err)
		return
	}
	writeJSON(w, 200, data)
}
