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

func TestHandleSwaggerUIOfflineSwitch(t *testing.T) {
	s := &Server{}
	// ?offline=1 → self-contained explorer.
	rec := httptest.NewRecorder()
	s.handleSwaggerUI(rec, httptest.NewRequest(http.MethodGet, "/swagger?offline=1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("offline swagger = %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "오프라인 API 탐색기") && !strings.Contains(body, "오프라인 탐색기") {
		t.Error("offline switch should serve the offline explorer")
	}
	if strings.Contains(body, "unpkg.com") {
		t.Error("offline page must not include the CDN bundle")
	}

	// Default → CDN page (links to the offline explorer).
	rec2 := httptest.NewRecorder()
	s.handleSwaggerUI(rec2, httptest.NewRequest(http.MethodGet, "/swagger", nil))
	if !strings.Contains(rec2.Body.String(), "/swagger?offline=1") {
		t.Error("default swagger page should link to the offline explorer")
	}
}
