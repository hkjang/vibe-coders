package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// requestTeamExpr maps a request row (alias r) to its team. Requests whose API key
// is unknown (passthrough / anonymous / legacy) or has no team fall into "unassigned",
// so traffic that never minted a gateway proxy key is still attributed somewhere.
const requestTeamExpr = `COALESCE(NULLIF((SELECT k.team FROM api_keys k WHERE k.id = r.api_key_id), ''), 'unassigned')`

// requestTeamFilter is requestTeamExpr compared to a bound parameter.
const requestTeamFilter = requestTeamExpr + ` = ?`

// friendlyAPIKeyName turns synthetic api_key_id values into human labels.
func friendlyAPIKeyName(id string) string {
	switch id {
	case "passthrough":
		return "패스스루 (직접 키)"
	case "anonymous":
		return "익명"
	default:
		return id
	}
}

func (s *SQLStore) ListUsers(ctx context.Context) ([]UserSummary, error) {
	// Driven by the union of every api_key_id seen in traffic AND every configured key,
	// so passthrough/anonymous callers (which have no api_keys row) still appear.
	rows, err := s.db.QueryContext(ctx, `
		SELECT ids.akid AS id,
			COALESCE(NULLIF(k.name, ''), ids.akid) AS name,
			COALESCE(k.owner, '') AS owner,
			COALESCE(NULLIF(k.team, ''), '') AS team,
			COALESCE(NULLIF(k.status, ''), CASE WHEN k.id IS NULL THEN 'external' ELSE 'active' END) AS status,
			COALESCE(u.requests, 0) AS requests,
			COALESCE(u.tokens, 0) AS tokens,
			COALESCE(u.cost, 0) AS cost,
			COALESCE(u.avg_latency, 0) AS avg_latency,
			COALESCE(u.last_seen, '') AS last_seen
		FROM (
			SELECT COALESCE(NULLIF(api_key_id, ''), 'anonymous') AS akid FROM request_logs
			UNION
			SELECT id AS akid FROM api_keys
		) ids
		LEFT JOIN api_keys k ON k.id = ids.akid
		LEFT JOIN (
			SELECT COALESCE(NULLIF(r.api_key_id, ''), 'anonymous') AS akid,
				COUNT(r.id) AS requests,
				SUM(COALESCE(t.total_tokens, 0)) AS tokens,
				SUM(COALESCE(t.estimated_cost, 0)) AS cost,
				AVG(r.latency_ms) AS avg_latency,
				MAX(r.created_at) AS last_seen
			FROM request_logs r
			LEFT JOIN token_usage t ON t.request_id = r.id
			GROUP BY COALESCE(NULLIF(r.api_key_id, ''), 'anonymous')
		) u ON u.akid = ids.akid
		ORDER BY 6 DESC, 2 ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := []UserSummary{}
	for rows.Next() {
		var u UserSummary
		if err := rows.Scan(&u.APIKeyID, &u.Name, &u.Owner, &u.Team, &u.Status, &u.Requests, &u.Tokens, &u.CostKRW, &u.AverageLatencyMS, &u.LastSeen); err != nil {
			return nil, err
		}
		if u.Name == u.APIKeyID {
			u.Name = friendlyAPIKeyName(u.APIKeyID)
		}
		result = append(result, u)
	}
	return result, rows.Err()
}

func (s *SQLStore) ListIPs(ctx context.Context) ([]IPSummary, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT COALESCE(NULLIF(r.client_ip, ''), 'unknown') AS ip,
			COUNT(r.id) AS requests,
			COALESCE(SUM(t.total_tokens), 0) AS tokens,
			COALESCE(SUM(t.estimated_cost), 0) AS cost,
			COALESCE(AVG(r.latency_ms), 0) AS avg_latency,
			COALESCE(MAX(r.created_at), '') AS last_seen,
			COUNT(DISTINCT NULLIF(r.api_key_id, '')) AS distinct_keys
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		GROUP BY COALESCE(NULLIF(r.client_ip, ''), 'unknown')
		ORDER BY requests DESC
		LIMIT 200
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := []IPSummary{}
	for rows.Next() {
		var ip IPSummary
		if err := rows.Scan(&ip.IP, &ip.Requests, &ip.Tokens, &ip.CostKRW, &ip.AverageLatencyMS, &ip.LastSeen, &ip.DistinctKeys); err != nil {
			return nil, err
		}
		result = append(result, ip)
	}
	return result, rows.Err()
}

func (s *SQLStore) ListTeams(ctx context.Context) ([]TeamSummary, error) {
	// Driven by request_logs so passthrough/anonymous traffic lands in "unassigned".
	// token_usage is 1:1 with request_logs, so the direct join does not multiply counts.
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+requestTeamExpr+` AS team,
			COUNT(DISTINCT COALESCE(NULLIF(r.api_key_id, ''), 'anonymous')) AS keys,
			COUNT(r.id) AS requests,
			SUM(COALESCE(t.total_tokens, 0)) AS tokens,
			SUM(COALESCE(t.estimated_cost, 0)) AS cost,
			AVG(r.latency_ms) AS avg_latency,
			MAX(r.created_at) AS last_seen
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		GROUP BY `+requestTeamExpr+`
		ORDER BY requests DESC, team ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := []TeamSummary{}
	for rows.Next() {
		var item TeamSummary
		var tokens, requests sql.NullInt64
		var cost, avgLatency sql.NullFloat64
		var lastSeen sql.NullString
		if err := rows.Scan(&item.Team, &item.Keys, &requests, &tokens, &cost, &avgLatency, &lastSeen); err != nil {
			return nil, err
		}
		item.Requests = requests.Int64
		item.Tokens = tokens.Int64
		item.CostKRW = cost.Float64
		item.AverageLatencyMS = avgLatency.Float64
		item.LastSeen = lastSeen.String
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *SQLStore) GetUserDetail(ctx context.Context, apiKeyID string, recent int) (UserDetail, error) {
	detail := UserDetail{
		Daily:      []TimeseriesPoint{},
		ByModel:    []GroupedStat{},
		ByLanguage: []LanguageGrouped{},
		ByIP:       []GroupedStat{},
		ByStatus:   []StatusBucket{},
		Recent:     []RecentRequest{},
		Heatmap:    Heatmap{Cells: []HeatmapCell{}},
		LLM: UserLLMDetail{
			Timeseries:     []LLMTimeseriesPoint{},
			Prompts:        []LLMPromptSummary{},
			FeedbackLabels: []LLMFeedbackLabelSummary{},
		},
	}

	key := APIKeyPublic{}
	err := s.db.QueryRowContext(ctx, s.bind(`
		SELECT id, name, COALESCE(owner, ''), COALESCE(team, ''), status, created_at
		FROM api_keys WHERE id = ?
	`), apiKeyID).Scan(&key.ID, &key.Name, &key.Owner, &key.Team, &key.Status, &key.CreatedAt)
	if err == sql.ErrNoRows {
		// passthrough / anonymous / legacy callers have no api_keys row. Only treat as
		// a synthetic user if they actually produced traffic; otherwise it's a 404.
		var seen int
		if cErr := s.db.QueryRowContext(ctx, s.bind(`SELECT COUNT(1) FROM request_logs WHERE api_key_id = ? LIMIT 1`), apiKeyID).Scan(&seen); cErr != nil {
			return detail, cErr
		}
		if seen == 0 {
			return detail, ErrNotFound
		}
		key = APIKeyPublic{ID: apiKeyID, Name: friendlyAPIKeyName(apiKeyID), Status: "external"}
	} else if err != nil {
		return detail, err
	}
	detail.APIKey = key

	stats := UserSummary{APIKeyID: key.ID, Name: key.Name, Owner: key.Owner, Team: key.Team, Status: key.Status}
	err = s.db.QueryRowContext(ctx, s.bind(`
		SELECT COUNT(r.id),
			COALESCE(SUM(t.total_tokens), 0),
			COALESCE(SUM(t.estimated_cost), 0),
			COALESCE(AVG(r.latency_ms), 0),
			COALESCE(MAX(r.created_at), '')
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE r.api_key_id = ?
	`), apiKeyID).Scan(&stats.Requests, &stats.Tokens, &stats.CostKRW, &stats.AverageLatencyMS, &stats.LastSeen)
	if err != nil {
		return detail, err
	}
	detail.Stats = stats

	if detail.Advanced, err = s.userAdvancedStats(ctx, apiKeyID); err != nil {
		return detail, err
	}
	if detail.ByStatus, err = s.statusBreakdownFilter(ctx, "r.api_key_id = ?", apiKeyID); err != nil {
		return detail, err
	}
	if detail.Heatmap, err = s.heatmapKSTFilter(ctx, time.Now().Add(-30*24*time.Hour), "r.api_key_id = ?", apiKeyID); err != nil {
		return detail, err
	}
	if detail.Daily, err = s.dailyTimeseries(ctx, "r.api_key_id = ?", apiKeyID); err != nil {
		return detail, err
	}
	if detail.ByModel, err = s.groupedFilter(ctx, "r.model", "r.api_key_id = ?", apiKeyID); err != nil {
		return detail, err
	}
	if detail.ByIP, err = s.groupedFilter(ctx, "r.client_ip", "r.api_key_id = ?", apiKeyID); err != nil {
		return detail, err
	}
	if detail.ByLanguage, err = s.languagesFilter(ctx, "r.api_key_id = ?", apiKeyID); err != nil {
		return detail, err
	}
	if detail.LLM.Summary, err = s.userLLMStats(ctx, apiKeyID); err != nil {
		return detail, err
	}
	if detail.LLM.Timeseries, err = s.llmTimeseriesFilter(ctx, "hour", time.Now().Add(-24*time.Hour), "r.api_key_id = ?", apiKeyID); err != nil {
		return detail, err
	}
	if detail.LLM.Prompts, err = s.llmPromptsFilter(ctx, "r.api_key_id = ?", 10, apiKeyID); err != nil {
		return detail, err
	}
	if detail.LLM.FeedbackLabels, err = s.llmFeedbackLabelsFilter(ctx, "r.api_key_id = ?", 10, apiKeyID); err != nil {
		return detail, err
	}
	if detail.Recent, err = s.RecentRequests(ctx, RequestFilter{Limit: recent, APIKeyID: apiKeyID}); err != nil {
		return detail, err
	}

	return detail, nil
}

func (s *SQLStore) GetTeamDetail(ctx context.Context, team string, recent int) (TeamDetail, error) {
	detail := TeamDetail{
		Daily:      []TimeseriesPoint{},
		ByModel:    []GroupedStat{},
		ByLanguage: []LanguageGrouped{},
		ByIP:       []GroupedStat{},
		ByKey:      []GroupedStat{},
		ByStatus:   []StatusBucket{},
		Recent:     []RecentRequest{},
		Heatmap:    Heatmap{Cells: []HeatmapCell{}},
		LLM: UserLLMDetail{
			Timeseries:     []LLMTimeseriesPoint{},
			Prompts:        []LLMPromptSummary{},
			FeedbackLabels: []LLMFeedbackLabelSummary{},
		},
	}
	whereClause := requestTeamFilter
	err := s.db.QueryRowContext(ctx, s.bind(`
		SELECT `+requestTeamExpr+` AS team,
			COUNT(DISTINCT COALESCE(NULLIF(r.api_key_id, ''), 'anonymous')) AS keys,
			COUNT(r.id) AS requests,
			COALESCE(SUM(t.total_tokens), 0) AS tokens,
			COALESCE(SUM(t.estimated_cost), 0) AS cost,
			COALESCE(AVG(r.latency_ms), 0) AS avg_latency,
			COALESCE(MAX(r.created_at), '') AS last_seen
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE `+whereClause+`
		GROUP BY `+requestTeamExpr+`
	`), team).Scan(&detail.Stats.Team, &detail.Stats.Keys, &detail.Stats.Requests, &detail.Stats.Tokens, &detail.Stats.CostKRW, &detail.Stats.AverageLatencyMS, &detail.Stats.LastSeen)
	if err == sql.ErrNoRows {
		return detail, ErrNotFound
	}
	if err != nil {
		return detail, err
	}
	if detail.Advanced, err = s.teamAdvancedStats(ctx, team); err != nil {
		return detail, err
	}
	if detail.ByStatus, err = s.statusBreakdownFilter(ctx, whereClause, team); err != nil {
		return detail, err
	}
	if detail.Heatmap, err = s.heatmapKSTFilter(ctx, time.Now().Add(-30*24*time.Hour), whereClause, team); err != nil {
		return detail, err
	}
	if detail.Daily, err = s.dailyTimeseries(ctx, whereClause, team); err != nil {
		return detail, err
	}
	if detail.ByModel, err = s.groupedFilter(ctx, "r.model", whereClause, team); err != nil {
		return detail, err
	}
	if detail.ByIP, err = s.groupedFilter(ctx, "r.client_ip", whereClause, team); err != nil {
		return detail, err
	}
	if detail.ByKey, err = s.groupedFilter(ctx, "r.api_key_id", whereClause, team); err != nil {
		return detail, err
	}
	if detail.ByLanguage, err = s.languagesFilter(ctx, whereClause, team); err != nil {
		return detail, err
	}
	if detail.LLM.Summary, err = s.teamLLMStats(ctx, team); err != nil {
		return detail, err
	}
	if detail.LLM.Timeseries, err = s.llmTimeseriesFilter(ctx, "hour", time.Now().Add(-24*time.Hour), whereClause, team); err != nil {
		return detail, err
	}
	if detail.LLM.Prompts, err = s.llmPromptsFilter(ctx, whereClause, 10, team); err != nil {
		return detail, err
	}
	if detail.LLM.FeedbackLabels, err = s.llmFeedbackLabelsFilter(ctx, whereClause, 10, team); err != nil {
		return detail, err
	}
	if detail.Recent, err = s.RecentRequests(ctx, RequestFilter{Limit: recent, Team: team}); err != nil {
		return detail, err
	}
	return detail, nil
}

func (s *SQLStore) userLLMStats(ctx context.Context, apiKeyID string) (UserLLMStats, error) {
	var stats UserLLMStats
	var aligned int64
	err := s.db.QueryRowContext(ctx, s.bind(`
		WITH feedback_per_request AS (
			SELECT request_id,
				COUNT(*) AS feedback_total,
				COALESCE(SUM(CASE WHEN rating < 0 THEN 1 ELSE 0 END), 0) AS negative_feedback,
				MAX(CASE WHEN rating < 0 THEN 1 ELSE 0 END) AS human_negative
			FROM llm_feedback
			GROUP BY request_id
		),
		evaluation_per_request AS (
			SELECT request_id,
				COUNT(*) AS evaluations,
				COALESCE(SUM(CASE WHEN passed = 0 THEN 1 ELSE 0 END), 0) AS eval_failures,
				MAX(CASE WHEN passed = 0 THEN 1 ELSE 0 END) AS eval_failed
			FROM llm_evaluations
			GROUP BY request_id
		),
		per_request AS (
			SELECT r.id,
				COALESCE(NULLIF(r.session_id, ''), '') AS session_id,
				COALESCE(NULLIF(r.prompt_name, ''), 'ad-hoc') AS prompt_name,
				COALESCE(r.prompt_version, '') AS prompt_version,
				COALESCE(r.first_chunk_ms, 0) AS first_chunk_ms,
				r.created_at,
				COALESCE(fp.human_negative, 0) AS human_negative,
				COALESCE(ep.eval_failed, 0) AS eval_failed,
				COALESCE(ep.evaluations, 0) AS evaluations,
				COALESCE(ep.eval_failures, 0) AS eval_failures,
				COALESCE(fp.feedback_total, 0) AS feedback_total,
				COALESCE(fp.negative_feedback, 0) AS negative_feedback
			FROM request_logs r
			LEFT JOIN feedback_per_request fp ON fp.request_id = r.id
			LEFT JOIN evaluation_per_request ep ON ep.request_id = r.id
			WHERE r.api_key_id = ?
		)
		SELECT COUNT(*),
			COUNT(DISTINCT NULLIF(session_id, '')),
			COUNT(DISTINCT prompt_name || '::' || prompt_version),
			COALESCE(SUM(evaluations), 0),
			COALESCE(SUM(eval_failures), 0),
			COALESCE(SUM(feedback_total), 0),
			COALESCE(SUM(negative_feedback), 0),
			COALESCE(SUM(CASE WHEN feedback_total > 0 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN feedback_total > 0 AND human_negative = eval_failed THEN 1 ELSE 0 END), 0),
			COALESCE(AVG(CASE WHEN first_chunk_ms > 0 THEN first_chunk_ms END), 0),
			COALESCE(MAX(created_at), '')
		FROM per_request
	`), apiKeyID).Scan(
		&stats.Requests,
		&stats.Sessions,
		&stats.PromptVariants,
		&stats.Evaluations,
		&stats.EvalFailures,
		&stats.FeedbackTotal,
		&stats.NegativeFeedback,
		&stats.AlignmentSamples,
		&aligned,
		&stats.AverageFirstChunkMS,
		&stats.LastSeen,
	)
	if err != nil {
		return stats, err
	}
	if stats.AlignmentSamples > 0 {
		stats.AlignmentRate = float64(aligned) / float64(stats.AlignmentSamples)
	}
	return stats, nil
}

func (s *SQLStore) teamLLMStats(ctx context.Context, team string) (UserLLMStats, error) {
	var stats UserLLMStats
	var aligned int64
	err := s.db.QueryRowContext(ctx, s.bind(`
		WITH feedback_per_request AS (
			SELECT request_id,
				COUNT(*) AS feedback_total,
				COALESCE(SUM(CASE WHEN rating < 0 THEN 1 ELSE 0 END), 0) AS negative_feedback,
				MAX(CASE WHEN rating < 0 THEN 1 ELSE 0 END) AS human_negative
			FROM llm_feedback
			GROUP BY request_id
		),
		evaluation_per_request AS (
			SELECT request_id,
				COUNT(*) AS evaluations,
				COALESCE(SUM(CASE WHEN passed = 0 THEN 1 ELSE 0 END), 0) AS eval_failures,
				MAX(CASE WHEN passed = 0 THEN 1 ELSE 0 END) AS eval_failed
			FROM llm_evaluations
			GROUP BY request_id
		),
		per_request AS (
			SELECT r.id,
				COALESCE(NULLIF(r.session_id, ''), '') AS session_id,
				COALESCE(NULLIF(r.prompt_name, ''), 'ad-hoc') AS prompt_name,
				COALESCE(r.prompt_version, '') AS prompt_version,
				COALESCE(r.first_chunk_ms, 0) AS first_chunk_ms,
				r.created_at,
				COALESCE(fp.human_negative, 0) AS human_negative,
				COALESCE(ep.eval_failed, 0) AS eval_failed,
				COALESCE(ep.evaluations, 0) AS evaluations,
				COALESCE(ep.eval_failures, 0) AS eval_failures,
				COALESCE(fp.feedback_total, 0) AS feedback_total,
				COALESCE(fp.negative_feedback, 0) AS negative_feedback
			FROM request_logs r
			LEFT JOIN feedback_per_request fp ON fp.request_id = r.id
			LEFT JOIN evaluation_per_request ep ON ep.request_id = r.id
			WHERE `+requestTeamFilter+`
		)
		SELECT COUNT(*),
			COUNT(DISTINCT NULLIF(session_id, '')),
			COUNT(DISTINCT prompt_name || '::' || prompt_version),
			COALESCE(SUM(evaluations), 0),
			COALESCE(SUM(eval_failures), 0),
			COALESCE(SUM(feedback_total), 0),
			COALESCE(SUM(negative_feedback), 0),
			COALESCE(SUM(CASE WHEN feedback_total > 0 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN feedback_total > 0 AND human_negative = eval_failed THEN 1 ELSE 0 END), 0),
			COALESCE(AVG(CASE WHEN first_chunk_ms > 0 THEN first_chunk_ms END), 0),
			COALESCE(MAX(created_at), '')
		FROM per_request
	`), team).Scan(
		&stats.Requests,
		&stats.Sessions,
		&stats.PromptVariants,
		&stats.Evaluations,
		&stats.EvalFailures,
		&stats.FeedbackTotal,
		&stats.NegativeFeedback,
		&stats.AlignmentSamples,
		&aligned,
		&stats.AverageFirstChunkMS,
		&stats.LastSeen,
	)
	if err != nil {
		return stats, err
	}
	if stats.AlignmentSamples > 0 {
		stats.AlignmentRate = float64(aligned) / float64(stats.AlignmentSamples)
	}
	return stats, nil
}

func (s *SQLStore) userAdvancedStats(ctx context.Context, apiKeyID string) (UserAdvancedStats, error) {
	var stats UserAdvancedStats
	since24h := time.Now().Add(-24 * time.Hour).UTC().Format(time.RFC3339Nano)
	var totalRequests int64
	err := s.db.QueryRowContext(ctx, s.bind(`
		SELECT
			COUNT(r.id),
			COALESCE(SUM(CASE WHEN r.status_code >= 400 THEN 1 ELSE 0 END), 0),
			COALESCE(AVG(NULLIF(r.first_chunk_ms, 0)), 0),
			COALESCE(SUM(t.prompt_tokens), 0),
			COALESCE(SUM(t.completion_tokens), 0),
			COALESCE(SUM(t.cached_tokens), 0),
			COALESCE(SUM(t.reasoning_tokens), 0),
			COUNT(DISTINCT NULLIF(r.model, '')),
			COUNT(DISTINCT NULLIF(r.client_ip, '')),
			COALESCE(SUM(CASE WHEN r.created_at >= ? THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN r.created_at >= ? THEN t.total_tokens ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN r.created_at >= ? THEN t.estimated_cost ELSE 0 END), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE r.api_key_id = ?
	`), since24h, since24h, since24h, apiKeyID).Scan(
		&totalRequests,
		&stats.Errors,
		&stats.AverageFirstChunkMS,
		&stats.PromptTokens,
		&stats.CompletionTokens,
		&stats.CachedTokens,
		&stats.ReasoningTokens,
		&stats.DistinctModels,
		&stats.DistinctIPs,
		&stats.Requests24h,
		&stats.Tokens24h,
		&stats.CostKRW24h,
	)
	if err != nil {
		return stats, err
	}
	if totalRequests > 0 {
		stats.ErrorRate = float64(stats.Errors) / float64(totalRequests)
	}

	latencies, firstChunks, err := s.latencySamplesFilter(ctx, "r.api_key_id = ?", apiKeyID)
	if err != nil {
		return stats, err
	}
	stats.LatencyP95MS = percentile95MS(latencies)
	stats.FirstChunkP95MS = percentile95MS(firstChunks)
	return stats, nil
}

func (s *SQLStore) teamAdvancedStats(ctx context.Context, team string) (UserAdvancedStats, error) {
	var stats UserAdvancedStats
	since24h := time.Now().Add(-24 * time.Hour).UTC().Format(time.RFC3339Nano)
	var totalRequests int64
	teamWhere := requestTeamFilter
	err := s.db.QueryRowContext(ctx, s.bind(`
		SELECT
			COUNT(r.id),
			COALESCE(SUM(CASE WHEN r.status_code >= 400 THEN 1 ELSE 0 END), 0),
			COALESCE(AVG(NULLIF(r.first_chunk_ms, 0)), 0),
			COALESCE(SUM(t.prompt_tokens), 0),
			COALESCE(SUM(t.completion_tokens), 0),
			COALESCE(SUM(t.cached_tokens), 0),
			COALESCE(SUM(t.reasoning_tokens), 0),
			COUNT(DISTINCT NULLIF(r.model, '')),
			COUNT(DISTINCT NULLIF(r.client_ip, '')),
			COALESCE(SUM(CASE WHEN r.created_at >= ? THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN r.created_at >= ? THEN t.total_tokens ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN r.created_at >= ? THEN t.estimated_cost ELSE 0 END), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE `+teamWhere+`
	`), since24h, since24h, since24h, team).Scan(
		&totalRequests,
		&stats.Errors,
		&stats.AverageFirstChunkMS,
		&stats.PromptTokens,
		&stats.CompletionTokens,
		&stats.CachedTokens,
		&stats.ReasoningTokens,
		&stats.DistinctModels,
		&stats.DistinctIPs,
		&stats.Requests24h,
		&stats.Tokens24h,
		&stats.CostKRW24h,
	)
	if err != nil {
		return stats, err
	}
	if totalRequests > 0 {
		stats.ErrorRate = float64(stats.Errors) / float64(totalRequests)
	}
	latencies, firstChunks, err := s.latencySamplesFilter(ctx, teamWhere, team)
	if err != nil {
		return stats, err
	}
	stats.LatencyP95MS = percentile95MS(latencies)
	stats.FirstChunkP95MS = percentile95MS(firstChunks)
	return stats, nil
}

func (s *SQLStore) latencySamplesFilter(ctx context.Context, whereClause string, args ...any) ([]int64, []int64, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(fmt.Sprintf(`
		SELECT r.latency_ms, COALESCE(r.first_chunk_ms, 0)
		FROM request_logs r
		WHERE %s
	`, whereClause)), args...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	latencies := []int64{}
	firstChunks := []int64{}
	for rows.Next() {
		var latency int64
		var firstChunk int64
		if err := rows.Scan(&latency, &firstChunk); err != nil {
			return nil, nil, err
		}
		latencies = append(latencies, latency)
		firstChunks = append(firstChunks, firstChunk)
	}
	return latencies, firstChunks, rows.Err()
}

func (s *SQLStore) statusBreakdownFilter(ctx context.Context, whereClause string, args ...any) ([]StatusBucket, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(fmt.Sprintf(`
		SELECT r.status_code, COUNT(*)
		FROM request_logs r
		WHERE %s
		GROUP BY r.status_code
	`, whereClause)), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	buckets := map[string]int64{}
	for rows.Next() {
		var code int
		var count int64
		if err := rows.Scan(&code, &count); err != nil {
			return nil, err
		}
		buckets[statusClass(code)] += count
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	result := []StatusBucket{}
	for _, class := range []string{"2xx", "3xx", "4xx", "quota", "5xx"} {
		if v, ok := buckets[class]; ok && v > 0 {
			result = append(result, StatusBucket{Class: class, Requests: v})
		}
	}
	return result, nil
}

func (s *SQLStore) GetIPDetail(ctx context.Context, ip string, recent int) (IPDetail, error) {
	detail := IPDetail{Daily: []TimeseriesPoint{}, ByModel: []GroupedStat{}, ByLanguage: []LanguageGrouped{}, ByKey: []GroupedStat{}, Recent: []RecentRequest{}}

	stats := IPSummary{IP: ip}
	err := s.db.QueryRowContext(ctx, s.bind(`
		SELECT COUNT(r.id),
			COALESCE(SUM(t.total_tokens), 0),
			COALESCE(SUM(t.estimated_cost), 0),
			COALESCE(AVG(r.latency_ms), 0),
			COALESCE(MAX(r.created_at), ''),
			COUNT(DISTINCT NULLIF(r.api_key_id, ''))
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE COALESCE(NULLIF(r.client_ip, ''), 'unknown') = ?
	`), ip).Scan(&stats.Requests, &stats.Tokens, &stats.CostKRW, &stats.AverageLatencyMS, &stats.LastSeen, &stats.DistinctKeys)
	if err != nil {
		return detail, err
	}
	if stats.Requests == 0 {
		return detail, ErrNotFound
	}
	detail.Stats = stats

	if detail.Daily, err = s.dailyTimeseries(ctx, "COALESCE(NULLIF(r.client_ip, ''), 'unknown') = ?", ip); err != nil {
		return detail, err
	}
	if detail.ByModel, err = s.groupedFilter(ctx, "r.model", "COALESCE(NULLIF(r.client_ip, ''), 'unknown') = ?", ip); err != nil {
		return detail, err
	}
	if detail.ByKey, err = s.groupedFilter(ctx, "r.api_key_id", "COALESCE(NULLIF(r.client_ip, ''), 'unknown') = ?", ip); err != nil {
		return detail, err
	}
	if detail.ByLanguage, err = s.languagesFilter(ctx, "COALESCE(NULLIF(r.client_ip, ''), 'unknown') = ?", ip); err != nil {
		return detail, err
	}
	if detail.Recent, err = s.RecentRequests(ctx, RequestFilter{Limit: recent, IP: ip}); err != nil {
		return detail, err
	}
	return detail, nil
}

func (s *SQLStore) dailyTimeseries(ctx context.Context, whereClause string, args ...any) ([]TimeseriesPoint, error) {
	query := s.bind(fmt.Sprintf(`
		SELECT substr(r.created_at, 1, 10) AS day,
			COUNT(r.id),
			COALESCE(SUM(t.total_tokens), 0),
			COALESCE(SUM(t.estimated_cost), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE %s
		GROUP BY substr(r.created_at, 1, 10)
		ORDER BY day DESC
		LIMIT 60
	`, whereClause))

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := []TimeseriesPoint{}
	for rows.Next() {
		var p TimeseriesPoint
		if err := rows.Scan(&p.Date, &p.Requests, &p.Tokens, &p.CostKRW); err != nil {
			return nil, err
		}
		result = append(result, p)
	}
	return result, rows.Err()
}

func (s *SQLStore) groupedFilter(ctx context.Context, column string, whereClause string, args ...any) ([]GroupedStat, error) {
	allowed := map[string]bool{"r.client_ip": true, "r.model": true, "r.api_key_id": true, "r.provider": true}
	if !allowed[column] {
		return nil, fmt.Errorf("unsupported grouping column %q", column)
	}
	query := s.bind(fmt.Sprintf(`
		SELECT COALESCE(NULLIF(%s, ''), 'unknown') AS key,
			COUNT(r.id) AS requests,
			COALESCE(SUM(t.total_tokens), 0) AS tokens,
			COALESCE(SUM(t.estimated_cost), 0) AS cost,
			COALESCE(AVG(r.latency_ms), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE %s
		GROUP BY COALESCE(NULLIF(%s, ''), 'unknown')
		ORDER BY requests DESC
		LIMIT 50
	`, column, whereClause, column))

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := []GroupedStat{}
	for rows.Next() {
		var g GroupedStat
		if err := rows.Scan(&g.Key, &g.Requests, &g.Tokens, &g.CostKRW, &g.AverageLatencyMS); err != nil {
			return nil, err
		}
		result = append(result, g)
	}
	return result, rows.Err()
}

func (s *SQLStore) languagesFilter(ctx context.Context, whereClause string, args ...any) ([]LanguageGrouped, error) {
	query := s.bind(fmt.Sprintf(`
		SELECT ls.language, COUNT(DISTINCT ls.request_id), COALESCE(AVG(ls.confidence), 0)
		FROM language_stats ls
		JOIN request_logs r ON r.id = ls.request_id
		WHERE %s
		GROUP BY ls.language
		ORDER BY COUNT(DISTINCT ls.request_id) DESC
		LIMIT 50
	`, whereClause))

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := []LanguageGrouped{}
	for rows.Next() {
		var lg LanguageGrouped
		if err := rows.Scan(&lg.Language, &lg.Requests, &lg.AverageConfidence); err != nil {
			return nil, err
		}
		result = append(result, lg)
	}
	return result, rows.Err()
}

func (s *SQLStore) RequestDetail(ctx context.Context, id string) (RequestDetail, error) {
	detail := RequestDetail{Prompts: []PromptDetail{}, Languages: []LanguageStat{}, Feedback: []LLMFeedback{}}

	query := s.bind(`
		SELECT r.id, r.trace_id, COALESCE(r.api_key_id, ''), COALESCE(r.client_ip, ''), COALESCE(r.forwarded_for, ''),
			COALESCE(r.user_agent, ''), COALESCE(r.model, ''), r.endpoint, r.stream, COALESCE(r.provider, ''),
			r.status_code, r.latency_ms, COALESCE(r.first_chunk_ms, 0),
			COALESCE(r.session_id, ''), COALESCE(r.prompt_name, ''), COALESCE(r.prompt_version, ''),
			COALESCE(r.prompt_variables_hash, ''), COALESCE(r.tool_count, 0), COALESCE(r.error, ''),
			COALESCE(t.prompt_tokens, 0), COALESCE(t.completion_tokens, 0), COALESCE(t.total_tokens, 0),
			COALESCE(t.cached_tokens, 0), COALESCE(t.reasoning_tokens, 0),
			COALESCE(t.estimated_cost, 0), COALESCE(t.currency, ''), COALESCE(t.source, ''),
			COALESCE(resp.finish_reason, ''), r.created_at
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		LEFT JOIN response_logs resp ON resp.request_id = r.id
		WHERE r.id = ?
	`)
	row := s.db.QueryRowContext(ctx, query, id)
	var item RecentRequest
	var streamInt int
	if err := row.Scan(&item.ID, &item.TraceID, &item.APIKeyID, &item.ClientIP, &item.ForwardedFor,
		&item.UserAgent, &item.Model, &item.Endpoint, &streamInt, &item.Provider,
		&item.StatusCode, &item.LatencyMS, &item.FirstChunkMS,
		&item.SessionID, &item.PromptName, &item.PromptVersion, &item.PromptVariablesHash, &item.ToolCount, &item.Error,
		&item.PromptTokens, &item.CompletionTokens, &item.TotalTokens,
		&item.CachedTokens, &item.ReasoningTokens,
		&item.EstimatedCost, &item.Currency, &item.TokenSource,
		&item.FinishReason, &item.CreatedAt); err != nil {
		if err == sql.ErrNoRows {
			return detail, ErrNotFound
		}
		return detail, err
	}
	item.Stream = streamInt == 1
	languages, err := s.languagesForRequest(ctx, item.ID)
	if err != nil {
		return detail, err
	}
	item.Languages = languages
	previews, err := s.promptsForRequest(ctx, item.ID)
	if err != nil {
		return detail, err
	}
	item.Prompts = previews
	detail.Request = item
	detail.Languages = languages
	tools, err := s.ToolsForRequest(ctx, item.ID)
	if err != nil {
		return detail, err
	}
	detail.Tools = tools
	detail.Spans = llmSpansForRequest(item, tools)
	if text2sqlSpans, err := s.Text2SQLSpansForRequest(ctx, item.ID); err != nil {
		return detail, err
	} else {
		detail.Text2SQLSpans = text2sqlSpans
	}
	if secretEvents, err := s.SecretEventsForRequest(ctx, item.ID); err != nil {
		return detail, err
	} else {
		detail.Governance.SecretEvents = secretEvents
	}
	if approvals, err := s.ApprovalsForRequest(ctx, item.ID); err != nil {
		return detail, err
	} else {
		detail.Governance.Approvals = approvals
	}
	if anomalyEvents, err := s.AnomalyEventsForRequest(ctx, item.ID, time.Hour); err != nil {
		return detail, err
	} else {
		detail.Governance.AnomalyEvents = anomalyEvents
	}
	if policyDecisions, err := s.PolicyDecisionEventsForRequest(ctx, item.ID); err != nil {
		return detail, err
	} else {
		detail.Governance.PolicyDecisions = policyDecisions
	}
	evaluations, err := s.EvaluationsForRequest(ctx, item.ID)
	if err != nil {
		return detail, err
	}
	detail.Evaluations = evaluations
	feedback, err := s.FeedbackForRequest(ctx, item.ID)
	if err != nil {
		return detail, err
	}
	detail.Feedback = feedback

	prompts, err := s.promptDetailsForRequest(ctx, item.ID)
	if err != nil {
		return detail, err
	}
	detail.Prompts = prompts

	resp, found, err := s.responseDetailForRequest(ctx, item.ID)
	if err != nil {
		return detail, err
	}
	if found {
		detail.Response = &resp
	}

	cv, cvFound, err := s.codeVerifyForRequest(ctx, item.ID)
	if err != nil {
		return detail, err
	}
	if cvFound {
		detail.CodeVerify = &cv
	}
	return detail, nil
}

func (s *SQLStore) FeedbackForRequest(ctx context.Context, requestID string) ([]LLMFeedback, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT id, request_id, trace_id, rating, label, COALESCE(comment, ''), source, COALESCE(created_by, ''), created_at
		FROM llm_feedback
		WHERE request_id = ?
		ORDER BY created_at DESC
	`), requestID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanLLMFeedback(rows)
}

func llmSpansForRequest(item RecentRequest, tools []ToolInvocation) []LLMSpan {
	status := "ok"
	if item.StatusCode >= 400 || item.Error != "" {
		status = "error"
	}
	kind := "llm"
	if strings.Contains(strings.ToLower(item.Endpoint), "embeddings") {
		kind = "embedding"
	}
	rootID := "span:" + item.ID + ":root"
	spans := []LLMSpan{{
		ID:               rootID,
		TraceID:          item.TraceID,
		RequestID:        item.ID,
		Name:             item.Endpoint,
		Kind:             kind,
		Status:           status,
		Error:            item.Error,
		LatencyMS:        item.LatencyMS,
		FirstChunkMS:     item.FirstChunkMS,
		PromptTokens:     item.PromptTokens,
		CompletionTokens: item.CompletionTokens,
		TotalTokens:      item.TotalTokens,
		EstimatedCost:    item.EstimatedCost,
		ToolCount:        item.ToolCount,
		CreatedAt:        item.CreatedAt,
	}}
	// Emit one span per actual tool call/result so the trace explorer shows real
	// MCP/tool spans (Datadog-style) instead of a single aggregate.
	emitted := 0
	for i, t := range tools {
		if t.Source == "definition" {
			continue // definitions are catalog, not spans
		}
		spanStatus := "ok"
		if t.IsError {
			spanStatus = "error"
		}
		name := t.ToolName
		if t.ServerLabel != "" && t.ServerLabel != "(none)" {
			name = t.ServerLabel + " · " + t.ToolName
		}
		spanKind := "tool"
		if t.IsMCP {
			spanKind = "mcp"
		}
		errText := ""
		if t.IsError {
			errText = "tool returned an error result"
		}
		spans = append(spans, LLMSpan{
			ID:        "span:" + item.ID + ":tool:" + itoa(i),
			TraceID:   item.TraceID,
			RequestID: item.ID,
			ParentID:  rootID,
			Name:      name,
			Kind:      spanKind,
			Status:    spanStatus,
			Error:     errText,
			ToolCount: 1,
			CreatedAt: item.CreatedAt,
		})
		emitted++
	}
	// Fall back to the aggregate span when no per-tool rows exist but tool_count > 0
	// (legacy rows captured before tool tracking shipped).
	if emitted == 0 && item.ToolCount > 0 {
		spans = append(spans, LLMSpan{
			ID:        "span:" + item.ID + ":tools",
			TraceID:   item.TraceID,
			RequestID: item.ID,
			ParentID:  rootID,
			Name:      "tool_calls",
			Kind:      "tool",
			Status:    status,
			Error:     item.Error,
			ToolCount: item.ToolCount,
			CreatedAt: item.CreatedAt,
		})
	}
	return spans
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	buf := [20]byte{}
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func (s *SQLStore) promptDetailsForRequest(ctx context.Context, requestID string) ([]PromptDetail, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT id, request_id, role, content_hash, COALESCE(content_text, ''), COALESCE(redacted_text, ''), COALESCE(language_hint, ''), created_at
		FROM prompt_logs
		WHERE request_id = ?
		ORDER BY created_at ASC
	`), requestID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := []PromptDetail{}
	for rows.Next() {
		var p PromptDetail
		if err := rows.Scan(&p.ID, &p.RequestID, &p.Role, &p.ContentHash, &p.ContentText, &p.RedactedText, &p.LanguageHint, &p.CreatedAt); err != nil {
			return nil, err
		}
		result = append(result, p)
	}
	return result, rows.Err()
}

func (s *SQLStore) responseDetailForRequest(ctx context.Context, requestID string) (ResponseDetail, bool, error) {
	var detail ResponseDetail
	err := s.db.QueryRowContext(ctx, s.bind(`
		SELECT status_code, COALESCE(finish_reason, ''), COALESCE(response_hash, ''), COALESCE(response_text_optional, ''), created_at
		FROM response_logs WHERE request_id = ?
	`), requestID).Scan(&detail.StatusCode, &detail.FinishReason, &detail.ResponseHash, &detail.ResponseTextOptional, &detail.CreatedAt)
	if err == sql.ErrNoRows {
		return ResponseDetail{}, false, nil
	}
	if err != nil {
		return ResponseDetail{}, false, err
	}
	return detail, true, nil
}

func (s *SQLStore) codeVerifyForRequest(ctx context.Context, requestID string) (CodeVerifyDetail, bool, error) {
	var d CodeVerifyDetail
	var hasCode int
	var findings string
	err := s.db.QueryRowContext(ctx, s.bind(`
		SELECT has_code, COALESCE(risk, ''), block_count, COALESCE(languages, ''),
			high_count, medium_count, syntax_count, secret_count, testable_count,
			COALESCE(findings_json, ''), created_at
		FROM code_verify_results WHERE request_id = ?
		ORDER BY created_at DESC LIMIT 1
	`), requestID).Scan(&hasCode, &d.Risk, &d.BlockCount, &d.Languages,
		&d.HighCount, &d.MediumCount, &d.SyntaxCount, &d.SecretCount, &d.TestableCount,
		&findings, &d.CreatedAt)
	if err == sql.ErrNoRows {
		return CodeVerifyDetail{}, false, nil
	}
	if err != nil {
		return CodeVerifyDetail{}, false, err
	}
	d.HasCode = hasCode != 0
	if strings.TrimSpace(findings) == "" {
		findings = "[]"
	}
	d.Findings = json.RawMessage(findings)
	return d, true, nil
}

// CodeVerifyByTrace returns the persisted code verdicts for every request sharing a trace.
func (s *SQLStore) CodeVerifyByTrace(ctx context.Context, traceID string) ([]CodeVerifyLog, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT id, request_id, trace_id, has_code, COALESCE(risk, ''), block_count, COALESCE(languages, ''),
			high_count, medium_count, syntax_count, secret_count, testable_count, COALESCE(findings_json, ''), created_at
		FROM code_verify_results WHERE trace_id = ? ORDER BY created_at DESC
	`), traceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CodeVerifyLog{}
	for rows.Next() {
		var c CodeVerifyLog
		var hasCode int
		var created string
		if err := rows.Scan(&c.ID, &c.RequestID, &c.TraceID, &hasCode, &c.Risk, &c.BlockCount, &c.Languages,
			&c.HighCount, &c.MediumCount, &c.SyntaxCount, &c.SecretCount, &c.TestableCount, &c.FindingsJSON, &created); err != nil {
			return nil, err
		}
		c.HasCode = hasCode != 0
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *SQLStore) EvaluationsForRequest(ctx context.Context, requestID string) ([]LLMEvaluation, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT id, request_id, trace_id, name, category, evaluator, score, label, passed,
			COALESCE(reason, ''), COALESCE(metadata, ''), created_at
		FROM llm_evaluations
		WHERE request_id = ?
		ORDER BY name ASC
	`), requestID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanEvaluations(rows)
}

func (s *SQLStore) RecentEvaluations(ctx context.Context, limit int) ([]LLMEvaluation, error) {
	return s.recentEvaluationsFilter(ctx, "1=1", limit)
}

func (s *SQLStore) RecentEvaluationsFilter(ctx context.Context, whereClause string, limit int, args ...any) ([]LLMEvaluation, error) {
	return s.recentEvaluationsFilter(ctx, whereClause, limit, args...)
}

func (s *SQLStore) recentEvaluationsFilter(ctx context.Context, whereClause string, limit int, args ...any) ([]LLMEvaluation, error) {
	if limit <= 0 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}
	queryArgs := append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(fmt.Sprintf(`
		SELECT e.id, e.request_id, e.trace_id, e.name, e.category, e.evaluator, e.score, e.label, e.passed,
			COALESCE(e.reason, ''), COALESCE(e.metadata, ''), e.created_at
		FROM llm_evaluations e
		JOIN request_logs r ON r.id = e.request_id
		WHERE %s
		ORDER BY e.created_at DESC
		LIMIT ?
	`, whereClause)), queryArgs...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanEvaluations(rows)
}

