package store

import (
	"context"
	"strings"
	"time"
)

// TeamUsageTotals are aggregate counters for one team over a window.
type TeamUsageTotals struct {
	Requests     int64   `json:"requests"`
	Tokens       int64   `json:"tokens"`
	CostKRW      float64 `json:"cost_krw"`
	Errors       int64   `json:"errors"`
	AvgLatencyMS float64 `json:"avg_latency_ms"`
	SuccessRate  float64 `json:"success_rate"`
}

// TeamUserUsage is one member's usage within the team.
type TeamUserUsage struct {
	UserID   string  `json:"user_id"`
	Requests int64   `json:"requests"`
	CostKRW  float64 `json:"cost_krw"`
	Errors   int64   `json:"errors"`
}

// TeamModelUsage is one model's usage within the team.
type TeamModelUsage struct {
	Model    string  `json:"model"`
	Requests int64   `json:"requests"`
	CostKRW  float64 `json:"cost_krw"`
}

// TeamDashboardData is the team_manager landing payload: team totals, top members, model
// mix, and recent failures — all scoped to the caller's team, no operational internals.
type TeamDashboardData struct {
	TeamKeys       []string        `json:"team_keys"`
	Totals         TeamUsageTotals `json:"totals"`
	TopUsers       []TeamUserUsage `json:"top_users"`
	Models         []TeamModelUsage `json:"models"`
	RecentFailures []UserFailure   `json:"recent_failures"`
}

// teamErrorExpr classifies a failed request consistently across the team queries.
const teamErrorExpr = `(r.status_code >= 400 OR COALESCE(r.error, '') <> '' OR COALESCE(r.failover, 0) = 1)`

// TeamSkillStat is one skill's usage profile aggregated over a team's members.
type TeamSkillStat struct {
	SkillName    string  `json:"skill_name"`
	Runs         int64   `json:"runs"`
	OK           int64   `json:"ok"`
	Errors       int64   `json:"errors"`
	SuccessRate  float64 `json:"success_rate"`
	TotalCostKRW float64 `json:"total_cost_krw"`
	AvgLatencyMS float64 `json:"avg_latency_ms"`
}

// keyPlaceholders builds "?, ?, ..." + cleaned args for an IN clause.
func keyPlaceholders(keys []string) (string, []any) {
	ph := make([]string, 0, len(keys))
	args := make([]any, 0, len(keys))
	for _, k := range keys {
		if k = strings.TrimSpace(k); k != "" {
			ph = append(ph, "?")
			args = append(args, k)
		}
	}
	return strings.Join(ph, ","), args
}

