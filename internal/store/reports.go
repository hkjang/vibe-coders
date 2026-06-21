package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// UserCodingReport is a per-user activity summary over a window (e.g. weekly):
// request volume, cost, error rate, the models/languages they lean on, a daily
// trend, and how much wall-clock time their sessions span.
type UserCodingReport struct {
	APIKeyID    string            `json:"api_key_id"`
	Name        string            `json:"name"`
	Owner       string            `json:"owner"`
	Team        string            `json:"team"`
	WindowStart string            `json:"window_start"`
	WindowEnd   string            `json:"window_end"`
	Requests    int64             `json:"requests"`
	Tokens      int64             `json:"tokens"`
	CostKRW     float64           `json:"cost_krw"`
	AvgLatency  float64           `json:"average_latency_ms"`
	Errors      int64             `json:"error_requests"`
	ErrorRate   float64           `json:"error_rate"`
	TopModels   []GroupedStat     `json:"top_models"`
	Languages   []LanguageGrouped `json:"top_languages"`
	Daily       []TimeseriesPoint `json:"daily"`
	Sessions    int64             `json:"sessions"`
	WorkSeconds float64           `json:"work_seconds"`
	AvgSession  float64           `json:"average_session_seconds"`
}

// UserCodingReportSince builds a UserCodingReport for a single api_key_id over
// [since, now]. It returns ErrNotFound when the key has neither a registered row
// nor any traffic in the window.
func (s *SQLStore) UserCodingReportSince(ctx context.Context, apiKeyID string, since time.Time) (UserCodingReport, error) {
	now := time.Now().UTC()
	report := UserCodingReport{
		APIKeyID:    apiKeyID,
		WindowStart: since.UTC().Format(time.RFC3339),
		WindowEnd:   now.Format(time.RFC3339),
		TopModels:   []GroupedStat{},
		Languages:   []LanguageGrouped{},
		Daily:       []TimeseriesPoint{},
	}
	sinceStr := since.UTC().Format(time.RFC3339Nano)

	// Identity: prefer a registered api_keys row; fall back to a synthetic label.
	var name, owner, team string
	registered := true
	err := s.db.QueryRowContext(ctx, s.bind(`
		SELECT name, COALESCE(owner, ''), COALESCE(team, '')
		FROM api_keys WHERE id = ?
	`), apiKeyID).Scan(&name, &owner, &team)
	if err == sql.ErrNoRows {
		registered = false
		name = friendlyAPIKeyName(apiKeyID)
	} else if err != nil {
		return report, err
	}
	report.Name, report.Owner, report.Team = name, owner, team

	// Core volume/cost/latency + error counts over the window.
	where := "r.api_key_id = ? AND r.created_at >= ?"
	err = s.db.QueryRowContext(ctx, s.bind(`
		SELECT COUNT(r.id),
			COALESCE(SUM(t.total_tokens), 0),
			COALESCE(SUM(t.estimated_cost), 0),
			COALESCE(AVG(r.latency_ms), 0),
			COALESCE(SUM(CASE WHEN r.status_code >= 400 THEN 1 ELSE 0 END), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE `+where), apiKeyID, sinceStr).
		Scan(&report.Requests, &report.Tokens, &report.CostKRW, &report.AvgLatency, &report.Errors)
	if err != nil {
		return report, err
	}
	if report.Requests == 0 && !registered {
		// No traffic in the window and no registered key: 404 unless this id has
		// ever produced traffic (a known external/passthrough caller).
		var everSeen int
		_ = s.db.QueryRowContext(ctx, s.bind(`SELECT COUNT(1) FROM request_logs WHERE api_key_id = ?`), apiKeyID).Scan(&everSeen)
		if everSeen == 0 {
			return report, ErrNotFound
		}
	}
	if report.Requests > 0 {
		report.ErrorRate = float64(report.Errors) / float64(report.Requests)
	}

	// Reuse the windowed helpers for model/language/daily breakdowns.
	if report.TopModels, err = s.groupedFilter(ctx, "r.model", where, apiKeyID, sinceStr); err != nil {
		return report, err
	}
	if report.Languages, err = s.languagesFilter(ctx, where, apiKeyID, sinceStr); err != nil {
		return report, err
	}
	if report.Daily, err = s.dailyTimeseries(ctx, where, apiKeyID, sinceStr); err != nil {
		return report, err
	}

	// Session work time: span of each session in the window, summed in Go so the
	// timestamp math stays portable across SQLite and PostgreSQL.
	report.Sessions, report.WorkSeconds, err = s.sessionWorkSeconds(ctx, apiKeyID, sinceStr)
	if err != nil {
		return report, err
	}
	if report.Sessions > 0 {
		report.AvgSession = report.WorkSeconds / float64(report.Sessions)
	}

	return report, nil
}

