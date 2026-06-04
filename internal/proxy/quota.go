package proxy

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"vibe-coders/internal/store"
)

// Asia/Seoul fixed offset. KST has no DST so a fixed offset is safe.
var seoulZone = time.FixedZone("KST", 9*3600)

type quotaDecision struct {
	Allowed     bool
	Reason      string
	Quota       store.QuotaRecord
	Tokens      int64
	CostKRW     float64
	PeriodStart time.Time
	PeriodEnd   time.Time
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

func (s *Server) checkQuotas(ctx context.Context, apiKeyID string, clientIP string) (quotaDecision, error) {
	now := time.Now()

	team, err := s.db.GetTeamForAPIKey(ctx, apiKeyID)
	if err != nil {
		return quotaDecision{Allowed: true}, err
	}

	scopes := []struct{ scope, value string }{
		{"global", "*"},
		{"api_key", apiKeyID},
		{"ip", clientIP},
	}
	if team != "" {
		scopes = append(scopes, struct{ scope, value string }{"team", team})
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
			_, costKRW, tokens, err := s.db.UsageSince(ctx, store.UsageFilter{
				Scope:      q.Scope,
				ScopeValue: q.ScopeValue,
				Since:      start,
			})
			if err != nil {
				return quotaDecision{Allowed: true}, err
			}
			if q.TokenLimit > 0 && tokens >= q.TokenLimit {
				return quotaDecision{
					Allowed: false, Reason: "token_limit_exceeded",
					Quota: q, Tokens: tokens, CostKRW: costKRW,
					PeriodStart: start, PeriodEnd: end,
				}, nil
			}
			if q.KRWLimit > 0 && costKRW >= q.KRWLimit {
				return quotaDecision{
					Allowed: false, Reason: "krw_limit_exceeded",
					Quota: q, Tokens: tokens, CostKRW: costKRW,
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
