package store

import (
	"context"
	"sort"
	"strings"
	"time"
)

// AdminAuditAnomaly summarizes potentially-suspicious admin activity for one admin over a
// window: bursts of destructive actions, privilege/scope changes, off-hours activity, and
// overall volume. Read-only detection — nothing enforces on it.
type AdminAuditAnomaly struct {
	AdminID             string   `json:"admin_id"`
	TotalActions        int64    `json:"total_actions"`
	DestructiveActions  int64    `json:"destructive_actions"`
	PrivilegeActions    int64    `json:"privilege_actions"`
	OffHoursActions     int64    `json:"off_hours_actions"`
	DistinctActionTypes int64    `json:"distinct_action_types"`
	Flags               []string `json:"flags"`
	Severity            string   `json:"severity"` // "high" | "medium" | "ok"
}

// privilege/destructive keyword sets matched (case-insensitive substring) against the
// audit action string. Action names are conventionally dotted, e.g. "apikey.scopes.update".
var auditDestructiveKeywords = []string{"delete", "revoke", "remove", "hard"}
var auditPrivilegeKeywords = []string{"scope", "role", "grant", "permission", "escalat"}

// isOffHours reports whether t (in UTC) falls in the off-hours window 22:00–06:00.
func isOffHours(t time.Time) bool {
	h := t.UTC().Hour()
	return h < 6 || h >= 22
}

func actionMatches(action string, keywords []string) bool {
	a := strings.ToLower(action)
	for _, k := range keywords {
		if strings.Contains(a, k) {
			return true
		}
	}
	return false
}

// AdminAuditAnomalies scans admin audit logs since `since` and returns, for each admin
// that trips at least one rule, an anomaly summary. destructiveThreshold flags a burst of
// destructive actions; highVolumeThreshold flags excessive overall activity. Any privilege
// change or off-hours action is surfaced. Sorted by severity then volume.
func (s *SQLStore) AdminAuditAnomalies(ctx context.Context, since time.Time, destructiveThreshold, highVolumeThreshold int) ([]AdminAuditAnomaly, error) {
	if destructiveThreshold <= 0 {
		destructiveThreshold = 5
	}
	if highVolumeThreshold <= 0 {
		highVolumeThreshold = 100
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT COALESCE(admin_id, '(unknown)'), action, created_at
		FROM admin_audit_logs
		WHERE created_at >= ?
		ORDER BY created_at ASC
		LIMIT 20000`), since.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type acc struct {
		anomaly  AdminAuditAnomaly
		actions  map[string]bool
	}
	agg := map[string]*acc{}
	for rows.Next() {
		var adminID, action, createdAt string
		if err := rows.Scan(&adminID, &action, &createdAt); err != nil {
			return nil, err
		}
		a := agg[adminID]
		if a == nil {
			a = &acc{anomaly: AdminAuditAnomaly{AdminID: adminID}, actions: map[string]bool{}}
			agg[adminID] = a
		}
		a.anomaly.TotalActions++
		a.actions[action] = true
		if actionMatches(action, auditDestructiveKeywords) {
			a.anomaly.DestructiveActions++
		}
		if actionMatches(action, auditPrivilegeKeywords) {
			a.anomaly.PrivilegeActions++
		}
		if t := parseOptionalTime(createdAt); !t.IsZero() && isOffHours(t) {
			a.anomaly.OffHoursActions++
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := []AdminAuditAnomaly{}
	for _, a := range agg {
		an := a.anomaly
		an.DistinctActionTypes = int64(len(a.actions))
		flags := []string{}
		if an.DestructiveActions >= int64(destructiveThreshold) {
			flags = append(flags, "destructive_burst")
		}
		if an.PrivilegeActions > 0 {
			flags = append(flags, "privilege_changes")
		}
		if an.TotalActions >= int64(highVolumeThreshold) {
			flags = append(flags, "high_volume")
		}
		if an.OffHoursActions > 0 {
			flags = append(flags, "off_hours")
		}
		if len(flags) == 0 {
			continue
		}
		an.Flags = flags
		switch {
		case strListHas(flags, "destructive_burst") || strListHas(flags, "privilege_changes"):
			an.Severity = "high"
		case strListHas(flags, "high_volume") || strListHas(flags, "off_hours"):
			an.Severity = "medium"
		default:
			an.Severity = "ok"
		}
		out = append(out, an)
	}
	severityRank := map[string]int{"high": 0, "medium": 1, "ok": 2}
	sort.Slice(out, func(i, j int) bool {
		if severityRank[out[i].Severity] != severityRank[out[j].Severity] {
			return severityRank[out[i].Severity] < severityRank[out[j].Severity]
		}
		return out[i].TotalActions > out[j].TotalActions
	})
	return out, nil
}

func strListHas(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}
