package store

import (
	"context"
	"testing"
	"time"
)

func TestInsuranceClaims(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	rec := func(id, project string, status int, failover bool, errMsg string) {
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{ID: id, TraceID: id, APIKeyID: "k", Endpoint: "/v1/chat/completions",
				Model: "gpt-4.1", Project: project, StatusCode: status, Failover: failover, Error: errMsg, CreatedAt: now},
		}); err != nil {
			t.Fatal(err)
		}
	}

	// Project "shaky": 10 requests, 3 degraded (one 500, one 400, one failover-only).
	for i := 0; i < 7; i++ {
		rec("s"+itoaStore(i), "shaky", 200, false, "")
	}
	rec("s7", "shaky", 500, false, "boom")  // 5xx (also error → still one claim)
	rec("s8", "shaky", 404, false, "")      // 4xx
	rec("s9", "shaky", 200, true, "")       // failover-only
	// Project "solid": 5 requests all clean.
	for i := 0; i < 5; i++ {
		rec("o"+itoaStore(i), "solid", 200, false, "")
	}

	claims, err := db.InsuranceClaims(ctx, "project", now.Add(-time.Hour), 100, 0.99)
	if err != nil {
		t.Fatal(err)
	}
	byScope := map[string]InsuranceClaim{}
	for _, c := range claims {
		byScope[c.Scope] = c
	}
	shaky, solid := byScope["shaky"], byScope["solid"]

	if shaky.Covered != 10 || shaky.Claims != 3 {
		t.Errorf("shaky = %d covered / %d claims, want 10 / 3", shaky.Covered, shaky.Claims)
	}
	if shaky.Claims5xx != 1 || shaky.Claims4xx != 1 || shaky.ClaimsFailover != 1 {
		t.Errorf("shaky breakdown 5xx/4xx/failover = %d/%d/%d, want 1/1/1", shaky.Claims5xx, shaky.Claims4xx, shaky.ClaimsFailover)
	}
	// claim_rate 0.3 > allowance 0.01 → SLA breached.
	if shaky.SLAMet {
		t.Error("shaky should breach the 0.99 SLA")
	}
	// allowed = 0.01 * 10 = 0.1; excess = 3 - 0.1 = 2.9.
	if shaky.ExcessClaims < 2.89 || shaky.ExcessClaims > 2.91 {
		t.Errorf("shaky excess claims = %f, want ~2.9", shaky.ExcessClaims)
	}
	if !solid.SLAMet || solid.Claims != 0 {
		t.Errorf("solid should meet SLA with 0 claims, got met=%v claims=%d", solid.SLAMet, solid.Claims)
	}
	// Worst breach sorts first.
	if len(claims) == 0 || claims[0].Scope != "shaky" {
		t.Errorf("worst-breach scope should sort first, got %+v", claims)
	}

	// Unsupported dimension errors.
	if _, err := db.InsuranceClaims(ctx, "bogus", now.Add(-time.Hour), 100, 0.99); err == nil {
		t.Error("unsupported dimension should error")
	}
}
