package proxy

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"sync"
	"sync/atomic"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/config"
	"vibe-coders/internal/secret"
	"vibe-coders/internal/store"
)

type Server struct {
	cfg          config.Config
	db           *store.SQLStore
	logger       *store.AsyncLogger
	client       *http.Client
	metrics      *Metrics
	secrets      *secret.Cipher
	retention    *store.RetentionWorker
	killState    atomicKillState
	mcpPolicy    atomic.Pointer[mcpPolicySnapshot]
	routingRules atomic.Pointer[routingRulesSnapshot]
	sessions     *sessionInferer
	extSeen      sync.Map // external key id -> struct{}; dedupes lazy registration
}

type atomicKillState struct {
	value atomic.Pointer[killSnapshot]
}

type killSnapshot struct {
	disabled  bool
	reason    string
	updatedBy string
	updatedAt time.Time
	fetchedAt time.Time
}

func NewServer(cfg config.Config, db *store.SQLStore, logger *store.AsyncLogger, retention *store.RetentionWorker) (*Server, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableCompression = false
	secrets, err := secret.New(cfg.Secret.GatewaySecret)
	if err != nil {
		return nil, fmt.Errorf("create secret cipher: %w", err)
	}
	server := &Server{
		cfg:    cfg,
		db:     db,
		logger: logger,
		client: &http.Client{
			Timeout:   cfg.Upstream.Timeout,
			Transport: transport,
		},
		metrics:   newMetrics(),
		secrets:   secrets,
		retention: retention,
		sessions:  newSessionInferer(cfg.Session.IdleTimeout),
	}

	if cfg.Upstream.APIKey != "" {
		encrypted, err := secrets.Encrypt(cfg.Upstream.APIKey)
		if err != nil {
			return nil, fmt.Errorf("encrypt default provider key: %w", err)
		}
		if err := db.UpsertProvider(context.Background(), store.ProviderConfig{
			Name:            cfg.Upstream.Provider,
			BaseURL:         cfg.Upstream.BaseURL,
			EncryptedAPIKey: encrypted,
			TimeoutMS:       int(cfg.Upstream.Timeout / time.Millisecond),
			Enabled:         true,
		}); err != nil {
			return nil, fmt.Errorf("upsert default provider: %w", err)
		}
	}

	for _, key := range cfg.Auth.ProxyAPIKeys {
		err := db.UpsertAPIKey(context.Background(), store.APIKeyRecord{
			ID:      key.ID,
			Name:    key.Name,
			KeyHash: key.KeyHash,
			Owner:   key.Owner,
			Team:    key.Team,
			Status:  "active",
		})
		if err != nil {
			return nil, fmt.Errorf("upsert proxy api key %s: %w", key.Name, err)
		}
	}

	return server, nil
}

func (s *Server) MetricsHandle() *Metrics { return s.metrics }

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/favicon.ico", s.handleFavicon)
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/ready", s.handleReady)
	mux.HandleFunc("/metrics", s.handleMetrics)
	mux.HandleFunc("/admin", s.handleAdminUI)
	mux.HandleFunc("/admin/", s.handleAdminUI)
	mux.HandleFunc("/admin/stats", s.handleStats)
	mux.HandleFunc("/admin/requests", s.handleRequests)
	mux.HandleFunc("/admin/api-keys", s.handleAPIKeys)
	mux.HandleFunc("/admin/api-keys/", s.handleAPIKeyByID)
	mux.HandleFunc("/admin/providers", s.handleProviders)
	mux.HandleFunc("/admin/providers/", s.handleProviderByName)
	mux.HandleFunc("/admin/audit-logs", s.handleAuditLogs)
	mux.HandleFunc("/admin/users", s.handleUsers)
	mux.HandleFunc("/admin/users/", s.handleUserDetail)
	mux.HandleFunc("/admin/teams", s.handleTeams)
	mux.HandleFunc("/admin/teams/", s.handleTeamDetail)
	mux.HandleFunc("/admin/ips", s.handleIPs)
	mux.HandleFunc("/admin/ips/", s.handleIPDetail)
	mux.HandleFunc("/admin/requests/", s.handleRequestDetail)
	mux.HandleFunc("/admin/prompts", s.handlePromptSearch)
	mux.HandleFunc("/admin/quotas", s.handleQuotas)
	mux.HandleFunc("/admin/quotas/", s.handleQuotaByID)
	mux.HandleFunc("/admin/retention", s.handleRetention)
	mux.HandleFunc("/admin/export.csv", s.handleExportCSV)
	mux.HandleFunc("/admin/timeseries", s.handleTimeseries)
	mux.HandleFunc("/admin/heatmap", s.handleHeatmap)
	mux.HandleFunc("/admin/anomalies", s.handleAnomalies)
	mux.HandleFunc("/admin/scatter", s.handleScatter)
	mux.HandleFunc("/admin/routing-rules", s.handleRoutingRules)
	mux.HandleFunc("/admin/routing-rules/", s.handleRoutingRuleByID)
	mux.HandleFunc("/admin/budgets", s.handleBudgets)
	mux.HandleFunc("/admin/budgets/", s.handleBudgetByID)
	mux.HandleFunc("/admin/waterfall", s.handleWaterfall)
	mux.HandleFunc("/admin/routing/learning", s.handleRoutingLearning)
	mux.HandleFunc("/admin/agents", s.handleAgents)
	mux.HandleFunc("/admin/prompts/fingerprints", s.handlePromptFingerprints)
	mux.HandleFunc("/admin/llm/traces", s.handleLLMTraces)
	mux.HandleFunc("/admin/llm/traces/", s.handleLLMTraceDetail)
	mux.HandleFunc("/admin/llm/sessions", s.handleLLMSessions)
	mux.HandleFunc("/admin/llm/session", s.handleLLMSessionTimeline)
	mux.HandleFunc("/admin/llm/prompts", s.handleLLMPrompts)
	mux.HandleFunc("/admin/llm/prompts/compare", s.handleLLMPromptCompare)
	mux.HandleFunc("/admin/llm/patterns", s.handleLLMPatterns)
	mux.HandleFunc("/admin/llm/insights", s.handleLLMInsights)
	mux.HandleFunc("/admin/llm/timeseries", s.handleLLMTimeseries)
	mux.HandleFunc("/admin/llm/feedback", s.handleLLMFeedback)
	mux.HandleFunc("/admin/llm/evaluations", s.handleLLMEvaluations)
	mux.HandleFunc("/admin/mcp/tools", s.handleMCPTools)
	mux.HandleFunc("/admin/mcp/servers", s.handleMCPServers)
	mux.HandleFunc("/admin/mcp/requests", s.handleMCPRequests)
	mux.HandleFunc("/admin/mcp/policies", s.handleMCPPolicies)
	mux.HandleFunc("/admin/mcp/policies/", s.handleMCPPolicyByServer)
	mux.HandleFunc("/admin/mcp/loops", s.handleMCPLoops)
	mux.HandleFunc("/admin/mcp/catalog", s.handleMCPCatalog)
	mux.HandleFunc("/admin/kill-switch", s.handleKillSwitch)
	mux.HandleFunc("/admin/alerts", s.handleAlertRules)
	mux.HandleFunc("/admin/alerts/", s.handleAlertRuleByID)
	mux.HandleFunc("/admin/saved-filters", s.handleSavedFilters)
	mux.HandleFunc("/admin/saved-filters/", s.handleSavedFilterByID)
	mux.HandleFunc("/admin/audit-logs.csv", s.handleAuditExportCSV)
	mux.HandleFunc("/admin/fallback", s.handleFallback)
	mux.HandleFunc("/admin/requests/diff", s.handleRequestDiff)
	mux.HandleFunc("/admin/suggest", s.handleSuggest)
	mux.HandleFunc("/v1/chat/completions", s.handleOpenAI)
	mux.HandleFunc("/v1/models", s.handleOpenAI)
	mux.HandleFunc("/v1/embeddings", s.handleOpenAI)
	return withTrace(mux)
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleFavicon(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "image/svg+xml")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write([]byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0f766e"/><path d="M8 10h16v3H8zm0 5h11v3H8zm0 5h16v3H8z" fill="#fff"/></svg>`))
}