func (s *SQLStore) RecentLLMFeedback(ctx context.Context, limit int) ([]LLMFeedback, error) {
	return s.recentLLMFeedbackFilter(ctx, "1=1", limit)
}

func (s *SQLStore) RecentLLMFeedbackFilter(ctx context.Context, whereClause string, limit int, args ...any) ([]LLMFeedback, error) {
	return s.recentLLMFeedbackFilter(ctx, whereClause, limit, args...)
}

func (s *SQLStore) recentLLMFeedbackFilter(ctx context.Context, whereClause string, limit int, args ...any) ([]LLMFeedback, error) {
	if limit <= 0 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}
	queryArgs := append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(fmt.Sprintf(`
		SELECT f.id, f.request_id, f.trace_id, f.rating, f.label, COALESCE(f.comment, ''), f.source, COALESCE(f.created_by, ''), f.created_at
		FROM llm_feedback f
		JOIN request_logs r ON r.id = f.request_id
		WHERE %s
		ORDER BY f.created_at DESC
		LIMIT ?
	`, whereClause)), queryArgs...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanLLMFeedback(rows)
}

func scanEvaluations(rows *sql.Rows) ([]LLMEvaluation, error) {
	result := []LLMEvaluation{}
	for rows.Next() {
		var item LLMEvaluation
		var passed int
		var createdAt string
		if err := rows.Scan(&item.ID, &item.RequestID, &item.TraceID, &item.Name, &item.Category, &item.Evaluator,
			&item.Score, &item.Label, &passed, &item.Reason, &item.Metadata, &createdAt); err != nil {
			return nil, err
		}
		item.Passed = passed == 1
		if parsed, err := time.Parse(time.RFC3339Nano, createdAt); err == nil {
			item.CreatedAt = parsed
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func scanLLMFeedback(rows *sql.Rows) ([]LLMFeedback, error) {
	result := []LLMFeedback{}
	for rows.Next() {
		var item LLMFeedback
		var createdAt string
		if err := rows.Scan(&item.ID, &item.RequestID, &item.TraceID, &item.Rating, &item.Label, &item.Comment, &item.Source, &item.CreatedBy, &createdAt); err != nil {
			return nil, err
		}
		if parsed, err := time.Parse(time.RFC3339Nano, createdAt); err == nil {
			item.CreatedAt = parsed
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *SQLStore) EvaluationSummary(ctx context.Context) ([]LLMEvaluationSummary, error) {
	return s.evaluationSummaryFilter(ctx, "1=1")
}

func (s *SQLStore) EvaluationSummaryFilter(ctx context.Context, whereClause string, args ...any) ([]LLMEvaluationSummary, error) {
	return s.evaluationSummaryFilter(ctx, whereClause, args...)
}

func (s *SQLStore) evaluationSummaryFilter(ctx context.Context, whereClause string, args ...any) ([]LLMEvaluationSummary, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(fmt.Sprintf(`
		SELECT name, category, COUNT(*), SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END),
			SUM(CASE WHEN passed = 0 THEN 1 ELSE 0 END), COALESCE(AVG(score), 0)
		FROM llm_evaluations e
		JOIN request_logs r ON r.id = e.request_id
		WHERE %s
		GROUP BY name, category
		ORDER BY name ASC
	`, whereClause)), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []LLMEvaluationSummary{}
	for rows.Next() {
		var item LLMEvaluationSummary
		if err := rows.Scan(&item.Name, &item.Category, &item.Total, &item.Passed, &item.Failed, &item.AverageScore); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *SQLStore) LLMFeedbackSummary(ctx context.Context) (LLMFeedbackSummary, error) {
	return s.llmFeedbackSummaryFilter(ctx, "1=1")
}

func (s *SQLStore) LLMFeedbackSummaryFilter(ctx context.Context, whereClause string, args ...any) (LLMFeedbackSummary, error) {
	return s.llmFeedbackSummaryFilter(ctx, whereClause, args...)
}

func (s *SQLStore) llmFeedbackSummaryFilter(ctx context.Context, whereClause string, args ...any) (LLMFeedbackSummary, error) {
	var summary LLMFeedbackSummary
	err := s.db.QueryRowContext(ctx, s.bind(fmt.Sprintf(`
		SELECT COUNT(*),
			COALESCE(SUM(CASE WHEN f.rating > 0 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN f.rating < 0 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN f.rating = 0 THEN 1 ELSE 0 END), 0),
			COALESCE(AVG(f.rating), 0)
		FROM llm_feedback f
		JOIN request_logs r ON r.id = f.request_id
		WHERE %s
	`, whereClause)), args...).Scan(&summary.Total, &summary.Positive, &summary.Negative, &summary.Neutral, &summary.AverageRating)
	return summary, err
}

func (s *SQLStore) LLMFeedbackLabels(ctx context.Context, limit int) ([]LLMFeedbackLabelSummary, error) {
	return s.llmFeedbackLabelsFilter(ctx, "1=1", limit)
}

func (s *SQLStore) LLMFeedbackLabelsFilter(ctx context.Context, whereClause string, limit int, args ...any) ([]LLMFeedbackLabelSummary, error) {
	return s.llmFeedbackLabelsFilter(ctx, whereClause, limit, args...)
}

func (s *SQLStore) llmFeedbackLabelsFilter(ctx context.Context, whereClause string, limit int, args ...any) ([]LLMFeedbackLabelSummary, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 200 {
		limit = 200
	}
	queryArgs := append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(fmt.Sprintf(`
		SELECT COALESCE(NULLIF(f.label, ''), 'unlabeled') AS label,
			COUNT(*),
			COALESCE(SUM(CASE WHEN f.rating > 0 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN f.rating < 0 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN f.rating = 0 THEN 1 ELSE 0 END), 0),
			COALESCE(AVG(f.rating), 0)
		FROM llm_feedback f
		JOIN request_logs r ON r.id = f.request_id
		WHERE %s
		GROUP BY COALESCE(NULLIF(f.label, ''), 'unlabeled')
		ORDER BY COUNT(*) DESC, label ASC
		LIMIT ?
	`, whereClause)), queryArgs...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []LLMFeedbackLabelSummary{}
	for rows.Next() {
		var item LLMFeedbackLabelSummary
		if err := rows.Scan(&item.Label, &item.Total, &item.Positive, &item.Negative, &item.Neutral, &item.AverageRating); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *SQLStore) LLMFeedbackPrompts(ctx context.Context, limit int) ([]LLMFeedbackPromptSummary, error) {
	return s.llmFeedbackPromptsFilter(ctx, "1=1", limit)
}

func (s *SQLStore) LLMFeedbackPromptsFilter(ctx context.Context, whereClause string, limit int, args ...any) ([]LLMFeedbackPromptSummary, error) {
	return s.llmFeedbackPromptsFilter(ctx, whereClause, limit, args...)
}

func (s *SQLStore) llmFeedbackPromptsFilter(ctx context.Context, whereClause string, limit int, args ...any) ([]LLMFeedbackPromptSummary, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 200 {
		limit = 200
	}
	queryArgs := append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(fmt.Sprintf(`
		SELECT COALESCE(NULLIF(r.prompt_name, ''), 'ad-hoc'),
			COALESCE(r.prompt_version, ''),
			COUNT(f.id),
			COALESCE(SUM(CASE WHEN f.rating > 0 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN f.rating < 0 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN f.rating = 0 THEN 1 ELSE 0 END), 0),
			COALESCE(AVG(f.rating), 0),
			COALESCE(MAX(f.created_at), '')
		FROM llm_feedback f
		JOIN request_logs r ON r.id = f.request_id
		WHERE %s
		GROUP BY COALESCE(NULLIF(r.prompt_name, ''), 'ad-hoc'), COALESCE(r.prompt_version, '')
		ORDER BY COUNT(f.id) DESC, MAX(f.created_at) DESC
		LIMIT ?
	`, whereClause)), queryArgs...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []LLMFeedbackPromptSummary{}
	for rows.Next() {
		var item LLMFeedbackPromptSummary
		if err := rows.Scan(&item.PromptName, &item.PromptVersion, &item.Total, &item.Positive, &item.Negative, &item.Neutral, &item.AverageRating, &item.LastSeen); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *SQLStore) LLMAlignmentSummary(ctx context.Context) (LLMAlignmentSummary, error) {
	return s.llmAlignmentSummaryFilter(ctx, "1=1")
}

func (s *SQLStore) LLMAlignmentSummaryFilter(ctx context.Context, whereClause string, args ...any) (LLMAlignmentSummary, error) {
	return s.llmAlignmentSummaryFilter(ctx, whereClause, args...)
}

func (s *SQLStore) llmAlignmentSummaryFilter(ctx context.Context, whereClause string, args ...any) (LLMAlignmentSummary, error) {
	var summary LLMAlignmentSummary
	err := s.db.QueryRowContext(ctx, s.bind(fmt.Sprintf(`
		WITH per_request AS (
			SELECT r.id,
				MAX(CASE WHEN f.rating < 0 THEN 1 ELSE 0 END) AS human_negative,
				MAX(CASE WHEN e.passed = 0 THEN 1 ELSE 0 END) AS eval_failed
			FROM request_logs r
			LEFT JOIN llm_feedback f ON f.request_id = r.id
			LEFT JOIN llm_evaluations e ON e.request_id = r.id
			WHERE EXISTS (SELECT 1 FROM llm_feedback f2 WHERE f2.request_id = r.id) AND %s
			GROUP BY r.id
		)
		SELECT COUNT(*),
			COALESCE(SUM(CASE WHEN human_negative = eval_failed THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN human_negative != eval_failed THEN 1 ELSE 0 END), 0),
			COALESCE(AVG(CASE WHEN human_negative = eval_failed THEN 1.0 ELSE 0.0 END), 0),
			COALESCE(SUM(human_negative), 0)
		FROM per_request
	`, whereClause)), args...).Scan(&summary.Total, &summary.Aligned, &summary.Misaligned, &summary.AlignmentRate, &summary.HumanNegativeCount)
	return summary, err
}

func (s *SQLStore) LLMAlignmentPrompts(ctx context.Context, limit int) ([]LLMAlignmentPromptSummary, error) {
	return s.llmAlignmentPromptsFilter(ctx, "1=1", limit)
}

func (s *SQLStore) LLMAlignmentPromptsFilter(ctx context.Context, whereClause string, limit int, args ...any) ([]LLMAlignmentPromptSummary, error) {
	return s.llmAlignmentPromptsFilter(ctx, whereClause, limit, args...)
}

func (s *SQLStore) llmAlignmentPromptsFilter(ctx context.Context, whereClause string, limit int, args ...any) ([]LLMAlignmentPromptSummary, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 200 {
		limit = 200
	}
	queryArgs := append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(fmt.Sprintf(`
		WITH per_request AS (
			SELECT r.id,
				COALESCE(NULLIF(r.prompt_name, ''), 'ad-hoc') AS prompt_name,
				COALESCE(r.prompt_version, '') AS prompt_version,
				MAX(CASE WHEN f.rating < 0 THEN 1 ELSE 0 END) AS human_negative,
				MAX(CASE WHEN e.passed = 0 THEN 1 ELSE 0 END) AS eval_failed,
				COALESCE(MAX(COALESCE(f.created_at, e.created_at, r.created_at)), '') AS last_seen
			FROM request_logs r
			LEFT JOIN llm_feedback f ON f.request_id = r.id
			LEFT JOIN llm_evaluations e ON e.request_id = r.id
			WHERE EXISTS (SELECT 1 FROM llm_feedback f2 WHERE f2.request_id = r.id) AND %s
			GROUP BY r.id, COALESCE(NULLIF(r.prompt_name, ''), 'ad-hoc'), COALESCE(r.prompt_version, '')
		)
		SELECT prompt_name, prompt_version, COUNT(*),
			COALESCE(SUM(CASE WHEN human_negative = eval_failed THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN human_negative != eval_failed THEN 1 ELSE 0 END), 0),
			COALESCE(AVG(CASE WHEN human_negative = eval_failed THEN 1.0 ELSE 0.0 END), 0),
			COALESCE(SUM(human_negative), 0),
			COALESCE(AVG(CASE WHEN eval_failed = 1 THEN 1.0 ELSE 0.0 END), 0),
			COALESCE(MAX(last_seen), '')
		FROM per_request
		GROUP BY prompt_name, prompt_version
		ORDER BY COUNT(*) DESC, MAX(last_seen) DESC
		LIMIT ?
	`, whereClause)), queryArgs...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []LLMAlignmentPromptSummary{}
	for rows.Next() {
		var item LLMAlignmentPromptSummary
		if err := rows.Scan(&item.PromptName, &item.PromptVersion, &item.Total, &item.Aligned, &item.Misaligned, &item.AlignmentRate, &item.HumanNegative, &item.EvalFailureRate, &item.LastSeen); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *SQLStore) LLMTimeseries(ctx context.Context, bucket string, since time.Time) ([]LLMTimeseriesPoint, error) {
	return s.llmTimeseriesFilter(ctx, bucket, since, "1=1")
}

func (s *SQLStore) LLMTimeseriesFilter(ctx context.Context, bucket string, since time.Time, whereClause string, args ...any) ([]LLMTimeseriesPoint, error) {
	return s.llmTimeseriesFilter(ctx, bucket, since, whereClause, args...)
}

func (s *SQLStore) llmTimeseriesFilter(ctx context.Context, bucket string, since time.Time, whereClause string, args ...any) ([]LLMTimeseriesPoint, error) {
	if bucket != "day" {
		bucket = "hour"
	}
	bucketExpr := "substr(r.created_at, 1, 13)"
	if bucket == "day" {
		bucketExpr = "substr(r.created_at, 1, 10)"
	}
	sinceText := since.UTC().Format(time.RFC3339Nano)
	queryArgs := append([]any{sinceText}, args...)
	rows, err := s.db.QueryContext(ctx, s.bind(fmt.Sprintf(`
		WITH request_buckets AS (
			SELECT r.id,
				%s AS bucket,
				r.status_code,
				COALESCE(r.first_chunk_ms, 0) AS first_chunk_ms,
				COALESCE(t.total_tokens, 0) AS total_tokens,
				COALESCE(t.estimated_cost, 0) AS estimated_cost
			FROM request_logs r
			LEFT JOIN token_usage t ON t.request_id = r.id
			WHERE r.created_at >= ? AND %s
		),
		feedback_per_request AS (
			SELECT request_id,
				COUNT(*) AS feedback_total,
				COALESCE(SUM(CASE WHEN rating < 0 THEN 1 ELSE 0 END), 0) AS feedback_negative,
				MAX(CASE WHEN rating < 0 THEN 1 ELSE 0 END) AS human_negative
			FROM llm_feedback
			GROUP BY request_id
		),
		evaluation_per_request AS (
			SELECT request_id,
				COALESCE(SUM(CASE WHEN passed = 0 THEN 1 ELSE 0 END), 0) AS eval_failures,
				MAX(CASE WHEN passed = 0 THEN 1 ELSE 0 END) AS eval_failed
			FROM llm_evaluations
			GROUP BY request_id
		)
		SELECT rb.bucket,
			COUNT(*) AS requests,
			COALESCE(SUM(rb.total_tokens), 0) AS tokens,
			COALESCE(SUM(rb.estimated_cost), 0) AS cost_krw,
			COALESCE(SUM(CASE WHEN rb.status_code >= 400 THEN 1 ELSE 0 END), 0) AS errors,
			COALESCE(AVG(CASE WHEN rb.first_chunk_ms > 0 THEN rb.first_chunk_ms END), 0) AS avg_first_chunk_ms,
			COALESCE(SUM(COALESCE(ep.eval_failures, 0)), 0) AS evaluation_failures,
			COALESCE(SUM(COALESCE(fp.feedback_total, 0)), 0) AS feedback_total,
			COALESCE(SUM(COALESCE(fp.feedback_negative, 0)), 0) AS negative_feedback,
			COALESCE(SUM(CASE
				WHEN fp.request_id IS NOT NULL AND COALESCE(fp.human_negative, 0) = COALESCE(ep.eval_failed, 0) THEN 1
				ELSE 0
			END), 0) AS aligned,
			COALESCE(SUM(CASE WHEN fp.request_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS alignment_samples
		FROM request_buckets rb
		LEFT JOIN feedback_per_request fp ON fp.request_id = rb.id
		LEFT JOIN evaluation_per_request ep ON ep.request_id = rb.id
		GROUP BY rb.bucket
		ORDER BY rb.bucket ASC
	`, bucketExpr, whereClause)), queryArgs...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := []LLMTimeseriesPoint{}
	for rows.Next() {
		var item LLMTimeseriesPoint
		var aligned int64
		if err := rows.Scan(
			&item.Date,
			&item.Requests,
			&item.Tokens,
			&item.CostKRW,
			&item.Errors,
			&item.AverageFirstChunkMS,
			&item.EvaluationFailures,
			&item.FeedbackTotal,
			&item.NegativeFeedback,
			&aligned,
			&item.AlignmentSamples,
		); err != nil {
			return nil, err
		}
		item.Bucket = bucket
		if item.AlignmentSamples > 0 {
			item.AlignmentRate = float64(aligned) / float64(item.AlignmentSamples)
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *SQLStore) LLMPrompts(ctx context.Context, limit int) ([]LLMPromptSummary, error) {
	return s.llmPromptsFilter(ctx, "1=1", limit)
}

func (s *SQLStore) LLMPromptsFilter(ctx context.Context, whereClause string, limit int, args ...any) ([]LLMPromptSummary, error) {
	return s.llmPromptsFilter(ctx, whereClause, limit, args...)
}

func (s *SQLStore) llmPromptsFilter(ctx context.Context, whereClause string, limit int, args ...any) ([]LLMPromptSummary, error) {
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	queryArgs := append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(fmt.Sprintf(`
		SELECT COALESCE(NULLIF(r.prompt_name, ''), 'ad-hoc') AS prompt_name,
			COALESCE(r.prompt_version, '') AS prompt_version,
			COUNT(r.id),
			COALESCE(SUM(t.total_tokens), 0),
			COALESCE(SUM(t.estimated_cost), 0),
			COALESCE(AVG(r.latency_ms), 0),
			COALESCE(SUM(CASE WHEN r.status_code >= 400 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(ef.failures), 0),
			COALESCE(MIN(r.created_at), ''),
			COALESCE(MAX(r.created_at), '')
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		LEFT JOIN (
			SELECT request_id, SUM(CASE WHEN passed = 0 THEN 1 ELSE 0 END) AS failures
			FROM llm_evaluations
			GROUP BY request_id
		) ef ON ef.request_id = r.id
		WHERE %s
		GROUP BY COALESCE(NULLIF(r.prompt_name, ''), 'ad-hoc'), COALESCE(r.prompt_version, '')
		ORDER BY COUNT(r.id) DESC, MAX(r.created_at) DESC
		LIMIT ?
	`, whereClause)), queryArgs...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []LLMPromptSummary{}
	for rows.Next() {
		var item LLMPromptSummary
		if err := rows.Scan(&item.PromptName, &item.PromptVersion, &item.Calls, &item.Tokens, &item.CostKRW,
			&item.AverageLatencyMS, &item.Errors, &item.EvalFailures, &item.FirstSeen, &item.LastSeen); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *SQLStore) LLMPromptComparison(ctx context.Context, promptName, candidateVersion, baselineVersion string) (LLMPromptComparison, error) {
	return s.llmPromptComparisonFilter(ctx, promptName, candidateVersion, baselineVersion, 3, "1=1")
}

func (s *SQLStore) LLMPromptComparisonLimit(ctx context.Context, promptName, candidateVersion, baselineVersion string, candidateLimit int) (LLMPromptComparison, error) {
	return s.llmPromptComparisonFilter(ctx, promptName, candidateVersion, baselineVersion, candidateLimit, "1=1")
}

func (s *SQLStore) LLMPromptComparisonFilter(ctx context.Context, promptName, candidateVersion, baselineVersion string, whereClause string, args ...any) (LLMPromptComparison, error) {
	return s.llmPromptComparisonFilter(ctx, promptName, candidateVersion, baselineVersion, 3, whereClause, args...)
}

func (s *SQLStore) LLMPromptComparisonFilterLimit(ctx context.Context, promptName, candidateVersion, baselineVersion string, candidateLimit int, whereClause string, args ...any) (LLMPromptComparison, error) {
	return s.llmPromptComparisonFilter(ctx, promptName, candidateVersion, baselineVersion, candidateLimit, whereClause, args...)
}

func (s *SQLStore) llmPromptComparisonFilter(ctx context.Context, promptName, candidateVersion, baselineVersion string, candidateLimit int, whereClause string, args ...any) (LLMPromptComparison, error) {
	result := LLMPromptComparison{PromptName: promptName, AvailableVersions: []string{}}
	if strings.TrimSpace(promptName) == "" {
		return result, ErrNotFound
	}
	if candidateLimit <= 0 {
		candidateLimit = 3
	}
	if candidateLimit > 10 {
		candidateLimit = 10
	}
	queryWhere := "COALESCE(NULLIF(r.prompt_name, ''), 'ad-hoc') = ?"
	queryArgs := append([]any{promptName}, args...)
	if whereClause != "" && whereClause != "1=1" {
		queryWhere += " AND " + whereClause
	}
	rows, err := s.llmPromptsFilter(ctx, queryWhere, 200, queryArgs...)
	if err != nil {
		return result, err
	}
	if len(rows) == 0 {
		return result, ErrNotFound
	}
	byVersion := make(map[string]LLMPromptSummary, len(rows))
	for _, row := range rows {
		result.AvailableVersions = append(result.AvailableVersions, row.PromptVersion)
		byVersion[row.PromptVersion] = row
	}
	if candidateVersion == "" {
		candidateVersion = rows[0].PromptVersion
	}
	candidate, ok := byVersion[candidateVersion]
	if !ok {
		return result, ErrNotFound
	}
	result.Candidate = candidate
	result.CandidateErrorRate = promptErrorRate(candidate)
	result.CandidateEvalRate = promptEvalFailureRate(candidate)
	result.BaselineCandidates = promptBaselineCandidates(rows, candidateVersion, candidateLimit)
	if len(result.BaselineCandidates) > 0 {
		result.CandidateOrdering = "nearest_previous_version_then_recent_activity"
	}
	manualBaseline := strings.TrimSpace(baselineVersion) != ""
	if baselineVersion == "" {
		baselineVersion, result.BaselineReason = selectPromptBaselineVersion(rows, candidateVersion)
	}
	if baselineVersion != "" {
		if result.BaselineReason == "" && manualBaseline {
			result.BaselineReason = "manual"
		}
		if baseline, ok := byVersion[baselineVersion]; ok {
			result.Baseline = &baseline
			result.BaselineErrorRate = promptErrorRate(baseline)
			result.BaselineEvalRate = promptEvalFailureRate(baseline)
			result.Delta = LLMPromptComparisonDelta{
				Calls:            candidate.Calls - baseline.Calls,
				Tokens:           candidate.Tokens - baseline.Tokens,
				CostKRW:          candidate.CostKRW - baseline.CostKRW,
				AverageLatencyMS: candidate.AverageLatencyMS - baseline.AverageLatencyMS,
				ErrorRate:        result.CandidateErrorRate - result.BaselineErrorRate,
				EvalFailureRate:  result.CandidateEvalRate - result.BaselineEvalRate,
			}
		}
	}
	return result, nil
}

func selectPromptBaselineVersion(rows []LLMPromptSummary, candidateVersion string) (string, string) {
	candidates := promptBaselineCandidates(rows, candidateVersion, 1)
	if len(candidates) == 0 {
		return "", ""
	}
	return candidates[0].PromptVersion, candidates[0].Reason
}

func promptBaselineCandidates(rows []LLMPromptSummary, candidateVersion string, limit int) []LLMPromptBaselineCandidate {
	if candidateVersion == "" {
		return nil
	}
	byVersion := make(map[string]LLMPromptSummary, len(rows))
	for _, row := range rows {
		byVersion[row.PromptVersion] = row
	}
	candidatePrefix, candidateNumber, candidateHasNumber := splitVersionNumber(candidateVersion)
	candidates := make([]LLMPromptBaselineCandidate, 0, limit)
	seen := map[string]bool{}
	if candidateHasNumber {
		type numbered struct {
			version string
			number  int
		}
		numberedRows := []numbered{}
		for _, row := range rows {
			if row.PromptVersion == candidateVersion {
				continue
			}
			prefix, number, ok := splitVersionNumber(row.PromptVersion)
			if !ok || prefix != candidatePrefix || number >= candidateNumber {
				continue
			}
			numberedRows = append(numberedRows, numbered{version: row.PromptVersion, number: number})
		}
		sort.Slice(numberedRows, func(i, j int) bool {
			return numberedRows[i].number > numberedRows[j].number
		})
		for _, row := range numberedRows {
			if !seen[row.version] {
				summary := byVersion[row.version]
				candidates = append(candidates, promptBaselineCandidate(summary, "nearest_previous_version"))
				seen[row.version] = true
				if len(candidates) >= limit {
					return candidates
				}
			}
		}
	}

	fallback := append([]LLMPromptSummary{}, rows...)
	sort.Slice(fallback, func(i, j int) bool {
		ti := parseRFC3339OrZero(fallback[i].LastSeen)
		tj := parseRFC3339OrZero(fallback[j].LastSeen)
		if !ti.Equal(tj) {
			return tj.Before(ti)
		}
		if fallback[i].Calls != fallback[j].Calls {
			return fallback[i].Calls > fallback[j].Calls
		}
		return fallback[i].PromptVersion > fallback[j].PromptVersion
	})
	for _, row := range fallback {
		if row.PromptVersion != candidateVersion {
			if !seen[row.PromptVersion] {
				candidates = append(candidates, promptBaselineCandidate(row, "recent_activity_fallback"))
				seen[row.PromptVersion] = true
				if len(candidates) >= limit {
					return candidates
				}
			}
		}
	}
	return candidates
}

func promptBaselineCandidate(summary LLMPromptSummary, reason string) LLMPromptBaselineCandidate {
	return LLMPromptBaselineCandidate{
		PromptVersion:    summary.PromptVersion,
		Reason:           reason,
		Calls:            summary.Calls,
		AverageLatencyMS: summary.AverageLatencyMS,
		ErrorRate:        promptErrorRate(summary),
		EvalFailureRate:  promptEvalFailureRate(summary),
		LastSeen:         summary.LastSeen,
	}
}

func splitVersionNumber(version string) (string, int, bool) {
	version = strings.TrimSpace(version)
	if version == "" {
		return "", 0, false
	}
	end := len(version)
	start := end
	for start > 0 {
		ch := version[start-1]
		if ch < '0' || ch > '9' {
			break
		}
		start--
	}
	if start == end {
		return version, 0, false
	}
	number, err := strconv.Atoi(version[start:end])
	if err != nil {
		return version, 0, false
	}
	return version[:start], number, true
}

func parseRFC3339OrZero(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}
	}
	return parsed
}

func promptErrorRate(item LLMPromptSummary) float64 {
	if item.Calls == 0 {
		return 0
	}
	return float64(item.Errors) / float64(item.Calls)
}

func promptEvalFailureRate(item LLMPromptSummary) float64 {
	if item.Calls == 0 {
		return 0
	}
	return float64(item.EvalFailures) / float64(item.Calls)
}

func (s *SQLStore) LLMSessions(ctx context.Context, limit int) ([]LLMSessionSummary, error) {
	return s.llmSessionsFilter(ctx, "1=1", limit)
}

func (s *SQLStore) LLMSessionsFilter(ctx context.Context, whereClause string, limit int, args ...any) ([]LLMSessionSummary, error) {
	return s.llmSessionsFilter(ctx, whereClause, limit, args...)
}

func (s *SQLStore) llmSessionsFilter(ctx context.Context, whereClause string, limit int, args ...any) ([]LLMSessionSummary, error) {
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	evalWhereClause := strings.ReplaceAll(whereClause, "r.", "r2.")
	queryArgs := append([]any{}, args...)
	queryArgs = append(queryArgs, args...)
	queryArgs = append(queryArgs, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(fmt.Sprintf(`
		SELECT COALESCE(NULLIF(r.session_id, ''), 'no-session') AS session_id,
			COUNT(r.id),
			COALESCE(SUM(t.total_tokens), 0),
			COALESCE(SUM(t.estimated_cost), 0),
			COALESCE(SUM(CASE WHEN r.status_code >= 400 THEN 1 ELSE 0 END), 0),
			COALESCE(ef.failures, 0),
			COALESCE(MIN(r.created_at), ''),
			COALESCE(MAX(r.created_at), '')
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		LEFT JOIN (
			SELECT COALESCE(NULLIF(r2.session_id, ''), 'no-session') AS session_id, COUNT(*) AS failures
			FROM llm_evaluations e
			JOIN request_logs r2 ON r2.id = e.request_id
			WHERE e.passed = 0 AND %s
			GROUP BY COALESCE(NULLIF(r2.session_id, ''), 'no-session')
		) ef ON ef.session_id = COALESCE(NULLIF(r.session_id, ''), 'no-session')
		WHERE %s
		GROUP BY COALESCE(NULLIF(r.session_id, ''), 'no-session'), ef.failures
		ORDER BY MAX(r.created_at) DESC
		LIMIT ?
	`, evalWhereClause, whereClause)), queryArgs...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []LLMSessionSummary{}
	for rows.Next() {
		var item LLMSessionSummary
		if err := rows.Scan(&item.SessionID, &item.Requests, &item.Tokens, &item.CostKRW, &item.Errors,
			&item.EvaluationFailures, &item.FirstSeen, &item.LastSeen); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

// SessionTimeline returns the ordered turns of a single session with running
// cumulative cost/token totals — the basis for the session cost timeline view.
func (s *SQLStore) SessionTimeline(ctx context.Context, sessionID string, limit int) (SessionTimeline, error) {
	timeline := SessionTimeline{SessionID: sessionID, Points: []SessionTimelinePoint{}}
	if limit <= 0 || limit > 2000 {
		limit = 1000
	}
	query := s.bind(`
		SELECT r.id, r.trace_id, COALESCE(r.model, ''), COALESCE(r.provider, ''),
			COALESCE(NULLIF(r.prompt_name, ''), 'ad-hoc'),
			r.status_code, r.latency_ms, COALESCE(r.first_chunk_ms, 0),
			COALESCE(t.total_tokens, 0), COALESCE(t.estimated_cost, 0),
			(SELECT COUNT(*) FROM tool_invocations ti WHERE ti.request_id = r.id AND ti.source = 'call'),
			(SELECT COUNT(*) FROM tool_invocations ti WHERE ti.request_id = r.id AND ti.is_error = 1),
			(SELECT COUNT(*) FROM llm_evaluations e WHERE e.request_id = r.id AND e.passed = 0),
			r.created_at
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE COALESCE(NULLIF(r.session_id, ''), 'no-session') = ?
		ORDER BY r.created_at ASC
		LIMIT ?`)
	rows, err := s.db.QueryContext(ctx, query, sessionID, limit)
	if err != nil {
		return timeline, err
	}
	defer rows.Close()

	var cumCost float64
	var cumTokens int64
	var firstTS, lastTS string
	for rows.Next() {
		var p SessionTimelinePoint
		if err := rows.Scan(&p.RequestID, &p.TraceID, &p.Model, &p.Provider, &p.PromptName,
			&p.StatusCode, &p.LatencyMS, &p.FirstChunkMS, &p.TotalTokens, &p.CostKRW,
			&p.ToolCalls, &p.ToolErrors, &p.EvalFailures, &p.CreatedAt); err != nil {
			return timeline, err
		}
		cumCost += p.CostKRW
		cumTokens += p.TotalTokens
		p.CumulativeCostKRW = cumCost
		p.CumulativeTokens = cumTokens
		timeline.ToolCalls += p.ToolCalls
		if firstTS == "" {
			firstTS = p.CreatedAt
		}
		lastTS = p.CreatedAt
		timeline.Points = append(timeline.Points, p)
	}
	if err := rows.Err(); err != nil {
		return timeline, err
	}
	timeline.Requests = len(timeline.Points)
	timeline.TotalCostKRW = cumCost
	timeline.TotalTokens = cumTokens
	if firstTS != "" && lastTS != "" {
		if a, err1 := time.Parse(time.RFC3339Nano, firstTS); err1 == nil {
			if b, err2 := time.Parse(time.RFC3339Nano, lastTS); err2 == nil {
				timeline.DurationSeconds = int64(b.Sub(a).Seconds())
			}
		}
	}
	return timeline, nil
}

func (s *SQLStore) LLMPatterns(ctx context.Context, limit int) ([]LLMPatternSummary, error) {
	return s.llmPatternsFilter(ctx, "1=1", limit)
}

func (s *SQLStore) LLMPatternsFilter(ctx context.Context, whereClause string, limit int, args ...any) ([]LLMPatternSummary, error) {
	return s.llmPatternsFilter(ctx, whereClause, limit, args...)
}

func (s *SQLStore) llmPatternsFilter(ctx context.Context, whereClause string, limit int, args ...any) ([]LLMPatternSummary, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	queryArgs := append([]any{}, args...)
	queryArgs = append(queryArgs, limit*20)
	rows, err := s.db.QueryContext(ctx, s.bind(fmt.Sprintf(`
		SELECT r.id,
			COALESCE(pl.redacted_text, ''),
			COALESCE(pl.language_hint, ''),
			r.status_code,
			r.latency_ms,
			COALESCE(t.total_tokens, 0),
			COALESCE(t.estimated_cost, 0)
		FROM request_logs r
		JOIN prompt_logs pl ON pl.request_id = r.id
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE COALESCE(pl.redacted_text, '') != '' AND %s
		ORDER BY r.created_at DESC
		LIMIT ?
	`, whereClause)), queryArgs...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type requestPatternInput struct {
		text     string
		language string
		status   int
		latency  int64
		tokens   int64
		cost     float64
	}
	byRequest := map[string]*requestPatternInput{}
	for rows.Next() {
		var id string
		var text string
		var language string
		var status int
		var latency int64
		var tokens int64
		var cost float64
		if err := rows.Scan(&id, &text, &language, &status, &latency, &tokens, &cost); err != nil {
			return nil, err
		}
		item := byRequest[id]
		if item == nil {
			item = &requestPatternInput{language: language, status: status, latency: latency, tokens: tokens, cost: cost}
			byRequest[id] = item
		}
		if item.text != "" {
			item.text += "\n"
		}
		item.text += text
		if item.language == "" && language != "" {
			item.language = language
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	aggregate := map[string]*LLMPatternSummary{}
	var latencyTotals = map[string]int64{}
	for _, item := range byRequest {
		pattern := llmPatternForPrompt(item.text, item.language)
		summary := aggregate[pattern]
		if summary == nil {
			summary = &LLMPatternSummary{Pattern: pattern, Language: item.language, Sample: truncatePatternSample(item.text, 180)}
			aggregate[pattern] = summary
		}
		summary.Requests++
		summary.Tokens += item.tokens
		summary.CostKRW += item.cost
		if item.status >= 400 {
			summary.Errors++
		}
		if summary.Language == "" && item.language != "" {
			summary.Language = item.language
		}
		latencyTotals[pattern] += item.latency
	}

	result := make([]LLMPatternSummary, 0, len(aggregate))
	for pattern, summary := range aggregate {
		if summary.Requests > 0 {
			summary.AverageLatencyMS = float64(latencyTotals[pattern]) / float64(summary.Requests)
		}
		result = append(result, *summary)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Requests == result[j].Requests {
			return result[i].Pattern < result[j].Pattern
		}
		return result[i].Requests > result[j].Requests
	})
	if len(result) > limit {
		result = result[:limit]
	}
	return result, nil
}

func llmPatternForPrompt(text string, language string) string {
	lower := strings.ToLower(text)
	switch {
	case containsAny(lower, "ignore previous", "jailbreak", "system prompt", "developer message", "prompt injection", "이전 지시", "시스템 프롬프트"):
		return "prompt-injection-risk"
	case containsAny(lower, "error", "bug", "exception", "traceback", "stack trace", "오류", "버그", "에러"):
		return "debugging"
	case containsAny(lower, "test", "coverage", "unit test", "integration test", "테스트"):
		return "testing"
	case containsAny(lower, "refactor", "cleanup", "clean up", "리팩터", "리팩토링"):
		return "refactoring"
	case containsAny(lower, "sql", "database", "query", "schema", "migration", "postgres", "sqlite"):
		return "database"
	case containsAny(lower, "security", "vulnerability", "secret", "token", "xss", "csrf", "보안", "취약점"):
		return "security"
	case containsAny(lower, "latency", "performance", "slow", "optimize", "성능", "지연", "최적화"):
		return "performance"
	case language != "":
		return "code-" + strings.ToLower(language)
	default:
		return "general"
	}
}

func containsAny(text string, needles ...string) bool {
	for _, needle := range needles {
		if strings.Contains(text, strings.ToLower(needle)) {
			return true
		}
	}
	return false
}

func truncatePatternSample(text string, max int) string {
	text = strings.Join(strings.Fields(text), " ")
	if len(text) <= max {
		return text
	}
	if max <= 1 {
		return text[:max]
	}
	return strings.TrimSpace(text[:max-1]) + "..."
}

func (s *SQLStore) LLMInsights(ctx context.Context, since time.Time, limit int) ([]LLMInsight, error) {
	return s.llmInsightsFilter(ctx, since, "1=1", limit)
}

func (s *SQLStore) LLMInsightsFilter(ctx context.Context, since time.Time, whereClause string, limit int, args ...any) ([]LLMInsight, error) {
	return s.llmInsightsFilter(ctx, since, whereClause, limit, args...)
}

func (s *SQLStore) llmInsightsFilter(ctx context.Context, since time.Time, whereClause string, limit int, args ...any) ([]LLMInsight, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	sinceText := since.UTC().Format(time.RFC3339Nano)
	insights := []LLMInsight{}

	withLimit := func(values ...any) []any {
		queryArgs := append([]any{sinceText}, values...)
		return append(queryArgs, limit)
	}

	if rows, err := s.db.QueryContext(ctx, s.bind(fmt.Sprintf(`
		SELECT e.name, e.category, COUNT(*), COALESCE(MAX(e.created_at), '')
		FROM llm_evaluations e
		JOIN request_logs r ON r.id = e.request_id
		WHERE e.created_at >= ? AND e.passed = 0 AND %s
		GROUP BY e.name, e.category
		ORDER BY COUNT(*) DESC
		LIMIT ?
	`, whereClause)), withLimit(args...)...); err != nil {
		return nil, err
	} else {
		for rows.Next() {
			var name, category, lastSeen string
			var count int64
			if err := rows.Scan(&name, &category, &count, &lastSeen); err != nil {
				rows.Close()
				return nil, err
			}
			insights = append(insights, LLMInsight{
				ID:             insightID("eval", name, category),
				Severity:       insightSeverity(count, 10, 3),
				Kind:           "evaluation_failure",
				Title:          "Evaluation failure: " + name,
				Detail:         fmt.Sprintf("%s evaluation failed %d times in the selected window.", category, count),
				Scope:          "evaluation",
				ScopeValue:     name,
				ScopeDetail:    category,
				Count:          count,
				MetricValue:    float64(count),
				Recommendation: "Open the LLM Observability evaluation table and inspect the latest failing traces for this evaluator.",
				LastSeen:       lastSeen,
			})
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}

	if rows, err := s.db.QueryContext(ctx, s.bind(fmt.Sprintf(`
		SELECT COALESCE(NULLIF(r.session_id, ''), 'no-session'), COALESCE(NULLIF(r.prompt_name, ''), 'ad-hoc'),
			COUNT(*), COALESCE(MAX(e.created_at), '')
		FROM llm_evaluations e
		JOIN request_logs r ON r.id = e.request_id
		WHERE e.created_at >= ? AND e.name = 'prompt.injection' AND e.passed = 0 AND %s
		GROUP BY COALESCE(NULLIF(r.session_id, ''), 'no-session'), COALESCE(NULLIF(r.prompt_name, ''), 'ad-hoc')
		ORDER BY COUNT(*) DESC
		LIMIT ?
	`, whereClause)), withLimit(args...)...); err != nil {
		return nil, err
	} else {
		for rows.Next() {
			var sessionID, promptName, lastSeen string
			var count int64
			if err := rows.Scan(&sessionID, &promptName, &count, &lastSeen); err != nil {
				rows.Close()
				return nil, err
			}
			insights = append(insights, LLMInsight{
				ID:             insightID("injection", sessionID, promptName),
				Severity:       insightSeverity(count, 3, 1),
				Kind:           "prompt_injection_risk",
				Title:          "Prompt injection risk detected",
				Detail:         fmt.Sprintf("Session %s / prompt %s triggered prompt injection checks %d times.", sessionID, promptName, count),
				Scope:          "session",
				ScopeValue:     sessionID,
				Count:          count,
				MetricValue:    float64(count),
				Recommendation: "Review the prompt template and add stronger input isolation or tool-use constraints before allowing automated actions.",
				LastSeen:       lastSeen,
			})
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}

	if rows, err := s.db.QueryContext(ctx, s.bind(fmt.Sprintf(`
		SELECT COALESCE(NULLIF(r.model, ''), 'unknown'), COALESCE(NULLIF(r.provider, ''), 'unknown'),
			COUNT(*), COALESCE(MAX(e.created_at), '')
		FROM llm_evaluations e
		JOIN request_logs r ON r.id = e.request_id
		WHERE e.created_at >= ? AND e.name = 'cost.has_usage' AND e.passed = 0 AND %s
		GROUP BY COALESCE(NULLIF(r.model, ''), 'unknown'), COALESCE(NULLIF(r.provider, ''), 'unknown')
		ORDER BY COUNT(*) DESC
		LIMIT ?
	`, whereClause)), withLimit(args...)...); err != nil {
		return nil, err
	} else {
		for rows.Next() {
			var model, provider, lastSeen string
			var count int64
			if err := rows.Scan(&model, &provider, &count, &lastSeen); err != nil {
				rows.Close()
				return nil, err
			}
			insights = append(insights, LLMInsight{
				ID:             insightID("usage", model, provider),
				Severity:       insightSeverity(count, 20, 5),
				Kind:           "missing_usage",
				Title:          "Provider usage data missing",
				Detail:         fmt.Sprintf("%s/%s returned no usage metadata %d times.", provider, model, count),
				Scope:          "model",
				ScopeValue:     model,
				Count:          count,
				MetricValue:    float64(count),
				Recommendation: "Verify provider compatibility or keep model pricing configured so estimated token/cost data stays usable.",
				LastSeen:       lastSeen,
			})
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}

	if rows, err := s.db.QueryContext(ctx, s.bind(fmt.Sprintf(`
		SELECT COALESCE(NULLIF(r.model, ''), 'unknown'), COALESCE(NULLIF(r.provider, ''), 'unknown'),
			COUNT(*), COALESCE(AVG(r.first_chunk_ms), 0), COALESCE(MAX(r.created_at), '')
		FROM request_logs r
		WHERE r.created_at >= ? AND r.first_chunk_ms >= 3000 AND %s
		GROUP BY COALESCE(NULLIF(r.model, ''), 'unknown'), COALESCE(NULLIF(r.provider, ''), 'unknown')
		ORDER BY COUNT(*) DESC, AVG(first_chunk_ms) DESC
		LIMIT ?
	`, whereClause)), withLimit(args...)...); err != nil {
		return nil, err
	} else {
		for rows.Next() {
			var model, provider, lastSeen string
			var count int64
			var avgFirstChunk float64
			if err := rows.Scan(&model, &provider, &count, &avgFirstChunk, &lastSeen); err != nil {
				rows.Close()
				return nil, err
			}
			insights = append(insights, LLMInsight{
				ID:             insightID("latency", model, provider),
				Severity:       insightSeverity(count, 20, 5),
				Kind:           "slow_first_chunk",
				Title:          "Slow first response chunk",
				Detail:         fmt.Sprintf("%s/%s had %d requests with first chunk >= 3000 ms.", provider, model, count),
				Scope:          "model",
				ScopeValue:     model,
				Count:          count,
				MetricValue:    avgFirstChunk,
				Recommendation: "Check provider health, model routing, streaming behavior, and failover candidates for this model.",
				LastSeen:       lastSeen,
			})
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}

	if rows, err := s.db.QueryContext(ctx, s.bind(fmt.Sprintf(`
		SELECT COALESCE(NULLIF(r.session_id, ''), 'no-session'), COUNT(*), COALESCE(MAX(r.created_at), '')
		FROM request_logs r
		WHERE r.created_at >= ? AND r.status_code >= 400 AND %s
		GROUP BY COALESCE(NULLIF(r.session_id, ''), 'no-session')
		ORDER BY COUNT(*) DESC
		LIMIT ?
	`, whereClause)), withLimit(args...)...); err != nil {
		return nil, err
	} else {
		for rows.Next() {
			var sessionID, lastSeen string
			var count int64
			if err := rows.Scan(&sessionID, &count, &lastSeen); err != nil {
				rows.Close()
				return nil, err
			}
			insights = append(insights, LLMInsight{
				ID:             insightID("session-errors", sessionID),
				Severity:       insightSeverity(count, 10, 3),
				Kind:           "session_errors",
				Title:          "Session has repeated errors",
				Detail:         fmt.Sprintf("Session %s produced %d HTTP errors.", sessionID, count),
				Scope:          "session",
				ScopeValue:     sessionID,
				Count:          count,
				MetricValue:    float64(count),
				Recommendation: "Open the session in Trace Explorer and check quota, provider, model, and prompt changes around the failing calls.",
				LastSeen:       lastSeen,
			})
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}

	if rows, err := s.db.QueryContext(ctx, s.bind(fmt.Sprintf(`
		SELECT COALESCE(NULLIF(r.prompt_name, ''), 'ad-hoc'),
			COALESCE(r.prompt_version, ''),
			COALESCE(NULLIF(f.label, ''), 'unlabeled'),
			COUNT(f.id),
			COALESCE(AVG(f.rating), 0),
			COALESCE(MAX(f.created_at), '')
		FROM llm_feedback f
		JOIN request_logs r ON r.id = f.request_id
		WHERE f.created_at >= ? AND f.rating < 0 AND %s
		GROUP BY COALESCE(NULLIF(r.prompt_name, ''), 'ad-hoc'), COALESCE(r.prompt_version, ''), COALESCE(NULLIF(f.label, ''), 'unlabeled')
		ORDER BY COUNT(f.id) DESC, AVG(f.rating) ASC
		LIMIT ?
	`, whereClause)), withLimit(args...)...); err != nil {
		return nil, err
	} else {
		for rows.Next() {
			var promptName, promptVersion, label, lastSeen string
			var count int64
			var avgRating float64
			if err := rows.Scan(&promptName, &promptVersion, &label, &count, &avgRating, &lastSeen); err != nil {
				rows.Close()
				return nil, err
			}
			insights = append(insights, LLMInsight{
				ID:             insightID("feedback", promptName, promptVersion, label),
				Severity:       insightSeverity(count, 5, 2),
				Kind:           "negative_human_feedback",
				Title:          "Negative human feedback cluster",
				Detail:         fmt.Sprintf("Prompt %s@%s collected %d negative feedback items with label %s.", promptName, promptVersion, count, label),
				Scope:          "prompt",
				ScopeValue:     promptName,
				ScopeDetail:    promptVersion,
				Count:          count,
				MetricValue:    avgRating,
				Recommendation: "Inspect recent traces for this prompt version and compare human feedback with managed evaluation failures before changing the template.",
				LastSeen:       lastSeen,
			})
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}

	if rows, err := s.db.QueryContext(ctx, s.bind(fmt.Sprintf(`
		WITH per_request AS (
			SELECT r.id,
				COALESCE(NULLIF(r.prompt_name, ''), 'ad-hoc') AS prompt_name,
				COALESCE(r.prompt_version, '') AS prompt_version,
				MAX(CASE WHEN f.rating < 0 THEN 1 ELSE 0 END) AS human_negative,
				MAX(CASE WHEN e.passed = 0 THEN 1 ELSE 0 END) AS eval_failed,
				COALESCE(MAX(COALESCE(f.created_at, e.created_at, r.created_at)), '') AS last_seen
			FROM request_logs r
			LEFT JOIN llm_feedback f ON f.request_id = r.id
			LEFT JOIN llm_evaluations e ON e.request_id = r.id
			WHERE COALESCE(f.created_at, e.created_at, r.created_at) >= ?
				AND EXISTS (SELECT 1 FROM llm_feedback f2 WHERE f2.request_id = r.id)
				AND %s
			GROUP BY r.id, COALESCE(NULLIF(r.prompt_name, ''), 'ad-hoc'), COALESCE(r.prompt_version, '')
		)
		SELECT prompt_name, prompt_version, COUNT(*), COALESCE(MAX(last_seen), '')
		FROM per_request
		WHERE human_negative != eval_failed
		GROUP BY prompt_name, prompt_version
		ORDER BY COUNT(*) DESC, MAX(last_seen) DESC
		LIMIT ?
	`, whereClause)), withLimit(args...)...); err != nil {
		return nil, err
	} else {
		for rows.Next() {
			var promptName, promptVersion, lastSeen string
			var count int64
			if err := rows.Scan(&promptName, &promptVersion, &count, &lastSeen); err != nil {
				rows.Close()
				return nil, err
			}
			insights = append(insights, LLMInsight{
				ID:             insightID("alignment-mismatch", promptName, promptVersion),
				Severity:       insightSeverity(count, 4, 2),
				Kind:           "feedback_eval_mismatch",
				Title:          "Human feedback and managed eval disagree",
				Detail:         fmt.Sprintf("Prompt %s@%s has %d requests where human negative feedback and eval failure status do not match.", promptName, promptVersion, count),
				Scope:          "prompt",
				ScopeValue:     promptName,
				ScopeDetail:    promptVersion,
				Count:          count,
				MetricValue:    float64(count),
				Recommendation: "Open Alignment by Prompt and inspect traces where human feedback disagrees with managed evaluation before tuning thresholds or prompts.",
				LastSeen:       lastSeen,
			})
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}

	sort.Slice(insights, func(i, j int) bool {
		if severityRank(insights[i].Severity) == severityRank(insights[j].Severity) {
			if insights[i].Count == insights[j].Count {
				return insights[i].LastSeen > insights[j].LastSeen
			}
			return insights[i].Count > insights[j].Count
		}
		return severityRank(insights[i].Severity) > severityRank(insights[j].Severity)
	})
	if len(insights) > limit {
		insights = insights[:limit]
	}
	return insights, nil
}

func insightSeverity(count int64, highAt int64, mediumAt int64) string {
	if count >= highAt {
		return "high"
	}
	if count >= mediumAt {
		return "medium"
	}
	return "low"
}

func severityRank(severity string) int {
	switch severity {
	case "high":
		return 3
	case "medium":
		return 2
	case "low":
		return 1
	default:
		return 0
	}
}

func insightID(parts ...string) string {
	return auditHash(strings.Join(parts, "|"))
}

func auditHash(text string) string {
	var hash uint64 = 1469598103934665603
	for _, b := range []byte(text) {
		hash ^= uint64(b)
		hash *= 1099511628211
	}
	return fmt.Sprintf("ins_%x", hash)
}

func (s *SQLStore) SearchPrompts(ctx context.Context, q PromptSearch) ([]RecentRequest, error) {
	limit := q.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 10000 {
		limit = 10000
	}

	where := []string{"1=1"}
	args := []any{}
	kw := q.Keyword
	if strings.HasPrefix(kw, "#") {
		tag := strings.TrimPrefix(kw, "#")
		where = append(where, "EXISTS (SELECT 1 FROM request_notes rn WHERE rn.request_id = r.id AND (',' || rn.tags || ',') LIKE ?)")
		args = append(args, "%,"+tag+",%")
		kw = ""
	}
	if kw != "" {
		where = append(where, "EXISTS (SELECT 1 FROM prompt_logs pl WHERE pl.request_id = r.id AND (pl.redacted_text LIKE ? OR pl.content_text LIKE ?))")
		needle := "%" + kw + "%"
		args = append(args, needle, needle)
	}
	if q.APIKeyID != "" {
		where = append(where, "r.api_key_id = ?")
		args = append(args, q.APIKeyID)
	}
	if q.IP != "" {
		where = append(where, "r.client_ip = ?")
		args = append(args, q.IP)
	}
	if q.Language != "" {
		where = append(where, "EXISTS (SELECT 1 FROM language_stats ls WHERE ls.request_id = r.id AND ls.language = ?)")
		args = append(args, q.Language)
	}
	if q.Since != "" {
		where = append(where, "r.created_at >= ?")
		args = append(args, q.Since)
	}
	args = append(args, limit)

	query := s.bind(`SELECT r.id, r.trace_id, COALESCE(r.api_key_id, ''), COALESCE(r.client_ip, ''), COALESCE(r.forwarded_for, ''),
			COALESCE(r.user_agent, ''), COALESCE(r.model, ''), r.endpoint, r.stream, COALESCE(r.provider, ''),
			r.status_code, r.latency_ms, COALESCE(r.first_chunk_ms, 0),
			COALESCE(r.session_id, ''), COALESCE(r.prompt_name, ''), COALESCE(r.prompt_version, ''),
			COALESCE(r.prompt_variables_hash, ''), COALESCE(r.tool_count, 0), COALESCE(r.error, ''),
			COALESCE(t.prompt_tokens, 0), COALESCE(t.completion_tokens, 0), COALESCE(t.total_tokens, 0),
			COALESCE(t.cached_tokens, 0), COALESCE(t.reasoning_tokens, 0),
			COALESCE(t.estimated_cost, 0), COALESCE(t.currency, ''), COALESCE(t.source, ''),
			COALESCE(resp.finish_reason, ''), r.created_at
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		LEFT JOIN response_logs resp ON resp.request_id = r.id
		WHERE ` + strings.Join(where, " AND ") + `
		ORDER BY r.created_at DESC
		LIMIT ?`)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}

	result := []RecentRequest{}
	for rows.Next() {
		var item RecentRequest
		var streamInt int
		if err := rows.Scan(&item.ID, &item.TraceID, &item.APIKeyID, &item.ClientIP, &item.ForwardedFor,
			&item.UserAgent, &item.Model, &item.Endpoint, &streamInt, &item.Provider,
			&item.StatusCode, &item.LatencyMS, &item.FirstChunkMS,
			&item.SessionID, &item.PromptName, &item.PromptVersion, &item.PromptVariablesHash, &item.ToolCount, &item.Error,
			&item.PromptTokens, &item.CompletionTokens, &item.TotalTokens,
			&item.CachedTokens, &item.ReasoningTokens,
			&item.EstimatedCost, &item.Currency, &item.TokenSource,
			&item.FinishReason, &item.CreatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		item.Stream = streamInt == 1
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	for i := range result {
		result[i].Languages, err = s.languagesForRequest(ctx, result[i].ID)
		if err != nil {
			return nil, err
		}
		result[i].Prompts, err = s.promptsForRequest(ctx, result[i].ID)
		if err != nil {
			return nil, err
		}
	}
	if err := s.attachNotes(ctx, result); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *SQLStore) UsageSince(ctx context.Context, filter UsageFilter) (int64, float64, int64, error) {
	where := []string{"r.created_at >= ?"}
	args := []any{filter.Since.UTC().Format(time.RFC3339Nano)}
	switch filter.Scope {
	case "api_key":
		where = append(where, "r.api_key_id = ?")
		args = append(args, filter.ScopeValue)
	case "team":
		where = append(where, requestTeamFilter)
		args = append(args, filter.ScopeValue)
	case "ip":
		where = append(where, "COALESCE(NULLIF(r.client_ip, ''), 'unknown') = ?")
		args = append(args, filter.ScopeValue)
	case "global":
		// no extra filter
	default:
		return 0, 0, 0, fmt.Errorf("unsupported quota scope %q", filter.Scope)
	}

	query := s.bind(`SELECT COUNT(r.id), COALESCE(SUM(t.total_tokens), 0), COALESCE(SUM(t.estimated_cost), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE ` + strings.Join(where, " AND "))

	var requests int64
	var tokens int64
	var cost float64
	if err := s.db.QueryRowContext(ctx, query, args...).Scan(&requests, &tokens, &cost); err != nil {
		return 0, 0, 0, err
	}
	return requests, cost, tokens, nil
}

func (s *SQLStore) GetTeamForAPIKey(ctx context.Context, apiKeyID string) (string, error) {
	if apiKeyID == "" || apiKeyID == "anonymous" {
		return "", nil
	}
	var team string
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT COALESCE(team, '') FROM api_keys WHERE id = ?`), apiKeyID).Scan(&team)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return team, err
}

// quota CRUD ------------------------------------------------------------------

func (s *SQLStore) ListQuotas(ctx context.Context) ([]QuotaPublic, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, scope, scope_value, period, token_limit, krw_limit, enabled, COALESCE(note, ''), created_at
		FROM quotas
		ORDER BY scope ASC, scope_value ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []QuotaPublic{}
	for rows.Next() {
		var q QuotaPublic
		var enabled int
		if err := rows.Scan(&q.ID, &q.Scope, &q.ScopeValue, &q.Period, &q.TokenLimit, &q.KRWLimit, &enabled, &q.Note, &q.CreatedAt); err != nil {
			return nil, err
		}
		q.Enabled = enabled == 1
		result = append(result, q)
	}
	return result, rows.Err()
}

func (s *SQLStore) ActiveQuotasFor(ctx context.Context, scope string, scopeValue string) ([]QuotaRecord, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, scope, scope_value, period, token_limit, krw_limit, enabled, COALESCE(note, ''), created_at
		FROM quotas WHERE enabled = 1 AND scope = ? AND scope_value = ?`), scope, scopeValue)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []QuotaRecord{}
	for rows.Next() {
		var q QuotaRecord
		var enabled int
		var createdAt string
		if err := rows.Scan(&q.ID, &q.Scope, &q.ScopeValue, &q.Period, &q.TokenLimit, &q.KRWLimit, &enabled, &q.Note, &createdAt); err != nil {
			return nil, err
		}
		q.Enabled = enabled == 1
		if parsed, err := time.Parse(time.RFC3339Nano, createdAt); err == nil {
			q.CreatedAt = parsed
		}
		result = append(result, q)
	}
	return result, rows.Err()
}

func (s *SQLStore) UpsertQuota(ctx context.Context, q QuotaRecord) error {
	if q.CreatedAt.IsZero() {
		q.CreatedAt = time.Now().UTC()
	}
	query := s.bind(`INSERT INTO quotas (id, scope, scope_value, period, token_limit, krw_limit, enabled, note, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			scope = excluded.scope,
			scope_value = excluded.scope_value,
			period = excluded.period,
			token_limit = excluded.token_limit,
			krw_limit = excluded.krw_limit,
			enabled = excluded.enabled,
			note = excluded.note`)
	_, err := s.db.ExecContext(ctx, query, q.ID, q.Scope, q.ScopeValue, q.Period, q.TokenLimit, q.KRWLimit, boolInt(q.Enabled), q.Note, formatTime(q.CreatedAt))
	return err
}

func (s *SQLStore) DeleteQuota(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM quotas WHERE id = ?`), id)
	return err
}

// retention ------------------------------------------------------------------

func (s *SQLStore) PurgeOlderThan(ctx context.Context, table string, days int) (int64, error) {
	if days <= 0 {
		return 0, nil
	}
	allowed := map[string]bool{"request_logs": true, "prompt_logs": true, "response_logs": true, "token_usage": true, "language_stats": true, "llm_evaluations": true, "llm_feedback": true}
	if !allowed[table] {
		return 0, fmt.Errorf("unsupported table %q for purge", table)
	}
	cutoff := time.Now().UTC().AddDate(0, 0, -days).Format(time.RFC3339Nano)

	if table == "request_logs" {
		// must also delete children
		var total int64
		queries := []string{
			`DELETE FROM prompt_logs WHERE request_id IN (SELECT id FROM request_logs WHERE created_at < ?)`,
			`DELETE FROM response_logs WHERE request_id IN (SELECT id FROM request_logs WHERE created_at < ?)`,
			`DELETE FROM token_usage WHERE request_id IN (SELECT id FROM request_logs WHERE created_at < ?)`,
			`DELETE FROM language_stats WHERE request_id IN (SELECT id FROM request_logs WHERE created_at < ?)`,
			`DELETE FROM llm_evaluations WHERE request_id IN (SELECT id FROM request_logs WHERE created_at < ?)`,
			`DELETE FROM llm_feedback WHERE request_id IN (SELECT id FROM request_logs WHERE created_at < ?)`,
			`DELETE FROM tool_invocations WHERE request_id IN (SELECT id FROM request_logs WHERE created_at < ?)`,
			`DELETE FROM request_logs WHERE created_at < ?`,
		}
		for _, q := range queries {
			res, err := s.db.ExecContext(ctx, s.bind(q), cutoff)
			if err != nil {
				return total, err
			}
			if n, err := res.RowsAffected(); err == nil {
				total += n
			}
		}
		return total, nil
	}

	res, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM `+table+` WHERE created_at < ?`), cutoff)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	return n, err
}

func (s *SQLStore) Timeseries(ctx context.Context, q TimeseriesQuery) ([]TimeseriesPoint, error) {
	where := []string{"r.created_at >= ?"}
	args := []any{q.Since.UTC().Format(time.RFC3339Nano)}
	switch q.Scope {
	case "api_key":
		where = append(where, "r.api_key_id = ?")
		args = append(args, q.ScopeValue)
	case "ip":
		where = append(where, "COALESCE(NULLIF(r.client_ip, ''), 'unknown') = ?")
		args = append(args, q.ScopeValue)
	case "model":
		where = append(where, "r.model = ?")
		args = append(args, q.ScopeValue)
	case "", "global":
		// no extra filter
	default:
		return nil, fmt.Errorf("unsupported timeseries scope %q", q.Scope)
	}

	bucketExpr := "substr(r.created_at, 1, 13)" // YYYY-MM-DDTHH (UTC hour bucket)
	bucketLabel := "hour"
	if q.Bucket == "day" {
		bucketExpr = "substr(r.created_at, 1, 10)" // YYYY-MM-DD
		bucketLabel = "day"
	}

	query := s.bind(fmt.Sprintf(`
		SELECT %s AS bucket,
			COUNT(r.id),
			COALESCE(SUM(t.total_tokens), 0),
			COALESCE(SUM(t.estimated_cost), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE %s
		GROUP BY %s
		ORDER BY bucket ASC
	`, bucketExpr, strings.Join(where, " AND "), bucketExpr))

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []TimeseriesPoint{}
	for rows.Next() {
		var p TimeseriesPoint
		if err := rows.Scan(&p.Date, &p.Requests, &p.Tokens, &p.CostKRW); err != nil {
			return nil, err
		}
		p.Bucket = bucketLabel
		result = append(result, p)
	}
	return result, rows.Err()
}

// HeatmapKST returns request counts bucketed by Asia/Seoul day-of-week (0=Sunday) and hour (0-23).
// The SQL only fetches raw timestamps; bucketing happens in Go so we can apply the KST offset
// without depending on database-specific timezone functions.
func (s *SQLStore) HeatmapKST(ctx context.Context, since time.Time) (Heatmap, error) {
	return s.heatmapKSTFilter(ctx, since, "1=1")
}

func (s *SQLStore) heatmapKSTFilter(ctx context.Context, since time.Time, whereClause string, args ...any) (Heatmap, error) {
	heat := Heatmap{Since: since.UTC().Format(time.RFC3339), Cells: []HeatmapCell{}}
	allArgs := append([]any{since.UTC().Format(time.RFC3339Nano)}, args...)
	rows, err := s.db.QueryContext(ctx, s.bind(fmt.Sprintf(`
		SELECT created_at
		FROM request_logs r
		WHERE r.created_at >= ? AND %s
	`, whereClause)), allArgs...)
	if err != nil {
		return heat, err
	}
	defer rows.Close()

	zone := time.FixedZone("KST", 9*3600)
	grid := [7][24]int64{}
	for rows.Next() {
		var ts string
		if err := rows.Scan(&ts); err != nil {
			return heat, err
		}
		parsed, err := time.Parse(time.RFC3339Nano, ts)
		if err != nil {
			parsed, err = time.Parse(time.RFC3339, ts)
			if err != nil {
				continue
			}
		}
		local := parsed.In(zone)
		grid[int(local.Weekday())][local.Hour()]++
	}
	if err := rows.Err(); err != nil {
		return heat, err
	}
	for d := 0; d < 7; d++ {
		for h := 0; h < 24; h++ {
			if grid[d][h] == 0 {
				continue
			}
			heat.Cells = append(heat.Cells, HeatmapCell{Day: d, Hour: h, Requests: grid[d][h]})
		}
	}
	return heat, nil
}

func (s *SQLStore) RequestRawBody(ctx context.Context, id string) (string, string, bool, error) {
	var body sql.NullString
	var endpoint string
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT COALESCE(body_raw, ''), endpoint FROM request_logs WHERE id = ?`), id).Scan(&body, &endpoint)
	if err == sql.ErrNoRows {
		return "", "", false, ErrNotFound
	}
	if err != nil {
		return "", "", false, err
	}
	return body.String, endpoint, true, nil
}

func (s *SQLStore) DistinctValues(ctx context.Context, field string, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 500 {
		limit = 500
	}
	var query string
	switch field {
	case "model":
		query = `SELECT model, COUNT(*) AS c FROM request_logs WHERE model != '' GROUP BY model ORDER BY c DESC LIMIT ?`
	case "ip":
		query = `SELECT COALESCE(NULLIF(client_ip, ''), 'unknown'), COUNT(*) AS c FROM request_logs GROUP BY COALESCE(NULLIF(client_ip, ''), 'unknown') ORDER BY c DESC LIMIT ?`
	case "language":
		query = `SELECT language, COUNT(DISTINCT request_id) AS c FROM language_stats GROUP BY language ORDER BY c DESC LIMIT ?`
	case "tag":
		query = `SELECT tags, 1 FROM request_notes WHERE tags != '' LIMIT ?`
	default:
		return nil, fmt.Errorf("unsupported field %q", field)
	}
	rows, err := s.db.QueryContext(ctx, s.bind(query), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	seen := map[string]bool{}
	result := []string{}
	for rows.Next() {
		var value string
		var count int64
		if err := rows.Scan(&value, &count); err != nil {
			return nil, err
		}
		if field == "tag" {
			for _, t := range strings.Split(value, ",") {
				t = strings.TrimSpace(t)
				if t == "" || seen[t] {
					continue
				}
				seen[t] = true
				result = append(result, t)
			}
			continue
		}
		if !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	return result, rows.Err()
}

func (s *SQLStore) Counts(ctx context.Context) (requests int64, prompts int64, responses int64, err error) {
	if err = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM request_logs`).Scan(&requests); err != nil {
		return
	}
	if err = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM prompt_logs`).Scan(&prompts); err != nil {
		return
	}
	if err = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM response_logs`).Scan(&responses); err != nil {
		return
	}
	return
}
