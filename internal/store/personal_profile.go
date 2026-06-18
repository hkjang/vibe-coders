package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ProfileCount is a (key, requests) pair used in a profile's top-N breakdowns.
type ProfileCount struct {
	Key      string `json:"key"`
	Requests int64  `json:"requests"`
}

// PersonalProfile summarizes one user's AI usage: team/role, volume + cost tendency,
// reliability, and preferred task types / models / languages. It is a derived, read-only
// signal intended to seed routing, template recommendations, Text2SQL hints, and cost
// coaching. Computed from request_logs joined to api_keys (for user identity).
type PersonalProfile struct {
	UserID               string         `json:"user_id"`
	Team                 string         `json:"team"`
	Role                 string         `json:"role"`
	Requests             int64          `json:"requests"`
	TotalCostKRW         float64        `json:"total_cost_krw"`
	AvgCostPerRequest    float64        `json:"avg_cost_per_request"`
	AvgLatencyMS         float64        `json:"avg_latency_ms"`
	SuccessRate          float64        `json:"success_rate"`
	ErrorRate            float64        `json:"error_rate"`
	CacheRate            float64        `json:"cache_rate"`
	Text2SQLUsageRate    float64        `json:"text2sql_usage_rate"`
	MCPUsageRate         float64        `json:"mcp_usage_rate"`
	RiskScore            int            `json:"risk_score"`
	DistinctModels       int64          `json:"distinct_models"`
	DistinctFingerprints int64          `json:"distinct_prompt_fingerprints"`
	TopTaskTypes         []ProfileCount `json:"top_task_types"`
	TopModels            []ProfileCount `json:"top_models"`
	TopLanguages         []ProfileCount `json:"top_languages"`
	TopMCPTools          []ProfileCount `json:"top_mcp_tools"`
	Summary              string         `json:"summary"`
	Since                string         `json:"since"`
}

