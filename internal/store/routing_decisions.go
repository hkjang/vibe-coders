package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"sort"
	"strings"
	"time"
)

func (s *SQLStore) ListRoutingDecisions(ctx context.Context, limit int) ([]RoutingDecisionLog, error) {
	return s.ListRoutingDecisionsScoped(ctx, limit, nil, false)
}

// ListRoutingDecisionsScoped keeps routing history inside the caller's request-team
// boundary. The unrestricted wrapper deliberately avoids joining request_logs so
// retention-orphaned legacy decisions remain visible to full administrators.
func (s *SQLStore) ListRoutingDecisionsScoped(ctx context.Context, limit int, teams []string, teamScoped bool) ([]RoutingDecisionLog, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	from := " FROM routing_decisions rd"
	where := []string{}
	args := []any{}
	if routingDecisionTeamFilterRequested(teams, teamScoped) {
		from += " JOIN request_logs r ON r.id = rd.request_id"
		where, args = appendRequestTeamCondition(where, args, "", teams, teamScoped)
	}
	query := `SELECT rd.id, rd.request_id, rd.trace_id, COALESCE(rd.requested_model, ''), COALESCE(rd.selected_model, ''),
			COALESCE(rd.selected_provider, ''), rd.complexity_score, COALESCE(rd.complexity_tier, ''),
			rd.prompt_length, rd.token_estimate, rd.code_density, rd.file_count, rd.conversation_depth,
			rd.instruction_density, rd.reasoning_keywords, rd.refactoring_keywords, rd.debugging_keywords,
			rd.risk_score, COALESCE(rd.risk_tier, ''), COALESCE(rd.risk_categories, '[]'),
			rd.health_score, COALESCE(rd.fallback_path, '[]'), COALESCE(rd.decision_reason, ''), rd.created_at` + from
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}
	query += " ORDER BY rd.created_at DESC LIMIT ?"
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(query), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []RoutingDecisionLog{}
	for rows.Next() {
		item, err := scanRoutingDecision(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *SQLStore) RoutingDecisionByID(ctx context.Context, id string) (RoutingDecisionLog, error) {
	return s.RoutingDecisionByIDScoped(ctx, id, nil, false)
}

// RoutingDecisionByIDScoped applies the same team boundary as the list endpoint.
// Scoped lookups use an inner join and therefore fail closed for retention orphans.
func (s *SQLStore) RoutingDecisionByIDScoped(ctx context.Context, id string, teams []string, teamScoped bool) (RoutingDecisionLog, error) {
	from := " FROM routing_decisions rd"
	where := []string{"(rd.id = ? OR rd.request_id = ?)"}
	args := []any{id, id}
	if routingDecisionTeamFilterRequested(teams, teamScoped) {
		from += " JOIN request_logs r ON r.id = rd.request_id"
		where, args = appendRequestTeamCondition(where, args, "", teams, teamScoped)
	}
	query := `SELECT rd.id, rd.request_id, rd.trace_id, COALESCE(rd.requested_model, ''), COALESCE(rd.selected_model, ''),
			COALESCE(rd.selected_provider, ''), rd.complexity_score, COALESCE(rd.complexity_tier, ''),
			rd.prompt_length, rd.token_estimate, rd.code_density, rd.file_count, rd.conversation_depth,
			rd.instruction_density, rd.reasoning_keywords, rd.refactoring_keywords, rd.debugging_keywords,
			rd.risk_score, COALESCE(rd.risk_tier, ''), COALESCE(rd.risk_categories, '[]'),
			rd.health_score, COALESCE(rd.fallback_path, '[]'), COALESCE(rd.decision_reason, ''), rd.created_at` + from +
		" WHERE " + strings.Join(where, " AND ") +
		" ORDER BY CASE WHEN rd.id = ? THEN 0 ELSE 1 END, rd.created_at DESC, rd.id DESC LIMIT 1"
	args = append(args, id)
	row := s.db.QueryRowContext(ctx, s.bind(query), args...)
	item, err := scanRoutingDecision(row)
	if err == sql.ErrNoRows {
		return RoutingDecisionLog{}, ErrNotFound
	}
	return item, err
}

func routingDecisionTeamFilterRequested(teams []string, teamScoped bool) bool {
	if teamScoped {
		return true
	}
	for _, team := range teams {
		if strings.TrimSpace(team) != "" {
			return true
		}
	}
	return false
}

// RoutingDecisionByRequestID resolves only the request foreign key. Callers that
// already hold a request ID must not use RoutingDecisionByID: legacy data can contain
// a decision primary key equal to another request ID, and the broad lookup would mix
// artifacts across requests.
func (s *SQLStore) RoutingDecisionByRequestID(ctx context.Context, requestID string) (RoutingDecisionLog, error) {
	row := s.db.QueryRowContext(ctx, s.bind(`
		SELECT id, request_id, trace_id, COALESCE(requested_model, ''), COALESCE(selected_model, ''),
			COALESCE(selected_provider, ''), complexity_score, COALESCE(complexity_tier, ''),
			prompt_length, token_estimate, code_density, file_count, conversation_depth,
			instruction_density, reasoning_keywords, refactoring_keywords, debugging_keywords,
			risk_score, COALESCE(risk_tier, ''), COALESCE(risk_categories, '[]'),
			health_score, COALESCE(fallback_path, '[]'), COALESCE(decision_reason, ''), created_at
		FROM routing_decisions
		WHERE request_id = ?
		ORDER BY created_at DESC, id DESC
		LIMIT 1`), requestID)
	item, err := scanRoutingDecision(row)
	if err == sql.ErrNoRows {
		return RoutingDecisionLog{}, ErrNotFound
	}
	return item, err
}

type routingDecisionScanner interface {
	Scan(dest ...any) error
}

func scanRoutingDecision(row routingDecisionScanner) (RoutingDecisionLog, error) {
	var item RoutingDecisionLog
	var categoriesRaw, fallbackRaw, createdAt string
	err := row.Scan(&item.ID, &item.RequestID, &item.TraceID, &item.RequestedModel, &item.SelectedModel,
		&item.SelectedProvider, &item.Complexity.Score, &item.Complexity.Tier,
		&item.Complexity.PromptLength, &item.Complexity.TokenEstimate, &item.Complexity.CodeDensity,
		&item.Complexity.FileCount, &item.Complexity.ConversationDepth, &item.Complexity.InstructionDensity,
		&item.Complexity.ReasoningKeywords, &item.Complexity.RefactoringKeywords, &item.Complexity.DebuggingKeywords,
		&item.Risk.Score, &item.Risk.Tier, &categoriesRaw,
		&item.HealthScore, &fallbackRaw, &item.DecisionReason, &createdAt)
	if err != nil {
		return RoutingDecisionLog{}, err
	}
	_ = json.Unmarshal([]byte(categoriesRaw), &item.Risk.Categories)
	_ = json.Unmarshal([]byte(fallbackRaw), &item.FallbackPath)
	if parsed, err := time.Parse(time.RFC3339Nano, createdAt); err == nil {
		item.CreatedAt = parsed
	}
	return item, nil
}

func (s *SQLStore) ProviderHealthScores(ctx context.Context, since time.Time) ([]ProviderHealthScore, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT COALESCE(provider, ''), latency_ms, status_code, COALESCE(error, ''),
			COALESCE(failover, 0), COALESCE(fallback_from, ''), COALESCE(fallback_reason, '')
		FROM request_logs
		WHERE created_at >= ?`), since.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	return scanProviderHealthScores(rows)
}

func (s *SQLStore) ProviderHealthScoresBetween(ctx context.Context, since, until time.Time) ([]ProviderHealthScore, error) {
	if !until.After(since) {
		return []ProviderHealthScore{}, nil
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT COALESCE(provider, ''), latency_ms, status_code, COALESCE(error, ''),
			COALESCE(failover, 0), COALESCE(fallback_from, ''), COALESCE(fallback_reason, '')
		FROM request_logs
		WHERE created_at >= ? AND created_at < ?`),
		since.UTC().Format(time.RFC3339Nano),
		until.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	return scanProviderHealthScores(rows)
}

