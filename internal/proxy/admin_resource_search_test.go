package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func resourceSearchRequest(s *Server, body, token string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/admin/resource-search", strings.NewReader(body))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	s.handleAdminResourceSearch(w, r)
	return w
}

func TestResourceSearchAuthorizationAndValidation(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	s := &Server{db: db, cfg: config.Config{Auth: config.AuthConfig{AdminToken: "full", AdminReadonlyToken: "reader"}}}
	for _, token := range []string{"", "invalid"} {
		w := resourceSearchRequest(s, `{"query":"정산","kinds":["workflow"]}`, token)
		if w.Code != 401 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("unauthorized search was not rejected")
		}
	}
	// This read-only POST must remain usable without admin:write.
	w := resourceSearchRequest(s, `{"query":"정산","kinds":["workflow"]}`, "reader")
	if w.Code != 200 {
		t.Fatalf("read-only credential status=%d", w.Code)
	}
	for _, body := range []string{
		`{}`, `{"query":"x","kinds":["workflow"]}`, `{"query":"정산","kinds":["unknown"]}`,
		`{"query":"정산","kinds":["workflow","workflow"]}`, `{"query":"정산","kinds":[]}`,
		`{"query":"정산","kinds":["workflow"],"extra":true}`, `{"query":"정산","kinds":["workflow"]}{}`,
		`{"query":"person@example.com","kinds":["workflow"]}`,
		`{"query":"Bearer sensitive-fixture","kinds":["workflow"]}`,
		`{"query":"` + strings.Repeat("x", 4100) + `","kinds":["workflow"]}`,
	} {
		w := resourceSearchRequest(s, body, "full")
		if w.Code != 400 {
			t.Fatalf("invalid request status=%d", w.Code)
		}
		if strings.Contains(w.Body.String(), "sensitive-fixture") || strings.Contains(w.Body.String(), "person@example.com") {
			t.Fatal("error echoed input")
		}
	}
	w = httptest.NewRecorder()
	s.handleAdminResourceSearch(w, httptest.NewRequest(http.MethodGet, "/admin/resource-search", nil))
	if w.Code != 405 || w.Header().Get("Allow") != "POST" {
		t.Fatal("method boundary missing")
	}
}

