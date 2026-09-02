package proxy

import (
	"crypto/sha256"
	"crypto/subtle"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

const (
	appUIEnabledKey          = "ui.app.enabled"
	appUIDefaultEntryKey     = "ui.app.default_entry"
	appUILegacyFallbackKey   = "ui.app.legacy_fallback"
	appUIFeedbackEnabledKey  = "ui.app.feedback_enabled"
	appUITelemetryEnabledKey = "ui.app.telemetry_enabled"
)

type appUIRuntimeConfig struct {
	Enabled          bool   `json:"enabled"`
	DefaultEntry     string `json:"default_entry"`
	LegacyFallback   bool   `json:"legacy_fallback"`
	FeedbackEnabled  bool   `json:"feedback_enabled"`
	TelemetryEnabled bool   `json:"telemetry_enabled"`
}

type appUIFeature struct {
	FeatureID          string   `json:"feature_id"`
	Title              string   `json:"title"`
	AppPath            string   `json:"app_path"`
	LegacyPath         string   `json:"legacy_path"`
	Status             string   `json:"status"`
	RiskLevel          string   `json:"risk_level"`
	RequiredPermission string   `json:"required_permission"`
	ReadOnly           bool     `json:"read_only"`
	EnabledRoles       []string `json:"enabled_roles"`
	RolloutPercent     int      `json:"rollout_percent"`
	FallbackEnabled    bool     `json:"fallback_enabled"`
	MinimumAPIVersion  string   `json:"minimum_api_version"`
	Available          bool     `json:"available"`
	AvailabilityReason string   `json:"availability_reason,omitempty"`
}

// appUIFeatures is deliberately conservative. New React screens enter as read-only
// previews for a narrow role cohort; every other domain keeps its proven /admin path.
var appUIFeatures = []appUIFeature{
	{FeatureID: "overview", Title: "Overview", AppPath: "/app/overview", LegacyPath: "/admin#/dashboard", Status: "preview_read_only", RiskLevel: "low", RequiredPermission: "admin:read", ReadOnly: true, EnabledRoles: []string{"super_admin", "admin", "ops_admin", "ai_admin", "security_admin", "billing_admin", "readonly_admin", "viewer"}, RolloutPercent: 100, FallbackEnabled: true, MinimumAPIVersion: "v0.80.0"},
	{FeatureID: "gateway.health", Title: "Gateway Health", AppPath: "/app/gateway/health", LegacyPath: "/admin#/routing/health", Status: "preview_read_only", RiskLevel: "low", RequiredPermission: "routing:read", ReadOnly: true, EnabledRoles: []string{"super_admin", "admin", "ai_admin"}, RolloutPercent: 100, FallbackEnabled: true, MinimumAPIVersion: "v0.81.0"},
	{FeatureID: "gateway.providers", Title: "Provider", AppPath: "/app/gateway/providers", LegacyPath: "/admin#/settings", Status: "preview_read_only", RiskLevel: "medium", RequiredPermission: "admin:read", ReadOnly: true, EnabledRoles: []string{"super_admin", "admin", "ai_admin"}, RolloutPercent: 100, FallbackEnabled: true, MinimumAPIVersion: "v0.82.0"},
	{FeatureID: "gateway.models", Title: "Models", AppPath: "/app/gateway/models", LegacyPath: "/admin#/model-contracts", Status: "preview_read_only", RiskLevel: "medium", RequiredPermission: "admin:read", ReadOnly: true, EnabledRoles: []string{"super_admin", "admin", "ai_admin"}, RolloutPercent: 100, FallbackEnabled: true, MinimumAPIVersion: "v0.82.0"},
	{FeatureID: "routing.rules", Title: "Routing", AppPath: "/app/routing/rules", LegacyPath: "/admin#/routing", Status: "legacy", RiskLevel: "high", RequiredPermission: "routing:read", ReadOnly: true, RolloutPercent: 100, FallbackEnabled: true, MinimumAPIVersion: "v0.80.0"},
	{FeatureID: "observability.requests", Title: "Requests", AppPath: "/app/observability/requests", LegacyPath: "/admin#/requests", Status: "legacy", RiskLevel: "low", RequiredPermission: "observability:read", ReadOnly: true, RolloutPercent: 100, FallbackEnabled: true, MinimumAPIVersion: "v0.80.0"},
	{FeatureID: "observability.traces", Title: "Traces", AppPath: "/app/observability/traces", LegacyPath: "/admin#/llm", Status: "legacy", RiskLevel: "low", RequiredPermission: "observability:read", ReadOnly: true, RolloutPercent: 100, FallbackEnabled: true, MinimumAPIVersion: "v0.80.0"},
	{FeatureID: "prompts.lab", Title: "Prompt Lab", AppPath: "/app/prompts/lab", LegacyPath: "/admin#/prompt-lab", Status: "legacy", RiskLevel: "medium", RequiredPermission: "admin:read", ReadOnly: true, RolloutPercent: 100, FallbackEnabled: true, MinimumAPIVersion: "v0.80.0"},
	{FeatureID: "access.users", Title: "Users & Teams", AppPath: "/app/access/users", LegacyPath: "/admin#/users", Status: "legacy", RiskLevel: "medium", RequiredPermission: "admin:read", ReadOnly: true, RolloutPercent: 100, FallbackEnabled: true, MinimumAPIVersion: "v0.80.0"},
	{FeatureID: "governance.policies", Title: "Policies", AppPath: "/app/governance/policies", LegacyPath: "/admin#/safety", Status: "legacy", RiskLevel: "high", RequiredPermission: "security:read", ReadOnly: true, RolloutPercent: 100, FallbackEnabled: true, MinimumAPIVersion: "v0.80.0"},
	{FeatureID: "mcp.overview", Title: "MCP & Agents", AppPath: "/app/mcp", LegacyPath: "/admin#/mcp", Status: "legacy", RiskLevel: "medium", RequiredPermission: "admin:read", ReadOnly: true, RolloutPercent: 100, FallbackEnabled: true, MinimumAPIVersion: "v0.80.0"},
	{FeatureID: "text2sql.overview", Title: "Text2SQL & Data", AppPath: "/app/text2sql", LegacyPath: "/admin#/text2sql", Status: "legacy", RiskLevel: "high", RequiredPermission: "admin:read", ReadOnly: true, RolloutPercent: 100, FallbackEnabled: true, MinimumAPIVersion: "v0.80.0"},
	{FeatureID: "finops.overview", Title: "FinOps", AppPath: "/app/finops", LegacyPath: "/admin#/billing", Status: "legacy", RiskLevel: "medium", RequiredPermission: "costs:read", ReadOnly: true, RolloutPercent: 100, FallbackEnabled: true, MinimumAPIVersion: "v0.80.0"},
	{FeatureID: "security.overview", Title: "Security", AppPath: "/app/security", LegacyPath: "/admin#/security", Status: "legacy", RiskLevel: "high", RequiredPermission: "security:read", ReadOnly: true, RolloutPercent: 100, FallbackEnabled: true, MinimumAPIVersion: "v0.80.0"},
	{FeatureID: "system.health", Title: "System Health", AppPath: "/app/system/health", LegacyPath: "/admin#/ops-home", Status: "preview_read_only", RiskLevel: "low", RequiredPermission: "admin:read", ReadOnly: true, EnabledRoles: []string{"super_admin", "admin", "ops_admin", "ai_admin", "security_admin", "billing_admin", "readonly_admin"}, RolloutPercent: 100, FallbackEnabled: true, MinimumAPIVersion: "v0.81.0"},
	{FeatureID: "system.settings", Title: "System", AppPath: "/app/system/settings", LegacyPath: "/admin#/settings", Status: "legacy", RiskLevel: "critical", RequiredPermission: "admin:read", ReadOnly: true, RolloutPercent: 100, FallbackEnabled: true, MinimumAPIVersion: "v0.80.0"},
}

var appUIImplementedFeatureIDs = map[string]struct{}{
	"overview":          {},
	"gateway.health":    {},
	"gateway.providers": {},
	"gateway.models":    {},
	"system.health":     {},
}

func appUIEnv(name, fallback string) string {
	if value, ok := os.LookupEnv(name); ok {
		return strings.TrimSpace(value)
	}
	return fallback
}

func validateAppUIPath(value string) error {
	value = strings.TrimSpace(value)
	lower := strings.ToLower(value)
	if strings.Contains(value, "\\") || strings.ContainsAny(value, "\r\n\x00") ||
		strings.Contains(lower, "%2f") || strings.Contains(lower, "%5c") || strings.Contains(lower, "%00") {
		return fmt.Errorf("must be an internal /app path")
	}
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "" || u.Host != "" || u.User != nil || u.Fragment != "" || u.RawQuery != "" || strings.HasPrefix(value, "//") {
		return fmt.Errorf("must be an internal /app path without query or fragment")
	}
	if u.Path != "/app" && !strings.HasPrefix(u.Path, "/app/") {
		return fmt.Errorf("must start with /app/")
	}
	cleanPath := path.Clean(u.Path)
	if strings.HasSuffix(u.Path, "/") && cleanPath != "/" {
		cleanPath += "/"
	}
	if cleanPath != u.Path {
		return fmt.Errorf("must be a normalized internal /app path")
	}
	for _, feature := range appUIFeatures {
		if cleanPath == feature.AppPath {
			return nil
		}
	}
	return fmt.Errorf("must match a registered /app feature path")
}

func validateAppUIStatus(value string) error {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "hidden", "legacy", "preview_read_only", "preview", "stable", "deprecated", "retired":
		return nil
	default:
		return fmt.Errorf("must be hidden|legacy|preview_read_only|preview|stable|deprecated|retired")
	}
}

