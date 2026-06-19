package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

type chatTestAuthContextKey struct{}

type chatTestInjectedAuth struct {
	APIKeyID string
	AuthCtx  *store.AuthContext
}

func injectedChatTestAuth(ctx context.Context) (chatTestInjectedAuth, bool) {
	injected, ok := ctx.Value(chatTestAuthContextKey{}).(chatTestInjectedAuth)
	if !ok || strings.TrimSpace(injected.APIKeyID) == "" {
		return chatTestInjectedAuth{}, false
	}
	return injected, true
}

type chatTestTarget struct {
	ID          string         `json:"id"`
	Kind        string         `json:"kind"`
	Label       string         `json:"label"`
	Model       string         `json:"model,omitempty"`
	Provider    string         `json:"provider,omitempty"`
	Pattern     string         `json:"pattern,omitempty"`
	Enabled     bool           `json:"enabled"`
	Editable    bool           `json:"editable"`
	Description string         `json:"description,omitempty"`
	Metadata    map[string]any `json:"metadata,omitempty"`
}

type chatTestRunRequest struct {
	TargetID       string            `json:"target_id"`
	Model          string            `json:"model"`
	Provider       string            `json:"provider"`
	Prompt         string            `json:"prompt"`
	Messages       []map[string]any  `json:"messages"`
	APIKeyID       string            `json:"api_key_id"`
	BearerToken    string            `json:"bearer_token"`
	Temperature    *float64          `json:"temperature"`
	MaxTokens      int               `json:"max_tokens"`
	NoRoute        bool              `json:"no_route"`
	IncludePreview bool              `json:"include_preview"`
	Headers        map[string]string `json:"headers"`
}

func (s *Server) handleChatTestTargets(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	catalog := s.chatTestTargetCatalog(r.Context())
	writeJSON(w, http.StatusOK, catalog)
}

