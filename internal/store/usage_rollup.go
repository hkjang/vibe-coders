package store

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"
)

// Per-day usage totals.
//
// A quota is enforced by comparing the period's usage against a limit, and the usage was
// computed on every request by aggregating request_logs joined to token_usage across the
// whole period. For a monthly quota that is a month of traffic, re-read per request.
// Measured over 100,000 rows: 63ms for the global scope, 22ms for an IP, 12ms for an API
// key — and it grows with the traffic the gateway has already served, so the cost per
// request rises with the request rate.
//
// The totals are kept per day instead, updated in the same transaction that writes the
// request, so enforcement reads a handful of small rows.
//
// Days are Asia/Seoul days because that is what periodBounds uses: a daily quota starts at
// KST midnight and a monthly one at the KST first of the month, so both are day boundaries
// and a period is exactly a whole number of these rows. A caller asking about an instant
// that is not a KST midnight is asking something the day rows cannot answer, and is sent
// to the exact query instead.
//
// The rollup is not authoritative for time before it existed. usage_rollup_state records
// when this database started keeping it; a period that began earlier is answered the old
// way, which costs what it always did and stops happening after one period.

// usageRollupScopes are the scopes recorded directly from the request row. "team" is not
// among them on purpose: requestTeamExpr resolves a request's team from api_keys at read
// time, not at write time, so a team total fixed when the request was logged would stop
// matching the moment a key moved between teams. Team usage is derived from the api_key
// rows instead.
var usageRollupScopes = []string{"global", "api_key", "ip"}

// kstDay renders an instant as the Asia/Seoul calendar day it falls in.
func kstDay(t time.Time) string { return t.In(seoulZone).Format("2006-01-02") }

// isKSTMidnight reports whether an instant is the start of a Seoul day.
func isKSTMidnight(t time.Time) bool {
	local := t.In(seoulZone)
	h, m, sec := local.Clock()
	return h == 0 && m == 0 && sec == 0 && local.Nanosecond() == 0
}

// normalizedClientIP matches the expression UsageSince filters the ip scope by, so a row
// written here is found by a query there.
func normalizedClientIP(ip string) string {
	if strings.TrimSpace(ip) == "" {
		return "unknown"
	}
	return ip
}

// rollupUpsert returns the statement and arguments that add one request to the day totals
// of every scope it belongs to. It is one statement so the write costs one round trip
// rather than one per scope.
func (s *SQLStore) rollupUpsert(req RequestLog, usage *TokenUsage) (string, []any) {
	day := kstDay(req.CreatedAt)
	var tokens int64
	var cost float64
	if usage != nil {
		tokens = int64(usage.TotalTokens)
		cost = usage.EstimatedCost
	}
	// A non-finite cost is stored as NULL by SQLite, which these columns forbid, and a
	// running total that is NaN would stay NaN for every later request in that scope. The
	// rest of the record is cleansed the same way by cleanArgs.
	if math.IsNaN(cost) || math.IsInf(cost, 0) {
		cost = 0
	}
	values := make([]string, 0, len(usageRollupScopes))
	args := make([]any, 0, len(usageRollupScopes)*6)
	for _, scope := range usageRollupScopes {
		var scopeValue string
		switch scope {
		case "global":
			scopeValue = "*"
		case "api_key":
			scopeValue = req.APIKeyID
		case "ip":
			scopeValue = normalizedClientIP(req.ClientIP)
		}
		values = append(values, "(?, ?, ?, ?, ?, ?)")
		args = append(args, scope, scopeValue, day, 1, tokens, cost)
	}
	query := `INSERT INTO usage_rollup (scope, scope_value, day, requests, tokens, cost)
		VALUES ` + strings.Join(values, ", ") + `
		ON CONFLICT(scope, scope_value, day) DO UPDATE SET
			requests = usage_rollup.requests + excluded.requests,
			tokens = usage_rollup.tokens + excluded.tokens,
			cost = usage_rollup.cost + excluded.cost`
	return s.bind(query), args
}

