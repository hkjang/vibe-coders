package store

import (
	"context"
	"fmt"
	"time"
)

// DownshiftUsageRow is one (scope, requested_model) group of requests where the served
// model differed from the model the client asked for (a routing downshift). The token
// sums let the caller price a baseline at the requested model and compare to actual cost.
type DownshiftUsageRow struct {
	Scope            string
	RequestedModel   string
	Requests         int64
	PromptTokens     int64
	CompletionTokens int64
	CachedTokens     int64
	ActualCostKRW    float64
}

// CacheUsageRow is per-scope cache-hit accounting: how many requests were served from
// cache vs not, and the total actual cost of the non-cache requests (used to estimate
// the cost a cache hit avoided).
type CacheUsageRow struct {
	Scope            string
	CacheHits        int64
	NonCacheRequests int64
	NonCacheCostKRW  float64
}

// RoutingDownshiftUsage returns per-(scope, requested_model) token sums and actual cost
// for requests that were routed to a different model than requested. The caller prices a
// baseline at the requested model to compute downshift savings. Bounded to a generous cap
// of scope×model groups.
func (s *SQLStore) RoutingDownshiftUsage(ctx context.Context, dimension string, since time.Time) ([]DownshiftUsageRow, error) {
	col, ok := costAllocationColumns[dimension]
	if !ok {
		return nil, fmt.Errorf("unsupported savings dimension %q", dimension)
	}
	query := s.bind(fmt.Sprintf(`
		SELECT COALESCE(NULLIF(%s, ''), '(unset)') AS key,
			r.requested_model,
			COUNT(*),
			COALESCE(SUM(t.prompt_tokens), 0),
			COALESCE(SUM(t.completion_tokens), 0),
			COALESCE(SUM(t.cached_tokens), 0),
			COALESCE(SUM(t.estimated_cost), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE r.created_at >= ?
			AND COALESCE(r.requested_model, '') <> ''
			AND r.requested_model <> COALESCE(r.model, '')
		GROUP BY COALESCE(NULLIF(%s, ''), '(unset)'), r.requested_model
		ORDER BY COUNT(*) DESC
		LIMIT 2000
	`, col, col))
	rows, err := s.db.QueryContext(ctx, query, since.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DownshiftUsageRow{}
	for rows.Next() {
		var d DownshiftUsageRow
		if err := rows.Scan(&d.Scope, &d.RequestedModel, &d.Requests, &d.PromptTokens, &d.CompletionTokens, &d.CachedTokens, &d.ActualCostKRW); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// CacheUsage returns per-scope cache-hit counts and the non-cache request count + cost,
// so the caller can estimate avoided cost as cache_hits × (non-cache cost / non-cache
// requests). Cache hits are identified by route_reason = 'cache'.
func (s *SQLStore) CacheUsage(ctx context.Context, dimension string, since time.Time) ([]CacheUsageRow, error) {
	col, ok := costAllocationColumns[dimension]
	if !ok {
		return nil, fmt.Errorf("unsupported savings dimension %q", dimension)
	}
	query := s.bind(fmt.Sprintf(`
		SELECT COALESCE(NULLIF(%s, ''), '(unset)') AS key,
			COALESCE(SUM(CASE WHEN COALESCE(r.route_reason, '') = 'cache' THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN COALESCE(r.route_reason, '') <> 'cache' THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN COALESCE(r.route_reason, '') <> 'cache' THEN COALESCE(t.estimated_cost, 0) ELSE 0 END), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE r.created_at >= ?
		GROUP BY COALESCE(NULLIF(%s, ''), '(unset)')
	`, col, col))
	rows, err := s.db.QueryContext(ctx, query, since.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CacheUsageRow{}
	for rows.Next() {
		var c CacheUsageRow
		if err := rows.Scan(&c.Scope, &c.CacheHits, &c.NonCacheRequests, &c.NonCacheCostKRW); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
