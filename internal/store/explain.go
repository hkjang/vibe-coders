package store

import (
	"context"
	"database/sql"
	"encoding/json"
)

// ExplainData carries the raw per-request fields the Explainability View needs that are
// not already on RecentRequest (routing decision + fallback + token source breakdown).
type ExplainData struct {
	RequestID           string
	TraceID             string
	Model               string
	Provider            string
	Endpoint            string
	StatusCode          int
	Error               string
	LatencyMS           int64
	FirstChunkMS        int64
	Stream              bool
	SessionID           string
	RouteReason         string
	RouteDetail         string
	RequestedModel      string
	Complexity          int
	ComplexityTier      string
	RiskScore           int
	RiskTier            string
	RiskCategories      []string
	HealthScore         int
	RoutingReason       string
	RoutingFallbackPath []string
	Failover            bool
	FallbackFrom        string
	FallbackReason      string
	PromptTokens        int64
	CompletionTokens    int64
	TotalTokens         int64
	CachedTokens        int64
	ReasoningTokens     int64
	EstimatedCost       float64
	Currency            string
	TokenSource         string
	CreatedAt           string
}

// ExplainRow loads the explainability fields for a single request.
func (s *SQLStore) ExplainRow(ctx context.Context, id string) (ExplainData, error) {
	var d ExplainData
	var streamInt, failoverInt int
	var riskCategoriesRaw, fallbackPathRaw string
	err := s.db.QueryRowContext(ctx, s.bind(`
		SELECT r.id, r.trace_id, COALESCE(r.model, ''), COALESCE(r.provider, ''), r.endpoint,
			r.status_code, COALESCE(r.error, ''), r.latency_ms, COALESCE(r.first_chunk_ms, 0), r.stream,
			COALESCE(r.session_id, ''), COALESCE(r.route_reason, ''), COALESCE(r.route_detail, ''), COALESCE(r.requested_model, ''),
			COALESCE(r.complexity, 0), COALESCE(rd.complexity_tier, ''), COALESCE(rd.risk_score, 0), COALESCE(rd.risk_tier, ''),
			COALESCE(rd.risk_categories, '[]'), COALESCE(rd.health_score, 0), COALESCE(rd.decision_reason, ''),
			COALESCE(rd.fallback_path, '[]'), COALESCE(r.failover, 0), COALESCE(r.fallback_from, ''), COALESCE(r.fallback_reason, ''),
			COALESCE(t.prompt_tokens, 0), COALESCE(t.completion_tokens, 0), COALESCE(t.total_tokens, 0),
			COALESCE(t.cached_tokens, 0), COALESCE(t.reasoning_tokens, 0),
			COALESCE(t.estimated_cost, 0), COALESCE(t.currency, ''), COALESCE(t.source, ''),
			r.created_at
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		LEFT JOIN routing_decisions rd ON rd.request_id = r.id
		WHERE r.id = ?`), id).Scan(
		&d.RequestID, &d.TraceID, &d.Model, &d.Provider, &d.Endpoint,
		&d.StatusCode, &d.Error, &d.LatencyMS, &d.FirstChunkMS, &streamInt,
		&d.SessionID, &d.RouteReason, &d.RouteDetail, &d.RequestedModel,
		&d.Complexity, &d.ComplexityTier, &d.RiskScore, &d.RiskTier,
		&riskCategoriesRaw, &d.HealthScore, &d.RoutingReason,
		&fallbackPathRaw, &failoverInt, &d.FallbackFrom, &d.FallbackReason,
		&d.PromptTokens, &d.CompletionTokens, &d.TotalTokens,
		&d.CachedTokens, &d.ReasoningTokens,
		&d.EstimatedCost, &d.Currency, &d.TokenSource,
		&d.CreatedAt)
	if err == sql.ErrNoRows {
		return ExplainData{}, ErrNotFound
	}
	if err != nil {
		return ExplainData{}, err
	}
	d.Stream = streamInt == 1
	d.Failover = failoverInt == 1
	_ = json.Unmarshal([]byte(riskCategoriesRaw), &d.RiskCategories)
	_ = json.Unmarshal([]byte(fallbackPathRaw), &d.RoutingFallbackPath)
	return d, nil
}
