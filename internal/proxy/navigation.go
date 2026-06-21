package proxy

import (
	"net/http"
	"strings"
)

// menuVersion is bumped whenever the menu registry or its access rules change, so the
// SPA can detect a stale navigation and refresh /me/navigation without a full reload.
const menuVersion = 1

// menuItem is one navigable destination in the admin SPA. Access is decided server-side
// from the caller's scopes + enabled feature flags — the same registry drives both the
// rendered menu (/me/navigation) and the SPA's route guard, so hiding a menu and blocking
// its route can never drift apart.
type menuItem struct {
	ID       string   `json:"id"`
	Label    string   `json:"label"`
	Path     string   `json:"path"`             // hash route, e.g. "#/dashboard"
	Tab      string   `json:"tab"`              // SPA data-tab value
	Group    string   `json:"group"`            // me | ops | security | settings
	Scopes   []string `json:"required_scopes"`  // any-of; empty = any authenticated user
	Features []string `json:"required_features"`
	DataScope string  `json:"data_scope"`       // self | team | all
}

// menuRegistry is the single source of truth for navigation. Order = display order.
var menuRegistry = []menuItem{
	// 내 영역 — every authenticated user.
	{ID: "me.home", Label: "내 홈", Path: "#/me", Tab: "me", Group: "me", DataScope: "self"},
	{ID: "me.keys", Label: "내 키", Path: "#/mykeys", Tab: "mykeys", Group: "me", Features: []string{"self_service_keys"}, DataScope: "self"},
	// 팀 영역 — team_manager (and admins) see their team's usage/cost/failures.
	{ID: "team.home", Label: "팀 대시보드", Path: "#/team", Tab: "team", Group: "team", Scopes: []string{"team:read"}, DataScope: "team"},
	{ID: "team.portal", Label: "팀 포털", Path: "#/team-portal", Tab: "team-portal", Group: "team", Scopes: []string{"team:read"}, DataScope: "team"},
	// 운영 영역 — operational surface (admin:read).
	{ID: "ops.home", Label: "운영 홈", Path: "#/ops-home", Tab: "ops-home", Group: "ops", Scopes: []string{"admin:read"}, DataScope: "all"},
	{ID: "ops.capabilities", Label: "기능 맵", Path: "#/capabilities", Tab: "capabilities", Group: "ops", Scopes: []string{"admin:read"}, DataScope: "all"},
	{ID: "ops.dashboard", Label: "대시보드", Path: "#/dashboard", Tab: "dashboard", Group: "ops", Scopes: []string{"admin:read"}, DataScope: "all"},
	{ID: "ops.mcp", Label: "MCP", Path: "#/mcp", Tab: "mcp", Group: "ops", Scopes: []string{"admin:read"}, DataScope: "all"},
	{ID: "ops.routing", Label: "라우팅", Path: "#/routing", Tab: "routing", Group: "ops", Scopes: []string{"admin:read"}, DataScope: "all"},
	{ID: "ops.chat_test", Label: "Chat 테스트", Path: "#/chat-test", Tab: "chat-test", Group: "ops", Scopes: []string{"admin:read"}, DataScope: "all"},
	{ID: "ops.requests", Label: "호출 이력", Path: "#/requests", Tab: "requests", Group: "ops", Scopes: []string{"admin:read"}, DataScope: "all"},
	{ID: "ops.prompts", Label: "프롬프트 검색", Path: "#/prompts", Tab: "prompts", Group: "ops", Scopes: []string{"admin:read"}, DataScope: "all"},
	{ID: "ops.prompt_assets", Label: "자산 관리소", Path: "#/prompt-assets", Tab: "prompt-assets", Group: "ops", Scopes: []string{"admin:read"}, DataScope: "all"},
	{ID: "ops.apps", Label: "AI 업무 앱", Path: "#/apps", Tab: "apps", Group: "ops", Scopes: []string{"admin:read"}, DataScope: "all"},
	{ID: "ops.users", Label: "사용자", Path: "#/users", Tab: "users", Group: "ops", Scopes: []string{"admin:read"}, DataScope: "all"},
	{ID: "ops.text2sql", Label: "Text2SQL", Path: "#/text2sql", Tab: "text2sql", Group: "ops", Scopes: []string{"admin:read"}, DataScope: "all"},
	{ID: "ops.dwdashboard", Label: "DW 대시보드", Path: "#/dwdashboard", Tab: "dwdashboard", Group: "ops", Scopes: []string{"admin:read"}, DataScope: "all"},
	{ID: "ops.data_products", Label: "데이터 상품", Path: "#/data-products", Tab: "data-products", Group: "ops", Scopes: []string{"admin:read"}, DataScope: "all"},
	{ID: "ops.remediation", Label: "자동 조치", Path: "#/remediation", Tab: "remediation", Group: "ops", Scopes: []string{"admin:read"}, DataScope: "all"},
	{ID: "ops.scorecard", Label: "팀 성숙도", Path: "#/scorecard", Tab: "scorecard", Group: "ops", Scopes: []string{"admin:read"}, DataScope: "all"},
	{ID: "ops.model_contracts", Label: "모델 계약", Path: "#/model-contracts", Tab: "model-contracts", Group: "ops", Scopes: []string{"admin:read"}, DataScope: "all"},
	{ID: "ops.policy_advisor", Label: "정책 어드바이저", Path: "#/policy-advisor", Tab: "policy-advisor", Group: "ops", Scopes: []string{"admin:read"}, DataScope: "all"},
	{ID: "ops.narrative", Label: "운영 보고서", Path: "#/narrative", Tab: "narrative", Group: "ops", Scopes: []string{"admin:read"}, DataScope: "all"},
	{ID: "ops.personalization", Label: "개인화", Path: "#/personalization", Tab: "personalization", Group: "ops", Scopes: []string{"admin:read"}, DataScope: "all"},
	// 보안 영역.
	{ID: "sec.dashboard", Label: "보안 대시보드", Path: "#/security", Tab: "security", Group: "security", Scopes: []string{"security:read"}, DataScope: "all"},
	{ID: "sec.safety", Label: "안전", Path: "#/safety", Tab: "safety", Group: "security", Scopes: []string{"security:read"}, DataScope: "all"},
	// 비용 영역.
	{ID: "bill.dashboard", Label: "비용 대시보드", Path: "#/billing", Tab: "billing", Group: "billing", Scopes: []string{"admin:read"}, DataScope: "all"},
	// 설정 영역.
	{ID: "set.settings", Label: "설정", Path: "#/settings", Tab: "settings", Group: "settings", Scopes: []string{"admin:read"}, DataScope: "all"},
}

