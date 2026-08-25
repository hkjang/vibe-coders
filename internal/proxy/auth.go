package proxy

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

var allScopes = []string{
	"chat:completion", "embeddings:create", "models:read",
	"admin:read", "admin:write", "routing:read", "routing:write",
	"observability:read", "costs:read", "security:read", "mcp:use", "mcp:admin",
	"team:read",
}

var roleScopes = map[string][]string{
	"super_admin": allScopes,
	"admin":       allScopes,
	"team_admin":  {"chat:completion", "embeddings:create", "models:read", "admin:read", "routing:read", "observability:read", "costs:read", "security:read", "mcp:use", "team:read"},
	// team_manager sees only their team's surface (team:read) — NOT the full operator
	// dashboard (no admin:read), so they land on /team rather than /admin.
	"team_manager":    {"chat:completion", "embeddings:create", "models:read", "observability:read", "costs:read", "mcp:use", "team:read"},
	"developer":       {"chat:completion", "embeddings:create", "models:read", "routing:read", "observability:read", "costs:read", "mcp:use"},
	"viewer":          {"models:read", "admin:read", "routing:read", "observability:read", "costs:read", "security:read"},
	"service_account": {"chat:completion", "embeddings:create", "models:read", "mcp:use"},
	// Settings-scoped sub-admins: they can read the admin surface (admin:read) and write
	// only their slice of runtime settings (enforced per-category in the settings handlers,
	// not via a broad admin:write grant).
	"ops_admin":      {"admin:read", "observability:read", "costs:read", "models:read"},
	"ai_admin":       {"admin:read", "models:read", "routing:read", "observability:read"},
	"security_admin": {"admin:read", "security:read"},
	"billing_admin":  {"admin:read", "costs:read", "observability:read", "models:read"},
	"readonly_admin": {"admin:read", "observability:read", "costs:read", "security:read"},
}

type accessClaims struct {
	Subject   string   `json:"sub"`
	Email     string   `json:"email"`
	Role      string   `json:"role"`
	TeamID    string   `json:"team_id"`
	Scopes    []string `json:"scopes"`
	SessionID string   `json:"sid"`
	ExpiresAt int64    `json:"exp"`
	IssuedAt  int64    `json:"iat"`
	Type      string   `json:"typ"`
}

