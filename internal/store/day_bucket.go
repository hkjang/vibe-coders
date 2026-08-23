package store

import (
	"fmt"
	"time"
)

// Which day a request belongs to.
//
// Timestamps are stored as RFC3339 in UTC, and the daily charts bucketed them by cutting
// the first ten characters off that string — a UTC day. Everything else in the product
// works in Seoul time: quota periods reset at KST midnight (seoulZone), budgets run on
// KST months (budgetKST), chargeback windows are KST (chargebackKST), and the activity
// heatmap converts to KST before bucketing.
//
// So the same three requests, all sent on a Monday morning and evening in Seoul, appeared
// as one Monday on the heatmap and as two separate days on the cost chart. Every request
// between 00:00 and 09:00 KST — nine hours of each day, including a whole working morning
// — was charted against the day before. Nothing errored; the numbers were just attributed
// to the wrong day, and they disagreed with the quota that had already reset.
//
// seoulZone is the one Seoul offset this package works in. Korea has no daylight saving,
// so a fixed +09:00 is exact rather than an approximation.
var seoulZone = time.FixedZone("KST", 9*3600)

// seoulDayExpr returns SQL that buckets a UTC timestamp column into a Seoul calendar day.
// The two drivers need different syntax for it, which is why this is a function and not a
// constant: SQLite has datetime() modifiers, PostgreSQL has interval arithmetic.
func (s *SQLStore) seoulDayExpr(column string) string {
	if s.dialect == "postgres" {
		return fmt.Sprintf("to_char((%s)::timestamptz + interval '9 hours', 'YYYY-MM-DD')", column)
	}
	return fmt.Sprintf("substr(datetime(%s, '+9 hours'), 1, 10)", column)
}

// seoulHourExpr is the same for an hour bucket, keeping the YYYY-MM-DDTHH shape the
// callers already parse.
func (s *SQLStore) seoulHourExpr(column string) string {
	if s.dialect == "postgres" {
		return fmt.Sprintf("to_char((%s)::timestamptz + interval '9 hours', 'YYYY-MM-DD\"T\"HH24')", column)
	}
	return fmt.Sprintf("replace(substr(datetime(%s, '+9 hours'), 1, 13), ' ', 'T')", column)
}
