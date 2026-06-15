package store

import (
	"context"
	"fmt"
	"sort"
	"time"
)

// ErrorBudgetBurn is the multi-window error-budget burn rate for one scope. Burn rate is
// claim_rate / allowance (allowance = 1 - SLA target): 1.0 means the error budget is
// being spent exactly at the sustainable pace, > 1 means too fast. A short and a long
// window are compared so transient spikes (short only) are distinguished from sustained
// burn (both). DaysToExhaustion projects a 30-day budget at the long-window rate.
type ErrorBudgetBurn struct {
	Scope            string  `json:"scope"`
	ReqShort         int64   `json:"requests_short"`
	ClaimsShort      int64   `json:"claims_short"`
	ReqLong          int64   `json:"requests_long"`
	ClaimsLong       int64   `json:"claims_long"`
	ClaimRateShort   float64 `json:"claim_rate_short"`
	ClaimRateLong    float64 `json:"claim_rate_long"`
	BurnRateShort    float64 `json:"burn_rate_short"`
	BurnRateLong     float64 `json:"burn_rate_long"`
	SLATarget        float64 `json:"sla_target"`
	Severity         string  `json:"severity"` // "fast" | "slow" | "ok"
	DaysToExhaustion float64 `json:"days_to_exhaustion"`
}

const errorBudgetPeriodDays = 30.0

// ErrorBudgetBurn computes the multi-window burn rate per scope of a dimension over a
// long window, with a nested short window. A scope is "fast" (page) when both windows
// burn >= fastThreshold, "slow" (ticket) when the long window burns >= slowThreshold,
// else "ok". Scopes are sorted by severity (fast first) then long-window burn rate.
func (s *SQLStore) ErrorBudgetBurn(ctx context.Context, dimension string, longSince, shortSince time.Time, limit int, slaTarget, fastThreshold, slowThreshold float64) ([]ErrorBudgetBurn, error) {
	col, ok := costAllocationColumns[dimension]
	if !ok {
		return nil, fmt.Errorf("unsupported burn-rate dimension %q", dimension)
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	if slaTarget <= 0 || slaTarget >= 1 {
		slaTarget = 0.99
	}
	allowance := 1 - slaTarget
	query := s.bind(fmt.Sprintf(`
		SELECT COALESCE(NULLIF(%s, ''), '(unset)') AS key,
			COALESCE(SUM(CASE WHEN r.created_at >= ? THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN r.created_at >= ? AND (r.status_code >= 400 OR COALESCE(r.failover, 0) = 1 OR COALESCE(r.error, '') <> '') THEN 1 ELSE 0 END), 0),
			COUNT(*),
			COALESCE(SUM(CASE WHEN r.status_code >= 400 OR COALESCE(r.failover, 0) = 1 OR COALESCE(r.error, '') <> '' THEN 1 ELSE 0 END), 0)
		FROM request_logs r
		WHERE r.created_at >= ?
		GROUP BY COALESCE(NULLIF(%s, ''), '(unset)')
		ORDER BY COUNT(*) DESC
		LIMIT %d
	`, col, col, limit))

	shortStr := shortSince.UTC().Format(time.RFC3339Nano)
	longStr := longSince.UTC().Format(time.RFC3339Nano)
	rows, err := s.db.QueryContext(ctx, query, shortStr, shortStr, longStr)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ErrorBudgetBurn{}
	for rows.Next() {
		var b ErrorBudgetBurn
		if err := rows.Scan(&b.Scope, &b.ReqShort, &b.ClaimsShort, &b.ReqLong, &b.ClaimsLong); err != nil {
			return nil, err
		}
		b.SLATarget = slaTarget
		if b.ReqShort > 0 {
			b.ClaimRateShort = float64(b.ClaimsShort) / float64(b.ReqShort)
		}
		if b.ReqLong > 0 {
			b.ClaimRateLong = float64(b.ClaimsLong) / float64(b.ReqLong)
		}
		if allowance > 0 {
			b.BurnRateShort = b.ClaimRateShort / allowance
			b.BurnRateLong = b.ClaimRateLong / allowance
		}
		switch {
		case b.BurnRateShort >= fastThreshold && b.BurnRateLong >= fastThreshold:
			b.Severity = "fast"
		case b.BurnRateLong >= slowThreshold:
			b.Severity = "slow"
		default:
			b.Severity = "ok"
		}
		if b.BurnRateLong > 0 {
			b.DaysToExhaustion = errorBudgetPeriodDays / b.BurnRateLong
		}
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	severityRank := map[string]int{"fast": 0, "slow": 1, "ok": 2}
	sort.Slice(out, func(i, j int) bool {
		if severityRank[out[i].Severity] != severityRank[out[j].Severity] {
			return severityRank[out[i].Severity] < severityRank[out[j].Severity]
		}
		return out[i].BurnRateLong > out[j].BurnRateLong
	})
	return out, nil
}