func (s *Server) bootstrapAdmin(ctx context.Context) error {
	if !s.cfg.Auth.Enabled || s.cfg.Auth.BootstrapEmail == "" || s.cfg.Auth.BootstrapPassword == "" {
		return nil
	}
	if _, found, err := s.db.AuthUserByEmail(ctx, s.cfg.Auth.BootstrapEmail); err != nil || found {
		return err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(s.cfg.Auth.BootstrapPassword), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	user := store.AuthUser{
		ID:           "usr_" + audit.HashText(s.cfg.Auth.BootstrapEmail)[:16],
		Email:        s.cfg.Auth.BootstrapEmail,
		PasswordHash: string(hash),
		Name:         "Bootstrap Admin",
		Role:         "super_admin",
		Status:       "active",
	}
	if err := s.db.CreateAuthUser(ctx, user); err != nil {
		return err
	}
	s.auditAuthEvent(ctx, "role_changed", user.ID, "", "", "bootstrap super_admin")
	return nil
}

func (s *Server) issueTokenPair(ctx context.Context, user store.AuthUser, teamID, ip, ua string) (map[string]any, error) {
	pair, _, err := s.issueTokenPairWithSession(ctx, user, teamID, ip, ua)
	return pair, err
}

// issueTokenPairWithSession is issueTokenPair that also returns the internal session id, so
// SSO callers can link the Keycloak sid to the session for targeted logout.
func (s *Server) issueTokenPairWithSession(ctx context.Context, user store.AuthUser, teamID, ip, ua string) (map[string]any, string, error) {
	now := time.Now().UTC()
	sessionID := newID("sess")
	if err := s.db.InsertAuthSession(ctx, sessionID, user.ID, ip, ua, now.Add(s.cfg.Auth.RefreshTokenTTL)); err != nil {
		return nil, "", err
	}
	refresh, err := randomSecret(40)
	if err != nil {
		return nil, "", err
	}
	if err := s.db.InsertRefreshToken(ctx, store.RefreshTokenRecord{
		ID:        newID("rt"),
		UserID:    user.ID,
		SessionID: sessionID,
		TokenHash: hashProxyKey(refresh),
		ExpiresAt: now.Add(s.cfg.Auth.RefreshTokenTTL),
		CreatedAt: now,
	}); err != nil {
		return nil, "", err
	}
	access, err := s.signAccessToken(accessClaims{
		Subject:   user.ID,
		Email:     user.Email,
		Role:      user.Role,
		TeamID:    teamID,
		Scopes:    s.effectiveScopesForRole(ctx, user.Role),
		SessionID: sessionID,
		ExpiresAt: now.Add(s.cfg.Auth.AccessTokenTTL).Unix(),
		IssuedAt:  now.Unix(),
		Type:      "access",
	})
	if err != nil {
		return nil, "", err
	}
	return map[string]any{
		"access_token":       access,
		"refresh_token":      refresh,
		"token_type":         "Bearer",
		"expires_in":         int(s.cfg.Auth.AccessTokenTTL.Seconds()),
		"refresh_expires_in": int(s.cfg.Auth.RefreshTokenTTL.Seconds()),
		"user": map[string]any{
			"id": user.ID, "email": user.Email, "name": user.Name, "role": user.Role, "team_id": teamID,
		},
	}, sessionID, nil
}

func (s *Server) rotateRefreshToken(ctx context.Context, raw string, ip, ua string) (map[string]any, error) {
	rec, found, err := s.db.RefreshTokenByHash(ctx, hashProxyKey(raw))
	if err != nil {
		return nil, err
	}
	if !found || !rec.RevokedAt.IsZero() || rec.ExpiresAt.Before(time.Now().UTC()) {
		return nil, errors.New("invalid refresh token")
	}
	active, err := s.db.AuthSessionActive(ctx, rec.SessionID)
	if err != nil {
		return nil, err
	}
	if !active {
		return nil, errors.New("session revoked")
	}
	user, found, err := s.db.AuthUserByID(ctx, rec.UserID)
	if err != nil {
		return nil, err
	}
	if !found || user.Status != "active" {
		return nil, errors.New("user inactive")
	}
	if err := s.db.RevokeRefreshToken(ctx, rec.ID); err != nil {
		return nil, err
	}
	teamID, _ := s.db.PrimaryTeamForUser(ctx, user.ID)
	refresh, err := randomSecret(40)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	if err := s.db.InsertRefreshToken(ctx, store.RefreshTokenRecord{
		ID:          newID("rt"),
		UserID:      user.ID,
		SessionID:   rec.SessionID,
		TokenHash:   hashProxyKey(refresh),
		ExpiresAt:   now.Add(s.cfg.Auth.RefreshTokenTTL),
		CreatedAt:   now,
		RotatedFrom: rec.ID,
	}); err != nil {
		return nil, err
	}
	access, err := s.signAccessToken(accessClaims{
		Subject: user.ID, Email: user.Email, Role: user.Role, TeamID: teamID,
		Scopes: s.effectiveScopesForRole(ctx, user.Role), SessionID: rec.SessionID,
		ExpiresAt: now.Add(s.cfg.Auth.AccessTokenTTL).Unix(), IssuedAt: now.Unix(), Type: "access",
	})
	if err != nil {
		return nil, err
	}
	_ = ip
	_ = ua
	return map[string]any{
		"access_token":       access,
		"refresh_token":      refresh,
		"token_type":         "Bearer",
		"expires_in":         int(s.cfg.Auth.AccessTokenTTL.Seconds()),
		"refresh_expires_in": int(s.cfg.Auth.RefreshTokenTTL.Seconds()),
	}, nil
}

func (s *Server) signAccessToken(claims accessClaims) (string, error) {
	header := map[string]string{"alg": "HS256", "typ": "JWT"}
	hb, _ := json.Marshal(header)
	cb, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	unsigned := base64.RawURLEncoding.EncodeToString(hb) + "." + base64.RawURLEncoding.EncodeToString(cb)
	mac := hmac.New(sha256.New, []byte(s.cfg.Auth.JWTSecret))
	mac.Write([]byte(unsigned))
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func (s *Server) verifyAccessToken(ctx context.Context, token string) (accessClaims, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return accessClaims{}, false
	}
	unsigned := parts[0] + "." + parts[1]
	mac := hmac.New(sha256.New, []byte(s.cfg.Auth.JWTSecret))
	mac.Write([]byte(unsigned))
	want := mac.Sum(nil)
	got, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(got, want) {
		return accessClaims{}, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return accessClaims{}, false
	}
	var claims accessClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return accessClaims{}, false
	}
	if claims.Type != "access" || claims.ExpiresAt <= time.Now().Unix() {
		return accessClaims{}, false
	}
	active, err := s.db.AuthSessionActive(ctx, claims.SessionID)
	if err != nil || !active {
		return accessClaims{}, false
	}
	return claims, true
}

func scopesForRole(role string) []string {
	if scopes, ok := roleScopes[role]; ok {
		return append([]string{}, scopes...)
	}
	return append([]string{}, roleScopes["viewer"]...)
}

func validRole(role string) bool {
	_, ok := roleScopes[role]
	return ok
}

func roleRank(role string) int {
	switch role {
	case "super_admin":
		return 5
	case "admin":
		return 4
	case "team_admin":
		return 3
	case "ops_admin", "ai_admin", "security_admin", "billing_admin":
		return 3
	case "team_manager":
		return 2
	case "developer", "service_account":
		return 2
	case "viewer", "readonly_admin":
		return 1
	default:
		return 0
	}
}

func (s *Server) canAssignRole(r *http.Request, role string) bool {
	role = strings.TrimSpace(role)
	if role == "" || !s.cfg.Auth.Enabled {
		return true
	}
	claims, ok := s.currentAccessClaims(r)
	if !ok {
		return false
	}
	if claims.Role == "super_admin" {
		return true
	}
	return roleRank(role) > 0 && roleRank(role) < roleRank(claims.Role)
}

