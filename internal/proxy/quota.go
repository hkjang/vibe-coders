package proxy

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"vibe-coders/internal/store"
)

// Asia/Seoul fixed offset. KST has no DST so a fixed offset is safe.
var seoulZone = time.FixedZone("KST", 9*3600)

type quotaDecision struct {
	Allowed bool
	Reason  string
	Quota   store.QuotaRecord
	// Tokens and CostKRW are the totals enforcement compared against the limit, i.e.
	// committed usage plus in-flight reservations. The reserved half is broken out
	// separately because a caller refused while committed usage sits below the limit
	// has no way to explain the refusal otherwise.
	Tokens          int64
	CostKRW         float64
	ReservedTokens  int64
	ReservedCostKRW float64
	PeriodStart     time.Time
	PeriodEnd       time.Time
}

func periodBounds(period string, now time.Time) (time.Time, time.Time) {
	now = now.In(seoulZone)
	switch period {
	case "monthly":
		start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, seoulZone)
		end := start.AddDate(0, 1, 0)
		return start, end
	default:
		start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, seoulZone)
		end := start.AddDate(0, 0, 1)
		return start, end
	}
}

// checkQuotas decides whether a request may proceed.
//
// knownTeam is the api key's team when the caller already has it — authentication reads the
// whole key row, so the request path does — and nil when it does not, in which case it is
// looked up. It is the raw api_keys.team value, which is what quota rows are scoped by, and
// not the canonical team id authentication resolves for display.
func (s *Server) checkQuotas(ctx context.Context, apiKeyID string, clientIP string, knownTeam *string) (quotaDecision, error) {
	now := time.Now()

	var team string
	if knownTeam != nil {
		team = *knownTeam
	} else {
		var err error
		team, err = s.db.GetTeamForAPIKey(ctx, apiKeyID)
		if err != nil {
			return quotaDecision{Allowed: true}, err
		}
	}

	scopes := []struct{ scope, value string }{
		{"global", "*"},
		{"api_key", apiKeyID},
		{"ip", clientIP},
	}
	if team != "" {
		scopes = append(scopes, struct{ scope, value string }{"team", team})
	}

	// Every quota's in-flight total comes from the same handful of rows, so they are read
	// once here rather than once per quota.
	var reserved map[string]map[string]store.ReservedTotals
	if s.quotaReservationsEnabled() {
		live, err := s.db.LiveReservations(ctx, now)
		if err != nil {
			// Reservations are an accuracy improvement, not an authority: if they cannot
			// be read, fall back to committed usage rather than failing the request or
			// letting it through unchecked.
			slog.Warn("read quota reservations failed", "error", err)
		} else {
			reserved = live
		}
	}

	for _, scope := range scopes {
		if scope.value == "" {
			continue
		}
		quotas, err := s.db.ActiveQuotasFor(ctx, scope.scope, scope.value)
		if err != nil {
			return quotaDecision{Allowed: true}, err
		}
		for _, q := range quotas {
			start, end := periodBounds(q.Period, now)
			_, costKRW, tokens, err := s.db.UsageForPeriod(ctx, store.UsageFilter{
				Scope:      q.Scope,
				ScopeValue: q.ScopeValue,
				Since:      start,
			})
			if err != nil {
				return quotaDecision{Allowed: true}, err
			}
			// Committed usage only exists once a request has finished, so on its own it
			// cannot see anything currently in flight. Add the outstanding reservations
			// so concurrent requests count against each other instead of each being
			// measured against a total that excludes all the others.
			reservedTokens, reservedCost := int64(0), 0.0
			if byValue, ok := reserved[q.Scope]; ok {
				if r, found := byValue[q.ScopeValue]; found {
					reservedTokens, reservedCost = r.Tokens, r.CostKRW
					tokens += r.Tokens
					costKRW += r.CostKRW
				}
			}
			if q.TokenLimit > 0 && tokens >= q.TokenLimit {
				return quotaDecision{
					Allowed: false, Reason: "token_limit_exceeded",
					Quota: q, Tokens: tokens, CostKRW: costKRW,
					ReservedTokens: reservedTokens, ReservedCostKRW: reservedCost,
					PeriodStart: start, PeriodEnd: end,
				}, nil
			}
			if q.KRWLimit > 0 && costKRW >= q.KRWLimit {
				return quotaDecision{
					Allowed: false, Reason: "krw_limit_exceeded",
					Quota: q, Tokens: tokens, CostKRW: costKRW,
					ReservedTokens: reservedTokens, ReservedCostKRW: reservedCost,
					PeriodStart: start, PeriodEnd: end,
				}, nil
			}
		}
	}
	return quotaDecision{Allowed: true}, nil
}