func validateAppUIRoles(value string) error {
	for _, role := range strings.Split(value, ",") {
		role = strings.TrimSpace(role)
		if role == "" {
			continue
		}
		for _, r := range role {
			if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '_' && r != '-' && r != '.' {
				return fmt.Errorf("roles must contain only lowercase letters, numbers, dot, dash, or underscore")
			}
		}
	}
	return nil
}

func appUIFeatureSettingDefs() []settingDef {
	defs := make([]settingDef, 0, len(appUIFeatures)*4)
	for _, feature := range appUIFeatures {
		prefix := "ui.app.feature." + feature.FeatureID
		defs = append(defs,
			settingDef{Key: prefix + ".status", Category: "ui.app.features", Type: stString, validate: validateAppUIStatus, envValue: func(config.Config) string { return feature.Status }},
			settingDef{Key: prefix + ".roles", Category: "ui.app.features", Type: stCSV, validate: validateAppUIRoles, envValue: func(config.Config) string { return strings.Join(feature.EnabledRoles, ",") }},
			settingDef{Key: prefix + ".rollout", Category: "ui.app.features", Type: stInt, validate: func(value string) error {
				n, err := strconv.Atoi(strings.TrimSpace(value))
				if err != nil || n < 0 || n > 100 {
					return fmt.Errorf("must be an integer between 0 and 100")
				}
				return nil
			}, envValue: func(config.Config) string { return strconv.Itoa(feature.RolloutPercent) }},
			settingDef{Key: prefix + ".readonly", Category: "ui.app.features", Type: stBool, envValue: func(config.Config) string { return strconv.FormatBool(feature.ReadOnly) }},
		)
	}
	return defs
}