func TestResourceSearchProjectionAndRuntimeFeature(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	s := &Server{db: db}
	for _, wf := range []store.Workflow{
		{ID: "wf-safe", Name: "정산 업무", Description: "private-description", Steps: []store.WorkflowStep{{Note: "private-body"}}},
		{ID: "wf-mail", Name: "정산 person@example.com"},
		{ID: "vc_sk_" + strings.Repeat("x", 43), Name: "정산 비밀 식별자"},
	} {
		if err := db.UpsertWorkflow(t.Context(), wf); err != nil {
			t.Fatal(err)
		}
	}
	w := resourceSearchRequest(s, `{"query":"정산","kinds":["workflow"]}`, "")
	if w.Code != 200 {
		t.Fatalf("status=%d", w.Code)
	}
	var result struct {
		Groups []resourceSearchGroup `json:"groups"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Groups) != 1 || len(result.Groups[0].Items) != 1 || result.Groups[0].Items[0].ID != "wf-safe" {
		t.Fatal("safe metadata projection failed")
	}
	for _, text := range []string{"private-description", "private-body", "person@example.com", "vc_sk_"} {
		if strings.Contains(w.Body.String(), text) {
			t.Fatal("sensitive metadata escaped search projection")
		}
	}
	// A runtime hidden feature must not be searchable even by a full admin.
	if err := db.UpsertAdminSetting(t.Context(), store.AdminSetting{Key: "ui.app.feature.agents.workflows.status", ValueJSON: `"hidden"`, ValueType: "string"}, "test", "search guard"); err != nil {
		t.Fatal(err)
	}
	w = resourceSearchRequest(s, `{"query":"정산","kinds":["workflow"]}`, "")
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || result.Groups[0].Status != "forbidden" || len(result.Groups[0].Items) != 0 {
		t.Fatal("hidden feature leaked search results")
	}
}

func TestResourceSearchProviderUsesOpaqueIdentityWithoutUpstream(t *testing.T) {
	var calls atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(500) }))
	t.Cleanup(upstream.Close)
	server, db, gateway := newAdminModelsTestServer(t, "")
	if err := db.UpsertProvider(t.Context(), store.ProviderConfig{Name: "search-provider", BaseURL: upstream.URL, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	// Match the existing provider-list projection: ambiguous provider names are
	// not newly disclosed by the generic resource-title projection.
	if err := db.UpsertProvider(t.Context(), store.ProviderConfig{Name: "search,provider", BaseURL: upstream.URL, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	response, body := req(t, http.MethodPost, gateway.URL+"/admin/resource-search", `{"query":"search","kinds":["provider"]}`)
	if response.StatusCode != 200 || !validRequestID(response.Header.Get("X-Request-ID")) {
		t.Fatal("HTTP search contract failed")
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Groups []resourceSearchGroup `json:"groups"`
	}
	if err := json.Unmarshal(encoded, &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Groups) != 1 || len(result.Groups[0].Items) != 1 || result.Groups[0].Items[0].ID != server.providerRef("search-provider") {
		t.Fatal("opaque provider identity missing")
	}
	if calls.Load() != 0 || strings.Contains(string(encoded), upstream.URL) {
		t.Fatal("search fetched or exposed upstream configuration")
	}
}

func TestResourceSearchSafeTextPreservesUnicodeAndPunctuation(t *testing.T) {
	s := &Server{cfg: config.Config{Auth: config.AuthConfig{APIKeyPrefix: "corp_"}}}
	for _, text := range []string{"일일, 월간 정산", strings.Repeat("한", 128), strings.Repeat("😀", 256)} {
		if !s.safeResourceSearchText(text) {
			t.Fatal("safe Unicode or punctuation was rejected")
		}
	}
	for _, text := range []string{"line\nfeed", "corp_" + strings.Repeat("x", 43), "person@example.com", "Bearer fixture-value"} {
		if s.safeResourceSearchText(text) {
			t.Fatal("unsafe search text was accepted")
		}
	}
}

func TestResourceSearchJWTReadScope(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.Enabled = true
	s.cfg.Auth.JWTSecret = "synthetic-resource-search-session-secret"
	now := time.Now().UTC()
	for _, test := range []struct {
		name   string
		scopes []string
		status int
	}{
		{"model-only", []string{"models:read"}, 403},
		{"read-only", []string{"admin:read"}, 200},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := db.InsertAuthSession(t.Context(), test.name, "search-reader", "127.0.0.1", "fixture", now.Add(time.Hour)); err != nil {
				t.Fatal(err)
			}
			token, err := s.signAccessToken(accessClaims{Subject: "search-reader", Role: "admin", Scopes: test.scopes, SessionID: test.name, Type: "access", IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix()})
			if err != nil {
				t.Fatal(err)
			}
			w := resourceSearchRequest(s, `{"query":"정산","kinds":["workflow"]}`, token)
			if w.Code != test.status {
				t.Fatalf("permission result=%d expected=%d", w.Code, test.status)
			}
		})
	}
}

func TestResourceSearchOpenAPIContract(t *testing.T) {
	encoded, err := json.Marshal(buildOpenAPISpec())
	if err != nil {
		t.Fatal(err)
	}
	var spec map[string]any
	if err := json.Unmarshal(encoded, &spec); err != nil {
		t.Fatal(err)
	}
	paths := spec["paths"].(map[string]any)
	assertJSONRequestSchema(t, paths, "/admin/resource-search", "post", "ResourceSearchRequest")
	assertJSONOperationSchema(t, paths, "/admin/resource-search", "post", "200", "ResourceSearchResponse")
	for _, status := range []string{"400", "401", "403", "405", "503"} {
		assertJSONOperationSchema(t, paths, "/admin/resource-search", "post", status, "AppError")
	}
}
