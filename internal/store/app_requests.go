package store

import (
	"context"
	"strings"
	"time"
)

// AppRequestFilter is the bounded, read-only filter used by the React request
// explorer. It is intentionally separate from RequestFilter so the legacy
// /admin/requests contract and query remain unchanged.
type AppRequestFilter struct {
	Limit       int
	IP          string
	Model       string
	Provider    string
	ProviderSet bool
	RequestID   string
	TraceID     string
	SessionID   string
	APIKeyID    string
	Language    string
	StatusMin   int
	StatusMax   int
	StatusCode  int
	Teams       []string
	TeamScoped  bool
	From        time.Time
	To          time.Time
	CursorAt    string
	CursorID    string
	Direction   string
}

// AppRequestSummary contains only metadata approved for the React read-only
// projection. Provider is kept internal so the proxy can replace it with an
// opaque reference and bounded display label before serialization.
type AppRequestSummary struct {
	RequestID        string  `json:"request_id"`
	TraceID          string  `json:"trace_id"`
	SessionID        string  `json:"session_id"`
	APIKeyID         string  `json:"api_key_id"`
	IP               string  `json:"ip"`
	Method           string  `json:"method"`
	Model            string  `json:"model"`
	Provider         string  `json:"-"`
	Endpoint         string  `json:"endpoint"`
	Stream           bool    `json:"stream"`
	StatusCode       int     `json:"status_code"`
	LatencyMS        int64   `json:"latency_ms"`
	FirstChunkMS     int64   `json:"first_chunk_ms"`
	PromptTokens     int     `json:"prompt_tokens"`
	CompletionTokens int     `json:"completion_tokens"`
	TotalTokens      int     `json:"total_tokens"`
	CachedTokens     int     `json:"cached_tokens"`
	ReasoningTokens  int     `json:"reasoning_tokens"`
	EstimatedCost    float64 `json:"estimated_cost"`
	Currency         string  `json:"currency"`
	FinishReason     string  `json:"finish_reason"`
	CreatedAt        string  `json:"created_at"`
}

// AppRequestProviderNames returns provider identities visible in the caller's
// team scope. Names never leave the proxy; they are used only to resolve an
// opaque provider_ref back to an exact SQL predicate.
func (s *SQLStore) AppRequestProviderNames(ctx context.Context, teams []string, teamScoped bool) ([]string, error) {
	where, args := appendRequestTeamCondition([]string{"1=1"}, nil, "", teams, teamScoped)
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT DISTINCT COALESCE(r.provider, '')
		FROM request_logs r
		WHERE `+strings.Join(where, " AND ")+`
		ORDER BY COALESCE(r.provider, '')
		LIMIT 10001`), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	providers := []string{}
	for rows.Next() {
		var provider string
		if err := rows.Scan(&provider); err != nil {
			return nil, err
		}
		providers = append(providers, provider)
	}
	return providers, rows.Err()
}

// AppRecentRequests returns one stable keyset page. hasMore refers to the
// requested direction; newer pages are queried ascending and reversed so the
// public result is always (created_at DESC, id DESC).
func (s *SQLStore) AppRecentRequests(ctx context.Context, filter AppRequestFilter) ([]AppRequestSummary, bool, error) {
	where := []string{"1=1"}
	args := []any{}
	addExact := func(column, value string) {
		if value != "" {
			where = append(where, column+" = ?")
			args = append(args, value)
		}
	}
	addExact("COALESCE(NULLIF(r.client_ip, ''), 'unknown')", filter.IP)
	addExact("r.model", filter.Model)
	if filter.ProviderSet {
		where = append(where, "COALESCE(r.provider, '') = ?")
		args = append(args, filter.Provider)
	}
	addExact("r.id", filter.RequestID)
	addExact("r.trace_id", filter.TraceID)
	addExact("COALESCE(NULLIF(r.session_id, ''), 'no-session')", filter.SessionID)
	addExact("r.api_key_id", filter.APIKeyID)
	if filter.Language != "" {
		where = append(where, "EXISTS (SELECT 1 FROM language_stats ls WHERE ls.request_id = r.id AND ls.language = ?)")
		args = append(args, filter.Language)
	}
	if filter.StatusCode != 0 {
		where = append(where, "r.status_code = ?")
		args = append(args, filter.StatusCode)
	} else {
		if filter.StatusMin != 0 {
			where = append(where, "r.status_code >= ?")
			args = append(args, filter.StatusMin)
		}
		if filter.StatusMax != 0 {
			where = append(where, "r.status_code <= ?")
			args = append(args, filter.StatusMax)
		}
	}
	where, args = appendRequestTeamCondition(where, args, "", filter.Teams, filter.TeamScoped)
	if !filter.From.IsZero() {
		where = append(where, "r.created_at >= ?")
		args = append(args, filter.From.UTC().Format(time.RFC3339Nano))
	}
	if !filter.To.IsZero() {
		where = append(where, "r.created_at <= ?")
		args = append(args, filter.To.UTC().Format(time.RFC3339Nano))
	}
	order := "r.created_at DESC, r.id DESC"
	if filter.CursorAt != "" {
		operator := "<"
		if filter.Direction == "newer" {
			operator = ">"
			order = "r.created_at ASC, r.id ASC"
		}
		where = append(where, "(r.created_at "+operator+" ? OR (r.created_at = ? AND r.id "+operator+" ?))")
		args = append(args, filter.CursorAt, filter.CursorAt, filter.CursorID)
	}
	args = append(args, filter.Limit+1)
	query := s.bind(`SELECT r.id, COALESCE(r.trace_id, ''), COALESCE(r.session_id, ''),
			COALESCE(r.api_key_id, ''), COALESCE(NULLIF(r.client_ip, ''), 'unknown'),
			COALESCE(r.method, ''), COALESCE(r.model, ''), COALESCE(r.provider, ''),
			COALESCE(r.endpoint, ''), r.stream, r.status_code, r.latency_ms,
			COALESCE(r.first_chunk_ms, 0), COALESCE(t.prompt_tokens, 0),
			COALESCE(t.completion_tokens, 0), COALESCE(t.total_tokens, 0),
			COALESCE(t.cached_tokens, 0), COALESCE(t.reasoning_tokens, 0),
			COALESCE(t.estimated_cost, 0), COALESCE(t.currency, ''),
			COALESCE(resp.finish_reason, ''), r.created_at
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		LEFT JOIN response_logs resp ON resp.request_id = r.id
		WHERE ` + strings.Join(where, " AND ") + `
		ORDER BY ` + order + ` LIMIT ?`)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := []AppRequestSummary{}
	for rows.Next() {
		var item AppRequestSummary
		var stream int
		if err := rows.Scan(&item.RequestID, &item.TraceID, &item.SessionID, &item.APIKeyID,
			&item.IP, &item.Method, &item.Model, &item.Provider, &item.Endpoint, &stream,
			&item.StatusCode, &item.LatencyMS, &item.FirstChunkMS, &item.PromptTokens,
			&item.CompletionTokens, &item.TotalTokens, &item.CachedTokens,
			&item.ReasoningTokens, &item.EstimatedCost, &item.Currency,
			&item.FinishReason, &item.CreatedAt); err != nil {
			return nil, false, err
		}
		item.Stream = stream == 1
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	hasMore := len(items) > filter.Limit
	if hasMore {
		items = items[:filter.Limit]
	}
	if filter.Direction == "newer" {
		for left, right := 0, len(items)-1; left < right; left, right = left+1, right-1 {
			items[left], items[right] = items[right], items[left]
		}
	}
	return items, hasMore, nil
}
