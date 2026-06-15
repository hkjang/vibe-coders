package store

import (
	"context"
	"sort"
	"time"
)

// KeyAlert flags an active API key that is expiring, expired, never used, or idle.
// Read-only operational signal for key hygiene.
type KeyAlert struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	UserID     string   `json:"user_id"`
	Team       string   `json:"team"`
	ExpiresAt  string   `json:"expires_at"`
	LastUsedAt string   `json:"last_used_at"`
	DaysIdle   int      `json:"days_idle"`   // since last use (or since creation if never used)
	Flags      []string `json:"flags"`       // expired | expiring_soon | never_used | stale_unused
	Severity   string   `json:"severity"`    // high | medium
}

// KeyHealthAlerts returns active keys that need attention as of `now`: expiring within
// expiringDays, already expired (but still active), never used, or idle beyond staleDays.
// When userID is non-empty, only that user's keys are considered. Sorted high severity first.
func (s *SQLStore) KeyHealthAlerts(ctx context.Context, now time.Time, staleDays, expiringDays int, userID string) ([]KeyAlert, error) {
	if staleDays <= 0 {
		staleDays = 30
	}
	if expiringDays <= 0 {
		expiringDays = 7
	}
	query := `
		SELECT k.id, k.name, COALESCE(k.user_id, ''), COALESCE(k.team, ''),
			COALESCE(k.expires_at, ''), COALESCE(k.created_at, ''),
			COALESCE(MAX(r.created_at), '')
		FROM api_keys k
		LEFT JOIN request_logs r ON r.api_key_id = k.id
		WHERE k.status = 'active' AND COALESCE(k.revoked_at, '') = ''`
	args := []any{}
	if userID != "" {
		query += ` AND k.user_id = ?`
		args = append(args, userID)
	}
	query += ` GROUP BY k.id, k.name, k.user_id, k.team, k.expires_at, k.created_at`

	rows, err := s.db.QueryContext(ctx, s.bind(query), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []KeyAlert{}
	staleCutoff := now.AddDate(0, 0, -staleDays)
	for rows.Next() {
		var a KeyAlert
		var createdAt, lastUsed string
		if err := rows.Scan(&a.ID, &a.Name, &a.UserID, &a.Team, &a.ExpiresAt, &createdAt, &lastUsed); err != nil {
			return nil, err
		}
		a.LastUsedAt = lastUsed
		flags := []string{}

		// Expiry checks.
		if a.ExpiresAt != "" {
			if exp := parseOptionalTime(a.ExpiresAt); !exp.IsZero() {
				if exp.Before(now) {
					flags = append(flags, "expired")
				} else if exp.Before(now.AddDate(0, 0, expiringDays)) {
					flags = append(flags, "expiring_soon")
				}
			}
		}

		// Usage checks: reference point is last use, else creation.
		ref := parseOptionalTime(lastUsed)
		if lastUsed == "" {
			flags = append(flags, "never_used")
			ref = parseOptionalTime(createdAt)
		} else if ref.Before(staleCutoff) {
			flags = append(flags, "stale_unused")
		}
		if !ref.IsZero() {
			a.DaysIdle = int(now.Sub(ref).Hours() / 24)
		}

		if len(flags) == 0 {
			continue
		}
		a.Flags = flags
		if strListHas(flags, "expired") || strListHas(flags, "expiring_soon") {
			a.Severity = "high"
		} else {
			a.Severity = "medium"
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	severityRank := map[string]int{"high": 0, "medium": 1}
	sort.Slice(out, func(i, j int) bool {
		if severityRank[out[i].Severity] != severityRank[out[j].Severity] {
			return severityRank[out[i].Severity] < severityRank[out[j].Severity]
		}
		return out[i].DaysIdle > out[j].DaysIdle
	})
	return out, nil
}
