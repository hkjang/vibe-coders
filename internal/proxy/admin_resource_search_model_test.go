package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func modelSearchGroups(t *testing.T, s *Server, body string) []resourceSearchGroup {
	t.Helper()
	w := resourceSearchRequest(s, body, "")
	if w.Code != 200 {
		t.Fatalf("search status %d", w.Code)
	}
	var response struct {
		Groups []resourceSearchGroup `json:"groups"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	return response.Groups
}

func TestResourceSearchModelSharesCatalogAndProviderIdentity(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != "GET" || r.URL.Path != "/v1/models" {
			t.Error("search invoked a non-catalog endpoint")
		}
		fmt.Fprint(w, `{"data":[{"id":"정산 모델","owned_by":"private-owner","extra":"private-definition"},{"id":"정산 person@example.com"},{"id":"정산 vc_sk_`+strings.Repeat("x", 43)+`"}]}`)
	}))
	t.Cleanup(upstream.Close)
	s, db, gateway := newAdminModelsTestServer(t, "")
	for _, name := range []string{"alpha", "vibe"} {
		addAdminModelsProvider(t, s, db, store.ProviderConfig{Name: name, BaseURL: upstream.URL, Enabled: true}, "isolated-model-search-key")
	}
	if err := db.UpsertAgentRoute(t.Context(), store.AgentRoute{ID: "route-search", VirtualModel: "정산 모델", Name: "private-agent-description", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	groups := modelSearchGroups(t, s, `{"query":"정산","kinds":["model"]}`)
	if len(groups) != 1 || groups[0].Status != "ok" || len(groups[0].Items) != 3 {
		t.Fatalf("unexpected group shape: status=%s rows=%d", groups[0].Status, len(groups[0].Items))
	}
	expected := map[string]bool{s.providerRef("alpha"): false, s.providerRef("vibe"): false, s.systemProviderRef("vibe"): true}
	for _, item := range groups[0].Items {
		virtual, ok := expected[item.ProviderRef]
		if !ok || item.Virtual != virtual || item.ID != "정산 모델" || item.Title != item.ID {
			t.Fatal("provider identity or safe projection lost")
		}
		delete(expected, item.ProviderRef)
	}
	if len(expected) != 0 {
		t.Fatal("duplicate model providers were collapsed")
	}
	encoded, _ := json.Marshal(groups)
	for _, value := range []string{"private-owner", "private-definition", "private-agent-description", "person@example.com", "vc_sk_", upstream.URL} {
		if strings.Contains(string(encoded), value) {
			t.Fatal("model search leaked non-navigation metadata")
		}
	}
	// A following catalog request and repeated search share the already-fresh cache.
	resp, catalog := getAdminModels(t, gateway.URL+"/admin/models", "")
	if resp.StatusCode != 200 || len(catalog.Models) == 0 {
		t.Fatal("shared catalog unavailable")
	}
	modelSearchGroups(t, s, `{"query":"정산","kinds":["model"]}`)
	if calls.Load() != 2 {
		t.Fatalf("catalog cache not reused: %d upstream calls", calls.Load())
	}
	// Runtime feature denial must prevent even a stale refresh.
	if err := db.UpsertAdminSetting(t.Context(), store.AdminSetting{Key: "ui.app.feature.gateway.models.status", ValueJSON: `"hidden"`, ValueType: "string"}, "test", "fixture"); err != nil {
		t.Fatal(err)
	}
	groups = modelSearchGroups(t, s, `{"query":"정산","kinds":["model"]}`)
	if groups[0].Status != "forbidden" || len(groups[0].Items) != 0 || calls.Load() != 2 {
		t.Fatal("hidden feature accessed model inventory")
	}
}

func TestResourceSearchModelPartialStaleAndChangedConfiguration(t *testing.T) {
	var fail atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail.Load() {
			w.WriteHeader(503)
			return
		}
		fmt.Fprint(w, `{"data":[{"id":"billing-model"}]}`)
	}))
	t.Cleanup(upstream.Close)
	s, db, _ := newAdminModelsTestServer(t, "")
	var clock atomic.Int64
	clock.Store(time.Now().UnixNano())
	s.adminModels.now = func() time.Time { return time.Unix(0, clock.Load()) }
	s.adminModels.freshTTL = time.Second
	provider := store.ProviderConfig{Name: "alpha", BaseURL: upstream.URL, Enabled: true}
	addAdminModelsProvider(t, s, db, provider, "isolated-model-search-key")
	groups := modelSearchGroups(t, s, `{"query":"BILLING","kinds":["model"]}`)
	if groups[0].Status != "ok" || len(groups[0].Items) != 1 {
		t.Fatal("cold inventory search failed")
	}
	fail.Store(true)
	clock.Add(int64(2 * time.Second))
	groups = modelSearchGroups(t, s, `{"query":"billing","kinds":["model"]}`)
	if groups[0].Status != "partial" || len(groups[0].Items) != 1 {
		t.Fatal("stale search must retain results with a partial warning")
	}
	provider.BaseURL = upstream.URL + "/changed"
	addAdminModelsProvider(t, s, db, provider, "isolated-model-search-key")
	groups = modelSearchGroups(t, s, `{"query":"billing","kinds":["model"]}`)
	if groups[0].Status != "partial" || len(groups[0].Items) != 0 {
		t.Fatal("old configuration cache escaped fingerprint validation")
	}
	provider.Enabled = false
	addAdminModelsProvider(t, s, db, provider, "isolated-model-search-key")
	groups = modelSearchGroups(t, s, `{"query":"billing","kinds":["model"]}`)
	if groups[0].Status != "ok" || len(groups[0].Items) != 0 {
		t.Fatal("disabled provider remained searchable")
	}
}

func TestResourceSearchModelBoundsAndUnrelatedGroups(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	for index := 0; index < 12; index++ {
		if err := db.UpsertAgentRoute(t.Context(), store.AgentRoute{ID: fmt.Sprintf("billing-%02d", index), VirtualModel: fmt.Sprintf("billing-%02d", index), Enabled: true}); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.UpsertWorkflow(t.Context(), store.Workflow{ID: "workflow", Name: "billing workflow"}); err != nil {
		t.Fatal(err)
	}
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	t.Cleanup(slow.Close)
	addAdminModelsProvider(t, s, db, store.ProviderConfig{Name: "slow", BaseURL: slow.URL, Enabled: true}, "isolated-model-search-key")
	// Keep the real three-second search deadline while bounding this fixture's upstream refresh.
	s.adminModels.refreshTimeout = time.Second
	requestCtx, requestCancel := context.WithTimeout(t.Context(), 200*time.Millisecond)
	defer requestCancel()
	request := httptest.NewRequest(http.MethodPost, "/admin/resource-search", strings.NewReader(`{"query":"billing","kinds":["model","workflow"]}`)).WithContext(requestCtx)
	recorder := httptest.NewRecorder()
	s.handleAdminResourceSearch(recorder, request)
	var response struct {
		Groups []resourceSearchGroup `json:"groups"`
	}
	if recorder.Code != 200 || json.Unmarshal(recorder.Body.Bytes(), &response) != nil {
		t.Fatal("bounded request failed")
	}
	groups := response.Groups
	if len(groups) != 2 || groups[0].Kind != "model" || groups[1].Kind != "workflow" {
		t.Fatal("requested group order changed")
	}
	if groups[0].Status != "partial" || !groups[0].Limited || len(groups[0].Items) != 10 {
		t.Fatal("bounded virtual results lost during upstream failure")
	}
	if groups[1].Status != "ok" || len(groups[1].Items) != 1 {
		t.Fatal("slow model upstream starved unrelated metadata")
	}
	for i, item := range groups[0].Items {
		if item.ID != fmt.Sprintf("billing-%02d", i) {
			t.Fatal("model search order is unstable")
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	group := s.searchModelNavigation(ctx, "billing", s.providerRefsSnapshot())
	if group.Status != "unavailable" || len(group.Items) != 0 {
		t.Fatal("cancelled search exposed retained rows")
	}
}

func TestResourceSearchModelRequiresAdminReadSession(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.Enabled = true
	s.cfg.Auth.JWTSecret = "synthetic-model-search-session"
	now := time.Now().UTC()
	for _, check := range []struct {
		name   string
		scopes []string
		status int
	}{
		{"model-only", []string{"models:read"}, 403},
		{"read-only", []string{"admin:read"}, 200},
	} {
		t.Run(check.name, func(t *testing.T) {
			if err := db.InsertAuthSession(t.Context(), check.name, "reader", "127.0.0.1", "fixture", now.Add(time.Hour)); err != nil {
				t.Fatal(err)
			}
			token, err := s.signAccessToken(accessClaims{Subject: "reader", Role: "admin", Scopes: check.scopes, SessionID: check.name, Type: "access", IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix()})
			if err != nil {
				t.Fatal(err)
			}
			w := resourceSearchRequest(s, `{"query":"billing","kinds":["model"]}`, token)
			if w.Code != check.status {
				t.Fatalf("model metadata permission status %d", w.Code)
			}
		})
	}
	if resourceSearchRequest(s, `{"query":"billing","kinds":["model"]}`, "").Code != 401 {
		t.Fatal("model search accepted an unauthenticated request")
	}
}