func (s *Server) chatTestTargetCatalog(ctx context.Context) map[string]any {
	grouped := map[string][]chatTestTarget{
		"routing":  {},
		"provider": {},
		"text2sql": {},
		"mcp":      {},
	}
	flat := []chatTestTarget{}
	seen := map[string]bool{}
	add := func(group string, target chatTestTarget) {
		target.ID = strings.TrimSpace(target.ID)
		if target.ID == "" || seen[target.ID] {
			return
		}
		if target.Metadata == nil {
			target.Metadata = map[string]any{}
		}
		seen[target.ID] = true
		grouped[group] = append(grouped[group], target)
		flat = append(flat, target)
	}

	for _, alias := range []string{"vibe/auto", "vibe-coders/auto", "auto"} {
		add("routing", chatTestTarget{
			ID:          "routing:" + alias,
			Kind:        "routing",
			Label:       alias + " · Intelligent Router",
			Model:       alias,
			Enabled:     true,
			Description: "Complexity, risk, provider health, auth policy를 반영해 모델을 자동 선택합니다.",
		})
	}
	if rules, err := s.db.ListRoutingRules(ctx); err == nil {
		for _, rule := range rules {
			label := strings.TrimSpace(rule.TargetModel)
			if rule.TargetProvider != "" {
				label += " · " + rule.TargetProvider
			}
			add("routing", chatTestTarget{
				ID:          "routing-rule:" + rule.ID,
				Kind:        "routing_rule",
				Label:       label,
				Model:       rule.TargetModel,
				Provider:    rule.TargetProvider,
				Pattern:     rule.MatchPattern,
				Enabled:     rule.Enabled,
				Description: rule.Note,
				Metadata: map[string]any{
					"priority":       rule.Priority,
					"min_complexity": rule.MinComplexity,
					"max_complexity": rule.MaxComplexity,
				},
			})
		}
	}

	for _, p := range []struct {
		model string
		mode  string
		desc  string
	}{
		{"vibe/text2sql-preview", "preview", "SQL 생성과 검증까지만 수행합니다."},
		{"vibe/text2sql-execute", "execute", "read-only SQL 실행과 마스킹 요약까지 수행합니다."},
		{"vibe/text2sql-accurate", "preview", "정확도 우선 생성 모델을 사용합니다."},
		{"vibe/text2sql-local", "preview", "로컬/사내 모델 프로필을 사용합니다."},
		{"vibe/text2sql-auto", "preview", "라우터가 SQL 생성 upstream 모델을 선택합니다."},
	} {
		add("text2sql", chatTestTarget{
			ID:          "text2sql:" + p.model,
			Kind:        "text2sql",
			Label:       p.model,
			Model:       p.model,
			Enabled:     true,
			Description: p.desc,
			Metadata:    map[string]any{"mode": p.mode, "source": "built_in"},
		})
	}
	if profiles, err := s.db.ListText2SQLProfiles(ctx); err == nil {
		for _, profile := range profiles {
			add("text2sql", chatTestTarget{
				ID:          "text2sql-profile:" + profile.VirtualModel,
				Kind:        "text2sql_profile",
				Label:       profile.VirtualModel,
				Model:       profile.VirtualModel,
				Enabled:     profile.Enabled,
				Description: "Runtime Text2SQL virtual model profile",
				Metadata: map[string]any{
					"mode":               profile.Mode,
					"upstream_model":     profile.UpstreamModel,
					"summary_model":      profile.SummaryModel,
					"schema_name":        profile.SchemaName,
					"exec_connection_id": profile.ExecConnectionID,
					"updated_at":         profile.UpdatedAt,
				},
			})
		}
	}

	if providers, err := s.db.ListProviders(ctx); err == nil {
		for _, provider := range providers {
			patterns := splitChatTestPatterns(provider.ModelPatterns)
			if len(patterns) == 0 {
				add("provider", chatTestTarget{
					ID:          "provider:" + provider.Name,
					Kind:        "provider",
					Label:       provider.Name + " · 직접 모델명 입력",
					Provider:    provider.Name,
					Enabled:     provider.Enabled,
					Editable:    true,
					Description: "등록된 provider입니다. 테스트할 모델명을 직접 입력하세요.",
					Metadata:    providerMetadata(provider),
				})
				continue
			}
			for _, pattern := range patterns {
				add("provider", chatTestTarget{
					ID:          "provider:" + provider.Name + ":" + pattern,
					Kind:        "provider_pattern",
					Label:       provider.Name + " · " + pattern,
					Model:       chatTestModelFromPattern(pattern),
					Provider:    provider.Name,
					Pattern:     pattern,
					Enabled:     provider.Enabled,
					Editable:    strings.ContainsAny(pattern, "*?[]"),
					Description: "Provider model pattern 기반 테스트 대상입니다.",
					Metadata:    providerMetadata(provider),
				})
			}
		}
	}

	snap := s.mcpToolsSnapshotCached(ctx)
	for _, route := range mcpRouteViews(snap) {
		name := firstNonEmpty(route.ExposedName, route.URI, route.TargetName)
		add("mcp", chatTestTarget{
			ID:          "mcp:" + route.Kind + ":" + name,
			Kind:        "mcp_" + route.Kind,
			Label:       name + " · " + route.UpstreamName,
			Model:       "vibe/auto",
			Enabled:     route.DiscoveryError == "",
			Editable:    true,
			Description: route.Description,
			Metadata: map[string]any{
				"kind":               route.Kind,
				"exposed_name":       route.ExposedName,
				"uri":                route.URI,
				"upstream_id":        route.UpstreamID,
				"upstream_name":      route.UpstreamName,
				"target_method":      route.TargetMethod,
				"target_name":        route.TargetName,
				"last_discovered_at": route.LastDiscoveredAt,
				"discovery_error":    route.DiscoveryError,
			},
		})
	}

	for group := range grouped {
		sort.SliceStable(grouped[group], func(i, j int) bool {
			if grouped[group][i].Enabled != grouped[group][j].Enabled {
				return grouped[group][i].Enabled
			}
			return grouped[group][i].Label < grouped[group][j].Label
		})
	}
	sort.SliceStable(flat, func(i, j int) bool {
		if flat[i].Kind != flat[j].Kind {
			return flat[i].Kind < flat[j].Kind
		}
		return flat[i].Label < flat[j].Label
	})

	return map[string]any{
		"targets":        flat,
		"grouped":        grouped,
		"defaults":       map[string]any{"model": "vibe/auto", "prompt": "Reply with pong in one short sentence.", "max_tokens": 64, "temperature": 0},
		"mcp_fetched_at": snap.fetchedAt.UTC().Format(time.RFC3339),
		"mcp_errors":     snap.errors,
	}
}

