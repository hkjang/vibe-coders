package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"vibe-coders/internal/store"
)

// rawPromptViewerRoles may view captured prompt/response ORIGINALS. Lower-privilege
// operators (viewer, readonly_admin, ops_admin, ai_admin, team_admin) still reach the
// request-detail surface (admin:read) but see only redacted text — data-scope masking.
var rawPromptViewerRoles = map[string]bool{"super_admin": true, "admin": true, "security_admin": true}

// canViewRawPrompts reports whether the caller may see un-redacted prompt/response text.
// Legacy admin-token mode (auth disabled) is treated as full admin.
func (s *Server) canViewRawPrompts(r *http.Request) bool {
	if !s.cfg.Auth.Enabled {
		return true
	}
	claims, ok := s.currentAccessClaims(r)
	if !ok {
		return false
	}
	return rawPromptViewerRoles[claims.Role]
}

// redactPromptDetails collapses each prompt's raw ContentText to its redacted form so no
// original leaks. Idempotent; safe when ContentText already equals RedactedText.
func redactPromptDetails(prompts []store.PromptDetail) {
	for i := range prompts {
		if prompts[i].ContentText != "" && prompts[i].ContentText != prompts[i].RedactedText {
			prompts[i].ContentText = prompts[i].RedactedText
		}
	}
}

// maskRequestDetail redacts prompt originals in a request detail unless the caller is
// authorized to view raw content.
func (s *Server) maskRequestDetail(r *http.Request, d *store.RequestDetail) {
	if d == nil || s.canViewRawPrompts(r) {
		return
	}
	redactPromptDetails(d.Prompts)
}

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
	"security_admin":  "보안 관리자 — 보안 대시보드(정책위반·Secret·위험MCP·승인대기)",
	"billing_admin":   "비용 관리자 — 비용 대시보드(비용센터·예산소진·모델전환)",
	"readonly_admin":  "읽기전용 관리자 — 운영 조회, 변경 불가",
}

// roleInfo is one row of the role catalog (GET /admin/roles).
type roleInfo struct {
	Role        string   `json:"role"`
	Scopes      []string `json:"scopes"`
	DefaultHome string   `json:"default_home"`
	IsAdmin     bool     `json:"is_admin"`
	IsSystem    bool     `json:"is_system"`
	Rank        int      `json:"rank"`
	Description string   `json:"description"`
}

// effectiveScopesForRole resolves a role's scopes through the custom-role overlay first,
// falling back to the built-in map. Used at token issuance so custom roles take effect.
func (s *Server) effectiveScopesForRole(ctx context.Context, role string) []string {
	if cr, found, err := s.db.GetCustomRole(ctx, role); err == nil && found {
		return cr.Scopes
	}
	return scopesForRole(role)
}

// effectiveValidRole reports whether a role exists either built-in or as a custom role.
func (s *Server) effectiveValidRole(ctx context.Context, role string) bool {
	if validRole(role) {
		return true
	}
	if _, found, err := s.db.GetCustomRole(ctx, role); err == nil && found {
		return true
	}
	return false
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
			DefaultHome: resolveHome(role, s),
			IsAdmin:     hasScope(s, "admin:read"),
			IsSystem:    true,
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

// customRoleInfo projects a stored custom role into the catalog row shape.
func customRoleInfo(c store.CustomRole) roleInfo {
	home := strings.TrimSpace(c.DefaultHome)
	if home == "" {
		home = resolveDefaultHome(c.Scopes)
	}
	return roleInfo{
		Role: c.Role, Scopes: c.Scopes, DefaultHome: home,
		IsAdmin: hasScope(c.Scopes, "admin:read"), IsSystem: false,
		Rank: 0, Description: c.Description,
	}
}

// handleAdminRoles manages the role catalog. Admin-only.
// GET    /admin/roles            → built-in + custom roles + all_scopes
// POST   /admin/roles            → create/update a custom role {role, description, scopes, default_home}
// DELETE /admin/roles?role=NAME  → remove a custom role
func (s *Server) handleAdminRoles(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		roles := roleCatalog()
		if custom, err := s.db.ListCustomRoles(r.Context()); err == nil {
			for _, c := range custom {
				roles = append(roles, customRoleInfo(c))
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"roles": roles, "all_scopes": allScopes})
	case http.MethodPost:
		var p struct {
			Role        string   `json:"role"`
			Description string   `json:"description"`
			Scopes      []string `json:"scopes"`
			DefaultHome string   `json:"default_home"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		role := strings.ToLower(strings.TrimSpace(p.Role))
		if role == "" {
			writeOpenAIError(w, http.StatusBadRequest, "role is required", "invalid_request_error", "missing_role")
			return
		}
		if _, isBuiltin := roleScopes[role]; isBuiltin {
			writeOpenAIError(w, http.StatusConflict, "'"+role+"' is a built-in role and cannot be overridden", "invalid_request_error", "builtin_role")
			return
		}
		// Validate every scope against the known set.
		clean := []string{}
		for _, sc := range p.Scopes {
			sc = strings.TrimSpace(sc)
			if sc == "" {
				continue
			}
			if !hasScope(allScopes, sc) {
				writeOpenAIError(w, http.StatusBadRequest, "unknown scope: "+sc, "invalid_request_error", "invalid_scope")
				return
			}
			clean = append(clean, sc)
		}
		cr := store.CustomRole{Role: role, Description: strings.TrimSpace(p.Description), Scopes: clean, DefaultHome: strings.TrimSpace(p.DefaultHome)}
		if err := s.db.UpsertCustomRole(r.Context(), cr); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "role_save_failed")
			return
		}
		s.auditAdmin(r, "role.upsert", role, auditJSON(map[string]any{"scopes": clean}))
		writeJSON(w, http.StatusCreated, map[string]any{"role": customRoleInfo(cr)})
	case http.MethodDelete:
		role := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("role")))
		if role == "" {
			writeOpenAIError(w, http.StatusBadRequest, "role query param is required", "invalid_request_error", "missing_role")
			return
		}
		if _, isBuiltin := roleScopes[role]; isBuiltin {
			writeOpenAIError(w, http.StatusConflict, "cannot delete built-in role", "invalid_request_error", "builtin_role")
			return
		}
		if err := s.db.DeleteCustomRole(r.Context(), role); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "role_delete_failed")
			return
		}
		s.auditAdmin(r, "role.delete", role, "")
		writeJSON(w, http.StatusOK, map[string]any{"role": role, "deleted": true})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
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
			if !s.effectiveValidRole(r.Context(), preview) {
				writeOpenAIError(w, http.StatusBadRequest, "unknown role: "+preview, "invalid_request_error", "invalid_role")
				return
			}
			role, scopes = preview, s.effectiveScopesForRole(r.Context(), preview)
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
		"default_home": resolveHome(role, scopes),
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
