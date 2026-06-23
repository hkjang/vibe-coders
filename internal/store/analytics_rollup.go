package store

import (
	"context"
	"fmt"
	"time"
)

// rollupDimensions are the columns daily aggregates are kept for. "all" is a
// single global bucket; the rest reuse request_logs columns.
var rollupDimensions = map[string]string{
	"all":         "",
	"model":       "model",
	"provider":    "provider",
	"project":     "project",
	"cost_center": "cost_center",
}

// AnalyticsRollupRow is one day's aggregate for a dimension value. These survive
// detailed-log retention so long-term trends remain queryable after raw logs are
// purged — the source for a warehouse (PostgreSQL/ClickHouse) export.
type AnalyticsRollupRow struct {
	Day       string  `json:"day"`
	Dimension string  `json:"dimension"`
	DimValue  string  `json:"dim_value"`
	Requests  int64   `json:"requests"`
	Tokens    int64   `json:"tokens"`
	CostKRW   float64 `json:"cost_krw"`
	Errors    int64   `json:"errors"`
}

// RollupDay (re)computes the daily aggregates for the given KST/UTC day string
// ("2006-01-02") across all dimensions and upserts them, so it is safe to re-run.
func (s *SQLStore) RollupDay(ctx context.Context, day string) error {
	for dim, col := range rollupDimensions {
		if err := s.rollupDayDimension(ctx, day, dim, col); err != nil {
			return err
		}
	}
	return nil
}

func (s *SQLStore) rollupDayDimension(ctx context.Context, day, dimension, col string) error {
	keyExpr := "'*'"
	if col != "" {
		keyExpr = "COALESCE(NULLIF(r." + col + ", ''), '(unset)')"
	}
	// Idempotent upsert keyed on (day, dimension, dim_value). This replaces an earlier
	// DELETE-then-INSERT which (a) raced under concurrent rollups — two runs would each DELETE,
	// then both INSERT the same PK and one failed with a unique violation (analytics_daily_pkey,
	// SQLSTATE 23505) — and (b) could wipe a day's surviving aggregate to zero if re-run after
	// retention had already purged that day's raw logs. ON CONFLICT makes concurrent/repeat runs
	// converge to the recomputed totals with no error.
	query := s.bind(fmt.Sprintf(`
		INSERT INTO analytics_daily (day, dimension, dim_value, requests, tokens, cost_krw, errors)
		SELECT ?, ?, %s,
			COUNT(r.id),
			COALESCE(SUM(t.total_tokens), 0),
			COALESCE(SUM(t.estimated_cost), 0),
			COALESCE(SUM(CASE WHEN r.status_code >= 400 THEN 1 ELSE 0 END), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE substring(r.created_at, 1, 10) = ?
		GROUP BY 3
		ON CONFLICT (day, dimension, dim_value) DO UPDATE SET
			requests = excluded.requests,
			tokens = excluded.tokens,
			cost_krw = excluded.cost_krw,
			errors = excluded.errors`, keyExpr))
	if _, err := s.db.ExecContext(ctx, query, day, dimension, day); err != nil {
		return err
	}
	return nil
}

// RollupRange rolls up each day in [from, to] inclusive (by UTC date). Used to
// backfill or to capture recent days before retention purges the raw rows.
func (s *SQLStore) RollupRange(ctx context.Context, from, to time.Time) (int, error) {
	days := 0
	for d := from.UTC().Truncate(24 * time.Hour); !d.After(to.UTC()); d = d.AddDate(0, 0, 1) {
		if err := s.RollupDay(ctx, d.Format("2006-01-02")); err != nil {
			return days, err
		}
		days++
	}
	return days, nil
}

// ListDailyRollups returns stored daily aggregates for a dimension since `sinceDay`
// (inclusive, "2006-01-02"), newest first.
func (s *SQLStore) ListDailyRollups(ctx context.Context, dimension, sinceDay string, limit int) ([]AnalyticsRollupRow, error) {
	if limit <= 0 || limit > 5000 {
		limit = 1000
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT day, dimension, dim_value, requests, tokens, cost_krw, errors
		FROM analytics_daily WHERE dimension = ? AND day >= ?
		ORDER BY day DESC, requests DESC LIMIT ?`), dimension, sinceDay, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AnalyticsRollupRow{}
	for rows.Next() {
		var a AnalyticsRollupRow
		if err := rows.Scan(&a.Day, &a.Dimension, &a.DimValue, &a.Requests, &a.Tokens, &a.CostKRW, &a.Errors); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// RollupPeriod aggregates stored daily rows into week or month buckets on read.
func (s *SQLStore) RollupPeriod(ctx context.Context, dimension, period, sinceDay string, limit int) ([]AnalyticsRollupRow, error) {
	daily, err := s.ListDailyRollups(ctx, dimension, sinceDay, 5000)
	if err != nil {
		return nil, err
	}
	if period != "week" && period != "month" {
		if limit > 0 && len(daily) > limit {
			daily = daily[:limit]
		}
		return daily, nil
	}
	byBucket := map[string]*AnalyticsRollupRow{}
	order := []string{}
	for _, r := range daily {
		bucket := periodBucket(r.Day, period)
		key := bucket + "\x00" + r.DimValue
		agg, ok := byBucket[key]
		if !ok {
			agg = &AnalyticsRollupRow{Day: bucket, Dimension: dimension, DimValue: r.DimValue}
			byBucket[key] = agg
			order = append(order, key)
		}
		agg.Requests += r.Requests
		agg.Tokens += r.Tokens
		agg.CostKRW += r.CostKRW
		agg.Errors += r.Errors
	}
	out := make([]AnalyticsRollupRow, 0, len(order))
	for _, k := range order {
		out = append(out, *byBucket[k])
	}
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// periodBucket maps a "2006-01-02" day to its week (ISO year-Www) or month (YYYY-MM).
func periodBucket(day, period string) string {
	t, err := time.Parse("2006-01-02", day)
	if err != nil {
		return day
	}
	if period == "month" {
		return t.Format("2006-01")
	}
	y, wk := t.ISOWeek()
	return fmt.Sprintf("%d-W%02d", y, wk)
}
