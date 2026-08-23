package store

import (
	"context"
	"testing"
	"time"
)

// Retention purges request_logs and its children, but several per-request telemetry
// tables were left out. Each carries the request id next to an api key, user or team —
// so a purged request still had rows saying who made it, and routing_decisions still
// held the PII/secret categories detected in its prompt. They also grow one row per
// request forever while request_logs shrinks.
func TestPurgeRemovesPerRequestTelemetryWithItsRequest(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	old := time.Now().UTC().AddDate(0, 0, -120)
	recent := time.Now().UTC()

	// One request past retention, one inside it.
	for _, spec := range []struct {
		id string
		at time.Time
	}{{"req-old", old}, {"req-new", recent}} {
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{
				ID: spec.id, TraceID: spec.id, Endpoint: "/v1/chat/completions",
				Model: "m", Provider: "p", StatusCode: 200, APIKeyID: "key-1",
				CreatedAt: spec.at,
			},
			Routing: &RoutingDecisionLog{
				ID: "rd-" + spec.id, RequestID: spec.id, TraceID: spec.id,
				SelectedModel: "m", SelectedProvider: "p",
				// The reason this matters beyond table size: risk categories are the
				// PII/secret classification of the prompt.
				Risk:      RiskAnalysis{Score: 40, Tier: "medium", Categories: []string{"pii"}},
				CreatedAt: spec.at,
			},
		}); err != nil {
			t.Fatal(err)
		}
	}

	before, err := db.ListRoutingDecisions(ctx, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(before) != 2 {
		t.Fatalf("expected both routing decisions to be stored, got %d", len(before))
	}

	// Retain 90 days: the 120-day-old request must go, the recent one must stay.
	if _, err := db.PurgeOlderThan(ctx, "request_logs", 90); err != nil {
		t.Fatal(err)
	}

	after, err := db.ListRoutingDecisions(ctx, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != 1 {
		t.Fatalf("routing decisions after purge = %d, want 1 — telemetry outlived the "+
			"request it describes", len(after))
	}
	if after[0].RequestID != "req-new" {
		t.Fatalf("the surviving routing decision is %q, want req-new", after[0].RequestID)
	}

	// Nothing inside the retention window may be touched.
	var remaining int
	if err := db.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM request_logs`).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 1 {
		t.Fatalf("request_logs after purge = %d, want 1", remaining)
	}
}

// The purge must not reach operator-managed records, which are not request telemetry
// and have their own lifecycle. Deleting those would destroy work an operator did.
func TestPurgeLeavesOperatorRecordsAlone(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	old := time.Now().UTC().AddDate(0, 0, -120)

	if err := db.InsertLogRecord(ctx, LogRecord{Request: RequestLog{
		ID: "req-old", TraceID: "req-old", Endpoint: "/v1/chat/completions",
		Model: "m", Provider: "p", StatusCode: 200, CreatedAt: old,
	}}); err != nil {
		t.Fatal(err)
	}
	// An operator's note on that request.
	if _, err := db.db.ExecContext(ctx, db.bind(
		`INSERT INTO request_notes (request_id, note, tags, updated_at) VALUES (?, ?, ?, ?)`),
		"req-old", "looked into this", "", old.Format(time.RFC3339Nano)); err != nil {
		t.Skipf("request_notes shape differs; skipping: %v", err)
	}

	if _, err := db.PurgeOlderThan(ctx, "request_logs", 90); err != nil {
		t.Fatal(err)
	}

	var notes int
	if err := db.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM request_notes`).Scan(&notes); err != nil {
		t.Fatal(err)
	}
	if notes != 1 {
		t.Fatalf("request_notes after purge = %d, want 1 — operator annotations are not "+
			"telemetry and must survive", notes)
	}
}