func init() {
	for _, feature := range appUIFeatures {
		prefix := "ui.app.feature." + feature.FeatureID
		settingDescriptions[prefix+".status"] = feature.Title + "의 Legacy/Preview/Stable 전환 상태."
		settingDescriptions[prefix+".roles"] = feature.Title + " Preview를 사용할 수 있는 역할 목록(CSV)."
		settingDescriptions[prefix+".rollout"] = feature.Title + "의 사용자 점진 배포 비율(0~100)."
		settingDescriptions[prefix+".readonly"] = feature.Title + " 신규 화면의 읽기 전용 강제 여부."
	}
}

func (s *Server) appUIConf() appUIRuntimeConfig {
	if value := s.appUIRuntime.Load(); value != nil {
		return *value
	}
	return appUIRuntimeConfig{DefaultEntry: "/app/overview", LegacyFallback: true}
}

func (s *Server) reloadAppUIRuntime(stored map[string]store.AdminSetting) {
	get := func(key string) string {
		def, ok := settingDefByKey(key)
		if !ok {
			return ""
		}
		value, _, _ := s.effectiveSettingValue(stored, def)
		return strings.TrimSpace(value)
	}
	boolValue := func(key string, fallback bool) bool {
		value, err := strconv.ParseBool(get(key))
		if err != nil {
			return fallback
		}
		return value
	}
	entry := get(appUIDefaultEntryKey)
	if validateAppUIPath(entry) != nil {
		entry = "/app/overview"
	}
	conf := appUIRuntimeConfig{
		Enabled:          boolValue(appUIEnabledKey, false),
		DefaultEntry:     entry,
		LegacyFallback:   boolValue(appUILegacyFallbackKey, true),
		FeedbackEnabled:  boolValue(appUIFeedbackEnabledKey, false),
		TelemetryEnabled: boolValue(appUITelemetryEnabledKey, false),
	}
	s.appUIRuntime.Store(&conf)
}

