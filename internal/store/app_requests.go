package store

import (
	"context"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	appRequestTimeLayout            = "2006-01-02T15:04:05.000000000Z"
	maxAppRequestPageSize           = 200
	maxAppRequestProviderCandidates = 1024
	// SQL substr counts Unicode characters, while the public projection limits
	// UTF-8 bytes. Reading max+1 characters lets the proxy detect overflow and
	// still bounds each database value to at most 4*(max+1) bytes.
	appRequestReadIDChars           = 513
	appRequestReadIPChars           = 129
	appRequestReadMethodChars       = 33
	appRequestReadModelChars        = 257
	appRequestReadProviderChars     = 257
	appRequestReadEndpointChars     = 513
	appRequestReadCurrencyChars     = 17
	appRequestReadFinishReasonChars = 257
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

// AppRequestProviderCandidates returns a bounded list of configured provider
// identities. It deliberately does not discover names by scanning request_logs:
// provider_ref is accepted only for an operator-configured provider and fails
// closed when the configured set exceeds the bounded lookup budget or contains
// an identity that cannot be read within the public provider boundary.
func (s *SQLStore) AppRequestProviderCandidates(ctx context.Context) ([]string, bool, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT substr(name, 1, `+fmt.Sprint(appRequestReadProviderChars)+`)
		FROM provider_configs
		ORDER BY name ASC
		LIMIT ?`), maxAppRequestProviderCandidates+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	providers := []string{}
	unsafe := false
	for rows.Next() {
		var provider string
		if err := rows.Scan(&provider); err != nil {
			return nil, false, err
		}
		if len(provider) > appRequestReadProviderChars-1 || !utf8.ValidString(provider) {
			unsafe = true
		}
		providers = append(providers, provider)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	truncated := len(providers) > maxAppRequestProviderCandidates
	if truncated {
		providers = providers[:maxAppRequestProviderCandidates]
	}
	return providers, truncated || unsafe, nil
}

// appRequestCreatedAtExpr normalizes the UTC RFC3339Nano strings written by
// formatTime to one fixed-width representation inside SQL. RFC3339Nano omits
// trailing fractional zeroes, so a direct TEXT comparison incorrectly sorts an
// exact second (..03Z) after a later fractional instant (..03.5Z). The
// expression uses functions/operators shared by SQLite and PostgreSQL and is
// shared verbatim by the query and its expression index.
func appRequestCreatedAtExpr(column string) string {
	return `(CASE
		WHEN ((length(` + column + `) = 20) AND (substr(` + column + `, 20, 1) = 'Z'))
			THEN (substr(` + column + `, 1, 19) || '.000000000Z')
		WHEN ((length(` + column + `) >= 22) AND (length(` + column + `) <= 30)
			AND (substr(` + column + `, 20, 1) = '.')
			AND (substr(` + column + `, length(` + column + `), 1) = 'Z'))
			THEN ((substr(` + column + `, 1, (length(` + column + `) - 1))
				|| substr('000000000', 1, (30 - length(` + column + `)))) || 'Z')
		ELSE ` + column + ` END)`
}

// appRequestValidRowPredicate is shared by the request-page query and its
// partial cursor indexes. Keeping malformed or oversized identifiers outside
// those indexes gives PostgreSQL an ordered path with useful statistics and
// keeps SQLite from walking rows the public projection must reject anyway.
func appRequestValidRowPredicate(idColumn, createdAtColumn string) string {
	return appRequestBoundedTextPredicate(idColumn) + " AND length(" + createdAtColumn + ") BETWEEN 20 AND 30"
}

func appRequestBoundedTextPredicate(column string) string {
	return "length(CAST(" + column + " AS BLOB)) BETWEEN 1 AND 512"
}

func appRequestValidChildPredicate(requestIDColumn, idColumn, createdAtColumn string) string {
	return appRequestBoundedTextPredicate(requestIDColumn) + " AND " +
		appRequestBoundedTextPredicate(idColumn) + " AND length(" + createdAtColumn + ") BETWEEN 20 AND 30"
}

func appRequestFixedTime(value time.Time) string {
	return value.UTC().Format(appRequestTimeLayout)
}

// appRecentRequestsQuery selects the bounded request page before joining the
// request-scoped usage and response tables. The LIMIT in the derived table is
// an intentional optimization boundary: a page of 51 requests must never turn
// into a full token_usage/response_logs join on a long-lived installation.
func (s *SQLStore) appRecentRequestsQuery(filter AppRequestFilter) (string, []any, int, error) {
	limit := filter.Limit
	if limit <= 0 || limit > maxAppRequestPageSize {
		limit = 50
	}
	createdAt := appRequestCreatedAtExpr("r.created_at")
	validRow := renderForDialect(appRequestValidRowPredicate("r.id", "r.created_at"), s.dialect)
	validRequestAPIKey := renderForDialect(appRequestBoundedTextPredicate("r.api_key_id"), s.dialect)
	validTeamKey := renderForDialect(appRequestBoundedTextPredicate("k.id")+" AND "+appRequestBoundedTextPredicate("k.team"), s.dialect)
	validTokenUsage := renderForDialect(appRequestValidChildPredicate("t_pick.request_id", "t_pick.id", "t_pick.created_at"), s.dialect)
	validResponse := renderForDialect(appRequestValidChildPredicate("resp_pick.request_id", "resp_pick.id", "resp_pick.created_at"), s.dialect)
	where := []string{validRow}
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
	if filter.APIKeyID != "" {
		where = append(where, validRequestAPIKey)
		addExact("r.api_key_id", filter.APIKeyID)
	}
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
	where, args = appendRequestTeamConditionWithPredicates(
		where, args, "", filter.Teams, filter.TeamScoped, validRequestAPIKey, validTeamKey,
		s.dialect == "sqlite",
	)
	if !filter.From.IsZero() {
		where = append(where, createdAt+" >= ?")
		args = append(args, appRequestFixedTime(filter.From))
	}
	if !filter.To.IsZero() {
		where = append(where, createdAt+" <= ?")
		args = append(args, appRequestFixedTime(filter.To))
	}
	order := createdAt + " DESC, r.id DESC"
	if filter.CursorAt != "" {
		cursorTime, err := time.Parse(time.RFC3339Nano, filter.CursorAt)
		if err != nil {
			return "", nil, 0, fmt.Errorf("invalid app request cursor time: %w", err)
		}
		cursorAt := appRequestFixedTime(cursorTime)
		operator := "<"
		scalarOperator := "<="
		if filter.Direction == "newer" {
			operator = ">"
			scalarOperator = ">="
			order = createdAt + " ASC, r.id ASC"
		}
		// SQLite does not turn a row-value comparison into an expression-index
		// range seek by itself. This logically redundant scalar bound does.
		where = append(where, createdAt+" "+scalarOperator+" ?")
		args = append(args, cursorAt)
		where = append(where, "("+createdAt+", r.id) "+operator+" (?, ?)")
		args = append(args, cursorAt, filter.CursorID)
	}
	pageLimit := limit + 1
	args = append(args, pageLimit, pageLimit)
	pageOrder := "page.created_at DESC, page.request_id DESC"
	if filter.Direction == "newer" && filter.CursorAt != "" {
		pageOrder = "page.created_at ASC, page.request_id ASC"
	}
	query := s.bind(`SELECT page.request_id, page.trace_id, page.session_id, page.api_key_id,
			page.client_ip, page.method, page.model, page.provider, page.endpoint,
			page.stream, page.status_code, page.latency_ms, page.first_chunk_ms,
			COALESCE(t.prompt_tokens, 0), COALESCE(t.completion_tokens, 0),
			COALESCE(t.total_tokens, 0), COALESCE(t.cached_tokens, 0),
			COALESCE(t.reasoning_tokens, 0), COALESCE(t.estimated_cost, 0),
			substr(COALESCE(t.currency, ''), 1, ` + fmt.Sprint(appRequestReadCurrencyChars) + `),
			substr(COALESCE(resp.finish_reason, ''), 1, ` + fmt.Sprint(appRequestReadFinishReasonChars) + `),
			page.created_at
		FROM (
			SELECT substr(r.id, 1, ` + fmt.Sprint(appRequestReadIDChars) + `) AS request_id,
			substr(COALESCE(r.trace_id, ''), 1, ` + fmt.Sprint(appRequestReadIDChars) + `) AS trace_id,
			substr(COALESCE(r.session_id, ''), 1, ` + fmt.Sprint(appRequestReadIDChars) + `) AS session_id,
			substr(COALESCE(r.api_key_id, ''), 1, ` + fmt.Sprint(appRequestReadIDChars) + `) AS api_key_id,
			substr(COALESCE(NULLIF(r.client_ip, ''), 'unknown'), 1, ` + fmt.Sprint(appRequestReadIPChars) + `) AS client_ip,
			substr(COALESCE(r.method, ''), 1, ` + fmt.Sprint(appRequestReadMethodChars) + `) AS method,
			substr(COALESCE(r.model, ''), 1, ` + fmt.Sprint(appRequestReadModelChars) + `) AS model,
			substr(COALESCE(r.provider, ''), 1, ` + fmt.Sprint(appRequestReadProviderChars) + `) AS provider,
			substr(COALESCE(r.endpoint, ''), 1, ` + fmt.Sprint(appRequestReadEndpointChars) + `) AS endpoint,
			r.stream AS stream, r.status_code AS status_code, r.latency_ms AS latency_ms,
			COALESCE(r.first_chunk_ms, 0) AS first_chunk_ms, ` + createdAt + ` AS created_at
			FROM request_logs r
			WHERE ` + strings.Join(where, " AND ") + `
			ORDER BY ` + order + ` LIMIT ?
		) page
		LEFT JOIN token_usage t ON t.id = (
			SELECT t_pick.id FROM token_usage t_pick
			WHERE t_pick.request_id = page.request_id
			AND ` + validTokenUsage + `
			ORDER BY ` + appRequestCreatedAtExpr("t_pick.created_at") + ` DESC, t_pick.id DESC LIMIT 1
		)
		LEFT JOIN response_logs resp ON resp.id = (
			SELECT resp_pick.id FROM response_logs resp_pick
			WHERE resp_pick.request_id = page.request_id
			AND ` + validResponse + `
			ORDER BY ` + appRequestCreatedAtExpr("resp_pick.created_at") + ` DESC, resp_pick.id DESC LIMIT 1
		)
		ORDER BY ` + pageOrder + ` LIMIT ?`)
	return query, args, limit, nil
}

// AppRecentRequests returns one stable keyset page. hasMore refers to the
// requested direction; newer pages are queried ascending and reversed so the
// public result is always (created_at DESC, id DESC).
func (s *SQLStore) AppRecentRequests(ctx context.Context, filter AppRequestFilter) ([]AppRequestSummary, bool, error) {
	query, args, limit, err := s.appRecentRequestsQuery(filter)
	if err != nil {
		return nil, false, err
	}
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
		parsedAt, err := time.Parse(appRequestTimeLayout, item.CreatedAt)
		if err != nil {
			return nil, false, fmt.Errorf("invalid app request created_at: %w", err)
		}
		item.CreatedAt = appRequestFixedTime(parsedAt)
		item.Stream = stream == 1
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	if filter.Direction == "newer" {
		for left, right := 0, len(items)-1; left < right; left, right = left+1, right-1 {
			items[left], items[right] = items[right], items[left]
		}
	}
	return items, hasMore, nil
}