func (s *Server) handleChatTestRun(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var input chatTestRunRequest
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	input.Model = strings.TrimSpace(input.Model)
	if input.Model == "" {
		input.Model = "vibe/auto"
	}
	if input.MaxTokens <= 0 {
		input.MaxTokens = 64
	}
	if input.MaxTokens > 4096 {
		input.MaxTokens = 4096
	}
	messages := input.Messages
	if len(messages) == 0 {
		prompt := strings.TrimSpace(input.Prompt)
		if prompt == "" {
			prompt = "Reply with pong in one short sentence."
		}
		messages = []map[string]any{{"role": "user", "content": prompt}}
	}
	body := map[string]any{
		"model":      input.Model,
		"messages":   messages,
		"max_tokens": input.MaxTokens,
		"stream":     false,
	}
	if input.Temperature != nil {
		body["temperature"] = *input.Temperature
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid chat body", "invalid_request_error", "invalid_body")
		return
	}

	internalReq := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewReader(encoded))
	internalReq.RemoteAddr = r.RemoteAddr
	internalReq.Header.Set("Content-Type", "application/json")
	internalReq.Header.Set("Accept", "application/json")
	internalReq.Header.Set("User-Agent", "vibe-admin-chat-test")
	internalReq.Header.Set("X-Request-ID", newID("trace_chat_test"))
	if input.Provider = strings.TrimSpace(input.Provider); input.Provider != "" {
		internalReq.Header.Set("X-Proxy-Provider", input.Provider)
	}
	if input.NoRoute {
		internalReq.Header.Set("X-Proxy-No-Route", "1")
	}
	for k, v := range input.Headers {
		k = strings.TrimSpace(k)
		if k == "" || strings.EqualFold(k, "authorization") || strings.EqualFold(k, "content-type") {
			continue
		}
		internalReq.Header.Set(k, v)
	}

	authMode := "admin_synthetic"
	policyAPIKeyID := ""
	if token := strings.TrimSpace(input.BearerToken); token != "" {
		internalReq.Header.Set("Authorization", "Bearer "+token)
		authMode = "bearer"
	} else {
		authCtx, apiKeyID, ok := s.chatTestInjectedAuthContext(w, r, input.APIKeyID)
		if !ok {
			return
		}
		policyAPIKeyID = apiKeyID
		internalReq = internalReq.WithContext(context.WithValue(internalReq.Context(), chatTestAuthContextKey{}, chatTestInjectedAuth{APIKeyID: apiKeyID, AuthCtx: authCtx}))
		if strings.TrimSpace(input.APIKeyID) != "" {
			authMode = "api_key_policy"
		}
	}

	var preview map[string]any
	if input.IncludePreview {
		plan := s.planIntelligentRouting(r.Context(), encoded, "/v1/chat/completions", strings.TrimSpace(input.Provider) != "", input.NoRoute, nil)
		preview = map[string]any{
			"requested_model":   plan.RequestedModel,
			"selected_model":    plan.SelectedModel,
			"selected_provider": plan.SelectedProvider,
			"complexity":        plan.Complexity,
			"risk":              plan.Risk,
			"health_score":      plan.HealthScore,
			"fallback_path":     plan.FallbackPath,
			"route_reason":      plan.RouteReason,
			"decision_reason":   plan.DecisionReason,
			"would_rewrite":     plan.RequestedModel != "" && plan.SelectedModel != "" && plan.RequestedModel != plan.SelectedModel,
		}
	}

	rec := httptest.NewRecorder()
	start := time.Now()
	s.handleOpenAI(rec, internalReq)
	latency := time.Since(start)
	resp := rec.Result()
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	content, finishReason := extractChatTestContent(respBody)

	headers := map[string]string{}
	for key, values := range resp.Header {
		if len(values) == 0 {
			continue
		}
		lower := strings.ToLower(key)
		if strings.HasPrefix(lower, "x-") || lower == "content-type" {
			headers[key] = strings.Join(values, ",")
		}
	}

	statusCode := resp.StatusCode
	if statusCode == 0 {
		statusCode = http.StatusOK
	}
	s.auditAdmin(r, "chat_test.run", "", auditJSON(map[string]any{
		"target_id":         input.TargetID,
		"model":             input.Model,
		"provider":          input.Provider,
		"auth_mode":         authMode,
		"policy_api_key_id": policyAPIKeyID,
		"status_code":       statusCode,
	}))
	writeJSON(w, http.StatusOK, map[string]any{
		"status_code":       statusCode,
		"ok":                statusCode >= 200 && statusCode < 300,
		"latency_ms":        latency.Milliseconds(),
		"auth_mode":         authMode,
		"policy_api_key_id": policyAPIKeyID,
		"request": map[string]any{
			"model":      input.Model,
			"provider":   input.Provider,
			"target_id":  input.TargetID,
			"max_tokens": input.MaxTokens,
			"no_route":   input.NoRoute,
		},
		"headers":       headers,
		"content":       content,
		"finish_reason": finishReason,
		"raw":           string(respBody),
		"preview":       preview,
	})
}