func effectiveAppUIFeatures(stored map[string]store.AdminSetting, s *Server, userID, role string, scopes []string, authenticated bool) []appUIFeature {
	out := make([]appUIFeature, 0, len(appUIFeatures))
	legacyFallback := s.appUIConf().LegacyFallback
	for _, base := range appUIFeatures {
		feature := base
		feature.EnabledRoles = append([]string{}, base.EnabledRoles...)
		prefix := "ui.app.feature." + feature.FeatureID
		if def, ok := settingDefByKey(prefix + ".status"); ok {
			if value, _, _ := s.effectiveSettingValue(stored, def); value != "" {
				feature.Status = strings.ToLower(strings.TrimSpace(value))
			}
		}
		if def, ok := settingDefByKey(prefix + ".roles"); ok {
			if value, _, _ := s.effectiveSettingValue(stored, def); strings.TrimSpace(value) != "" {
				feature.EnabledRoles = splitCSV(value)
			}
		}
		if def, ok := settingDefByKey(prefix + ".rollout"); ok {
			if value, _, _ := s.effectiveSettingValue(stored, def); value != "" {
				if n, err := strconv.Atoi(strings.TrimSpace(value)); err == nil && n >= 0 && n <= 100 {
					feature.RolloutPercent = n
				}
			}
		}
		if def, ok := settingDefByKey(prefix + ".readonly"); ok {
			if value, _, _ := s.effectiveSettingValue(stored, def); value != "" {
				if b, err := strconv.ParseBool(strings.TrimSpace(value)); err == nil {
					feature.ReadOnly = b
				}
			}
		}
		feature.Available, feature.AvailabilityReason = appUIFeatureAvailable(feature, userID, role, scopes, authenticated)
		if feature.Status != "retired" && !feature.Available && feature.FallbackEnabled && legacyFallback && feature.LegacyPath != "" &&
			(feature.AvailabilityReason == "role_not_enabled" || feature.AvailabilityReason == "outside_rollout") {
			feature.Status = "legacy"
			feature.ReadOnly = true
			feature.Available = true
			feature.AvailabilityReason = "legacy_fallback"
		}
		if feature.Status == "legacy" && feature.Available && (!legacyFallback || !feature.FallbackEnabled || feature.LegacyPath == "") {
			feature.Available = false
			feature.AvailabilityReason = "legacy_fallback_disabled"
		}
		if !appUIFeatureImplemented(feature.FeatureID) && feature.Available {
			switch {
			case feature.Status == "retired":
				feature.Available = false
				feature.AvailabilityReason = "ui_not_implemented"
			case feature.Status == "legacy":
				// The common Legacy gate above has already validated this bridge.
			case legacyFallback && feature.FallbackEnabled && feature.LegacyPath != "":
				feature.Status = "legacy"
				feature.ReadOnly = true
				feature.AvailabilityReason = "ui_not_implemented"
			default:
				feature.Available = false
				feature.AvailabilityReason = "ui_not_implemented"
			}
		}
		out = append(out, feature)
	}
	return out
}

func appUIFeatureImplemented(featureID string) bool {
	_, ok := appUIImplementedFeatureIDs[featureID]
	return ok
}

func appUIFeatureAvailable(feature appUIFeature, userID, role string, scopes []string, authenticated bool) (bool, string) {
	if feature.Status == "hidden" {
		return false, "feature_hidden"
	}
	if !authenticated {
		return false, "authentication_required"
	}
	if feature.RequiredPermission != "" && !hasScope(scopes, feature.RequiredPermission) {
		return false, "permission_denied"
	}
	if strings.HasPrefix(feature.Status, "preview") && len(feature.EnabledRoles) > 0 && !hasScope(feature.EnabledRoles, role) {
		return false, "role_not_enabled"
	}
	if feature.RolloutPercent < 100 {
		if feature.RolloutPercent <= 0 || appUIRolloutBucket(userID, feature.FeatureID) >= feature.RolloutPercent {
			return false, "outside_rollout"
		}
	}
	return true, ""
}

func appUIRolloutBucket(userID, featureID string) int {
	sum := sha256.Sum256([]byte(userID + "\x00" + featureID))
	return int(uint16(sum[0])<<8|uint16(sum[1])) % 100
}