// rollupStart caches the instant this database started keeping day totals. It is written
// once, at migration, and never changes afterwards, so it is read once.
type rollupStart struct {
	mu     sync.Mutex
	at     time.Time
	loaded bool
}

// rollupBeginningOfTime marks a database whose day totals are complete for all of its
// history, which is any database that had no requests when the totals were introduced.
var rollupBeginningOfTime = time.Unix(0, 0).UTC()

// markUsageRollupStarted records the instant from which the day totals are complete.
// Called at the end of Migrate; the ON CONFLICT makes it a no-op on every run after the
// first, which is what keeps an existing database from claiming coverage of traffic it
// never counted.
//
// A database with no requests yet has nothing uncounted, so its totals are complete from
// the beginning and the fast path works immediately. One that already holds traffic is
// only complete from now, so the period in progress — the rest of today, or the rest of
// the month — is still answered exactly. After that period it needs no special case.
func (s *SQLStore) markUsageRollupStarted(ctx context.Context) error {
	startedAt := time.Now().UTC()
	var seen int
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT 1 FROM request_logs LIMIT 1`)).Scan(&seen)
	if err == sql.ErrNoRows {
		startedAt = rollupBeginningOfTime
	} else if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, s.bind(
		`INSERT INTO usage_rollup_state (id, started_at) VALUES ('singleton', ?)
		 ON CONFLICT(id) DO NOTHING`), formatTime(startedAt))
	return err
}

// usageRollupStartedAt returns the instant the day totals became complete, and whether
// that is known at all.
func (s *SQLStore) usageRollupStartedAt(ctx context.Context) (time.Time, bool) {
	s.rollupStart.mu.Lock()
	defer s.rollupStart.mu.Unlock()
	if s.rollupStart.loaded {
		return s.rollupStart.at, true
	}
	var raw string
	err := s.db.QueryRowContext(ctx, s.bind(
		`SELECT started_at FROM usage_rollup_state WHERE id = 'singleton'`)).Scan(&raw)
	if err != nil {
		// Unknown rather than "never": leaving loaded false means the next call tries
		// again rather than caching a failure as an answer.
		return time.Time{}, false
	}
	at := parseOptionalTime(raw)
	if at.IsZero() {
		return time.Time{}, false
	}
	s.rollupStart.at = at
	s.rollupStart.loaded = true
	return at, true
}

// UsageForPeriod returns the usage a quota should be enforced against. It answers from the
// day totals when they cover the period, and falls back to the exact aggregate when they
// do not — an unaligned start, or a period that began before this database started
// keeping them. Both paths return the same numbers; the difference is only what they cost.
func (s *SQLStore) UsageForPeriod(ctx context.Context, filter UsageFilter) (int64, float64, int64, error) {
	if !s.rollupCovers(ctx, filter.Since) {
		return s.UsageSince(ctx, filter)
	}
	day := kstDay(filter.Since)
	var query string
	var args []any
	switch filter.Scope {
	case "global":
		query = `SELECT COALESCE(SUM(requests), 0), COALESCE(SUM(cost), 0), COALESCE(SUM(tokens), 0)
			FROM usage_rollup WHERE scope = 'global' AND scope_value = '*' AND day >= ?`
		args = []any{day}
	case "api_key", "ip":
		query = `SELECT COALESCE(SUM(requests), 0), COALESCE(SUM(cost), 0), COALESCE(SUM(tokens), 0)
			FROM usage_rollup WHERE scope = ? AND scope_value = ? AND day >= ?`
		args = []any{filter.Scope, filter.ScopeValue, day}
	case "team":
		// The same mapping requestTeamExpr uses, applied to the api_key rows: a key with
		// no team, or an api_key_id no key matches, counts as "unassigned".
		query = `SELECT COALESCE(SUM(u.requests), 0), COALESCE(SUM(u.cost), 0), COALESCE(SUM(u.tokens), 0)
			FROM usage_rollup u
			LEFT JOIN api_keys k ON k.id = u.scope_value
			WHERE u.scope = 'api_key' AND u.day >= ?
			  AND COALESCE(NULLIF(k.team, ''), 'unassigned') = ?`
		args = []any{day, filter.ScopeValue}
	default:
		return 0, 0, 0, fmt.Errorf("unsupported quota scope %q", filter.Scope)
	}

	var requests, tokens int64
	var cost float64
	if err := s.db.QueryRowContext(ctx, s.bind(query), args...).Scan(&requests, &cost, &tokens); err != nil {
		if err == sql.ErrNoRows {
			return 0, 0, 0, nil
		}
		return 0, 0, 0, err
	}
	return requests, cost, tokens, nil
}

// rollupCovers reports whether the day totals can answer for a period starting at since.
func (s *SQLStore) rollupCovers(ctx context.Context, since time.Time) bool {
	if since.IsZero() || !isKSTMidnight(since) {
		return false
	}
	startedAt, ok := s.usageRollupStartedAt(ctx)
	if !ok {
		return false
	}
	// The totals cover whole days, so they can answer for a period only if they were
	// already being kept when its first day began.
	return !since.Before(startedAt)
}

// reconcileUsageRollupAfterPurge brings the day totals back in step with request_logs after
// retention has deleted part of it.
//
// The chosen behaviour is that purged traffic stops counting against a quota, which is what
// happened before the totals existed. Retention deletes by instant, not by day, so a day
// either falls entirely before the cutoff — its row is dropped — or straddles it, and is
// recomputed from what survived. Recomputing one day per purge is the price of the two
// staying exactly equal instead of nearly.
func (s *SQLStore) reconcileUsageRollupAfterPurge(ctx context.Context, cutoff time.Time) error {
	day := kstDay(cutoff)
	if _, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM usage_rollup WHERE day < ?`), day); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM usage_rollup WHERE day = ?`), day); err != nil {
		return err
	}

	local := cutoff.In(seoulZone)
	dayStart := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, seoulZone)
	from := formatTime(dayStart.UTC())
	to := formatTime(dayStart.Add(24 * time.Hour).UTC())

	// One statement per scope, each grouping the surviving rows the same way the exact
	// aggregate filters them, so a recomputed day matches what UsageSince would say.
	rebuilds := []string{
		`INSERT INTO usage_rollup (scope, scope_value, day, requests, tokens, cost)
			SELECT 'global', '*', ?, COUNT(*), COALESCE(SUM(t.total_tokens), 0), COALESCE(SUM(t.estimated_cost), 0)
			FROM request_logs r LEFT JOIN token_usage t ON t.request_id = r.id
			WHERE r.created_at >= ? AND r.created_at < ?
			HAVING COUNT(*) > 0`,
		`INSERT INTO usage_rollup (scope, scope_value, day, requests, tokens, cost)
			SELECT 'api_key', r.api_key_id, ?, COUNT(*), COALESCE(SUM(t.total_tokens), 0), COALESCE(SUM(t.estimated_cost), 0)
			FROM request_logs r LEFT JOIN token_usage t ON t.request_id = r.id
			WHERE r.created_at >= ? AND r.created_at < ?
			GROUP BY r.api_key_id`,
		`INSERT INTO usage_rollup (scope, scope_value, day, requests, tokens, cost)
			SELECT 'ip', COALESCE(NULLIF(r.client_ip, ''), 'unknown'), ?, COUNT(*), COALESCE(SUM(t.total_tokens), 0), COALESCE(SUM(t.estimated_cost), 0)
			FROM request_logs r LEFT JOIN token_usage t ON t.request_id = r.id
			WHERE r.created_at >= ? AND r.created_at < ?
			GROUP BY COALESCE(NULLIF(r.client_ip, ''), 'unknown')`,
	}
	for _, q := range rebuilds {
		if _, err := s.db.ExecContext(ctx, s.bind(q), day, from, to); err != nil {
			return err
		}
	}
	return nil
}
