package proxy

import (
	"net/http"
	"sort"
	"strings"
)

// handleMyOnboardingPack returns a client-specific connection pack for the caller: base URL,
// available/recommended models, scope, budget, and a copy-paste config snippet (MCP or OpenAI
// SDK). It never re-exposes an API key secret — only a placeholder. Any authenticated user.
// GET /me/onboarding-pack?client=mcp|cursor|roo|cline|openai-sdk
func (s *Server) handleMyOnboardingPack(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	// Identity + permissions: prefer the proxy API key (carries model allow/deny + budget),
	// fall back to a JWT session.
	apiKeyID, authCtx, keyOK := s.authenticateProxyContext(r)
	claims, jwtOK := s.currentAccessClaims(r)
	if !keyOK && !jwtOK {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	_ = apiKeyID

	client := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("client")))
	if client == "" {
		client = "mcp"
	}

	origin := requestOrigin(r)
	scopes := []string{}
	var budget float64
	if authCtx != nil {
		scopes = authCtx.Scopes
		budget = authCtx.BudgetLimitKRW
	} else if jwtOK {
		scopes = claims.Scopes
	}

	// Available models (priced catalog), filtered by per-key allow/deny when known.
	models := []string{}
	for m := range s.pricingMap(r.Context()) {
		if authCtx != nil && !listAllows(m, authCtx.AllowedModels, authCtx.DeniedModels) {
			continue
		}
		models = append(models, m)
	}
	sort.Strings(models)

	mcpConfig := map[string]any{"mcpServers": map[string]any{"vibe-gateway": map[string]any{
		"url": origin + "/mcp/gateway", "headers": map[string]any{"Authorization": "Bearer <YOUR_API_KEY>"},
	}}}

	pack := map[string]any{
		"client":             client,
		"base_url":           origin + "/v1",
		"mcp_url":            origin + "/mcp/gateway",
		"available_models":   models,
		"recommended_models": []string{"vibe/auto"},
		"scopes":             scopes,
		"budget_limit_krw":   budget,
		"mcp_config":         mcpConfig,
		"sample_curl": "curl " + origin + "/v1/chat/completions \\\n" +
			"  -H 'Authorization: Bearer <YOUR_API_KEY>' \\\n" +
			"  -H 'Content-Type: application/json' \\\n" +
			"  -d '{\"model\":\"vibe/auto\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}'",
		"note": "API Key secret은 발급 직후 1회만 표시됩니다. <YOUR_API_KEY>를 본인 키로 교체하세요.",
	}

	switch client {
	case "openai-sdk":
		pack["config_label"] = "OpenAI 호환 SDK"
		pack["config"] = "from openai import OpenAI\nclient = OpenAI(\n    base_url=\"" + origin + "/v1\",\n    api_key=\"<YOUR_API_KEY>\",\n)\n# model: \"vibe/auto\" 또는 /v1/models 조회"
	case "cursor", "roo", "cline", "claude", "mcp":
		pack["config_label"] = "MCP 클라이언트 (" + client + ")"
		pack["config"] = "mcp_config 필드의 JSON을 클라이언트 MCP 설정에 추가하세요."
	default:
		pack["config_label"] = client
		pack["config"] = "지원: mcp, cursor, roo, cline, openai-sdk"
	}

	writeJSON(w, http.StatusOK, pack)
}

// requestOrigin returns the externally-visible scheme://host for building connection URLs.
func requestOrigin(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if p := r.Header.Get("X-Forwarded-Proto"); p != "" {
		scheme = p
	}
	host := r.Host
	if h := r.Header.Get("X-Forwarded-Host"); h != "" {
		host = h
	}
	return scheme + "://" + host
}