// childTabs maps a parent tab to the nested route tabs that share its permission. The
// route guard treats a child as accessible exactly when its parent menu is accessible.
var childTabs = map[string][]string{
	"dashboard":   {"xview", "waterfall", "llm"},
	"chat-test":   {"prompt-lab"},
	"users":       {"teams", "ips", "quotas"},
	"safety":      {"skills", "skill-studio", "modeldeprecations"},
	"mcp":         {"agents", "vcs"},
	"dwdashboard": {"clickhouse", "dwmetrics"},
	"settings":    {"runtimesettings", "errors", "changesets"},
}

// featureFlags reports which optional features are enabled, for both /auth/me and menu
// gating. personal_home is always on (it is this feature); team_dashboard is reserved.
func (s *Server) featureFlags() map[string]bool {
	return map[string]bool{
		"self_service_keys": s.cfg.Auth.SelfServiceKeys,
		"personal_home":     true,
		"team_dashboard":    false,
	}
}

// menuAccessible reports whether a caller with the given scopes/features may see an item.
func menuAccessible(item menuItem, scopes []string, features map[string]bool) bool {
	for _, f := range item.Features {
		if !features[f] {
			return false
		}
	}
	if len(item.Scopes) == 0 {
		return true // any authenticated user
	}
	for _, want := range item.Scopes {
		if hasScope(scopes, want) {
			return true
		}
	}
	return false
}

