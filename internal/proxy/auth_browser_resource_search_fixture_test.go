//go:build linux

package proxy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// Synthetic metadata only. The disabled provider cannot change live routing;
// its address is nevertheless restricted to the existing loopback upstream.
func seedBrowserResourceSearchFixture(t *testing.T, db *store.SQLStore, upstream string) {
	t.Helper()
	ctx := t.Context()
	if err := db.UpsertProvider(ctx, store.ProviderConfig{Name: "검색검증 공급자", BaseURL: upstream, TimeoutMS: 1000}); err != nil {
		t.Fatal("synthetic resource search provider could not be prepared")
	}
	if err := db.UpsertWorkflow(ctx, store.Workflow{ID: "browser-search-workflow", Name: "검색검증 워크플로", Steps: []store.WorkflowStep{}}); err != nil {
		t.Fatal("synthetic resource search workflow could not be prepared")
	}
	if err := db.CreateWorkApp(ctx, store.WorkApp{ID: "browser-search-app", Title: "검색검증 업무 앱", Components: []store.AppComponent{}}); err != nil {
		t.Fatal("synthetic resource search application could not be prepared")
	}
	if _, err := db.UpsertSkill(ctx, store.Skill{Name: "검색검증 스킬", Instructions: "Synthetic isolated fixture instruction."}, "browser-fixture"); err != nil {
		t.Fatal("synthetic resource search skill could not be prepared")
	}
	if err := db.UpsertMCPUpstream(ctx, store.MCPUpstream{ID: "browser-search-mcp", Name: "검색검증 MCP 서버", URL: upstream, Enabled: false}); err != nil {
		t.Fatal("synthetic resource search MCP server could not be prepared")
	}
}

func TestResourceSearchRequiresSameSessionAsAdminLists(t *testing.T) {
	idp := newBrowserOIDCFixture(t, "http://127.0.0.1:12345/auth/keycloak/callback")
	db := openTestStore(t)
	defer db.Close()
	s := &Server{cfg: browserFixtureConfig(idp), db: db}
	s.cfg.Auth.JWTSecret = browserFixtureSecret(t)
	token := signRS256(t, idp.key, "browser-fixture", map[string]any{
		"iss": idp.server.URL, "aud": idp.clientID, "sub": "synthetic-machine-admin",
		"realm_access": map[string]any{"roles": []string{"browser-admin"}},
		"exp":          time.Now().Add(time.Minute).Unix(),
	})
	r := httptest.NewRequest(http.MethodGet, "/admin/providers", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	if claims, ok := s.currentAccessClaims(r); !ok || !hasScope(claims.Scopes, "admin:read") {
		t.Fatal("fixture must be a valid upstream admin token")
	}
	if s.authorizeAdmin(r) {
		t.Fatal("existing admin list unexpectedly accepts an unexchanged upstream token")
	}
	w := resourceSearchRequest(s, `{"query":"검색검증","kinds":["provider"]}`, token)
	if w.Code != http.StatusUnauthorized || strings.Contains(w.Body.String(), token) {
		t.Fatal("search must require the same active gateway session as existing admin lists")
	}
}
