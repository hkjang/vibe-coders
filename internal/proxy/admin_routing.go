package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

const (
	providerHealthDefaultThreshold = 70
	providerHealthTrendBuckets     = 6
)

type providerHealthRankingItem struct {
	Rank             int     `json:"rank"`
	Provider         string  `json:"provider"`
	Score            int     `json:"score"`
	Requests         int64   `json:"requests"`
	FallbackRate     float64 `json:"fallback_rate"`
	P95LatencyMS     int64   `json:"p95_latency_ms"`
	AverageLatencyMS float64 `json:"average_latency_ms"`
}

type providerHealthAlert struct {
	Provider string `json:"provider"`
	Code     string `json:"code"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
}

type providerHealthTrendBucket struct {
	Since     string                      `json:"since"`
	Until     string                      `json:"until"`
	Providers []store.ProviderHealthScore `json:"providers"`
}

func (s *Server) handleRoutingPreview(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "failed to read request body", "invalid_request_error", "invalid_body")
		return
	}
	var probe map[string]any
	if err := json.Unmarshal(body, &probe); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	authCtx, policyKeyID, ok := s.routingPreviewAuthContext(w, r, probe)
	if !ok {
		return
	}
	plan := s.planIntelligentRouting(r.Context(), body, "/v1/chat/completions", false, false, authCtx)
	writeJSON(w, http.StatusOK, map[string]any{
		"requested_model":   plan.RequestedModel,
		"selected_model":    plan.SelectedModel,
		"selected_provider": plan.SelectedProvider,
		"policy_api_key_id": policyKeyID,
		"complexity":        plan.Complexity,
		"risk":              plan.Risk,
		"health_score":      plan.HealthScore,
		"fallback_path":     plan.FallbackPath,
		"route_reason":      plan.RouteReason,
		"decision_reason":   plan.DecisionReason,
		"would_rewrite":     plan.RequestedModel != "" && plan.SelectedModel != "" && plan.RequestedModel != plan.SelectedModel,
	})
}

func (s *Server) routingPreviewAuthContext(w http.ResponseWriter, r *http.Request, probe map[string]any) (*store.AuthContext, string, bool) {
	apiKeyID := strings.TrimSpace(toString(probe["api_key_id"]))
	if apiKeyID == "" {
		return nil, "", true
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
		writeOpenAIError(w, http.StatusForbidden, "team_admin can only preview own team api keys", "permission_error", "team_scope_denied")
		return nil, "", false
	}
	authCtx := authContextFromAPIKey(key)
	s.enrichAuthContextTeam(r.Context(), &authCtx)
	return &authCtx, key.ID, true
}

func (s *Server) handleRoutingDecisions(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	limit := 100
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	decisions, err := s.db.ListRoutingDecisions(r.Context(), limit)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "routing_decisions_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"decisions": decisions})
}

func (s *Server) handleRoutingDecisionByID(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/admin/routing/decisions/")
	if id == "" || strings.Contains(id, "/") {
		writeOpenAIError(w, http.StatusBadRequest, "invalid decision id", "invalid_request_error", "invalid_decision_id")
		return
	}
	decision, err := s.db.RoutingDecisionByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "routing decision not found", "invalid_request_error", "routing_decision_not_found")
			return
		}
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "routing_decision_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"decision": decision})
}

func (s *Server) handleRoutingHealth(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), providerHealthWindow, "hour")
	until := time.Now().UTC()
	threshold := parseProviderHealthThreshold(r.URL.Query().Get("threshold"))
	scores, err := s.db.ProviderHealthScoresBetween(r.Context(), since, until.Add(time.Nanosecond))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "routing_health_failed")
		return
	}
	trend, err := s.providerHealthTrend(r.Context(), since, until, providerHealthTrendBuckets)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "routing_health_trend_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"since":     since.UTC().Format(time.RFC3339),
		"until":     until.Format(time.RFC3339),
		"threshold": threshold,
		"providers": scores,
		"ranking":   providerHealthRanking(scores),
		"degraded":  providerHealthDegraded(scores, threshold),
		"alerts":    providerHealthAlerts(scores, threshold),
		"trend":     trend,
	})
}

func parseProviderHealthThreshold(raw string) int {
	threshold := providerHealthDefaultThreshold
	if parsed, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil {
		threshold = parsed
	}
	if threshold < 0 {
		return 0
	}
	if threshold > 100 {
		return 100
	}
	return threshold
}

func providerHealthRanking(scores []store.ProviderHealthScore) []providerHealthRankingItem {
	ranked := append([]store.ProviderHealthScore(nil), scores...)
	sort.Slice(ranked, func(i, j int) bool {
		if ranked[i].Score != ranked[j].Score {
			return ranked[i].Score > ranked[j].Score
		}
		return ranked[i].Provider < ranked[j].Provider
	})
	out := make([]providerHealthRankingItem, 0, len(ranked))
	for i, score := range ranked {
		out = append(out, providerHealthRankingItem{
			Rank:             i + 1,
			Provider:         score.Provider,
			Score:            score.Score,
			Requests:         score.Requests,
			FallbackRate:     score.FallbackRate,
			P95LatencyMS:     score.P95LatencyMS,
			AverageLatencyMS: score.AverageLatencyMS,
		})
	}
	return out
}

func providerHealthDegraded(scores []store.ProviderHealthScore, threshold int) []store.ProviderHealthScore {
	out := []store.ProviderHealthScore{}
	for _, score := range scores {
		if score.Requests > 0 && score.Score < threshold {
			out = append(out, score)
		}
	}
	return out
}

func providerHealthAlerts(scores []store.ProviderHealthScore, threshold int) []providerHealthAlert {
	alerts := []providerHealthAlert{}
	for _, score := range scores {
		if score.Requests == 0 {
			continue
		}
		if score.Score < threshold {
			alerts = append(alerts, providerHealthAlert{
				Provider: score.Provider,
				Code:     "provider_degraded",
				Severity: providerHealthSeverity(score.Score, threshold),
				Message:  "provider health score is below threshold",
			})
		}
		if score.Timeouts > 0 {
			alerts = append(alerts, providerHealthAlert{
				Provider: score.Provider,
				Code:     "timeouts_detected",
				Severity: providerHealthSeverity(score.Score, threshold),
				Message:  "timeout signals were observed in the selected window",
			})
		}
		if score.Rate429 > 0 {
			alerts = append(alerts, providerHealthAlert{
				Provider: score.Provider,
				Code:     "rate_limit_detected",
				Severity: "warning",
				Message:  "429 rate limit responses were observed in the selected window",
			})
		}
		if score.Rate5xx > 0 {
			alerts = append(alerts, providerHealthAlert{
				Provider: score.Provider,
				Code:     "server_error_detected",
				Severity: providerHealthSeverity(score.Score, threshold),
				Message:  "5xx provider responses were observed in the selected window",
			})
		}
		if score.FallbackRate >= 0.1 {
			alerts = append(alerts, providerHealthAlert{
				Provider: score.Provider,
				Code:     "fallback_rate_high",
				Severity: providerHealthSeverity(score.Score, threshold),
				Message:  "fallback rate is elevated for the selected window",
			})
		}
	}
	return alerts
}

func providerHealthSeverity(score, threshold int) string {
	switch {
	case score < 40:
		return "critical"
	case score < threshold:
		return "warning"
	default:
		return "info"
	}
}

func (s *Server) providerHealthTrend(ctx context.Context, since, until time.Time, buckets int) ([]providerHealthTrendBucket, error) {
	if buckets <= 0 || !until.After(since) {
		return []providerHealthTrendBucket{}, nil
	}
	window := until.Sub(since)
	bucketSize := window / time.Duration(buckets)
	if bucketSize <= 0 {
		bucketSize = time.Second
	}
	trend := make([]providerHealthTrendBucket, 0, buckets)
	start := since.UTC()
	for i := 0; i < buckets && start.Before(until); i++ {
		end := start.Add(bucketSize)
		if i == buckets-1 || end.After(until) {
			end = until
		}
		queryEnd := end
		if !end.Before(until) {
			queryEnd = end.Add(time.Nanosecond)
		}
		scores, err := s.db.ProviderHealthScoresBetween(ctx, start, queryEnd)
		if err != nil {
			return nil, err
		}
		trend = append(trend, providerHealthTrendBucket{
			Since:     start.Format(time.RFC3339),
			Until:     end.Format(time.RFC3339),
			Providers: scores,
		})
		start = end
	}
	return trend, nil
}