// menuDecision returns whether a menu is allowed for the caller and a human reason — the
// data behind /permissions/effective so an operator can see exactly why a menu is hidden.
func menuDecision(item menuItem, scopes []string, features map[string]bool) (bool, string) {
	for _, f := range item.Features {
		if !features[f] {
			return false, "feature '" + f + "' disabled"
		}
	}
	if len(item.Scopes) == 0 {
		return true, "any authenticated user"
	}
	for _, want := range item.Scopes {
		if hasScope(scopes, want) {
			return true, "has scope '" + want + "'"
		}
	}
	return false, "missing any of scopes: " + strings.Join(item.Scopes, ", ")
}

// accessibleMenus returns the registry filtered to what the caller may see.
func accessibleMenus(scopes []string, features map[string]bool) []menuItem {
	out := make([]menuItem, 0, len(menuRegistry))
	for _, item := range menuRegistry {
		if menuAccessible(item, scopes, features) {
			out = append(out, item)
		}
	}
	return out
}

// allowedTabs is the flat set of SPA tabs the caller may route to: each accessible menu's
// tab plus that tab's nested children. Drives the SPA route guard.
func allowedTabs(scopes []string, features map[string]bool) []string {
	tabs := []string{}
	seen := map[string]bool{}
	add := func(t string) {
		if t != "" && !seen[t] {
			seen[t] = true
			tabs = append(tabs, t)
		}
	}
	for _, item := range accessibleMenus(scopes, features) {
		add(item.Tab)
		for _, c := range childTabs[item.Tab] {
			add(c)
		}
	}
	return tabs
}

// roleHomeOverride pins specific built-in roles to a role-tailored landing that scope
// alone can't distinguish (e.g. security_admin and readonly_admin both hold admin:read +
// security:read, but the former lands on the security dashboard).
var roleHomeOverride = map[string]string{
	"security_admin": "#/security",
	"billing_admin":  "#/billing",
	"team_manager":   "#/team",
}

// resolveDefaultHome picks the landing route from scopes alone: operators (admin:read) →
// operational dashboard; team managers (team:read, no admin:read) → team dashboard; else
// the personalized home.
func resolveDefaultHome(scopes []string) string {
	if hasScope(scopes, "admin:read") {
		return "#/dashboard"
	}
	if hasScope(scopes, "team:read") {
		return "#/team"
	}
	return "#/me"
}

// resolveHome is the role-aware landing: a per-role override wins, otherwise scope-based.
func resolveHome(role string, scopes []string) string {
	if h := roleHomeOverride[strings.TrimSpace(role)]; h != "" {
		return h
	}
	return resolveDefaultHome(scopes)
}

// navigationFor builds the full navigation payload for a caller's scopes/features.
func (s *Server) navigationFor(scopes []string, role string) map[string]any {
	features := s.featureFlags()
	return map[string]any{
		"menus":        accessibleMenus(scopes, features),
		"allowed_tabs": allowedTabs(scopes, features),
		"default_home": resolveHome(role, scopes),
		"role":         role,
		"scopes":       scopes,
		"features":     features,
		"menu_version": menuVersion,
	}
}

// handleMeNavigation returns the caller's accessible menu set, computed server-side. The
// SPA renders only these items and guards routes against allowed_tabs, so menu hiding and
// route blocking share one policy. In legacy mode (auth disabled) the full operator menu
// is returned, matching the admin-token surface.
func (s *Server) handleMeNavigation(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if !s.cfg.Auth.Enabled {
		writeJSON(w, http.StatusOK, s.navigationFor(append([]string{}, allScopes...), "admin"))
		return
	}
	claims, ok := s.currentAccessClaims(r)
	if !ok {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid access token", "invalid_request_error", "invalid_access_token")
		return
	}
	writeJSON(w, http.StatusOK, s.navigationFor(claims.Scopes, claims.Role))
}