func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	if err := s.db.Ping(r.Context()); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready", "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func (s *Server) handleMetrics(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	_, _ = w.Write([]byte(s.metrics.Prometheus(s.logger.QueueDepth(), s.logger.Dropped(), s.logger.Written())))
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	stats, err := s.db.Summary(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "stats_failed")
		return
	}
	cacheStats, err := s.db.EmbeddingCacheStats(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "stats_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"total_requests":        stats.TotalRequests,
		"total_tokens":          stats.TotalTokens,
		"total_cost_krw":        stats.TotalCostKRW,
		"average_latency_ms":    stats.AverageLatencyMS,
		"by_ip":                 stats.ByIP,
		"by_model":              stats.ByModel,
		"by_language":           stats.ByLanguage,
		"by_status":             stats.ByStatus,
		"top_users":             stats.TopUsers,
		"latency_quantiles":     s.metrics.LatencyQuantiles(),
		"first_chunk_quantiles": s.metrics.FirstChunkQuantiles(),
		"cache":                 cacheStats,
		"failover_total":        s.metrics.failovers.Load(),
		"cache_hits":            s.metrics.cacheHits.Load(),
		"cache_misses":          s.metrics.cacheMisses.Load(),
	})
}

func (s *Server) handleRequests(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	limit := 50
	if value := strings.TrimSpace(r.URL.Query().Get("limit")); value != "" {
		if parsed, err := strconv.Atoi(value); err == nil {
			limit = parsed
		}
	}
	requests, err := s.db.RecentRequests(r.Context(), store.RequestFilter{
		Limit:    limit,
		IP:       strings.TrimSpace(r.URL.Query().Get("ip")),
		Model:    strings.TrimSpace(r.URL.Query().Get("model")),
		Language: strings.TrimSpace(r.URL.Query().Get("language")),
	})
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "requests_failed")
		return
	}
	if requests == nil {
		requests = []store.RecentRequest{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"requests": requests})
}

