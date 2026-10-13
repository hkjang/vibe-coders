package store

import (
	"context"
	"errors"
	"math"
	"sort"
	"strings"
	"time"
)

// Quota reservations.
//
// Quotas are checked against committed usage, which is only written once a request has
// finished. The blind spot is therefore not milliseconds of logging lag — it is the
// whole duration of every in-flight request, which for an LLM call is seconds to
// minutes. Every request admitted in that window counts none of the others, so a busy
// key can overshoot its limit by as many requests as it can start before the first one
// returns.
//
// A reservation records what a request is expected to consume for as long as it is in
// flight, so concurrent requests can see each other. One row per request, carrying the
// same identity columns the usage query filters on, keeps the scope logic identical to
// committed usage instead of inventing a second set of rules.
//
// Rows are advisory and self-expiring: a gateway that dies mid-request must not leave a
// reservation pinning a quota forever, so every read filters on expires_at rather than
// trusting a cleanup pass to have run.
type QuotaReservation struct {
	RequestID string
	APIKeyID  string
	ClientIP  string
	Tokens    int64
	CostKRW   float64
	ExpiresAt time.Time
}

// ReserveQuota records an in-flight request's expected usage.
func (s *SQLStore) ReserveQuota(ctx context.Context, r QuotaReservation) error {
	if strings.TrimSpace(r.RequestID) == "" {
		return nil
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO quota_reservations
			(request_id, api_key_id, client_ip, tokens, cost_krw, created_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(request_id) DO UPDATE SET
			tokens = excluded.tokens,
			cost_krw = excluded.cost_krw,
			expires_at = excluded.expires_at`),
		r.RequestID, r.APIKeyID, r.ClientIP, r.Tokens, r.CostKRW,
		formatTime(time.Now().UTC()), formatTime(r.ExpiresAt.UTC()))
	return err
}

// ReleaseQuota drops a reservation once the request's real usage has been recorded.
// Releasing something already gone is not an error — a sweep may have beaten us to it.
func (s *SQLStore) ReleaseQuota(ctx context.Context, requestID string) error {
	if strings.TrimSpace(requestID) == "" {
		return nil
	}
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM quota_reservations WHERE request_id = ?`), requestID)
	return err
}

// ReservedUsage sums the in-flight reservations for one quota scope. Expired rows are
// excluded by the query itself, so a stalled cleanup can never over-count and block a
// tenant. Scope handling mirrors UsageForPeriod deliberately: the two numbers are added
// together, so they have to agree on what a scope means.
func (s *SQLStore) ReservedUsage(ctx context.Context, scope, scopeValue string, now time.Time) (int64, float64, error) {
	prefix := ""
	where := []string{"expires_at > ?"}
	args := []any{formatTime(now.UTC())}
	switch scope {
	case "api_key":
		prefix = apiKeyQuotaFamilyCTE
		where = append(where, "api_key_id IN (SELECT id FROM key_family)")
		args = append([]any{scopeValue}, args...)
	case "team":
		// Reuse the committed-usage expression verbatim rather than storing a team
		// column: the two sums are added together, so any divergence in what "team"
		// means would silently mis-count one side.
		where = append(where, reservationTeamFilter)
		args = append(args, scopeValue)
	case "ip":
		where = append(where, "COALESCE(NULLIF(client_ip, ''), 'unknown') = ?")
		args = append(args, scopeValue)
	case "global":
		// every in-flight request counts
	default:
		return 0, 0, nil
	}
	var tokens int64
	var cost float64
	err := s.db.QueryRowContext(ctx, s.bind(prefix+`SELECT COALESCE(SUM(tokens), 0), COALESCE(SUM(cost_krw), 0)
		FROM quota_reservations
		WHERE `+strings.Join(where, " AND ")), args...).Scan(&tokens, &cost)
	if err != nil {
		return 0, 0, err
	}
	return tokens, cost, nil
}

// reservationTeamFilter mirrors requestTeamExpr, resolved against the reservation's
// api_key_id instead of a request row.
const reservationTeamFilter = `COALESCE(NULLIF((SELECT k.team FROM api_keys k WHERE k.id = quota_reservations.api_key_id), ''), 'unassigned') = ?`

