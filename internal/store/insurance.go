package store

import (
	"context"
	"fmt"
	"math"
	"sort"
	"time"
)

// InsuranceClaim is the SLA-claims ledger for one insured scope over a window: covered
// requests (premiums), degraded outcomes (claims) with a diagnostic breakdown, and the
// SLA math (allowed vs excess claims). Read-only operational signal.
type InsuranceClaim struct {
	Scope          string  `json:"scope"`
	Covered        int64   `json:"covered_requests"`
	Claims         int64   `json:"claims"` // deduped count of degraded requests
	Claims5xx      int64   `json:"claims_5xx"`
	Claims4xx      int64   `json:"claims_4xx"`
	ClaimsFailover int64   `json:"claims_failover"`
	ClaimRate      float64 `json:"claim_rate"`
	Reliability    float64 `json:"reliability"`
	SLATarget      float64 `json:"sla_target"`
	SLAMet         bool    `json:"sla_met"`
	AllowedClaims  float64 `json:"allowed_claims"` // (1 - SLATarget) * covered
	ExcessClaims   float64 `json:"excess_claims"`  // max(0, claims - allowed): the breach magnitude
}

// InsuranceClaims computes the SLA-claims ledger per scope of a dimension. A request is
// a "claim" when it returned >= 400, failed over, or recorded an error; the per-category
// counts are diagnostic and may overlap, while Claims is the deduped headline. Each scope
// is compared against slaTarget (reliability 0..1): allowed claims = (1-target)*covered,
// and excess = claims beyond that allowance. Scopes are sorted worst-breach first.
func (s *SQLStore) InsuranceClaims(ctx context.Context, dimension string, since time.Time, limit int, slaTarget float64) ([]InsuranceClaim, error) {
	col, ok := costAllocationColumns[dimension]
	if !ok {
		return nil, fmt.Errorf("unsupported insurance dimension %q", dimension)
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	if slaTarget <= 0 || slaTarget >= 1 {
		slaTarget = 0.99
	}
	query := s.bind(fmt.Sprintf(`
		SELECT COALESCE(NULLIF(%s, ''), '(unset)') AS key,
			COUNT(*),
			COALESCE(SUM(CASE WHEN r.status_code >= 400 OR COALESCE(r.failover, 0) = 1 OR COALESCE(r.error, '') <> '' THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN r.status_code >= 500 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN r.status_code >= 400 AND r.status_code < 500 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN COALESCE(r.failover, 0) = 1 THEN 1 ELSE 0 END), 0)
		FROM request_logs r
		WHERE r.created_at >= ?
		GROUP BY COALESCE(NULLIF(%s, ''), '(unset)')
		ORDER BY COUNT(*) DESC
		LIMIT %d
	`, col, col, limit))

	rows, err := s.db.QueryContext(ctx, query, since.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []InsuranceClaim{}
	allowance := 1 - slaTarget
	for rows.Next() {
		var c InsuranceClaim
		if err := rows.Scan(&c.Scope, &c.Covered, &c.Claims, &c.Claims5xx, &c.Claims4xx, &c.ClaimsFailover); err != nil {
			return nil, err
		}
		c.SLATarget = slaTarget
		if c.Covered > 0 {
			c.ClaimRate = float64(c.Claims) / float64(c.Covered)
		}
		c.Reliability = 1 - c.ClaimRate
		c.AllowedClaims = allowance * float64(c.Covered)
		c.ExcessClaims = math.Max(0, float64(c.Claims)-c.AllowedClaims)
		c.SLAMet = c.ClaimRate <= allowance
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ExcessClaims != out[j].ExcessClaims {
			return out[i].ExcessClaims > out[j].ExcessClaims
		}
		return out[i].Covered > out[j].Covered
	})
	return out, nil
}
