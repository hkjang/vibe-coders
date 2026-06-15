package store

import (
	"context"
	"testing"
	"time"
)

func TestErrorBudgetBurn(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	rec := func(id, project string, status int, when time.Time) {
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{ID: id, TraceID: id, APIKeyID: "k", Endpoint: "/v1/chat/completions",
				Model: "gpt-4.1", Project: project, StatusCode: status, CreatedAt: when},
		}); err != nil {
			t.Fatal(err)
		}
	}

	recent := now.Add(-10 * time.Minute) // inside short (1h) and long (24h) windows
	older := now.Add(-5 * time.Hour)     // inside long only

	// Project "burning": within the last 10m, 5 of 10 requests fail (claim rate 0.5).
	for i := 0; i < 10; i++ {
		status := 200
		if i < 5 {
			status = 500
		}
		rec("br"+itoaStore(i), "burning", status, recent)
	}
	// Project "calm": 20 clean requests spread across the long window.
	for i := 0; i < 20; i++ {
		rec("ca"+itoaStore(i), "calm", 200, older)
	}

	longSince := now.Add(-24 * time.Hour)
	shortSince := now.Add(-time.Hour)
	// SLA 0.99 → allowance 0.01; fast 14.4, slow 3.
	burns, err := db.ErrorBudgetBurn(ctx, "project", longSince, shortSince, 100, 0.99, 14.4, 3.0)
	if err != nil {
		t.Fatal(err)
	}
	byScope := map[string]ErrorBudgetBurn{}
	for _, b := range burns {
		byScope[b.Scope] = b
	}
	burning, calm := byScope["burning"], byScope["calm"]

	// burning: claim rate 0.5 short and long → burn rate 50 >> 14.4 → fast.
	if burning.ClaimsShort != 5 || burning.ReqShort != 10 {
		t.Errorf("burning short = %d/%d claims/reqs, want 5/10", burning.ClaimsShort, burning.ReqShort)
	}
	if burning.BurnRateLong < 49 || burning.BurnRateLong > 51 {
		t.Errorf("burning long burn rate = %f, want ~50", burning.BurnRateLong)
	}
	if burning.Severity != "fast" {
		t.Errorf("burning severity = %q, want fast", burning.Severity)
	}
	// At 50x, a 30-day budget lasts 0.6 days.
	if burning.DaysToExhaustion < 0.55 || burning.DaysToExhaustion > 0.65 {
		t.Errorf("burning days-to-exhaustion = %f, want ~0.6", burning.DaysToExhaustion)
	}
	// calm: no claims → ok, no exhaustion.
	if calm.Severity != "ok" || calm.ClaimsLong != 0 {
		t.Errorf("calm should be ok with 0 claims, got severity=%q claims=%d", calm.Severity, calm.ClaimsLong)
	}
	// Fast-burning scope sorts first.
	if len(burns) == 0 || burns[0].Scope != "burning" {
		t.Errorf("fast-burning scope should sort first, got %+v", burns)
	}

	// Unsupported dimension errors.
	if _, err := db.ErrorBudgetBurn(ctx, "bogus", longSince, shortSince, 100, 0.99, 14.4, 3.0); err == nil {
		t.Error("unsupported dimension should error")
	}
}