// PersonalProfileActiveUsers returns the user_ids with the most requests since `since`.
func (s *SQLStore) PersonalProfileActiveUsers(ctx context.Context, since time.Time, limit int) ([]string, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT k.user_id, COUNT(*)
		FROM request_logs r
		JOIN api_keys k ON k.id = r.api_key_id
		WHERE COALESCE(k.user_id, '') <> '' AND r.created_at >= ?
		GROUP BY k.user_id
		ORDER BY COUNT(*) DESC
		LIMIT ?`), since.UTC().Format(time.RFC3339Nano), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var uid string
		var n int64
		if err := rows.Scan(&uid, &n); err != nil {
			return nil, err
		}
		out = append(out, uid)
	}
	return out, rows.Err()
}

// BuildPersonalProfile computes a user's profile from logs over the window.
func (s *SQLStore) BuildPersonalProfile(ctx context.Context, userID string, since time.Time) (PersonalProfile, error) {
	p := PersonalProfile{UserID: userID, Since: since.UTC().Format(time.RFC3339Nano),
		TopTaskTypes: []ProfileCount{}, TopModels: []ProfileCount{}, TopLanguages: []ProfileCount{}, TopMCPTools: []ProfileCount{}}
	sinceStr := since.UTC().Format(time.RFC3339Nano)

	var successes int64
	var cacheHits, text2sqlRequests, mcpRequests int64
	err := s.db.QueryRowContext(ctx, s.bind(`
		SELECT COALESCE(MAX(k.team), ''), COALESCE(MAX(k.role), ''),
			COUNT(*),
			COALESCE(SUM(t.estimated_cost), 0),
			COALESCE(SUM(CASE WHEN r.status_code >= 200 AND r.status_code < 300 AND COALESCE(r.error, '') = '' AND COALESCE(r.failover, 0) = 0 THEN 1 ELSE 0 END), 0),
			COALESCE(AVG(r.latency_ms), 0),
			COALESCE(SUM(CASE WHEN COALESCE(r.route_reason, '') = 'cache' OR COALESCE(t.cached_tokens, 0) > 0 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN COALESCE(r.route_reason, '') = 'text2sql' OR EXISTS (SELECT 1 FROM text2sql_query_logs q WHERE q.request_id = r.id) THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM tool_invocations ti WHERE ti.request_id = r.id AND ti.is_mcp = 1) THEN 1 ELSE 0 END), 0),
			COUNT(DISTINCT NULLIF(r.model, '')),
			COUNT(DISTINCT NULLIF(r.prompt_fingerprint, ''))
		FROM request_logs r
		JOIN api_keys k ON k.id = r.api_key_id
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE k.user_id = ? AND r.created_at >= ?`), userID, sinceStr).
		Scan(&p.Team, &p.Role, &p.Requests, &p.TotalCostKRW, &successes, &p.AvgLatencyMS, &cacheHits, &text2sqlRequests, &mcpRequests, &p.DistinctModels, &p.DistinctFingerprints)
	if err != nil {
		return p, err
	}
	if p.Requests > 0 {
		p.SuccessRate = float64(successes) / float64(p.Requests)
		p.ErrorRate = 1 - p.SuccessRate
		p.AvgCostPerRequest = p.TotalCostKRW / float64(p.Requests)
		p.CacheRate = float64(cacheHits) / float64(p.Requests)
		p.Text2SQLUsageRate = float64(text2sqlRequests) / float64(p.Requests)
		p.MCPUsageRate = float64(mcpRequests) / float64(p.Requests)
	}

	if p.TopTaskTypes, err = s.profileTopCounts(ctx, `COALESCE(NULLIF(r.task_type, ''), 'other')`, userID, sinceStr, false); err != nil {
		return p, err
	}
	if p.TopModels, err = s.profileTopCounts(ctx, `COALESCE(NULLIF(r.model, ''), '(unknown)')`, userID, sinceStr, false); err != nil {
		return p, err
	}
	if p.TopLanguages, err = s.profileTopCounts(ctx, `COALESCE(NULLIF(pl.language_hint, ''), '(unknown)')`, userID, sinceStr, true); err != nil {
		return p, err
	}
	if p.TopMCPTools, err = s.profileTopMCPTools(ctx, userID, sinceStr); err != nil {
		return p, err
	}
	if p.RiskScore, err = s.personalRiskScore(ctx, userID, sinceStr); err != nil {
		return p, err
	}
	p.Summary = personalProfileSummary(p)
	return p, nil
}

// profileTopCounts runs a top-5 GROUP BY of the given expression for a user. When joinPrompts
// is set, it joins user-role prompt_logs (for language breakdowns).
func (s *SQLStore) profileTopCounts(ctx context.Context, expr, userID, sinceStr string, joinPrompts bool) ([]ProfileCount, error) {
	join := ""
	if joinPrompts {
		join = "JOIN prompt_logs pl ON pl.request_id = r.id AND pl.role = 'user'"
	}
	query := s.bind(fmt.Sprintf(`
		SELECT %s AS key, COUNT(*)
		FROM request_logs r
		JOIN api_keys k ON k.id = r.api_key_id
		%s
		WHERE k.user_id = ? AND r.created_at >= ?
		GROUP BY %s
		ORDER BY COUNT(*) DESC
		LIMIT 5`, expr, join, expr))
	rows, err := s.db.QueryContext(ctx, query, userID, sinceStr)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ProfileCount{}
	for rows.Next() {
		var c ProfileCount
		if err := rows.Scan(&c.Key, &c.Requests); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *SQLStore) profileTopMCPTools(ctx context.Context, userID, sinceStr string) ([]ProfileCount, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT COALESCE(NULLIF(ti.server_label, ''), '(none)') || '/' || ti.tool_name AS key, COUNT(*)
		FROM tool_invocations ti
		JOIN request_logs r ON r.id = ti.request_id
		JOIN api_keys k ON k.id = r.api_key_id
		WHERE k.user_id = ? AND r.created_at >= ? AND ti.is_mcp = 1 AND ti.source = 'call'
		GROUP BY COALESCE(NULLIF(ti.server_label, ''), '(none)') || '/' || ti.tool_name
		ORDER BY COUNT(*) DESC
		LIMIT 5`), userID, sinceStr)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ProfileCount{}
	for rows.Next() {
		var c ProfileCount
		if err := rows.Scan(&c.Key, &c.Requests); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *SQLStore) personalRiskScore(ctx context.Context, userID, sinceStr string) (int, error) {
	var secretEvents, policyDecisions, riskyText2SQL, mcpToolErrors int64
	err := s.db.QueryRowContext(ctx, s.bind(`
		SELECT
			COALESCE((SELECT COUNT(*) FROM secret_events se LEFT JOIN api_keys k ON k.id = se.api_key_id
				WHERE (se.user_id = ? OR k.user_id = ?) AND se.created_at >= ?), 0),
			COALESCE((SELECT COUNT(*) FROM policy_decision_events pde LEFT JOIN api_keys k ON k.id = pde.api_key_id
				WHERE (pde.user_id = ? OR k.user_id = ?) AND pde.created_at >= ? AND LOWER(COALESCE(pde.decision, '')) <> 'default'), 0),
			COALESCE((SELECT COUNT(*) FROM text2sql_query_logs q JOIN api_keys k ON k.id = q.api_key_id
				WHERE k.user_id = ? AND q.created_at >= ? AND (q.valid = 0 OR COALESCE(q.explain_risk, 0) >= 80)), 0),
			COALESCE((SELECT COUNT(*) FROM tool_invocations ti JOIN request_logs r ON r.id = ti.request_id JOIN api_keys k ON k.id = r.api_key_id
				WHERE k.user_id = ? AND r.created_at >= ? AND ti.is_mcp = 1 AND ti.is_error = 1), 0)
	`), userID, userID, sinceStr, userID, userID, sinceStr, userID, sinceStr, userID, sinceStr).
		Scan(&secretEvents, &policyDecisions, &riskyText2SQL, &mcpToolErrors)
	if err != nil {
		return 0, err
	}
	score := int(secretEvents*12 + policyDecisions*8 + riskyText2SQL*10 + mcpToolErrors*4)
	if score > 100 {
		score = 100
	}
	return score, nil
}