// TeamPopularSkills ranks skills by usage among a team's members (skill_runs.actor → a
// user whose api key belongs to the team), busiest first. Powers 팀 인기 Skill.
func (s *SQLStore) TeamPopularSkills(ctx context.Context, keys []string, since time.Time, limit int) ([]TeamSkillStat, error) {
	in, args := keyPlaceholders(keys)
	if in == "" {
		return []TeamSkillStat{}, nil
	}
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	q := `SELECT sr.skill_name,
			COUNT(*),
			SUM(CASE WHEN sr.status = 'ok' THEN 1 ELSE 0 END),
			SUM(CASE WHEN sr.status = 'error' THEN 1 ELSE 0 END),
			COALESCE(SUM(sr.cost_krw), 0),
			COALESCE(AVG(sr.latency_ms), 0)
		FROM skill_runs sr
		WHERE sr.created_at >= ? AND EXISTS (
			SELECT 1 FROM api_keys k WHERE k.user_id = sr.actor AND k.team IN (` + in + `))
		GROUP BY sr.skill_name ORDER BY COUNT(*) DESC LIMIT ?`
	qArgs := append([]any{since.UTC().Format(time.RFC3339Nano)}, args...)
	qArgs = append(qArgs, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(q), qArgs...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TeamSkillStat{}
	for rows.Next() {
		var st TeamSkillStat
		if err := rows.Scan(&st.SkillName, &st.Runs, &st.OK, &st.Errors, &st.TotalCostKRW, &st.AvgLatencyMS); err != nil {
			return nil, err
		}
		if st.Runs > 0 {
			st.SuccessRate = float64(st.OK) / float64(st.Runs)
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

// TeamQualityExtras carries per-team quality signals not in TeamUsageTotals: cache-hit rate
// (cost discipline) and Text2SQL validity (data-query quality).
type TeamQualityExtras struct {
	CacheRate     float64 `json:"cache_rate"`
	Text2SQLTotal int64   `json:"text2sql_total"`
	Text2SQLOK    int64   `json:"text2sql_ok"`
}

// TeamQualityExtras computes the team's cache-hit rate and Text2SQL success counts since `since`.
func (s *SQLStore) TeamQualityExtras(ctx context.Context, keys []string, since time.Time) (TeamQualityExtras, error) {
	var out TeamQualityExtras
	in, args := keyPlaceholders(keys)
	if in == "" {
		return out, nil
	}
	sinceStr := since.UTC().Format(time.RFC3339Nano)

	cacheQ := `SELECT COALESCE(AVG(CASE WHEN COALESCE(t.cached_tokens, 0) > 0 THEN 1.0 ELSE 0.0 END), 0)
		FROM request_logs r
		JOIN api_keys k ON k.id = r.api_key_id
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE k.team IN (` + in + `) AND r.created_at >= ?`
	cacheArgs := append(append([]any{}, args...), sinceStr)
	if err := s.db.QueryRowContext(ctx, s.bind(cacheQ), cacheArgs...).Scan(&out.CacheRate); err != nil {
		return out, err
	}

	t2sQ := `SELECT COUNT(*), COALESCE(SUM(CASE WHEN valid = 1 THEN 1 ELSE 0 END), 0)
		FROM text2sql_query_logs
		WHERE team IN (` + in + `) AND created_at >= ?`
	t2sArgs := append(append([]any{}, args...), sinceStr)
	if err := s.db.QueryRowContext(ctx, s.bind(t2sQ), t2sArgs...).Scan(&out.Text2SQLTotal, &out.Text2SQLOK); err != nil {
		return out, err
	}
	return out, nil
}

// TeamTemplateCandidate is a recurring prompt cluster within a team, proposed as a team
// template. AlreadyProduct marks clusters already promoted to a prompt product.
type TeamTemplateCandidate struct {
	Fingerprint   string  `json:"fingerprint"`
	TaskType      string  `json:"task_type"`
	Requests      int64   `json:"requests"`
	AvgCostKRW    float64 `json:"avg_cost_krw"`
	SuccessRate   float64 `json:"success_rate"`
	AlreadyProduct bool   `json:"already_product"`
}

// TeamTemplateCandidates returns the most frequent prompt clusters for a team (≥minCount),
// flagging those already productized. Powers 팀 추천 템플릿.
func (s *SQLStore) TeamTemplateCandidates(ctx context.Context, keys []string, since time.Time, minCount, limit int) ([]TeamTemplateCandidate, error) {
	teamFilter, teamArgs := teamInClause(keys)
	if teamFilter == "" {
		return []TeamTemplateCandidate{}, nil
	}
	if minCount < 2 {
		minCount = 2
	}
	if limit <= 0 || limit > 100 {
		limit = 15
	}
	q := `SELECT r.prompt_fingerprint,
			COALESCE(NULLIF(MAX(r.task_type), ''), 'other') AS task_type,
			COUNT(*) AS requests,
			AVG(COALESCE(t.estimated_cost, 0)) AS avg_cost,
			SUM(CASE WHEN r.status_code >= 200 AND r.status_code < 300 AND COALESCE(r.error,'') = '' AND COALESCE(r.failover,0) = 0 THEN 1 ELSE 0 END) AS successes
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE r.created_at >= ? AND r.endpoint LIKE '%chat/completions%' AND COALESCE(r.prompt_fingerprint,'') <> '' AND ` + teamFilter + `
		GROUP BY r.prompt_fingerprint
		HAVING COUNT(*) >= ?
		ORDER BY requests DESC LIMIT ?`
	qArgs := append([]any{since.UTC().Format(time.RFC3339Nano)}, teamArgs...)
	qArgs = append(qArgs, minCount, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(q), qArgs...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TeamTemplateCandidate{}
	for rows.Next() {
		var c TeamTemplateCandidate
		var successes int64
		if err := rows.Scan(&c.Fingerprint, &c.TaskType, &c.Requests, &c.AvgCostKRW, &successes); err != nil {
			return nil, err
		}
		if c.Requests > 0 {
			c.SuccessRate = float64(successes) / float64(c.Requests)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Flag clusters already promoted to a prompt product.
	if fps, err := s.PromptProductFingerprints(ctx); err == nil {
		for i := range out {
			out[i].AlreadyProduct = fps[out[i].Fingerprint]
		}
	}
	return out, nil
}

// TeamMCPTool is one MCP tool's usage within a team.
type TeamMCPTool struct {
	ServerLabel  string  `json:"server_label"`
	ToolName     string  `json:"tool_name"`
	Ref          string  `json:"ref"` // server/tool
	Calls        int64   `json:"calls"`
	Errors       int64   `json:"errors"`
	SuccessRate  float64 `json:"success_rate"`
	AvgLatencyMS float64 `json:"avg_latency_ms"`
}

// TeamMCPTools ranks the MCP tools a team actually uses (by call volume), with success
// rate and latency. Powers the team onboarding pack's recommended-MCP section.
func (s *SQLStore) TeamMCPTools(ctx context.Context, keys []string, since time.Time, limit int) ([]TeamMCPTool, error) {
	teamFilter, teamArgs := teamInClause(keys)
	if teamFilter == "" {
		return []TeamMCPTool{}, nil
	}
	if limit <= 0 || limit > 50 {
		limit = 5
	}
	q := `SELECT COALESCE(NULLIF(ti.server_label,''),'(none)') AS server_label, ti.tool_name,
			COUNT(*),
			COALESCE(SUM(CASE WHEN ti.is_error = 1 THEN 1 ELSE 0 END), 0),
			COALESCE(AVG(r.latency_ms), 0)
		FROM tool_invocations ti
		JOIN request_logs r ON r.id = ti.request_id
		WHERE ti.created_at >= ? AND ti.is_mcp = 1 AND ti.source = 'call' AND COALESCE(ti.tool_name,'') <> '' AND ` + teamFilter + `
		GROUP BY server_label, ti.tool_name
		ORDER BY COUNT(*) DESC LIMIT ?`
	qArgs := append([]any{since.UTC().Format(time.RFC3339Nano)}, teamArgs...)
	qArgs = append(qArgs, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(q), qArgs...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TeamMCPTool{}
	for rows.Next() {
		var m TeamMCPTool
		if err := rows.Scan(&m.ServerLabel, &m.ToolName, &m.Calls, &m.Errors, &m.AvgLatencyMS); err != nil {
			return nil, err
		}
		if m.Calls > 0 {
			m.SuccessRate = float64(m.Calls-m.Errors) / float64(m.Calls)
		}
		m.Ref = m.ServerLabel + "/" + m.ToolName
		out = append(out, m)
	}
	return out, rows.Err()
}

// teamInClause builds "(requestTeamExpr) IN (?, ?, ...)" plus the bound args for a set of
// acceptable team identifiers (a team is stored on api_keys.team as id-or-name, so callers
// pass both their team id and name to match either).
func teamInClause(keys []string) (string, []any) {
	ph := make([]string, 0, len(keys))
	args := make([]any, 0, len(keys))
	for _, k := range keys {
		k = strings.TrimSpace(k)
		if k == "" {
			continue
		}
		ph = append(ph, "?")
		args = append(args, k)
	}
	if len(ph) == 0 {
		return "", nil
	}
	return requestTeamExpr + " IN (" + strings.Join(ph, ",") + ")", args
}

// TeamDashboardSince assembles the team dashboard for the given team identifiers since the
// cutoff. Returns zero-valued data (not an error) when keys is empty.
func (s *SQLStore) TeamDashboardSince(ctx context.Context, keys []string, since time.Time, limit int) (TeamDashboardData, error) {
	out := TeamDashboardData{TeamKeys: keys, TopUsers: []TeamUserUsage{}, Models: []TeamModelUsage{}, RecentFailures: []UserFailure{}}
	teamFilter, teamArgs := teamInClause(keys)
	if teamFilter == "" {
		return out, nil
	}
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	sinceStr := since.UTC().Format(time.RFC3339Nano)

	// Totals.
	totalsArgs := append([]any{sinceStr}, teamArgs...)
	err := s.db.QueryRowContext(ctx, s.bind(`
		SELECT COUNT(*),
			COALESCE(SUM(t.total_tokens), 0),
			COALESCE(SUM(t.estimated_cost), 0),
			COALESCE(SUM(CASE WHEN `+teamErrorExpr+` THEN 1 ELSE 0 END), 0),
			COALESCE(AVG(r.latency_ms), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE r.created_at >= ? AND `+teamFilter), totalsArgs...).
		Scan(&out.Totals.Requests, &out.Totals.Tokens, &out.Totals.CostKRW, &out.Totals.Errors, &out.Totals.AvgLatencyMS)
	if err != nil {
		return out, err
	}
	if out.Totals.Requests > 0 {
		out.Totals.SuccessRate = float64(out.Totals.Requests-out.Totals.Errors) / float64(out.Totals.Requests)
	}

	// Top members.
	userArgs := append(append([]any{sinceStr}, teamArgs...), limit)
	urows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT COALESCE(NULLIF((SELECT k.user_id FROM api_keys k WHERE k.id = r.api_key_id), ''), 'unattributed') AS uid,
			COUNT(*),
			COALESCE(SUM(t.estimated_cost), 0),
			COALESCE(SUM(CASE WHEN `+teamErrorExpr+` THEN 1 ELSE 0 END), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE r.created_at >= ? AND `+teamFilter+`
		GROUP BY uid ORDER BY COUNT(*) DESC LIMIT ?`), userArgs...)
	if err != nil {
		return out, err
	}
	for urows.Next() {
		var u TeamUserUsage
		if err := urows.Scan(&u.UserID, &u.Requests, &u.CostKRW, &u.Errors); err != nil {
			urows.Close()
			return out, err
		}
		out.TopUsers = append(out.TopUsers, u)
	}
	urows.Close()
	if err := urows.Err(); err != nil {
		return out, err
	}

	// Model mix.
	mrows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT COALESCE(NULLIF(r.model, ''), '(unknown)') AS model,
			COUNT(*),
			COALESCE(SUM(t.estimated_cost), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE r.created_at >= ? AND `+teamFilter+`
		GROUP BY model ORDER BY COUNT(*) DESC LIMIT ?`), userArgs...)
	if err != nil {
		return out, err
	}
	for mrows.Next() {
		var m TeamModelUsage
		if err := mrows.Scan(&m.Model, &m.Requests, &m.CostKRW); err != nil {
			mrows.Close()
			return out, err
		}
		out.Models = append(out.Models, m)
	}
	mrows.Close()
	if err := mrows.Err(); err != nil {
		return out, err
	}

	// Recent failures (team-scoped).
	frows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT r.id, COALESCE(NULLIF(r.model, ''), '(unknown)'), r.status_code,
			COALESCE(r.error, ''), COALESCE(NULLIF(r.task_type, ''), 'other'), r.created_at
		FROM request_logs r
		WHERE r.created_at >= ? AND `+teamFilter+` AND `+teamErrorExpr+`
		ORDER BY r.created_at DESC LIMIT ?`), userArgs...)
	if err != nil {
		return out, err
	}
	for frows.Next() {
		var f UserFailure
		if err := frows.Scan(&f.ID, &f.Model, &f.StatusCode, &f.Error, &f.TaskType, &f.CreatedAt); err != nil {
			frows.Close()
			return out, err
		}
		out.RecentFailures = append(out.RecentFailures, f)
	}
	frows.Close()
	return out, frows.Err()
}