func (s *Server) canModifySubjectRole(r *http.Request, currentRole string) bool {
	if !s.cfg.Auth.Enabled {
		return true
	}
	claims, ok := s.currentAccessClaims(r)
	if !ok {
		return false
	}
	if claims.Role == "super_admin" {
		return true
	}
	return roleRank(currentRole) > 0 && roleRank(currentRole) < roleRank(claims.Role)
}

func normalizeScopes(scopes []string) ([]string, bool) {
	out := []string{}
	seen := map[string]bool{}
	for _, raw := range scopes {
		scope := strings.TrimSpace(raw)
		if scope == "" {
			continue
		}
		if !hasScope(allScopes, scope) {
			return nil, false
		}
		if !seen[scope] {
			seen[scope] = true
			out = append(out, scope)
		}
	}
	return out, true
}

func (s *Server) scopesAssignable(r *http.Request, scopes []string) bool {
	if !s.cfg.Auth.Enabled {
		return true
	}
	claims, ok := s.currentAccessClaims(r)
	if !ok {
		return false
	}
	if claims.Role == "super_admin" {
		return true
	}
	for _, scope := range scopes {
		if !hasScope(claims.Scopes, scope) {
			return false
		}
	}
	return true
}

func defaultAPIKeyScopes(role string, serviceAccount bool) []string {
	if strings.TrimSpace(role) == "" {
		if serviceAccount {
			role = "service_account"
		} else {
			role = "developer"
		}
	}
	return scopesForRole(role)
}

func hasScope(scopes []string, scope string) bool {
	for _, s := range scopes {
		if s == scope {
			return true
		}
	}
	return false
}

func randomSecret(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func generateAuthAPIKey(prefix string) (string, error) {
	secret, err := randomSecret(32)
	if err != nil {
		return "", err
	}
	return prefix + secret, nil
}

func authContextFromAPIKey(key store.APIKeyRecord) store.AuthContext {
	role := key.Role
	if role == "" {
		if key.ServiceAccountID != "" {
			role = "service_account"
		} else {
			role = "developer"
		}
	}
	return store.AuthContext{
		UserID: key.UserID, TeamID: key.Team, KeyTeam: key.Team, Role: role, Scopes: key.Scopes,
		AllowedModels: key.AllowedModels, DeniedModels: key.DeniedModels,
		AllowedProviders: key.AllowedProviders, DeniedProviders: key.DeniedProviders,
		BudgetLimitKRW: key.BudgetLimitKRW, AllowedIPs: key.AllowedIPs, APIKeyID: key.ID,
	}
}

func (s *Server) enrichAuthContextTeam(ctx context.Context, authCtx *store.AuthContext) {
	if authCtx == nil || strings.TrimSpace(authCtx.TeamID) == "" {
		return
	}
	team, found, err := s.db.AuthTeamByIDOrName(ctx, authCtx.TeamID)
	if err != nil || !found {
		return
	}
	authCtx.TeamID = team.ID
	authCtx.TeamName = team.Name
}

func apiScopeForRequest(r *http.Request) string {
	switch r.URL.Path {
	case "/v1/chat/completions":
		return "chat:completion"
	case "/v1/embeddings":
		return "embeddings:create"
	case "/v1/models":
		return "models:read"
	case "/mcp":
		return "mcp:use"
	default:
		return ""
	}
}

func ipAllowed(ip string, allowed []string) bool {
	if len(allowed) == 0 {
		return true
	}
	parsed := net.ParseIP(ip)
	for _, raw := range allowed {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		if raw == ip {
			return true
		}
		if _, cidr, err := net.ParseCIDR(raw); err == nil && parsed != nil && cidr.Contains(parsed) {
			return true
		}
	}
	return false
}

func listAllows(value string, allowed, denied []string) bool {
	value = strings.ToLower(strings.TrimSpace(value))
	for _, pattern := range denied {
		if matchGlob(strings.ToLower(strings.TrimSpace(pattern)), value) {
			return false
		}
	}
	if len(allowed) == 0 {
		return true
	}
	for _, pattern := range allowed {
		if matchGlob(strings.ToLower(strings.TrimSpace(pattern)), value) {
			return true
		}
	}
	return false
}

func (s *Server) auditAuthEvent(ctx context.Context, typ, userID, keyID, teamID, detail string) {
	_ = s.db.InsertAuditEvent(ctx, store.AuthEvent{
		ID:          newID("ae"),
		EventType:   typ,
		ActorUserID: userID,
		APIKeyID:    keyID,
		TeamID:      teamID,
		Detail:      detail,
		CreatedAt:   time.Now().UTC(),
	})
}

func hashTokenForDisplay(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])[:12]
}

func parseAPITime(raw string) time.Time {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}
	}
	if parsed, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		return parsed
	}
	if parsed, err := time.Parse(time.RFC3339, raw); err == nil {
		return parsed
	}
	return time.Time{}
}
