package proxy

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestPromptProductMetadataProjectionAndLegacy(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	ctx := t.Context()
	if err := db.UpsertPromptTemplate(ctx, store.PromptTemplate{ID: "private-template", Name: "원본", Body: "private-body", Enabled: false, UseCount: 4}); err != nil {
		t.Fatal(err)
	}
	for range 4 {
		if err := db.TouchPromptTemplate(ctx, "private-template"); err != nil {
			t.Fatal(err)
		}
	}
	for _, p := range []store.PromptProduct{
		{ID: "a-private-id", Name: "공용 제품", TemplateID: "private-template", Category: "product", Description: "private-description", CreatedBy: "private-actor", SourceFingerprint: "private-fingerprint", RequestCount: 12, DistinctUsers: 3, CreatedAt: "2026-11-01T00:00:00Z"},
		{ID: "b-private-id", Name: "token=private-credential", TemplateID: "missing", SourceFingerprint: "private-invalid-fp", Category: "https://user:password@example.test", RequestCount: -1, DistinctUsers: -2, CreatedAt: "2026-11-01T00:00:00Z"},
	} {
		if err := db.UpsertPromptProduct(ctx, p); err != nil {
			t.Fatal(err)
		}
	}
	w := httptest.NewRecorder()
	s.Routes().ServeHTTP(w, httptest.NewRequest("GET", "/admin/prompt-products?view=metadata", nil))
	var response struct {
		Items []promptProductMetadataItem `json:"items"`
		Total int                         `json:"total"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &response) != nil || response.Total != 2 || len(response.Items) != 2 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("metadata response mismatch", w.Code)
	}
	for _, forbidden := range []string{"private-", "password", "template_id", "created_by", "description", "fingerprint", "distinct_users"} {
		if strings.Contains(w.Body.String(), forbidden) {
			t.Fatal("unsafe or misleading field reached metadata")
		}
	}
	first, second := response.Items[0], response.Items[1]
	if first.TemplateState != "disabled" || first.UseCount == nil || *first.UseCount != 4 || first.SourceKeys == nil || *first.SourceKeys != 3 {
		t.Fatal("template and source snapshot measures mixed")
	}
	if second.Name != "[숨김]" || second.Category != "[숨김]" || second.TemplateState != "missing" || second.UseCount != nil || second.SourceRequests != nil || second.SourceKeys != nil {
		t.Fatal("missing template or invalid historical metadata not projected")
	}
	w = httptest.NewRecorder()
	s.Routes().ServeHTTP(w, httptest.NewRequest("GET", "/admin/prompt-products", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "private-actor") || !strings.Contains(w.Body.String(), `"products"`) {
		t.Fatal("legacy list changed")
	}
	for _, query := range []string{"view=", "view=raw", "view=metadata&view=metadata", "view=metadata&limit=0", "view=metadata&limit=101", "view=metadata&limit=025", "view=metadata&offset=-1", "view=metadata&offset=1000001", "view=metadata&state=wrong", "view=metadata&extra=1", "view=metadata&state=all&state=enabled", "view=%zz", "view=metadata;other=1"} {
		w = httptest.NewRecorder()
		s.Routes().ServeHTTP(w, httptest.NewRequest("GET", "/admin/prompt-products?"+query, nil))
		if w.Code != 400 || strings.Contains(w.Body.String(), "private-") {
			t.Fatal("invalid query accepted", query, w.Code)
		}
	}
}

func TestPromptProductMetadataPermissionsAndFailure(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "public-product-fixture"
	for _, tc := range []struct {
		role    string
		scopes  []string
		allowed bool
	}{{"admin", []string{"admin:read"}, true}, {"readonly_admin", []string{"admin:read"}, true}, {"user", []string{"models:read"}, false}} {
		token := issueLLMScopedTestToken(t, db, s, "product-"+tc.role, tc.role, "", tc.scopes, time.Now().UTC())
		r := httptest.NewRequest("GET", "/admin/prompt-products?view=metadata", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		s.Routes().ServeHTTP(w, r)
		if (w.Code == 200) != tc.allowed {
			t.Fatal("metadata permission differs from legacy read", tc.role, w.Code)
		}
	}
	w := httptest.NewRecorder()
	s.Routes().ServeHTTP(w, httptest.NewRequest("GET", "/admin/prompt-products?view=metadata", nil))
	if w.Code != 401 {
		t.Fatal("anonymous metadata read")
	}
	s.cfg.Auth.Enabled = false
	db.Close()
	w = httptest.NewRecorder()
	s.Routes().ServeHTTP(w, httptest.NewRequest("GET", "/admin/prompt-products?view=metadata", nil))
	if w.Code != 500 || strings.Contains(w.Body.String(), "database") || strings.Contains(w.Body.String(), "items") {
		t.Fatal("storage failure leaked details or became empty data")
	}
}

func TestPromptProductMetadataSafeIntegerRange(t *testing.T) {
	for _, value := range []int64{-1, 9007199254740992} {
		if promptProductMetadataCount(value) != nil {
			t.Fatal("invalid browser count must be unknown")
		}
	}
	for _, value := range []int64{0, 9007199254740991} {
		if count := promptProductMetadataCount(value); count == nil || *count != value {
			t.Fatal("valid browser count changed")
		}
	}
}
