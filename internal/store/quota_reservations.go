package store

import (
	"context"
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
// tenant. Scope handling mirrors UsageSince deliberately: the two numbers are added
// together, so they have to agree on what a scope means.
func (s *SQLStore) ReservedUsage(ctx context.Context, scope, scopeValue string, now time.Time) (int64, float64, error) {
	where := []string{"expires_at > ?"}
	args := []any{formatTime(now.UTC())}
	switch scope {
	case "api_key":
		where = append(where, "api_key_id = ?")
		args = append(args, scopeValue)
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
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT COALESCE(SUM(tokens), 0), COALESCE(SUM(cost_krw), 0)
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
