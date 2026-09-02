package proxy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSwaggerOfflineSelfContained(t *testing.T) {
	// The offline explorer must not reference any external host (CDN/font/etc.).
	if strings.Contains(swaggerOfflineHTML, "http://") || strings.Contains(swaggerOfflineHTML, "https://") {
		t.Error("offline swagger HTML must not reference external URLs")
	}
	if !strings.Contains(swaggerOfflineHTML, "/openapi.json") {
		t.Error("offline swagger should fetch /openapi.json")
	}
}

func TestHandleSwaggerUIIsAlwaysSelfContained(t *testing.T) {
	s := &Server{}
	for _, target := range []string{"/swagger", "/swagger?offline=1"} {
		rec := httptest.NewRecorder()
		s.handleSwaggerUI(rec, httptest.NewRequest(http.MethodGet, target, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s = %d", target, rec.Code)
		}
		body := rec.Body.String()
		if !strings.Contains(body, "오프라인 API 탐색기") && !strings.Contains(body, "오프라인 탐색기") {
			t.Errorf("%s should serve the self-contained explorer", target)
		}
		if strings.Contains(body, "unpkg.com") || strings.Contains(body, `src="http`) || strings.Contains(body, "{{NONCE}}") {
			t.Errorf("%s contains an external asset or unresolved nonce", target)
		}
		if csp := rec.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "script-src 'nonce-") {
			t.Errorf("%s CSP = %q", target, csp)
		}
	}
}