func quotaRetryAfterSeconds(end time.Time) int {
	d := time.Until(end)
	if d <= 0 {
		return 1
	}
	return int(d.Seconds()) + 1
}

func formatKRW(v float64) string {
	return strconv.FormatFloat(v, 'f', 2, 64)
}

func quotaHeaderTag(d quotaDecision) string {
	return fmt.Sprintf("%s:%s:%s", d.Quota.Scope, d.Quota.ScopeValue, d.Quota.Period)
}

// quotaReservationsEnabled reports whether in-flight usage counts toward quotas.
// Reservations add one insert and one delete per request, so a deployment that does not
// use quotas at all can turn the whole mechanism off.
func (s *Server) quotaReservationsEnabled() bool {
	return s.quotaConf().ReservationsEnabled && s.db != nil
}

// reserveQuota records what this request is expected to consume, so requests running
// alongside it can see it. The expiry is the upstream timeout plus a margin: long
// enough that a slow but healthy request is never released early, short enough that a
// gateway killed mid-request stops holding the quota soon after.
func (s *Server) reserveQuota(ctx context.Context, requestID, apiKeyID, clientIP string, tokens int64, costKRW float64) {
	if !s.quotaReservationsEnabled() || requestID == "" {
		return
	}
	ttl := s.cfg.Upstream.Timeout + time.Minute
	if ttl <= 0 {
		ttl = 11 * time.Minute
	}
	if err := s.db.ReserveQuota(ctx, store.QuotaReservation{
		RequestID: requestID, APIKeyID: apiKeyID, ClientIP: clientIP,
		Tokens: tokens, CostKRW: costKRW, ExpiresAt: time.Now().UTC().Add(ttl),
	}); err != nil {
		slog.Warn("reserve quota failed", "request_id", requestID, "error", err)
	}
}

// releaseQuota drops the reservation once the request is done and its real usage is on
// its way to the log. It must run on every exit path, including failures: a reservation
// left behind would count against the quota until it expired.
func (s *Server) releaseQuota(requestID string) {
	if !s.quotaReservationsEnabled() || requestID == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.db.ReleaseQuota(ctx, requestID); err != nil {
		slog.Warn("release quota reservation failed", "request_id", requestID, "error", err)
	}
}

// startQuotaReservationSweeper deletes rows left by requests that never completed —
// a gateway killed mid-flight, for instance. Reads already exclude expired rows, so
// this is only housekeeping and its failure is never load-bearing.
func (s *Server) startQuotaReservationSweeper() {
	// Gated on the database rather than on the feature flag: reservations can now be
	// switched on at runtime, and a sweeper that only exists when the flag was set at
	// boot would leave orphaned holds accumulating for a feature enabled later. The
	// sweep deletes expired rows and nothing else, so running it while the feature is
	// off is a no-op against an empty table.
	if s.db == nil {
		return
	}
	interval := s.cfg.Quota.ReservationSweepInterval
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	parent := s.db.LifecycleContext()
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-parent.Done():
				return
			case <-t.C:
			}
			ctx, cancel := context.WithTimeout(parent, 10*time.Second)
			n, err := s.db.SweepExpiredQuotaReservations(ctx, time.Now())
			cancel()
			if err != nil {
				slog.Warn("sweep quota reservations failed", "error", err)
				continue
			}
			if n > 0 {
				// A non-zero sweep means requests died without releasing; worth seeing.
				slog.Info("swept expired quota reservations", "removed", n)
			}
		}
	}()
}