func scanProviderHealthScores(rows *sql.Rows) ([]ProviderHealthScore, error) {
	defer rows.Close()

	type accum struct {
		health    ProviderHealthScore
		latencies []int64
	}
	stats := map[string]*accum{}
	get := func(provider string) *accum {
		provider = strings.TrimSpace(provider)
		if provider == "" {
			provider = "(unknown)"
		}
		if stats[provider] == nil {
			stats[provider] = &accum{health: ProviderHealthScore{Provider: provider}}
		}
		return stats[provider]
	}

	for rows.Next() {
		var provider, errText, fallbackFrom, fallbackReason string
		var latency int64
		var status, failoverInt int
		if err := rows.Scan(&provider, &latency, &status, &errText, &failoverInt, &fallbackFrom, &fallbackReason); err != nil {
			return nil, err
		}
		a := get(provider)
		a.health.Requests++
		a.latencies = append(a.latencies, latency)
		if isTimeoutHealthSignal(status, errText) {
			a.health.Timeouts++
		}
		if status == 429 {
			a.health.Rate429++
		}
		if status >= 500 && status <= 599 {
			a.health.Rate5xx++
		}
		if failoverInt == 1 && strings.TrimSpace(fallbackFrom) != "" {
			f := get(fallbackFrom)
			f.health.Requests++
			f.health.Fallbacks++
			if isTimeoutHealthSignal(0, fallbackReason) {
				f.health.Timeouts++
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := make([]ProviderHealthScore, 0, len(stats))
	for _, a := range stats {
		h := a.health
		if len(a.latencies) > 0 {
			sort.Slice(a.latencies, func(i, j int) bool { return a.latencies[i] < a.latencies[j] })
			var total int64
			for _, v := range a.latencies {
				total += v
			}
			h.AverageLatencyMS = float64(total) / float64(len(a.latencies))
			h.P95LatencyMS = a.latencies[int(math.Ceil(float64(len(a.latencies))*0.95))-1]
		}
		if h.Requests > 0 {
			h.FallbackRate = float64(h.Fallbacks) / float64(h.Requests)
		}
		h.Score = providerHealthScoreValue(h)
		out = append(out, h)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		return out[i].Provider < out[j].Provider
	})
	return out, nil
}

func isTimeoutHealthSignal(status int, text string) bool {
	if status == 504 {
		return true
	}
	lower := strings.ToLower(text)
	return strings.Contains(lower, "timeout") || strings.Contains(lower, "deadline exceeded")
}

func providerHealthScoreValue(h ProviderHealthScore) int {
	if h.Requests <= 0 {
		return 100
	}
	rate := func(n int64) float64 { return float64(n) / float64(h.Requests) }
	score := 100.0
	score -= math.Min(25, h.AverageLatencyMS/400)
	score -= math.Min(25, float64(h.P95LatencyMS)/800)
	score -= math.Min(20, rate(h.Timeouts)*100)
	score -= math.Min(10, rate(h.Rate429)*50)
	score -= math.Min(15, rate(h.Rate5xx)*75)
	score -= math.Min(20, h.FallbackRate*100)
	if score < 0 {
		score = 0
	}
	if score > 100 {
		score = 100
	}
	return int(score + 0.5)
}

// ProviderModelDistribution counts requests per provider for one model over a window.
// The balancer's in-memory counters only describe what it intended; this is what the
// request log actually recorded, so an operator can verify that round robin really
// spread the traffic (and see the effect of failover, which the balancer never sees).
// An empty model counts every model.
type ProviderModelShare struct {
	Provider   string `json:"provider"`
	Requests   int64  `json:"requests"`
	Failovers  int64  `json:"failovers"`
	Errors     int64  `json:"errors"`
	AvgLatency int64  `json:"avg_latency_ms"`
}

func (s *SQLStore) ProviderModelDistribution(ctx context.Context, model string, since time.Time) ([]ProviderModelShare, error) {
	where := []string{"created_at >= ?", "COALESCE(provider, '') <> ''"}
	args := []any{since.UTC().Format(time.RFC3339Nano)}
	if m := strings.TrimSpace(model); m != "" {
		where = append(where, "LOWER(COALESCE(model, '')) = ?")
		args = append(args, strings.ToLower(m))
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT COALESCE(provider, ''), COUNT(*),
			COALESCE(SUM(CASE WHEN failover <> 0 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END), 0),
			COALESCE(AVG(latency_ms), 0)
		FROM request_logs
		WHERE `+strings.Join(where, " AND ")+`
		GROUP BY COALESCE(provider, '')
		ORDER BY COUNT(*) DESC`), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ProviderModelShare{}
	for rows.Next() {
		var item ProviderModelShare
		var avg float64
		if err := rows.Scan(&item.Provider, &item.Requests, &item.Failovers, &item.Errors, &avg); err != nil {
			return nil, err
		}
		item.AvgLatency = int64(avg + 0.5)
		out = append(out, item)
	}
	return out, rows.Err()
}
