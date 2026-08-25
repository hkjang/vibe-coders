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
		{"viewer", roleScopes["viewer"], "#/dashboard"}, // has admin:read
		{"readonly_admin", roleScopes["readonly_admin"], "#/dashboard"},
		{"security_admin", roleScopes["security_admin"], "#/dashboard"},
		{"developer", roleScopes["developer"], "#/me"}, // no admin:read
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

func TestRoleCatalog(t *testing.T) {
	cat := roleCatalog()
	if len(cat) != len(roleScopes) {
		t.Fatalf("catalog should list all %d roles, got %d", len(roleScopes), len(cat))
	}
	byRole := map[string]roleInfo{}
	for _, c := range cat {
		byRole[c.Role] = c
	}
	if !byRole["admin"].IsAdmin || byRole["admin"].DefaultHome != "#/dashboard" {
		t.Errorf("admin should be is_admin with dashboard home: %+v", byRole["admin"])
	}
	if byRole["developer"].IsAdmin || byRole["developer"].DefaultHome != "#/me" {
		t.Errorf("developer should be non-admin with /me home: %+v", byRole["developer"])
	}
	// Highest rank first.
	if cat[0].Rank < cat[len(cat)-1].Rank {
		t.Errorf("catalog should be ranked high→low, got %d..%d", cat[0].Rank, cat[len(cat)-1].Rank)
	}
}

func TestPermissionsEffectiveLegacyMode(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "perm.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(server.Routes())
	defer srv.Close()

	resp, _ := http.Get(srv.URL + "/permissions/effective")
	var eff struct {
		Role    string `json:"role"`
		IsAdmin bool   `json:"is_admin"`
		Menus   []struct {
			ID      string `json:"id"`
			Allowed bool   `json:"allowed"`
			Reason  string `json:"reason"`
		} `json:"menus"`
	}
	json.NewDecoder(resp.Body).Decode(&eff)
	resp.Body.Close()
	if !eff.IsAdmin {
		t.Errorf("legacy mode should be admin-equivalent, got role=%q", eff.Role)
	}
	// Every menu carries an allow/deny reason.
	for _, m := range eff.Menus {
		if m.Reason == "" {
			t.Errorf("menu %q missing decision reason", m.ID)
		}
	}
}

func TestTeamManagerNavigation(t *testing.T) {
	features := map[string]bool{"self_service_keys": false, "personal_home": true}
	scopes := roleScopes["team_manager"]
	if len(scopes) == 0 {
		t.Fatal("team_manager role must be defined")
	}
	// team_manager lands on the team dashboard, not /admin or /me.
	if got := resolveDefaultHome(scopes); got != "#/team" {
		t.Errorf("team_manager default_home = %q, want #/team", got)
	}
	tabs := tabSet(scopes, features)
	if !tabs["team"] || !tabs["me"] {
		t.Error("team_manager should see team + me tabs")
	}
	for _, forbidden := range []string{"dashboard", "users", "safety", "settings"} {
		if tabs[forbidden] {
			t.Errorf("team_manager must NOT see ops tab %q", forbidden)
		}
	}
	// admins also have team:read → can see the team tab.
	if !tabSet(roleScopes["admin"], features)["team"] {
		t.Error("admin should also see the team tab (has team:read)")
	}
}

func TestRoleHomeOverrides(t *testing.T) {
	features := map[string]bool{"self_service_keys": false, "personal_home": true}
	cases := []struct {
		role string
		home string
		tab  string
	}{
		{"security_admin", "#/security", "security"},
		{"billing_admin", "#/billing", "billing"},
		{"team_manager", "#/team", "team"},
		{"readonly_admin", "#/dashboard", "dashboard"}, // operator, no override
		{"admin", "#/dashboard", "dashboard"},
		{"developer", "#/me", "me"},
	}
	for _, c := range cases {
		scopes := roleScopes[c.role]
		if got := resolveHome(c.role, scopes); got != c.home {
			t.Errorf("resolveHome(%s) = %q, want %q", c.role, got, c.home)
		}
		if !tabSet(scopes, features)[c.tab] {
			t.Errorf("%s should see tab %q", c.role, c.tab)
		}
	}
	// billing_admin must NOT see the security tab (no security:read); security_admin must
	// NOT land on the plain dashboard despite holding admin:read.
	if tabSet(roleScopes["billing_admin"], features)["security"] {
		t.Error("billing_admin should not see security tab")
	}
}

func TestRedactPromptDetails(t *testing.T) {
	prompts := []store.PromptDetail{
		{Role: "user", ContentText: "secret original text", RedactedText: "[redacted]"},
		{Role: "system", ContentText: "same", RedactedText: "same"},
		{Role: "user", ContentText: "", RedactedText: "x"},
	}
	redactPromptDetails(prompts)
	if prompts[0].ContentText != "[redacted]" {
		t.Errorf("raw content should be collapsed to redacted, got %q", prompts[0].ContentText)
	}
	if prompts[1].ContentText != "same" {
		t.Errorf("already-equal content untouched, got %q", prompts[1].ContentText)
	}
	// rawPromptViewerRoles: only full admins + security_admin.
	for _, role := range []string{"admin", "super_admin", "security_admin"} {
		if !rawPromptViewerRoles[role] {
			t.Errorf("%s should be allowed to view raw prompts", role)
		}
	}
	for _, role := range []string{"viewer", "readonly_admin", "ops_admin", "ai_admin", "team_admin", "team_manager", "developer"} {
		if rawPromptViewerRoles[role] {
			t.Errorf("%s must NOT view raw prompts", role)
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
