package store

import (
	"context"
	"testing"
	"time"
)

func TestKeyHealthAlerts(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)

	mkKey := func(id, userID, expiresAt string) {
		if _, err := db.db.ExecContext(ctx,
			`INSERT INTO api_keys (id, name, key_hash, status, created_at, user_id, expires_at) VALUES (?,?,?,?,?,?,?)`,
			id, id+" key", "hash-"+id, "active", now.AddDate(0, 0, -90).Format(time.RFC3339Nano), userID, expiresAt); err != nil {
			t.Fatal(err)
		}
	}
	use := func(id, keyID string, when time.Time) {
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{ID: id, TraceID: id, APIKeyID: keyID, Endpoint: "/v1/chat/completions",
				Model: "gpt-4.1", StatusCode: 200, CreatedAt: when},
		}); err != nil {
			t.Fatal(err)
		}
	}

	// fresh: used yesterday, no expiry → no alert.
	mkKey("k_fresh", "u1", "")
	use("rf", "k_fresh", now.AddDate(0, 0, -1))
	// expiring: used recently but expires in 3 days → expiring_soon (high).
	mkKey("k_expiring", "u1", now.AddDate(0, 0, 3).Format(time.RFC3339Nano))
	use("re", "k_expiring", now.AddDate(0, 0, -1))
	// expired: expiry in the past → expired (high).
	mkKey("k_expired", "u2", now.AddDate(0, 0, -2).Format(time.RFC3339Nano))
	use("rx", "k_expired", now.AddDate(0, 0, -1))
	// never used: no request_logs → never_used (medium).
	mkKey("k_never", "u1", "")
	// stale: last used 60 days ago → stale_unused (medium).
	mkKey("k_stale", "u2", "")
	use("rs", "k_stale", now.AddDate(0, 0, -60))

	alerts, err := db.KeyHealthAlerts(ctx, now, 30, 7, "")
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]KeyAlert{}
	for _, a := range alerts {
		byID[a.ID] = a
	}
	if _, ok := byID["k_fresh"]; ok {
		t.Error("fresh key should not be flagged")
	}
	if a := byID["k_expiring"]; a.Severity != "high" || !strListHas(a.Flags, "expiring_soon") {
		t.Errorf("k_expiring = %+v, want high/expiring_soon", a)
	}
	if a := byID["k_expired"]; a.Severity != "high" || !strListHas(a.Flags, "expired") {
		t.Errorf("k_expired = %+v, want high/expired", a)
	}
	if a := byID["k_never"]; a.Severity != "medium" || !strListHas(a.Flags, "never_used") {
		t.Errorf("k_never = %+v, want medium/never_used", a)
	}
	if a := byID["k_stale"]; a.Severity != "medium" || !strListHas(a.Flags, "stale_unused") || a.DaysIdle < 59 {
		t.Errorf("k_stale = %+v, want medium/stale_unused/~60d idle", a)
	}
	// High severity sorts before medium.
	if len(alerts) > 0 && alerts[0].Severity != "high" {
		t.Errorf("high severity should sort first, got %q", alerts[0].Severity)
	}

	// User filter: only u2's keys (k_expired, k_stale).
	u2, err := db.KeyHealthAlerts(ctx, now, 30, 7, "u2")
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range u2 {
		if a.UserID != "u2" {
			t.Errorf("user filter leaked a non-u2 key: %+v", a)
		}
	}
	if len(u2) != 2 {
		t.Errorf("u2 should have 2 flagged keys, got %d", len(u2))
	}
}
