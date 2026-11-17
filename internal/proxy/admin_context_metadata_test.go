package proxy

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestContextMetadataProjectionAndLegacy(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	for _, entry := range []store.ContextRegistryEntry{
		{ID: "private-id", Key: "reference", Name: "공용 설명", Content: "private-content", Enabled: true, UseCount: 3, TokenEstimate: 10},
		{ID: "secret-id", Key: "token=private-credential", Name: "https://user:password@example.test", Content: "private-content", TokenEstimate: -1, UseCount: -1},
	} {
		if err := db.UpsertContextRegistry(t.Context(), entry); err != nil {
			t.Fatal(err)
		}
	}
	w := httptest.NewRecorder()
	s.Routes().ServeHTTP(w, httptest.NewRequest("GET", "/admin/contexts?view=metadata", nil))
	var response struct {
		Items []contextMetadataItem `json:"items"`
		Total int                   `json:"total"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &response) != nil || response.Total != 2 || len(response.Items) != 2 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("metadata response mismatch: %d", w.Code)
	}
	for _, forbidden := range []string{"private-", "secret-id", "content", "password"} {
		if strings.Contains(w.Body.String(), forbidden) {
			t.Fatal("unsafe metadata reached response")
		}
	}
	if response.Items[1].Key != "[숨김]" || response.Items[1].Name != "[숨김]" || response.Items[1].UseCount != nil || response.Items[1].TokenEstimate != nil || response.Items[1].LastUsedAt != nil {
		t.Fatal("unsafe or invalid historic metadata was not projected")
	}
	w = httptest.NewRecorder()
	s.Routes().ServeHTTP(w, httptest.NewRequest("GET", "/admin/contexts", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "private-content") || !strings.Contains(w.Body.String(), `"contexts"`) {
		t.Fatal("legacy response changed")
	}
	for _, query := range []string{"view=", "view=raw", "view=metadata&view=metadata", "view=metadata&limit=0", "view=metadata&limit=101", "view=metadata&limit=025", "view=metadata&offset=-1", "view=metadata&offset=1000001", "view=metadata&state=wrong", "view=metadata&extra=1", "view=metadata&state=all&state=enabled", "view=%zz", "view=metadata;other=1"} {
		w = httptest.NewRecorder()
		s.Routes().ServeHTTP(w, httptest.NewRequest("GET", "/admin/contexts?"+query, nil))
		if w.Code != 400 || strings.Contains(w.Body.String(), "private-") {
			t.Fatalf("invalid metadata query accepted: %s %d", query, w.Code)
		}
	}
}

func TestContextMetadataPermissionsAndFailure(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "public-context-fixture"
	for _, tc := range []struct {
		role    string
		scopes  []string
		allowed bool
	}{{"admin", []string{"admin:read"}, true}, {"readonly_admin", []string{"admin:read"}, true}, {"user", []string{"models:read"}, false}} {
		token := issueLLMScopedTestToken(t, db, s, "context-"+tc.role, tc.role, "", tc.scopes, time.Now().UTC())
		r := httptest.NewRequest("GET", "/admin/contexts?view=metadata", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		s.Routes().ServeHTTP(w, r)
		if (w.Code == 200) != tc.allowed {
			t.Fatal("metadata permission differs from legacy read", tc.role, w.Code)
		}
	}
	w := httptest.NewRecorder()
	s.Routes().ServeHTTP(w, httptest.NewRequest("GET", "/admin/contexts?view=metadata", nil))
	if w.Code != 401 {
		t.Fatal("anonymous metadata read")
	}
	s.cfg.Auth.Enabled = false
	db.Close()
	w = httptest.NewRecorder()
	s.Routes().ServeHTTP(w, httptest.NewRequest("GET", "/admin/contexts?view=metadata", nil))
	if w.Code != 500 || strings.Contains(w.Body.String(), "database") || strings.Contains(w.Body.String(), "items") {
		t.Fatal("storage failure leaked details or became empty data")
	}
}
