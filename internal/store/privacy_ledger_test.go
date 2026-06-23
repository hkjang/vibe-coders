package store

import (
	"context"
	"testing"
	"time"
)

func TestPrivacyLedgerByModel(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	when := time.Now().UTC().Add(-1 * time.Hour)

	mkReq := func(id string, status int) {
		rec := LogRecord{
			Request: RequestLog{ID: id, Endpoint: "/v1/chat/completions", Model: "gpt-4.1", Provider: "openai", StatusCode: status, CreatedAt: when},
			Usage:   &TokenUsage{ID: id + "_u", RequestID: id, TotalTokens: 100, EstimatedCost: 1, Currency: "KRW", CreatedAt: when},
		}
		if err := db.InsertLogRecord(ctx, rec); err != nil {
			t.Fatal(err)
		}
	}
	mkReq("pl1", 200)
	mkReq("pl2", 200)
	mkReq("pl3", 500) // error → not counted as successful egress

	mkSec := func(id, reqID, action string) {
		if err := db.InsertSecretEvent(ctx, SecretEvent{ID: id, RequestID: reqID, SecretType: "openai_api_key", Action: action, CreatedAt: when}); err != nil {
			t.Fatal(err)
		}
	}
	mkSec("s1", "pl1", "detect")
	mkSec("s2", "pl1", "mask")
	mkSec("s3", "pl2", "block")

	rows, err := db.PrivacyLedger(ctx, "model", when.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].DimValue != "gpt-4.1" {
		t.Fatalf("expected one gpt-4.1 row, got %+v", rows)
	}
	r := rows[0]
	if r.Detections != 1 || r.Masked != 1 || r.Blocked != 1 {
		t.Fatalf("secret counts wrong: %+v", r)
	}
	// Only the two 2xx requests count as egress; the 500 does not.
	if r.EgressRequests != 2 || r.EgressTokens != 200 {
		t.Fatalf("egress wrong (should exclude the 5xx): %+v", r)
	}
}

func TestPrivacyLedgerBadDimension(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	if _, err := db.PrivacyLedger(context.Background(), "nope", time.Now().Add(-time.Hour)); err == nil {
		t.Fatal("unsupported dimension should error")
	}
}
