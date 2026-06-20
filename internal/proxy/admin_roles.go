package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
)

// roleDescriptions documents each built-in role for the admin roles screen.
var roleDescriptions = map[string]string{
	"super_admin":     "최고 관리자 — 모든 권한",
	"admin":           "관리자 — 전체 운영/설정",
	"team_admin":      "팀 관리자 — 팀 단위 운영 조회 + 채팅",
	"team_manager":    "팀 매니저 — 팀 대시보드(사용량/비용/실패), 운영 화면 없음",
	"developer":       "개발자 — 채팅/임베딩/모델, 운영 화면 없음",
	"viewer":          "뷰어 — 운영 조회 전용",
	"service_account": "서비스 계정 — 채팅/임베딩/MCP",
	"ops_admin":       "운영 설정 관리자 — 관측/비용 + 일부 설정 쓰기",
	"ai_admin":        "AI 설정 관리자 — 모델/라우팅 + 일부 설정 쓰기",
	"security_admin":  "보안 관리자 — 안전/보안 surface",
	"readonly_admin":  "읽기전용 관리자 — 운영 조회, 변경 불가",
}

// roleInfo is one row of the role catalog (GET /admin/roles).
type roleInfo struct {
	Role        string   `json:"role"`
	Scopes      []string `json:"scopes"`
	DefaultHome string   `json:"default_home"`
	IsAdmin     bool     `json:"is_admin"`
	Rank        int      `json:"rank"`
	Description string   `json:"description"`
}

// roleCatalog returns every built-in role with its derived scopes, default home, and
// whether it reaches the operational surface (admin:read). Drives a permissions UI and
// keeps the role model discoverable without reading code.
func roleCatalog() []roleInfo {
	out := make([]roleInfo, 0, len(roleScopes))
	for role, scopes := range roleScopes {
		s := append([]string{}, scopes...)
		out = append(out, roleInfo{
			Role:        role,
			Scopes:      s,
			DefaultHome: resolveDefaultHome(s),
			IsAdmin:     hasScope(s, "admin:read"),
			Rank:        roleRank(role),
			Description: roleDescriptions[role],
		})
	}
	// Stable order: highest rank first, then name.
	for i := 0; i < len(out); i++ {
		for j := i + 1; j < len(out); j++ {
			if out[j].Rank > out[i].Rank || (out[j].Rank == out[i].Rank && out[j].Role < out[i].Role) {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	return out
}

// handleAdminRoles returns the role catalog. Admin-only (powers the permissions screen).
// GET /admin/roles
func (s *Server) handleAdminRoles(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"roles": roleCatalog(), "all_scopes": allScopes})
}

// handlePermissionsEffective returns the caller's effective role/scopes/features plus a
// per-menu allow/deny decision with reasons — the权한 debug view (FE-007/API-008). An admin
// may preview another role via ?role= without changing anyone's actual role.
// GET /permissions/effective[?role=]
func (s *Server) handlePermissionsEffective(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var role string
	var scopes []string
	if !s.cfg.Auth.Enabled {
		role, scopes = "admin", append([]string{}, allScopes...)
	} else {
		claims, ok := s.currentAccessClaims(r)
		if !ok {
			writeOpenAIError(w, http.StatusUnauthorized, "invalid access token", "invalid_request_error", "invalid_access_token")
			return
		}
		role, scopes = claims.Role, claims.Scopes
		// Admins may preview another role's effective permissions.
		if preview := strings.TrimSpace(r.URL.Query().Get("role")); preview != "" {
			if !s.authorizeAdmin(r) {
				writeOpenAIError(w, http.StatusForbidden, "previewing another role requires admin", "invalid_request_error", "forbidden")
				return
			}
			if !validRole(preview) {
				writeOpenAIError(w, http.StatusBadRequest, "unknown role: "+preview, "invalid_request_error", "invalid_role")
				return
			}
			role, scopes = preview, scopesForRole(preview)
		}
	}

	features := s.featureFlags()
	menus := make([]map[string]any, 0, len(menuRegistry))
	for _, item := range menuRegistry {
		allowed, reason := menuDecision(item, scopes, features)
		menus = append(menus, map[string]any{
			"id": item.ID, "label": item.Label, "path": item.Path, "tab": item.Tab,
			"group": item.Group, "data_scope": item.DataScope,
			"allowed": allowed, "reason": reason,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"role":         role,
		"scopes":       scopes,
		"features":     features,
		"default_home": resolveDefaultHome(scopes),
		"is_admin":     hasScope(scopes, "admin:read"),
		"menu_version": menuVersion,
		"menus":        menus,
	})
}

// handleMeAccessDenied records a client-side route-guard denial (a user hit a menu/route
// outside their permissions). Lets operators see attempted privilege escalation in the
// auth audit log even though the block happens in the SPA.
// POST /me/access-denied {tab, path}
func (s *Server) handleMeAccessDenied(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	userID, ok := s.meUserID(r)
	if !ok {
		// Not identifiable (e.g. legacy token) — nothing to attribute; accept silently.
		writeJSON(w, http.StatusOK, map[string]any{"status": "ignored"})
		return
	}
	var p struct {
		Tab  string `json:"tab"`
		Path string `json:"path"`
	}
	_ = json.NewDecoder(r.Body).Decode(&p)
	teamID := ""
	if claims, ok := s.currentAccessClaims(r); ok {
		teamID = claims.TeamID
	}
	detail := "menu access denied: tab=" + strings.TrimSpace(p.Tab)
	if p.Path != "" {
		detail += " path=" + strings.TrimSpace(p.Path)
	}
	s.auditAuthEvent(r.Context(), "access_denied", userID, "", teamID, detail)
	writeJSON(w, http.StatusOK, map[string]any{"status": "recorded"})
}
