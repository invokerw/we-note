package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestResourceReadsRejectOtherBrowserOrigins(t *testing.T) {
	mux := testMux(t)
	for _, path := range []string{"/assets/asset_example", "/assets/2026/11/25/deadbeef", "/assets/user_one/vault_one/2026/11/25/deadbeef", "/s/example/assets/asset_example"} {
		for _, site := range []string{"same-site", "cross-site"} {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			req.Header.Set("Sec-Fetch-Site", site)
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, req)
			if w.Code != http.StatusForbidden || w.Header().Get("Cross-Origin-Resource-Policy") != "same-origin" {
				t.Errorf("%s %s: status %d, CORP %q", site, path, w.Code, w.Header().Get("Cross-Origin-Resource-Policy"))
			}
		}
	}
}