// SweepExpiredQuotaReservations removes rows left behind by requests that never
// completed. Reads already ignore them; this only keeps the table small.
func (s *SQLStore) SweepExpiredQuotaReservations(ctx context.Context, now time.Time) (int64, error) {
	res, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM quota_reservations WHERE expires_at <= ?`),
		formatTime(now.UTC()))
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// ReservedTotals is the in-flight usage of one scope value.
type ReservedTotals struct {
	Tokens  int64
	CostKRW float64
}

const liveReservationsQuery = `WITH RECURSIVE live AS (
		SELECT COALESCE(api_key_id, '') AS api_key_id,
			COALESCE(NULLIF(client_ip, ''), 'unknown') AS client_ip,
			COALESCE(NULLIF((SELECT k.team FROM api_keys k WHERE k.id = quota_reservations.api_key_id), ''), 'unassigned') AS team,
			COALESCE(tokens, 0) AS tokens, COALESCE(cost_krw, 0) AS cost_krw
		FROM quota_reservations
		WHERE expires_at > ?
	), key_family(id) AS (
		SELECT DISTINCT api_key_id FROM live
		UNION
		SELECT CASE WHEN r.old_key_id = f.id THEN r.new_key_id ELSE r.old_key_id END
		FROM api_key_rotations r JOIN key_family f ON r.old_key_id = f.id OR r.new_key_id = f.id
	)
	SELECT 'api_key', api_key_id, '', SUM(tokens), SUM(cost_krw) FROM live GROUP BY api_key_id
	UNION ALL SELECT 'rotation', old_key_id, new_key_id, 0, 0 FROM api_key_rotations
		WHERE old_key_id IN (SELECT id FROM key_family)
	UNION ALL SELECT 'global', '*', '', SUM(tokens), SUM(cost_krw) FROM live HAVING COUNT(*) > 0
	UNION ALL SELECT 'ip', client_ip, '', SUM(tokens), SUM(cost_krw) FROM live GROUP BY client_ip
	UNION ALL SELECT 'team', team, '', SUM(tokens), SUM(cost_krw) FROM live GROUP BY team`

// LiveReservations sums the outstanding reservations for every scope at once.
//
// checkQuotas asks about each quota's scope separately, which is a round trip per quota
// even though every answer comes from the same handful of rows — the table holds only what
// is in flight. Reading them once and adding them up here costs one round trip whatever
// the operator has configured.
//
// The keys mirror what UsageForPeriod is asked for: "global" under "*", api keys by id,
// client IPs with blank mapped to "unknown", and teams by the same expression committed
// usage resolves them with. Divergence between the two would silently mis-count, because
// the two sums are added together.
func (s *SQLStore) LiveReservations(ctx context.Context, now time.Time) (map[string]map[string]ReservedTotals, error) {
	// Read reservations and lineage in one statement/snapshot. Only families
	// with live reservations are traversed, not the complete rotation history.
	// Key-family expansion is excluded from global/IP/team sums to avoid doubling.
	rows, err := s.db.QueryContext(ctx, s.bind(liveReservationsQuery), formatTime(now.UTC()))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	totals := map[string]map[string]ReservedTotals{
		"global": {}, "api_key": {}, "ip": {}, "team": {},
	}
	neighbors := map[string][]string{}
	for rows.Next() {
		var scope, value, related string
		var tokens int64
		var cost float64
		if err := rows.Scan(&scope, &value, &related, &tokens, &cost); err != nil {
			return nil, err
		}
		if scope == "rotation" {
			neighbors[value] = append(neighbors[value], related)
			neighbors[related] = append(neighbors[related], value)
			continue
		}
		totals[scope][value] = ReservedTotals{Tokens: tokens, CostKRW: cost}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Traverse each connected family once, not once per live key. SQL returns
	// original per-key totals and reachable edges from the same snapshot; only
	// after a complete component has been summed may its totals be expanded.
	visited := map[string]bool{}
	for seed := range neighbors {
		if visited[seed] {
			continue
		}
		visited[seed] = true
		members := []string{seed}
		for i := 0; i < len(members); i++ {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			for _, next := range neighbors[members[i]] {
				if !visited[next] {
					visited[next] = true
					members = append(members, next)
				}
			}
		}
		// Stable addition order avoids map iteration affecting fractional costs.
		sort.Strings(members)
		var sum ReservedTotals
		for _, id := range members {
			var err error
			sum, err = addReservedTotals(sum, totals["api_key"][id])
			if err != nil {
				return nil, err
			}
		}
		for _, id := range members {
			totals["api_key"][id] = sum
		}
	}
	return totals, nil
}

// Match SQL SUM/Scan's overflow failure instead of wrapping a family total.
func addReservedTotals(a, b ReservedTotals) (ReservedTotals, error) {
	if (b.Tokens > 0 && a.Tokens > math.MaxInt64-b.Tokens) || (b.Tokens < 0 && a.Tokens < math.MinInt64-b.Tokens) {
		return ReservedTotals{}, errors.New("reservation token total overflow")
	}
	cost := a.CostKRW + b.CostKRW
	if math.IsInf(cost, 0) || math.IsNaN(cost) {
		return ReservedTotals{}, errors.New("reservation cost total invalid")
	}
	return ReservedTotals{Tokens: a.Tokens + b.Tokens, CostKRW: cost}, nil
}