func (s *Server) handleAPIKeys(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		keys, err := s.db.ListAPIKeys(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "api_keys_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"api_keys": keys})
	case http.MethodPost:
		var payload struct {
			Name  string `json:"name"`
			Key   string `json:"key"`
			Owner string `json:"owner"`
			Team  string `json:"team"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		payload.Name = strings.TrimSpace(payload.Name)
		payload.Key = strings.TrimSpace(payload.Key)
		if payload.Name == "" {
			writeOpenAIError(w, http.StatusBadRequest, "name is required", "invalid_request_error", "missing_name")
			return
		}
		plainKey := payload.Key
		generated := false
		if plainKey == "" {
			var err error
			plainKey, err = generateProxyKey()
			if err != nil {
				writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "key_generation_failed")
				return
			}
			generated = true
		}
		record := store.APIKeyRecord{
			ID:      "key_" + hashProxyKey(plainKey)[:16],
			Name:    payload.Name,
			KeyHash: hashProxyKey(plainKey),
			Owner:   strings.TrimSpace(payload.Owner),
			Team:    strings.TrimSpace(payload.Team),
			Status:  "active",
		}
		if err := s.db.UpsertAPIKey(r.Context(), record); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "api_key_create_failed")
			return
		}
		s.auditAdmin(r, "api_key.upsert", "", auditJSON(map[string]any{"id": record.ID, "name": record.Name, "owner": record.Owner, "team": record.Team, "generated": generated}))
		writeJSON(w, http.StatusCreated, map[string]any{
			"api_key": map[string]any{
				"id":     record.ID,
				"name":   record.Name,
				"owner":  record.Owner,
				"team":   record.Team,
				"status": record.Status,
			},
			"secret": plainKey,
		})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) handleAPIKeyByID(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/admin/api-keys/")
	if id == "" || strings.Contains(id, "/") {
		writeOpenAIError(w, http.StatusBadRequest, "invalid API key id", "invalid_request_error", "invalid_api_key_id")
		return
	}
	switch r.Method {
	case http.MethodDelete:
		if err := s.db.SetAPIKeyStatus(r.Context(), id, "disabled"); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "api_key_update_failed")
			return
		}
		s.auditAdmin(r, "api_key.status", "", auditJSON(map[string]any{"id": id, "status": "disabled"}))
		writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "disabled"})
	case http.MethodPatch:
		// Partial update: status and/or label (name/owner/team). This is also how an
		// observed external key (ext_…, whose hash the gateway already stored) is
		// promoted to a named, active managed user — no plaintext needed.
		var payload struct {
			Status *string `json:"status"`
			Name   *string `json:"name"`
			Owner  *string `json:"owner"`
			Team   *string `json:"team"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		existing, found, err := s.db.GetAPIKey(r.Context(), id)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "api_key_lookup_failed")
			return
		}
		if !found {
			writeOpenAIError(w, http.StatusNotFound, "api key not found", "invalid_request_error", "api_key_not_found")
			return
		}
		updated := existing
		if payload.Status != nil {
			st := strings.TrimSpace(*payload.Status)
			if st != "active" && st != "disabled" {
				writeOpenAIError(w, http.StatusBadRequest, "status must be active or disabled", "invalid_request_error", "invalid_status")
				return
			}
			updated.Status = st
		}
		if payload.Name != nil {
			updated.Name = strings.TrimSpace(*payload.Name)
		}
		if payload.Owner != nil {
			updated.Owner = strings.TrimSpace(*payload.Owner)
		}
		if payload.Team != nil {
			updated.Team = strings.TrimSpace(*payload.Team)
		}
		if err := s.db.UpsertAPIKey(r.Context(), updated); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "api_key_update_failed")
			return
		}
		s.auditAdmin(r, "api_key.update", auditJSON(existing), auditJSON(updated))
		writeJSON(w, http.StatusOK, map[string]any{"id": updated.ID, "name": updated.Name, "owner": updated.Owner, "team": updated.Team, "status": updated.Status})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) handleProviders(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		providers, err := s.db.ListProviders(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "providers_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"providers": providers})
	case http.MethodPost:
		var payload struct {
			Name          string `json:"name"`
			BaseURL       string `json:"base_url"`
			APIKey        string `json:"api_key"`
			TimeoutMS     int    `json:"timeout_ms"`
			Enabled       *bool  `json:"enabled"`
			ModelPatterns string `json:"model_patterns"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		payload.Name = strings.TrimSpace(payload.Name)
		payload.BaseURL = strings.TrimRight(strings.TrimSpace(payload.BaseURL), "/")
		if payload.Name == "" || payload.BaseURL == "" {
			writeOpenAIError(w, http.StatusBadRequest, "name and base_url are required", "invalid_request_error", "missing_provider_fields")
			return
		}
		if _, err := url.ParseRequestURI(payload.BaseURL); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "base_url must be an absolute URL", "invalid_request_error", "invalid_base_url")
			return
		}
		if payload.TimeoutMS <= 0 {
			payload.TimeoutMS = int(s.cfg.Upstream.Timeout / time.Millisecond)
		}
		enabled := true
		if payload.Enabled != nil {
			enabled = *payload.Enabled
		}

		before, _, _ := s.db.GetProvider(r.Context(), payload.Name)
		encryptedKey := before.EncryptedAPIKey
		if strings.TrimSpace(payload.APIKey) != "" {
			var err error
			encryptedKey, err = s.secrets.Encrypt(strings.TrimSpace(payload.APIKey))
			if err != nil {
				writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "provider_encrypt_failed")
				return
			}
		}
		provider := store.ProviderConfig{
			Name:            payload.Name,
			BaseURL:         payload.BaseURL,
			EncryptedAPIKey: encryptedKey,
			TimeoutMS:       payload.TimeoutMS,
			Enabled:         enabled,
			ModelPatterns:   strings.TrimSpace(payload.ModelPatterns),
		}
		if err := s.db.UpsertProvider(r.Context(), provider); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "provider_save_failed")
			return
		}
		s.auditAdmin(r, "provider.upsert", providerAuditJSON(before), providerAuditJSON(provider))
		writeJSON(w, http.StatusOK, map[string]any{
			"provider": map[string]any{
				"name":               provider.Name,
				"base_url":           provider.BaseURL,
				"api_key_configured": provider.EncryptedAPIKey != "",
				"timeout_ms":         provider.TimeoutMS,
				"enabled":            provider.Enabled,
				"model_patterns":     provider.ModelPatterns,
			},
		})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) handleProviderByName(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/admin/providers/")
	if name == "" || strings.Contains(name, "/") {
		writeOpenAIError(w, http.StatusBadRequest, "invalid provider name", "invalid_request_error", "invalid_provider_name")
		return
	}
	switch r.Method {
	case http.MethodDelete:
		before, found, _ := s.db.GetProvider(r.Context(), name)
		if !found {
			writeOpenAIError(w, http.StatusNotFound, "provider not found: "+name, "invalid_request_error", "provider_not_found")
			return
		}
		deleted, err := s.db.DeleteProvider(r.Context(), name)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "provider_delete_failed")
			return
		}
		if !deleted {
			writeOpenAIError(w, http.StatusNotFound, "provider not found: "+name, "invalid_request_error", "provider_not_found")
			return
		}
		s.auditAdmin(r, "provider.delete", providerAuditJSON(before), "")
		writeJSON(w, http.StatusOK, map[string]string{"deleted": name})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) handleAuditLogs(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	limit := 50
	if value := strings.TrimSpace(r.URL.Query().Get("limit")); value != "" {
		if parsed, err := strconv.Atoi(value); err == nil {
			limit = parsed
		}
	}
	logs, err := s.db.ListAdminAudit(r.Context(), limit)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "audit_logs_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"audit_logs": logs})
}

func (s *Server) handleOpenAI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && !(r.Method == http.MethodGet && r.URL.Path == "/v1/models") {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}

	if snap := s.killSnapshot(r.Context()); snap != nil && snap.disabled {
		w.Header().Set("Retry-After", "60")
		w.Header().Set("X-Kill-Switch", "global")
		if snap.reason != "" {
			w.Header().Set("X-Kill-Reason", snap.reason)
		}
		s.metrics.IncKillSwitch()
		writeOpenAIError(w, http.StatusServiceUnavailable, "gateway is disabled by admin kill switch: "+snap.reason, "server_error", "kill_switch_active")
		return
	}

	// /v1/models GET은 인증 없이 모델 목록만 반환하므로 바로 upstream으로 프록시
	isModelsGet := r.Method == http.MethodGet && r.URL.Path == "/v1/models"

	var apiKeyID string
	if isModelsGet {
		// /v1/models는 인증 불필요 — anonymous로 처리
		apiKeyID = "anonymous"
	} else {
		var ok bool
		apiKeyID, ok = s.authenticateProxy(r)
		if !ok {
			writeOpenAIError(w, http.StatusUnauthorized, "invalid proxy API key", "invalid_request_error", "invalid_api_key")
			return
		}
	}

	clientAddr := clientIP(r)
	if decision, err := s.checkQuotas(r.Context(), apiKeyID, clientAddr); err != nil {
		slog.Warn("quota check failed", "error", err)
	} else if !decision.Allowed {
		w.Header().Set("Retry-After", strconv.Itoa(quotaRetryAfterSeconds(decision.PeriodEnd)))
		w.Header().Set("X-Quota-Scope", quotaHeaderTag(decision))
		w.Header().Set("X-Quota-Tokens", strconv.FormatInt(decision.Tokens, 10))
		w.Header().Set("X-Quota-Cost-KRW", formatKRW(decision.CostKRW))
		w.Header().Set("X-Quota-Period-Start", decision.PeriodStart.Format(time.RFC3339))
		w.Header().Set("X-Quota-Period-End", decision.PeriodEnd.Format(time.RFC3339))
		s.metrics.IncQuotaBlock()
		writeOpenAIError(w, http.StatusTooManyRequests, "quota exceeded: "+decision.Reason, "quota_error", decision.Reason)
		return
	}

	var body []byte
	var err error
	if r.Body != nil {
		body, err = io.ReadAll(r.Body)
		if err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "failed to read request body", "invalid_request_error", "invalid_body")
			return
		}
	}

	traceID := traceIDFromRequest(r)

	// Complexity-based cost-optimal routing: when the client did not pin a provider,
	// rewrite the requested model to a cheaper/premium one per configured rules.
	var routeDecision routingDecision
	pinned := strings.TrimSpace(r.Header.Get("X-Proxy-Provider")) != "" || strings.TrimSpace(r.URL.Query().Get("provider")) != ""
	noRoute := strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Proxy-No-Route")), "1")
	if r.URL.Path == "/v1/chat/completions" && r.Method == http.MethodPost && !pinned && !noRoute {
		origModel, complexity := previewModelComplexity(body, r.URL.Path)
		if d := s.evaluateRoutingRules(r.Context(), origModel, complexity); d.Applied {
			body = rewriteModelField(body, d.TargetModel)
			routeDecision = d
			w.Header().Set("X-Routed-Model", d.TargetModel)
		}
	}

	meta := s.auditRequest(r.URL.Path, body, apiKeyID, traceID, r)
	if routeDecision.Applied {
		meta.Request.RequestedModel = routeDecision.OriginalModel
		s.metrics.IncRoutingOverride()
	}

	// MCP server policy (allowlist / block) — reject requests that use a disallowed
	// MCP server before they ever reach the upstream.
	if s.enforceMCPPolicy(w, r, meta, traceID) {
		return
	}

	// Embedding cache (idempotent) — only applies to /v1/embeddings + POST.
	if r.URL.Path == "/v1/embeddings" && r.Method == http.MethodPost && s.cfg.Cache.EmbeddingEnabled {
		if served := s.serveEmbeddingFromCache(r.Context(), w, r, body, meta, traceID); served {
			return
		}
	}

	// Chat response cache — opt-in, only for deterministic (temp 0 / seed) requests.
	chatCacheKey, chatCacheable := s.chatCacheEligible(r, body)
	if chatCacheable {
		if served := s.serveChatFromCache(r.Context(), w, chatCacheKey, meta, traceID); served {
			return
		}
	}

	provider, err := s.selectProviderForced(r.Context(), r, meta.Request.Model, routeDecision.TargetProvider)
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, err.Error(), "server_error", "provider_unavailable")
		return
	}
	meta.Request.Provider = provider.Name
	meta.Request.RouteReason = provider.Reason
	meta.Request.RouteDetail = provider.Detail
	if routeDecision.Applied {
		// the model choice is the salient decision; surface it as the routing reason.
		meta.Request.RouteReason = "complexity_rule"
		meta.Request.RouteDetail = routeDecision.Desc
	}

	// Identify failover candidates: only when the client did NOT explicitly pin a provider.
	failoverCandidates := []string{}
	if strings.TrimSpace(r.Header.Get("X-Proxy-Provider")) == "" && strings.TrimSpace(r.URL.Query().Get("provider")) == "" {
		if cands, _ := s.providersForModel(r.Context(), meta.Request.Model); len(cands) > 1 {
			for _, name := range cands {
				if name != provider.Name {
					failoverCandidates = append(failoverCandidates, name)
				}
			}
		}
	}

	start := time.Now()
	resp, resolvedName, failoverFrom, err := s.dialUpstream(r.Context(), r, body, provider, traceID, failoverCandidates)
	if err != nil {
		s.metrics.IncUpstreamError()
		status := statusForUpstreamError(err)
		meta.Request.StatusCode = status
		meta.Request.LatencyMS = time.Since(start).Milliseconds()
		meta.Request.Error = err.Error()
		meta.Request.FallbackReason = err.Error()
		meta.Evaluations = buildLLMEvaluations(meta, ResponseAnalysis{})
		s.metrics.ObserveLLMEvaluations(meta.Evaluations)
		s.enqueue(meta)
		writeOpenAIError(w, status, "upstream request failed: "+err.Error(), "server_error", "upstream_request_failed")
		return
	}
	defer resp.Body.Close()
	if failoverFrom != "" {
		s.metrics.IncFailover()
		w.Header().Set("X-Failover-From", failoverFrom)
		meta.Request.Failover = true
		meta.Request.FallbackFrom = failoverFrom
	}
	if resolvedName != "" {
		meta.Request.Provider = resolvedName
	}

	stream := meta.Request.Stream || strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream")
	s.metrics.IncRequest(stream)
	meta.Request.Stream = stream
	meta.Request.StatusCode = resp.StatusCode

	copyDownstreamHeaders(w.Header(), resp.Header)
	if stream {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Accel-Buffering", "no")
	}
	w.Header().Set("X-Request-ID", traceID)
	w.WriteHeader(resp.StatusCode)

	captureForCache := !stream && r.URL.Path == "/v1/embeddings" && s.cfg.Cache.EmbeddingEnabled
	captureForChatCache := !stream && chatCacheable && resp.StatusCode == http.StatusOK
	captureLimit := s.cfg.Logging.ResponseMaxBytes
	if (captureForCache || captureForChatCache) && s.cfg.Cache.EmbeddingMaxBytes > captureLimit {
		captureLimit = s.cfg.Cache.EmbeddingMaxBytes
	}
	analyzer := NewResponseAnalyzer(stream, captureForCache || captureForChatCache || s.cfg.Logging.ResponseText, captureLimit)
	firstChunkMS, firstChunkSeen, copyErr := s.copyResponse(w, resp.Body, analyzer, stream, start)
	if firstChunkSeen {
		meta.Request.FirstChunkMS = firstChunkMS
		s.metrics.ObserveFirstChunk(firstChunkMS)
	}
	if copyErr != nil && !errors.Is(copyErr, context.Canceled) {
		meta.Request.Error = copyErr.Error()
		slog.Warn("downstream copy failed", "trace_id", traceID, "error", copyErr)
	}
	meta.Request.LatencyMS = time.Since(start).Milliseconds()
	s.metrics.ObserveLatency(meta.Request.LatencyMS)

	analysis := analyzer.Finalize()
	if captureForCache && analysis.Text != "" {
		s.maybeStoreEmbeddingCache(r.Context(), body, resp.StatusCode, resp.Header.Get("Content-Type"), []byte(analysis.Text))
	}
	if captureForChatCache && analysis.Text != "" {
		s.maybeStoreChatCache(r.Context(), chatCacheKey, resp.StatusCode, resp.Header.Get("Content-Type"), []byte(analysis.Text))
	}
	if captureForCache || captureForChatCache {
		s.metrics.IncCacheMiss()
	}
	// Clear captured text so we don't accidentally persist it when LOG_RESPONSE_TEXT=false.
	if (captureForCache || captureForChatCache) && !s.cfg.Logging.ResponseText {
		analysis.Text = ""
	}
	meta.Response = &store.ResponseLog{
		ID:                   newID("resp"),
		RequestID:            meta.Request.ID,
		StatusCode:           resp.StatusCode,
		FinishReason:         analysis.FinishReason,
		ResponseHash:         analysis.Hash,
		ResponseTextOptional: analysis.Text,
		CreatedAt:            time.Now().UTC(),
	}
	if analysis.HasUsage {
		meta.Usage = &store.TokenUsage{
			ID:               newID("usage"),
			RequestID:        meta.Request.ID,
			PromptTokens:     analysis.Usage.PromptTokens,
			CompletionTokens: analysis.Usage.CompletionTokens,
			TotalTokens:      analysis.Usage.TotalTokens,
			CachedTokens:     analysis.Usage.CachedTokens,
			ReasoningTokens:  analysis.Usage.ReasoningTokens,
			EstimatedCost:    audit.EstimateCostKRW(meta.Request.Model, analysis.Usage, s.cfg.Pricing),
			Currency:         "KRW",
			Source:           analysis.Usage.Source,
			CreatedAt:        time.Now().UTC(),
		}
	} else if promptEstimate, completionEstimate := promptTokenEstimate(meta.Prompts), analysis.CompletionTokensEstimate; promptEstimate > 0 || completionEstimate > 0 {
		estimated := audit.Usage{
			PromptTokens:     promptEstimate,
			CompletionTokens: completionEstimate,
			TotalTokens:      promptEstimate + completionEstimate,
			Source:           "estimated",
		}
		meta.Usage = &store.TokenUsage{
			ID:               newID("usage"),
			RequestID:        meta.Request.ID,
			PromptTokens:     estimated.PromptTokens,
			CompletionTokens: estimated.CompletionTokens,
			TotalTokens:      estimated.TotalTokens,
			EstimatedCost:    audit.EstimateCostKRW(meta.Request.Model, estimated, s.cfg.Pricing),
			Currency:         "KRW",
			Source:           estimated.Source,
			CreatedAt:        time.Now().UTC(),
		}
	}
	if len(analysis.ToolCalls) > 0 {
		meta.Tools = append(meta.Tools, toolInvocations(meta.Request, analysis.ToolCalls)...)
	}
	s.metrics.ObserveToolInvocations(meta.Tools)
	meta.Evaluations = buildLLMEvaluations(meta, analysis)
	s.metrics.ObserveLLMEvaluations(meta.Evaluations)
	s.enqueue(meta)
}

func (s *Server) copyResponse(w http.ResponseWriter, body io.Reader, analyzer *ResponseAnalyzer, flush bool, start time.Time) (int64, bool, error) {
	flusher, _ := w.(http.Flusher)
	buffer := make([]byte, 32*1024)
	var firstChunkMS int64
	firstChunkSeen := false
	for {
		n, readErr := body.Read(buffer)
		if n > 0 {
			if !firstChunkSeen {
				firstChunkMS = time.Since(start).Milliseconds()
				firstChunkSeen = true
			}
			chunk := buffer[:n]
			analyzer.Write(chunk)
			if _, err := w.Write(chunk); err != nil {
				return firstChunkMS, firstChunkSeen, err
			}
			if flush && flusher != nil {
				flusher.Flush()
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				return firstChunkMS, firstChunkSeen, nil
			}
			return firstChunkMS, firstChunkSeen, readErr
		}
	}
}

func (s *Server) enqueue(record store.LogRecord) {
	s.logger.Enqueue(record)
}

func (s *Server) upstreamURL(baseURL string, incoming *url.URL) (string, error) {
	base, err := url.Parse(baseURL)
	if err != nil {
		return "", err
	}
	base.Path = strings.TrimRight(base.Path, "/") + incoming.Path
	base.RawQuery = incoming.RawQuery
	return base.String(), nil
}

func (s *Server) authenticateProxy(r *http.Request) (string, bool) {
	token := bearerToken(r.Header.Get("Authorization"))
	if token == "" {
		hasKeys, err := s.db.HasActiveAPIKeys(r.Context())
		if err != nil {
			slog.Warn("check active proxy keys failed", "error", err)
			return "", false
		}
		if !hasKeys {
			return "anonymous", true
		}
		return "", false
	}
	keyHash := hashProxyKey(token)
	key, found, err := s.db.FindActiveAPIKeyByHash(r.Context(), keyHash)
	if err != nil {
		slog.Warn("lookup proxy api key failed", "error", err)
		return "", false
	}
	if found {
		return key.ID, true
	}
	// 토큰이 proxy key(pcg_ 접두사)가 아니면 upstream API key passthrough 로 허용
	// 이를 통해 Roo Code / Cursor 등이 upstream key 를 직접 보내도 프록시가 작동함
	if !strings.HasPrefix(token, "pcg_") {
		return s.attributeExternalKey(r, keyHash), true
	}
	hasKeys, err := s.db.HasActiveAPIKeys(r.Context())
	if err != nil {
		slog.Warn("check active proxy keys failed", "error", err)
		return "", false
	}
	if !hasKeys {
		return "anonymous", true
	}
	return "", false
}

// attributeExternalKey maps an unregistered (non-proxy) bearer key to a stable
// per-key identity so distinct client keys appear as distinct users in history,
// instead of collapsing into one shared "passthrough" bucket. The id is derived
// from the key hash (the gateway never stores the plaintext). On first sight it
// lazily registers a labeled api_keys row (status "external") so the user shows up
// with a name/team; an optional X-Vibe-User / X-Vibe-Team header sets those.
func (s *Server) attributeExternalKey(r *http.Request, keyHash string) string {
	if !s.cfg.Auth.AttributeExternalKeys {
		return "passthrough"
	}
	id := "ext_" + keyHash[:16]
	if _, seen := s.extSeen.Load(id); !seen {
		name := firstNonEmptyHeader(r, "X-Vibe-User", "X-User-Id", "X-Title")
		if name == "" {
			name = "external-" + keyHash[:8]
		}
		rec := store.APIKeyRecord{
			ID:      id,
			Name:    name,
			KeyHash: keyHash,
			Team:    firstNonEmptyHeader(r, "X-Vibe-Team", "X-Team"),
			Status:  "external",
		}
		if err := s.db.EnsureExternalAPIKey(r.Context(), rec); err != nil {
			slog.Warn("register external api key failed", "error", err)
		} else {
			s.extSeen.Store(id, struct{}{})
		}
	}
	return id
}

type resolvedProvider struct {
	Name    string
	BaseURL string
	APIKey  string
	Timeout time.Duration
	Reason  string // header | query | model_pattern | default
	Detail  string // e.g. matched glob pattern, or header name
}

// dialUpstream sends the request to `primary`. On transport-level failure (timeout,
// connection refused, EOF before any response) it falls back to the next candidate
// in `failoverCandidates`, in order. Returns the live response, the name of the
// provider that actually answered, and (if a failover occurred) the original primary's
// name in `failoverFrom`.
func (s *Server) dialUpstream(reqCtx context.Context, r *http.Request, body []byte, primary resolvedProvider, traceID string, failoverCandidates []string) (*http.Response, string, string, error) {
	type attempt struct {
		provider resolvedProvider
	}
	attempts := []attempt{{provider: primary}}
	for _, name := range failoverCandidates {
		// Re-resolve each candidate so we get its decrypted key and timeout.
		fakeReq := r.Clone(reqCtx)
		fakeReq.Header.Set("X-Proxy-Provider", name)
		cand, err := s.selectProvider(reqCtx, fakeReq, "")
		if err != nil {
			slog.Warn("failover candidate unavailable", "name", name, "error", err)
			continue
		}
		attempts = append(attempts, attempt{provider: cand})
	}

	var lastErr error
	for i, att := range attempts {
		upstreamURL, err := s.upstreamURL(att.provider.BaseURL, r.URL)
		if err != nil {
			return nil, "", "", err
		}
		ctx := reqCtx
		var cancel context.CancelFunc
		if att.provider.Timeout > 0 {
			ctx, cancel = context.WithTimeout(reqCtx, att.provider.Timeout)
		}
		upstreamReq, err := http.NewRequestWithContext(ctx, r.Method, upstreamURL, bytes.NewReader(body))
		if err != nil {
			if cancel != nil {
				cancel()
			}
			return nil, "", "", err
		}
		copyUpstreamHeaders(upstreamReq.Header, r.Header)
		upstreamReq.Header.Set("Authorization", "Bearer "+att.provider.APIKey)
		upstreamReq.Header.Set("X-Request-ID", traceID)
		if r.Method == http.MethodPost && upstreamReq.Header.Get("Content-Type") == "" {
			upstreamReq.Header.Set("Content-Type", "application/json")
		}

		resp, doErr := s.client.Do(upstreamReq)
		if doErr == nil {
			// Note: ctx must outlive resp.Body reads, so we do NOT call cancel() here.
			_ = cancel
			from := ""
			if i > 0 {
				from = primary.Name
			}
			return resp, att.provider.Name, from, nil
		}
		if cancel != nil {
			cancel()
		}
		lastErr = doErr
		slog.Warn("upstream call failed", "provider", att.provider.Name, "attempt", i, "error", doErr)
	}
	if lastErr == nil {
		lastErr = errors.New("no provider attempts made")
	}
	return nil, "", "", lastErr
}

// selectProviderForced resolves a provider, optionally pinned to forceProvider
// (set by a complexity routing rule's target_provider). When forceProvider is empty
// it behaves exactly like selectProvider.
func (s *Server) selectProviderForced(ctx context.Context, r *http.Request, model, forceProvider string) (resolvedProvider, error) {
	if strings.TrimSpace(forceProvider) != "" {
		clone := r.Clone(ctx)
		clone.Header.Set("X-Proxy-Provider", forceProvider)
		rp, err := s.selectProvider(ctx, clone, model)
		if err == nil {
			rp.Reason, rp.Detail = "rule_provider", forceProvider
		}
		return rp, err
	}
	return s.selectProvider(ctx, r, model)
}

func (s *Server) selectProvider(ctx context.Context, r *http.Request, model string) (resolvedProvider, error) {
	reason, detail := "default", ""
	name := strings.TrimSpace(r.Header.Get("X-Proxy-Provider"))
	if name != "" {
		reason, detail = "header", "X-Proxy-Provider"
	}
	if name == "" {
		if q := strings.TrimSpace(r.URL.Query().Get("provider")); q != "" {
			name, reason, detail = q, "query", "?provider="
		}
	}

	// If the client did not pin a provider, try to auto-route by model glob.
	if name == "" && model != "" {
		if matched, pattern, ok, err := s.matchProviderByModelDetail(ctx, model); err == nil && ok {
			name, reason, detail = matched, "model_pattern", pattern
		}
	}
	if name == "" {
		name = s.cfg.Upstream.Provider
		reason, detail = "default", "UPSTREAM_PROVIDER"
	}

	provider, found, err := s.db.GetProvider(ctx, name)
	if err != nil {
		return resolvedProvider{}, err
	}
	if !found {
		return resolvedProvider{}, fmt.Errorf("provider %q is not configured", name)
	}
	if !provider.Enabled {
		return resolvedProvider{}, fmt.Errorf("provider %q is disabled", name)
	}
	apiKey, err := s.secrets.Decrypt(provider.EncryptedAPIKey)
	if err != nil {
		return resolvedProvider{}, fmt.Errorf("provider %q API key cannot be decrypted", name)
	}
	if apiKey == "" {
		return resolvedProvider{}, fmt.Errorf("provider %q API key is not configured", name)
	}
	timeout := time.Duration(provider.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = s.cfg.Upstream.Timeout
	}
	return resolvedProvider{Name: provider.Name, BaseURL: provider.BaseURL, APIKey: apiKey, Timeout: timeout, Reason: reason, Detail: detail}, nil
}

// matchProviderByModelDetail is matchProviderByModel but also returns the matched glob.
func (s *Server) matchProviderByModelDetail(ctx context.Context, model string) (string, string, bool, error) {
	providers, err := s.db.ListProviderConfigs(ctx)
	if err != nil || len(providers) == 0 {
		return "", "", false, err
	}
	normalized := strings.ToLower(strings.TrimSpace(model))
	for _, p := range providers {
		if p.ModelPatterns == "" {
			continue
		}
		for _, raw := range strings.Split(p.ModelPatterns, ",") {
			pattern := strings.ToLower(strings.TrimSpace(raw))
			if pattern == "" {
				continue
			}
			if matchGlob(pattern, normalized) {
				return p.Name, pattern, true, nil
			}
		}
	}
	return "", "", false, nil
}

func (s *Server) matchProviderByModel(ctx context.Context, model string) (string, bool, error) {
	matches, err := s.providersForModel(ctx, model)
	if err != nil || len(matches) == 0 {
		return "", false, err
	}
	return matches[0], true, nil
}

// providersForModel returns all enabled providers whose model_patterns match the
// given model, in DB-listed order. The first element is the primary choice; the
// rest are valid failover targets.
func (s *Server) providersForModel(ctx context.Context, model string) ([]string, error) {
	if model == "" {
		return nil, nil
	}
	providers, err := s.db.ListProviderConfigs(ctx)
	if err != nil {
		return nil, err
	}
	normalized := strings.ToLower(strings.TrimSpace(model))
	matches := []string{}
	for _, p := range providers {
		if p.ModelPatterns == "" {
			continue
		}
		for _, raw := range strings.Split(p.ModelPatterns, ",") {
			pattern := strings.ToLower(strings.TrimSpace(raw))
			if pattern == "" {
				continue
			}
			if matchGlob(pattern, normalized) {
				matches = append(matches, p.Name)
				break
			}
		}
	}
	return matches, nil
}

// matchGlob implements a tiny case-insensitive glob with `*` as the wildcard.
// It supports patterns like "claude-*", "anthropic/*", "*-mini", "*o3*".
func matchGlob(pattern, value string) bool {
	if pattern == "*" {
		return true
	}
	if !strings.Contains(pattern, "*") {
		return pattern == value
	}
	parts := strings.Split(pattern, "*")
	pos := 0
	for i, part := range parts {
		if part == "" {
			continue
		}
		idx := strings.Index(value[pos:], part)
		if idx < 0 {
			return false
		}
		if i == 0 && idx != 0 {
			return false
		}
		pos += idx + len(part)
	}
	if !strings.HasSuffix(pattern, "*") && pos != len(value) {
		return false
	}
	return true
}

func hashProxyKey(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func generateProxyKey() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return "pcg_" + base64.RawURLEncoding.EncodeToString(raw), nil
}

func (s *Server) auditAdmin(r *http.Request, action string, before string, after string) {
	if err := s.db.InsertAdminAudit(r.Context(), store.AdminAuditLog{
		ID:          newID("audit"),
		AdminID:     adminID(r),
		Action:      action,
		BeforeValue: before,
		AfterValue:  after,
	}); err != nil {
		slog.Warn("write admin audit failed", "action", action, "error", err)
	}
}

func adminID(r *http.Request) string {
	token := bearerToken(r.Header.Get("Authorization"))
	if token == "" {
		return "anonymous"
	}
	return "admin_" + hashProxyKey(token)[:12]
}

func auditJSON(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(encoded)
}

func providerAuditJSON(provider store.ProviderConfig) string {
	if provider.Name == "" {
		return ""
	}
	return auditJSON(map[string]any{
		"name":               provider.Name,
		"base_url":           provider.BaseURL,
		"api_key_configured": provider.EncryptedAPIKey != "",
		"timeout_ms":         provider.TimeoutMS,
		"enabled":            provider.Enabled,
		"model_patterns":     provider.ModelPatterns,
	})
}

func (s *Server) authorizeAdmin(r *http.Request) bool {
	if s.cfg.Auth.AdminToken == "" && s.cfg.Auth.AdminReadonlyToken == "" {
		return true
	}
	token := bearerToken(r.Header.Get("Authorization"))
	if token == "" {
		slog.Warn("admin auth failed: missing or invalid bearer token header")
		return false
	}
	if s.cfg.Auth.AdminToken != "" && token == s.cfg.Auth.AdminToken {
		return true
	}
	if s.cfg.Auth.AdminReadonlyToken != "" && token == s.cfg.Auth.AdminReadonlyToken {
		// readonly: only allow safe methods on /admin
		return r.Method == http.MethodGet || r.Method == http.MethodHead
	}
	slog.Warn("admin auth failed: token mismatch", "received_token", token, "expected_token", s.cfg.Auth.AdminToken)
	return false
}

const killSnapshotTTL = 5 * time.Second

func (s *Server) killSnapshot(ctx context.Context) *killSnapshot {
	if cached := s.killState.value.Load(); cached != nil && time.Since(cached.fetchedAt) < killSnapshotTTL {
		return cached
	}
	flag, found, err := s.db.GetFlag(ctx, "gateway_disabled")
	snap := &killSnapshot{fetchedAt: time.Now()}
	if err == nil && found {
		snap.disabled = strings.EqualFold(strings.TrimSpace(flag.Value), "true") || flag.Value == "1"
		snap.reason = flag.Note
		snap.updatedAt = flag.UpdatedAt
		snap.updatedBy = flag.UpdatedBy
	}
	s.killState.value.Store(snap)
	return snap
}

// invalidateKillCache forces the next killSnapshot call to refetch.
func (s *Server) invalidateKillCache() {
	s.killState.value.Store(nil)
}

func (s *Server) handleAdminUI(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/admin" && r.URL.Path != "/admin/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(adminHTML))
}

func (s *Server) auditRequest(endpoint string, body []byte, apiKeyID string, traceID string, r *http.Request) store.LogRecord {
	requestID := newID("req")
	model, stream, prompts, languages := extractAudit(body, endpoint, s.cfg.Logging.RawPrompts)
	now := time.Now().UTC()

	for i := range prompts {
		prompts[i].ID = newID("prompt")
		prompts[i].RequestID = requestID
		prompts[i].CreatedAt = now
	}

	languageStats := make([]store.LanguageStat, 0, len(languages))
	for _, language := range languages {
		languageStats = append(languageStats, store.LanguageStat{
			ID:         newID("lang"),
			RequestID:  requestID,
			Language:   language.Language,
			Confidence: language.Confidence,
			Evidence:   language.Evidence,
			CreatedAt:  now,
		})
	}

	rawBody := ""
	if s.cfg.Logging.RawBodies {
		rawBody = string(body)
	}
	llmMeta := llmRequestMetadata(r, body, traceID)
	if llmMeta.SessionID == "" {
		// No explicit session id from the client (the Claude Code / Cursor / Roo /
		// Qwen case). Infer one from client identity + a sliding inactivity window,
		// or fall back to per-request grouping if inference is disabled.
		if s.cfg.Session.InferenceEnabled && s.sessions != nil {
			llmMeta.SessionID = s.inferSessionID(r, apiKeyID, now)
		} else {
			llmMeta.SessionID = "trace:" + traceID
		}
	}
	record := store.LogRecord{
		Request: store.RequestLog{
			ID:                  requestID,
			TraceID:             traceID,
			APIKeyID:            apiKeyID,
			ClientIP:            clientIP(r),
			ForwardedFor:        r.Header.Get("X-Forwarded-For"),
			UserAgent:           r.UserAgent(),
			Hostname:            hostname(),
			Model:               model,
			Endpoint:            endpoint,
			Stream:              stream,
			Provider:            s.cfg.Upstream.Provider,
			SessionID:           llmMeta.SessionID,
			PromptName:          llmMeta.PromptName,
			PromptVersion:       llmMeta.PromptVersion,
			PromptVariablesHash: llmMeta.PromptVariablesHash,
			ToolCount:           llmMeta.ToolCount,
			Complexity:          complexityScore(prompts, llmMeta.ToolCount),
			TaskType:            classifyTaskType(prompts),
			PromptFingerprint:   promptFingerprint(prompts),
			RequestHash:         audit.HashText(string(body)),
			BodyRaw:             rawBody,
			ReplayOf:            r.Header.Get("X-Proxy-Replay-Of"),
			CreatedAt:           now,
		},
		Prompts:   prompts,
		Languages: languageStats,
	}
	record.Tools = toolInvocations(record.Request, extractRequestTools(body))
	return record
}

// inferSessionID builds a stable client identity and asks the session inferer for
// a sliding-window session id. Identity = api key (or "anon") + client IP +
// user-agent + optional repo/branch project hints, so different tools, machines,
// or working branches map to different sessions while a single client's burst of
// requests groups together.
func (s *Server) inferSessionID(r *http.Request, apiKeyID string, now time.Time) string {
	keyPart := apiKeyID
	if keyPart == "" {
		keyPart = "anon"
	}
	identity := strings.Join([]string{
		keyPart,
		clientIP(r),
		r.UserAgent(),
		firstNonEmptyHeader(r, "X-Vibe-Repo", "X-Repo", "X-Project"),
		firstNonEmptyHeader(r, "X-Vibe-Branch", "X-Branch"),
	}, "|")
	return s.sessions.sessionFor(identity, now)
}

func extractAudit(body []byte, endpoint string, rawPrompts bool) (string, bool, []store.PromptLog, []audit.LanguageSignal) {
	if len(body) == 0 {
		return "", false, nil, nil
	}
	var root map[string]any
	if err := json.Unmarshal(body, &root); err != nil {
		return "", false, nil, nil
	}
	model, _ := root["model"].(string)
	stream, _ := root["stream"].(bool)
	texts := []string{}
	prompts := []store.PromptLog{}

	if endpoint == "/v1/chat/completions" {
		if messages, ok := root["messages"].([]any); ok {
			for _, item := range messages {
				message, _ := item.(map[string]any)
				role, _ := message["role"].(string)
				content := flattenContent(message["content"])
				if toolCalls, ok := message["tool_calls"]; ok {
					content = strings.TrimSpace(content + "\n" + jsonString(toolCalls))
				}
				if content == "" {
					continue
				}
				texts = append(texts, content)
				prompts = append(prompts, promptLog(role, content, rawPrompts))
			}
		}
		if tools, ok := root["tools"]; ok {
			content := jsonString(tools)
			if content != "" {
				texts = append(texts, content)
				prompts = append(prompts, promptLog("tools", content, rawPrompts))
			}
		}
	} else if endpoint == "/v1/embeddings" {
		content := flattenContent(root["input"])
		if content != "" {
			texts = append(texts, content)
			prompts = append(prompts, promptLog("input", content, rawPrompts))
		}
	}

	languages := audit.InferLanguages(texts)
	topLanguage := ""
	if len(languages) > 0 {
		topLanguage = languages[0].Language
	}
	for i := range prompts {
		prompts[i].LanguageHint = topLanguage
	}
	return model, stream, prompts, languages
}

func promptLog(role string, content string, rawPrompts bool) store.PromptLog {
	raw := ""
	if rawPrompts {
		raw = content
	}
	return store.PromptLog{
		Role:         firstNonEmpty(role, "unknown"),
		ContentHash:  audit.HashText(content),
		ContentText:  raw,
		RedactedText: audit.Redact(content),
	}
}

func promptTokenEstimate(prompts []store.PromptLog) int {
	total := 0
	for _, prompt := range prompts {
		total += audit.EstimateTokens(prompt.RedactedText)
	}
	return total
}

func flattenContent(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	case []any:
		parts := make([]string, 0, len(v))
		for _, item := range v {
			switch typed := item.(type) {
			case string:
				parts = append(parts, typed)
			case map[string]any:
				if text, ok := typed["text"].(string); ok {
					parts = append(parts, text)
				} else if text, ok := typed["input_text"].(string); ok {
					parts = append(parts, text)
				} else {
					parts = append(parts, jsonString(typed))
				}
			default:
				parts = append(parts, jsonString(typed))
			}
		}
		return strings.Join(parts, "\n")
	default:
		return jsonString(v)
	}
}

func jsonString(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(encoded)
}

func clientIP(r *http.Request) string {
	if value := strings.TrimSpace(r.Header.Get("CF-Connecting-IP")); value != "" {
		return value
	}
	if value := strings.TrimSpace(r.Header.Get("X-Real-IP")); value != "" {
		return value
	}
	if forwarded := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); forwarded != "" {
		return strings.TrimSpace(strings.Split(forwarded, ",")[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func hostname() string {
	name, err := os.Hostname()
	if err != nil {
		return ""
	}
	return name
}

func copyUpstreamHeaders(dst http.Header, src http.Header) {
	for key, values := range src {
		canonical := http.CanonicalHeaderKey(key)
		if hopByHopHeader(canonical) || canonical == "Authorization" || canonical == "Host" || canonical == "Content-Length" {
			continue
		}
		for _, value := range values {
			dst.Add(canonical, value)
		}
	}
}

func copyDownstreamHeaders(dst http.Header, src http.Header) {
	for key, values := range src {
		canonical := http.CanonicalHeaderKey(key)
		if hopByHopHeader(canonical) || canonical == "Content-Length" {
			continue
		}
		for _, value := range values {
			dst.Add(canonical, value)
		}
	}
}

func hopByHopHeader(key string) bool {
	switch strings.ToLower(key) {
	case "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade":
		return true
	default:
		return false
	}
}

func bearerToken(header string) string {
	const prefix = "bearer "
	if len(header) >= len(prefix) && strings.EqualFold(header[:len(prefix)], prefix) {
		return strings.TrimSpace(header[len(prefix):])
	}
	return ""
}

func traceIDFromRequest(r *http.Request) string {
	if value := strings.TrimSpace(r.Header.Get("X-Request-ID")); value != "" {
		return value
	}
	if value := strings.TrimSpace(r.Header.Get("X-Trace-ID")); value != "" {
		return value
	}
	return newID("trace")
}

func withTrace(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeOpenAIError(w http.ResponseWriter, status int, message string, typ string, code string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{
			"message": message,
			"type":    typ,
			"param":   nil,
			"code":    code,
		},
	})
}

func statusForUpstreamError(err error) int {
	if errors.Is(err, context.DeadlineExceeded) {
		return http.StatusGatewayTimeout
	}
	return http.StatusBadGateway
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
