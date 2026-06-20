package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"vibe-coders/internal/store"
)

func tabSet(scopes []string, features map[string]bool) map[string]bool {
	set := map[string]bool{}
	for _, t := range allowedTabs(scopes, features) {
		set[t] = true
	}
	return set
}

func TestResolveDefaultHome(t *testing.T) {
	cases := []struct {
		role   string
		scopes []string
		want   string
	}{
		{"admin", roleScopes["admin"], "#/dashboard"},
		{"viewer", roleScopes["viewer"], "#/dashboard"},          // has admin:read
		{"readonly_admin", roleScopes["readonly_admin"], "#/dashboard"},
		{"security_admin", roleScopes["security_admin"], "#/dashboard"},
		{"developer", roleScopes["developer"], "#/me"},           // no admin:read
		{"service_account", roleScopes["service_account"], "#/me"},
	}
	for _, c := range cases {
		if got := resolveDefaultHome(c.scopes); got != c.want {
			t.Errorf("resolveDefaultHome(%s) = %q, want %q", c.role, got, c.want)
		}
	}
}

func TestAccessibleMenusByRole(t *testing.T) {
	features := map[string]bool{"self_service_keys": true, "personal_home": true}

	// developer: only personal menus, no operational/security/settings.
	devTabs := tabSet(roleScopes["developer"], features)
	if !devTabs["me"] {
		t.Error("developer should see 내 홈 (me)")
	}
	for _, forbidden := range []string{"dashboard", "users", "safety", "settings", "requests"} {
		if devTabs[forbidden] {
			t.Errorf("developer must NOT see ops tab %q", forbidden)
		}
	}

	// viewer (admin:read, no security:read for the safety menu? viewer HAS security:read):
	viewerTabs := tabSet(roleScopes["viewer"], features)
	if !viewerTabs["dashboard"] || !viewerTabs["users"] {
		t.Error("viewer should see operational tabs")
	}
	if !viewerTabs["safety"] {
		t.Error("viewer has security:read → should see safety")
	}

	// ai_admin has admin:read but NOT security:read → no safety menu.
	aiTabs := tabSet(roleScopes["ai_admin"], features)
	if !aiTabs["dashboard"] {
		t.Error("ai_admin should see dashboard")
	}
	if aiTabs["safety"] {
		t.Error("ai_admin lacks security:read → must NOT see safety")
	}

	// admin: sees settings (and everything).
	adminTabs := tabSet(roleScopes["admin"], features)
	for _, want := range []string{"dashboard", "users", "safety", "settings", "me"} {
		if !adminTabs[want] {
			t.Errorf("admin should see %q", want)
		}
	}
	// Nested child tabs expand from their parent (safety → skills/skill-studio).
	if !adminTabs["skill-studio"] || !adminTabs["teams"] {
		t.Error("admin allowed_tabs should include nested children (skill-studio, teams)")
	}
}

func TestMeNavigationLegacyModeReturnsFullMenu(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "nav.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(server.Routes())
	defer srv.Close()

	resp, _ := http.Get(srv.URL + "/me/navigation")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /me/navigation = %d", resp.StatusCode)
	}
	var nav struct {
		Menus       []menuItem `json:"menus"`
		AllowedTabs []string   `json:"allowed_tabs"`
		DefaultHome string     `json:"default_home"`
		MenuVersion int        `json:"menu_version"`
	}
	json.NewDecoder(resp.Body).Decode(&nav)
	resp.Body.Close()
	// Legacy (auth disabled) = admin-equivalent: full menu, dashboard home.
	if nav.DefaultHome != "#/dashboard" {
		t.Errorf("legacy default_home = %q, want #/dashboard", nav.DefaultHome)
	}
	// All menus except feature-gated me.keys (self_service_keys defaults off in tests).
	if len(nav.Menus) != len(menuRegistry)-1 {
		t.Errorf("legacy mode should expose %d menus (all but feature-gated me.keys), got %d", len(menuRegistry)-1, len(nav.Menus))
	}
	tabs := map[string]bool{}
	for _, tb := range nav.AllowedTabs {
		tabs[tb] = true
	}
	for _, want := range []string{"dashboard", "settings", "safety", "skill-studio", "me"} {
		if !tabs[want] {
			t.Errorf("legacy allowed_tabs missing %q", want)
		}
	}
}

func TestMeKeysMenuGatedByFeature(t *testing.T) {
	on := tabSet(roleScopes["developer"], map[string]bool{"self_service_keys": true})
	if !on["mykeys"] {
		t.Error("mykeys should be visible when self_service_keys enabled")
	}
	off := tabSet(roleScopes["developer"], map[string]bool{"self_service_keys": false})
	if off["mykeys"] {
		t.Error("mykeys must be hidden when self_service_keys disabled")
	}
}