// personalProfileSummary renders a short Korean one-liner describing the user.
func personalProfileSummary(p PersonalProfile) string {
	if p.Requests == 0 {
		return "해당 기간 활동 없음"
	}
	tasks := make([]string, 0, 3)
	for i, tt := range p.TopTaskTypes {
		if i >= 3 {
			break
		}
		tasks = append(tasks, tt.Key)
	}
	topModel := "(없음)"
	if len(p.TopModels) > 0 {
		topModel = p.TopModels[0].Key
	}
	taskStr := "다양한 작업"
	if len(tasks) > 0 {
		taskStr = strings.Join(tasks, ", ")
	}
	return fmt.Sprintf("주로 %s을(를) 수행하며 %s 모델을 선호. 성공률 %.0f%%, 요청당 평균 %.2f KRW, 캐시 %.0f%%, MCP %.0f%% (총 %d건).",
		taskStr, topModel, p.SuccessRate*100, p.AvgCostPerRequest, p.CacheRate*100, p.MCPUsageRate*100, p.Requests)
}

// UpsertPersonalProfile stores the latest computed profile JSON for a user.
func (s *SQLStore) UpsertPersonalProfile(ctx context.Context, userID, profileJSON string) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO personal_profiles (user_id, profile, updated_at)
		VALUES (?, ?, ?)
		ON CONFLICT(user_id) DO UPDATE SET profile = excluded.profile, updated_at = excluded.updated_at`),
		userID, profileJSON, now)
	return err
}

// GetStoredPersonalProfile returns the last stored profile JSON for a user, if any.
func (s *SQLStore) GetStoredPersonalProfile(ctx context.Context, userID string) (string, string, bool, error) {
	var profile, updatedAt string
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT profile, updated_at FROM personal_profiles WHERE user_id = ?`), userID).
		Scan(&profile, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	return profile, updatedAt, true, nil
}