func (s *Server) chatTestInjectedAuthContext(w http.ResponseWriter, r *http.Request, apiKeyID string) (*store.AuthContext, string, bool) {
	apiKeyID = strings.TrimSpace(apiKeyID)
	if apiKeyID == "" {
		authCtx := &store.AuthContext{
			Role:     "super_admin",
			Scopes:   []string{"chat:completion", "models:read", "mcp:use", "routing:read", "observability:read"},
			APIKeyID: "admin_chat_test",
		}
		if claims, ok := s.currentAccessClaims(r); ok {
			authCtx.UserID = claims.Subject
			authCtx.TeamID = claims.TeamID
			authCtx.Role = firstNonEmpty(claims.Role, authCtx.Role)
		}
		return authCtx, "admin_chat_test", true
	}
	key, found, err := s.db.GetAPIKey(r.Context(), apiKeyID)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "api_key_lookup_failed")
		return nil, "", false
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "api key not found", "invalid_request_error", "api_key_not_found")
		return nil, "", false
	}
	if claims, ok := s.currentAccessClaims(r); ok && claims.Role == "team_admin" && key.Team != claims.TeamID {
		writeOpenAIError(w, http.StatusForbidden, "team_admin can only test own team api keys", "permission_error", "team_scope_denied")
		return nil, "", false
	}
	if key.Status != "active" || !key.RevokedAt.IsZero() {
		writeOpenAIError(w, http.StatusForbidden, "api key is not active", "permission_error", "api_key_inactive")
		return nil, "", false
	}
	if !key.ExpiresAt.IsZero() && key.ExpiresAt.Before(time.Now().UTC()) {
		writeOpenAIError(w, http.StatusForbidden, "api key is expired", "permission_error", "api_key_expired")
		return nil, "", false
	}
	authCtx := authContextFromAPIKey(key)
	s.enrichAuthContextTeam(r.Context(), &authCtx)
	return &authCtx, key.ID, true
}

func extractChatTestContent(body []byte) (string, string) {
	var parsed struct {
		Choices []struct {
			Message struct {
				Content any `json:"content"`
			} `json:"message"`
			Text         string `json:"text"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil || len(parsed.Choices) == 0 {
		return "", ""
	}
	content := parsed.Choices[0].Text
	if content == "" {
		content = toString(parsed.Choices[0].Message.Content)
	}
	if content == "" && parsed.Choices[0].Message.Content != nil {
		if encoded, err := json.Marshal(parsed.Choices[0].Message.Content); err == nil {
			content = string(encoded)
		}
	}
	return content, parsed.Choices[0].FinishReason
}

func splitChatTestPatterns(raw string) []string {
	parts := strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == '\n' || r == '\t' })
	out := []string{}
	seen := map[string]bool{}
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" || seen[part] {
			continue
		}
		seen[part] = true
		out = append(out, part)
	}
	sort.Strings(out)
	return out
}

func chatTestModelFromPattern(pattern string) string {
	if strings.ContainsAny(pattern, "*?[]") {
		return strings.NewReplacer("*", "", "?", "", "[", "", "]", "").Replace(pattern)
	}
	return pattern
}

func providerMetadata(provider store.ProviderPublic) map[string]any {
	return map[string]any{
		"base_url":           provider.BaseURL,
		"api_key_configured": provider.APIKeyConfigured,
		"timeout_ms":         provider.TimeoutMS,
		"created_at":         provider.CreatedAt,
	}
}