type appUIBootstrapUser struct {
	ID          string   `json:"id"`
	Email       string   `json:"email"`
	Role        string   `json:"role"`
	Roles       []string `json:"roles"`
	TeamID      string   `json:"team_id"`
	Scopes      []string `json:"scopes"`
	DefaultHome string   `json:"default_home"`
}

func secureTokenEqual(left, right string) bool {
	return len(left) == len(right) && subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

func (s *Server) appUIBootstrapIdentity(r *http.Request) (*appUIBootstrapUser, bool, bool) {
	token := bearerToken(r.Header.Get("Authorization"))
	if s.cfg.Auth.Enabled {
		if token == "" {
			return nil, false, true
		}
		claims, ok := s.currentAccessClaims(r)
		if !ok {
			return nil, false, false
		}
		return &appUIBootstrapUser{ID: claims.Subject, Email: claims.Email, Role: claims.Role, Roles: []string{claims.Role}, TeamID: claims.TeamID, Scopes: append([]string{}, claims.Scopes...), DefaultHome: resolveHome(claims.Role, claims.Scopes)}, true, true
	}

	legacyRequired := s.cfg.Auth.AdminToken != "" || s.cfg.Auth.AdminReadonlyToken != ""
	if legacyRequired && token == "" {
		return nil, false, true
	}
	role := "super_admin"
	if legacyRequired {
		switch {
		case s.cfg.Auth.AdminToken != "" && secureTokenEqual(token, s.cfg.Auth.AdminToken):
			role = "super_admin"
		case s.cfg.Auth.AdminReadonlyToken != "" && secureTokenEqual(token, s.cfg.Auth.AdminReadonlyToken):
			role = "readonly_admin"
		default:
			return nil, false, false
		}
	}
	scopes := scopesForRole(role)
	return &appUIBootstrapUser{ID: "legacy-admin", Email: "", Role: role, Roles: []string{role}, Scopes: scopes, DefaultHome: resolveHome(role, scopes)}, true, true
}

// handleAdminUIBootstrap aggregates existing auth, permission, migration, and minimum
// health information. It does not introduce separate business logic for the React UI.
func (s *Server) handleAdminUIBootstrap(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	user, authenticated, valid := s.appUIBootstrapIdentity(r)
	if !valid {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid access token", "invalid_request_error", "invalid_access_token")
		return
	}
	stored, err := s.loadStoredSettings(r)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "failed to load UI settings", "server_error", "ui_bootstrap_failed")
		return
	}
	role, userID := "", ""
	scopes := []string{}
	roles := []string{}
	if user != nil {
		role, userID = user.Role, user.ID
		scopes = append(scopes, user.Scopes...)
		roles = append(roles, user.Roles...)
	}
	uiConfig := s.appUIConf()
	features := effectiveAppUIFeatures(stored, s, userID, role, scopes, authenticated)
	allowedFeatures := make([]string, 0, len(features))
	legacyRouteMap := map[string]string{}
	for _, feature := range features {
		if feature.Available {
			allowedFeatures = append(allowedFeatures, feature.FeatureID)
			if uiConfig.LegacyFallback && feature.LegacyPath != "" && feature.FallbackEnabled {
				legacyRouteMap[feature.AppPath] = feature.LegacyPath
			}
		}
	}
	kc := s.keycloakConfig()
	mode := "open"
	if s.cfg.Auth.Enabled {
		mode = "session"
	} else if s.cfg.Auth.AdminToken != "" || s.cfg.Auth.AdminReadonlyToken != "" {
		mode = "legacy_token"
	}
	status := "healthy"
	if err := s.db.Ping(r.Context()); err != nil {
		status = "degraded"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"backend_version": AppVersion,
		"ui_version":      AppVersion,
		"api_version":     "v1",
		"ui":              uiConfig,
		"authentication": map[string]any{
			"enabled": s.cfg.Auth.Enabled, "authenticated": authenticated, "mode": mode,
			"keycloak_enabled": kc.Enabled, "allow_local_login": !kc.Enabled || kc.AllowLocalLogin,
			"sso_login_url": "/auth/keycloak/login",
		},
		"user":               user,
		"roles":              roles,
		"permissions":        scopes,
		"allowed_features":   allowedFeatures,
		"migration_registry": features,
		"system_status":      map[string]any{"status": status},
		"legacy_route_map":   legacyRouteMap,
	})
}