// InsertPersonalProfileSnapshot records a point-in-time profile for a user.
func (s *SQLStore) InsertPersonalProfileSnapshot(ctx context.Context, id, userID, profileJSON string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO personal_profile_snapshots (id, user_id, profile, created_at)
		VALUES (?, ?, ?, ?)`), id, userID, profileJSON, time.Now().UTC().Format(time.RFC3339Nano))
	return err
}

// PersonalProfileSnapshot is one stored historical profile.
type PersonalProfileSnapshot struct {
	ID        string `json:"id"`
	Profile   string `json:"profile"`
	CreatedAt string `json:"created_at"`
}

// ProfileDrift summarizes how a user's profile changed between their two most recent
// snapshots: deltas in volume, cost, reliability, and shifts in the dominant model/task.
// Flags surface notable movements. Read-only.
type ProfileDrift struct {
	UserID           string   `json:"user_id"`
	HasBaseline      bool     `json:"has_baseline"` // false when < 2 snapshots exist
	From             string   `json:"from"`         // older snapshot timestamp
	To               string   `json:"to"`           // newer snapshot timestamp
	RequestsDelta    int64    `json:"requests_delta"`
	CostDeltaKRW     float64  `json:"cost_delta_krw"`
	AvgCostDelta     float64  `json:"avg_cost_delta_krw"`
	SuccessRateDelta float64  `json:"success_rate_delta"`
	TopModelFrom     string   `json:"top_model_from"`
	TopModelTo       string   `json:"top_model_to"`
	TopModelChanged  bool     `json:"top_model_changed"`
	TopTaskFrom      string   `json:"top_task_from"`
	TopTaskTo        string   `json:"top_task_to"`
	TopTaskChanged   bool     `json:"top_task_changed"`
	Flags            []string `json:"flags"`
}

func topKeyOf(list []ProfileCount) string {
	if len(list) > 0 {
		return list[0].Key
	}
	return ""
}

// ProfileDriftForUser computes drift between the user's two most recent profile snapshots.
// Returns HasBaseline=false when fewer than two snapshots exist.
func (s *SQLStore) ProfileDriftForUser(ctx context.Context, userID string) (ProfileDrift, error) {
	d := ProfileDrift{UserID: userID, Flags: []string{}}
	snaps, err := s.ListPersonalProfileSnapshots(ctx, userID, 2)
	if err != nil {
		return d, err
	}
	if len(snaps) < 2 {
		return d, nil
	}
	var newer, older PersonalProfile
	if err := json.Unmarshal([]byte(snaps[0].Profile), &newer); err != nil {
		return d, nil
	}
	if err := json.Unmarshal([]byte(snaps[1].Profile), &older); err != nil {
		return d, nil
	}
	d.HasBaseline = true
	d.From = snaps[1].CreatedAt
	d.To = snaps[0].CreatedAt
	d.RequestsDelta = newer.Requests - older.Requests
	d.CostDeltaKRW = newer.TotalCostKRW - older.TotalCostKRW
	d.AvgCostDelta = newer.AvgCostPerRequest - older.AvgCostPerRequest
	d.SuccessRateDelta = newer.SuccessRate - older.SuccessRate
	d.TopModelFrom = topKeyOf(older.TopModels)
	d.TopModelTo = topKeyOf(newer.TopModels)
	d.TopModelChanged = d.TopModelFrom != d.TopModelTo
	d.TopTaskFrom = topKeyOf(older.TopTaskTypes)
	d.TopTaskTo = topKeyOf(newer.TopTaskTypes)
	d.TopTaskChanged = d.TopTaskFrom != d.TopTaskTo

	if d.AvgCostDelta > 0.01 {
		d.Flags = append(d.Flags, "cost_up")
	} else if d.AvgCostDelta < -0.01 {
		d.Flags = append(d.Flags, "cost_down")
	}
	if d.SuccessRateDelta < -0.02 {
		d.Flags = append(d.Flags, "success_down")
	}
	if d.TopModelChanged {
		d.Flags = append(d.Flags, "model_shift")
	}
	if d.TopTaskChanged {
		d.Flags = append(d.Flags, "task_shift")
	}
	return d, nil
}

// ListPersonalProfileSnapshots returns a user's snapshots newest-first.
func (s *SQLStore) ListPersonalProfileSnapshots(ctx context.Context, userID string, limit int) ([]PersonalProfileSnapshot, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, profile, created_at
		FROM personal_profile_snapshots WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`), userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PersonalProfileSnapshot{}
	for rows.Next() {
		var s PersonalProfileSnapshot
		if err := rows.Scan(&s.ID, &s.Profile, &s.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}