// sessionWorkSeconds sums the wall-clock span (last - first request) of each of
// the user's sessions within the window.
func (s *SQLStore) sessionWorkSeconds(ctx context.Context, apiKeyID, sinceStr string) (int64, float64, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT MIN(r.created_at), MAX(r.created_at)
		FROM request_logs r
		WHERE r.api_key_id = ? AND r.created_at >= ? AND COALESCE(r.session_id, '') <> ''
		GROUP BY r.session_id
	`), apiKeyID, sinceStr)
	if err != nil {
		return 0, 0, err
	}
	defer rows.Close()

	var sessions int64
	var total float64
	for rows.Next() {
		var minStr, maxStr string
		if err := rows.Scan(&minStr, &maxStr); err != nil {
			return 0, 0, err
		}
		sessions++
		first, ok1 := parseStoredTime(minStr)
		last, ok2 := parseStoredTime(maxStr)
		if ok1 && ok2 && last.After(first) {
			total += last.Sub(first).Seconds()
		}
	}
	return sessions, total, rows.Err()
}

// TeamForecast projects a team's month-to-date spend to month end at the current
// run-rate, and (when a team budget exists) whether it will exceed it.
type TeamForecast struct {
	Team         string  `json:"team"`
	SpentKRW     float64 `json:"spent_krw"`
	ProjectedKRW float64 `json:"projected_krw"`
	BudgetKRW    float64 `json:"budget_krw"` // 0 when no team budget is set
	HasBudget    bool    `json:"has_budget"`
	WillExceed   bool    `json:"will_exceed"`
	OverageKRW   float64 `json:"projected_overage_krw"`
	DaysElapsed  float64 `json:"days_elapsed"`
	DaysInMonth  float64 `json:"days_in_month"`
}

// TeamMonthlyForecast computes, for every team with traffic this calendar month,
// its run-rate projection to month end and overage vs any configured team budget.
func (s *SQLStore) TeamMonthlyForecast(ctx context.Context, now time.Time) ([]TeamForecast, error) {
	start, daysInMonth := kstMonthBounds(now)
	elapsed := now.Sub(start).Hours() / 24
	if elapsed < 0.02 {
		elapsed = 0.02
	}

	// Resolve team budgets first (a separate query) so its connection is released
	// before the main cursor opens — opening it mid-iteration deadlocks on SQLite's
	// single connection.
	budgets, err := s.ListBudgets(ctx)
	if err != nil {
		return nil, err
	}
	budgetByTeam := map[string]float64{}
	for _, b := range budgets {
		if b.Scope == "team" && b.MonthlyKRW > 0 {
			budgetByTeam[b.ScopeValue] = b.MonthlyKRW
		}
	}

	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT COALESCE(NULLIF(k.team, ''), '(none)') AS team, COALESCE(SUM(t.estimated_cost), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		LEFT JOIN api_keys k ON k.id = r.api_key_id
		WHERE r.created_at >= ?
		GROUP BY COALESCE(NULLIF(k.team, ''), '(none)')`), start.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []TeamForecast{}
	for rows.Next() {
		var f TeamForecast
		if err := rows.Scan(&f.Team, &f.SpentKRW); err != nil {
			return nil, err
		}
		f.DaysElapsed, f.DaysInMonth = elapsed, daysInMonth
		f.ProjectedKRW = (f.SpentKRW / elapsed) * daysInMonth
		if b, ok := budgetByTeam[f.Team]; ok {
			f.HasBudget, f.BudgetKRW = true, b
			if f.ProjectedKRW > b {
				f.WillExceed = true
				f.OverageKRW = f.ProjectedKRW - b
			}
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// CostAllocationRow is one bucket of cost attribution for a chosen dimension.
type CostAllocationRow struct {
	Key      string  `json:"key"`
	Requests int64   `json:"requests"`
	Tokens   int64   `json:"tokens"`
	CostKRW  float64 `json:"cost_krw"`
	Errors   int64   `json:"error_requests"`
}

// costAllocationColumns maps an allocation dimension to its request_logs column.
var costAllocationColumns = map[string]string{
	"repo":        "r.repo",
	"branch":      "r.branch",
	"project":     "r.project",
	"service":     "r.service",
	"cost_center": "r.cost_center",
	"model":       "r.model",
	"provider":    "r.provider",
	"api_key_id":  "r.api_key_id",
}

// CostAllocationDimensions lists the dimensions CostAllocation accepts.
func CostAllocationDimensions() []string {
	return []string{"repo", "branch", "project", "service", "cost_center", "model", "provider", "api_key_id"}
}

// CostAllocation attributes requests/tokens/cost/errors to buckets of the given
// dimension over [since, now]. Unknown dimensions return an error. Rows whose
// dimension value is empty are bucketed under "(unset)".
func (s *SQLStore) CostAllocation(ctx context.Context, dimension string, since time.Time, limit int) ([]CostAllocationRow, error) {
	col, ok := costAllocationColumns[dimension]
	if !ok {
		return nil, fmt.Errorf("unsupported allocation dimension %q", dimension)
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	query := s.bind(fmt.Sprintf(`
		SELECT COALESCE(NULLIF(%s, ''), '(unset)') AS key,
			COUNT(r.id),
			COALESCE(SUM(t.total_tokens), 0),
			COALESCE(SUM(t.estimated_cost), 0),
			COALESCE(SUM(CASE WHEN r.status_code >= 400 THEN 1 ELSE 0 END), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE r.created_at >= ?
		GROUP BY COALESCE(NULLIF(%s, ''), '(unset)')
		ORDER BY 4 DESC
		LIMIT %d
	`, col, col, limit))

	rows, err := s.db.QueryContext(ctx, query, since.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []CostAllocationRow{}
	for rows.Next() {
		var row CostAllocationRow
		if err := rows.Scan(&row.Key, &row.Requests, &row.Tokens, &row.CostKRW, &row.Errors); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// chargebackColumns extends costAllocationColumns with a team dimension (resolved via the
// owning API key). Used by the monthly chargeback pack.
var chargebackColumns = map[string]string{
	"repo":        "r.repo",
	"branch":      "r.branch",
	"project":     "r.project",
	"service":     "r.service",
	"cost_center": "r.cost_center",
	"model":       "r.model",
	"provider":    "r.provider",
	"team":        "k.team",
}

// ChargebackDimensions lists the dimensions CostAllocationWindow accepts.
func ChargebackDimensions() []string {
	return []string{"cost_center", "project", "team", "repo", "branch", "service", "model", "provider"}
}

// CostAllocationWindow attributes requests/tokens/cost/errors to buckets of `dimension` over
// [since, until). A zero `until` means "no upper bound". Supports a team dimension (via the
// owning API key). Mirrors CostAllocation but with a bounded window for monthly chargeback.
func (s *SQLStore) CostAllocationWindow(ctx context.Context, dimension string, since, until time.Time, limit int) ([]CostAllocationRow, error) {
	col, ok := chargebackColumns[dimension]
	if !ok {
		return nil, fmt.Errorf("unsupported allocation dimension %q", dimension)
	}
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	where := []string{"r.created_at >= ?"}
	args := []any{since.UTC().Format(time.RFC3339Nano)}
	if !until.IsZero() {
		where = append(where, "r.created_at < ?")
		args = append(args, until.UTC().Format(time.RFC3339Nano))
	}
	query := s.bind(fmt.Sprintf(`
		SELECT COALESCE(NULLIF(%s, ''), '(unset)') AS key,
			COUNT(r.id),
			COALESCE(SUM(t.total_tokens), 0),
			COALESCE(SUM(t.estimated_cost), 0),
			COALESCE(SUM(CASE WHEN r.status_code >= 400 THEN 1 ELSE 0 END), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		LEFT JOIN api_keys k ON k.id = r.api_key_id
		WHERE %s
		GROUP BY COALESCE(NULLIF(%s, ''), '(unset)')
		ORDER BY 4 DESC
		LIMIT %d
	`, col, strings.Join(where, " AND "), col, limit))

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CostAllocationRow{}
	for rows.Next() {
		var row CostAllocationRow
		if err := rows.Scan(&row.Key, &row.Requests, &row.Tokens, &row.CostKRW, &row.Errors); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// parseStoredTime parses a timestamp persisted by the gateway (RFC3339Nano,
// falling back to RFC3339).
func parseStoredTime(v string) (time.Time, bool) {
	if v == "" {
		return time.Time{}, false
	}
	if t, err := time.Parse(time.RFC3339Nano, v); err == nil {
		return t, true
	}
	if t, err := time.Parse(time.RFC3339, v); err == nil {
		return t, true
	}
	return time.Time{}, false
}
