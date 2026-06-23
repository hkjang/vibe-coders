package store

import (
	"context"
	"testing"
	"time"
)

func TestCodeVerifyPersistAndDetail(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	when := time.Date(2026, 6, 18, 9, 0, 0, 0, time.UTC)

	rec := LogRecord{
		Request: RequestLog{
			ID: "cv_req", TraceID: "cv_trace", Endpoint: "/v1/chat/completions", Model: "gpt-4.1",
			Provider: "openai", StatusCode: 200, CreatedAt: when,
		},
		Response: &ResponseLog{ID: "cv_resp", RequestID: "cv_req", StatusCode: 200, FinishReason: "stop", CreatedAt: when},
		CodeVerify: &CodeVerifyLog{
			ID: "cv_1", RequestID: "cv_req", TraceID: "cv_trace", HasCode: true, Risk: "high",
			BlockCount: 1, Languages: "shell", HighCount: 1, TestableCount: 1,
			FindingsJSON: `[{"severity":"high","category":"destructive","rule":"rm_rf","lang":"shell","line":1,"detail":"재귀 강제 삭제"}]`,
			CreatedAt:    when,
		},
	}
	if err := db.InsertLogRecord(ctx, rec); err != nil {
		t.Fatal(err)
	}

	detail, err := db.RequestDetail(ctx, "cv_req")
	if err != nil {
		t.Fatal(err)
	}
	if detail.CodeVerify == nil {
		t.Fatal("RequestDetail should include the code verdict")
	}
	if detail.CodeVerify.Risk != "high" || !detail.CodeVerify.HasCode || detail.CodeVerify.HighCount != 1 {
		t.Fatalf("verdict mismatch: %+v", detail.CodeVerify)
	}
	if detail.CodeVerify.Languages != "shell" || len(detail.CodeVerify.Findings) == 0 {
		t.Fatalf("verdict findings/languages mismatch: %+v", detail.CodeVerify)
	}

	byTrace, err := db.CodeVerifyByTrace(ctx, "cv_trace")
	if err != nil || len(byTrace) != 1 || byTrace[0].RequestID != "cv_req" || byTrace[0].Risk != "high" {
		t.Fatalf("CodeVerifyByTrace = %+v err=%v", byTrace, err)
	}

	// A request with no persisted verdict reports nil (omitted).
	rec2 := LogRecord{Request: RequestLog{ID: "cv_req2", Endpoint: "/v1/models", StatusCode: 200, CreatedAt: when}}
	if err := db.InsertLogRecord(ctx, rec2); err != nil {
		t.Fatal(err)
	}
	d2, err := db.RequestDetail(ctx, "cv_req2")
	if err != nil {
		t.Fatal(err)
	}
	if d2.CodeVerify != nil {
		t.Fatalf("request without verdict should have nil CodeVerify, got %+v", d2.CodeVerify)
	}
}

func TestCodeVerifyModelStats(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	when := time.Now().UTC().Add(-time.Hour)

	mk := func(id, model, risk string, high, testable int) {
		rec := LogRecord{
			Request: RequestLog{ID: id, Endpoint: "/v1/chat/completions", Model: model, StatusCode: 200, CreatedAt: when},
			CodeVerify: &CodeVerifyLog{
				ID: id + "_cv", RequestID: id, HasCode: true, Risk: risk, BlockCount: 1,
				Languages: "go", HighCount: high, TestableCount: testable, FindingsJSON: "[]", CreatedAt: when,
			},
		}
		if err := db.InsertLogRecord(ctx, rec); err != nil {
			t.Fatal(err)
		}
	}
	mk("s1", "model-a", "high", 2, 0)
	mk("s2", "model-a", "high", 1, 1)
	mk("s3", "model-b", "low", 0, 1)

	stats, err := db.CodeVerifyModelStats(ctx, time.Now().UTC().Add(-2*time.Hour), 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(stats) != 2 {
		t.Fatalf("want 2 models, got %d: %+v", len(stats), stats)
	}
	// model-a has the most high-risk verdicts → ranked first.
	if stats[0].Model != "model-a" || stats[0].RiskHigh != 2 || stats[0].Verdicts != 2 || stats[0].HighFindings != 3 {
		t.Fatalf("model-a stats wrong: %+v", stats[0])
	}
	if stats[0].HighRiskRate != 1.0 {
		t.Fatalf("model-a high-risk rate should be 1.0, got %v", stats[0].HighRiskRate)
	}
	if stats[1].Model != "model-b" || stats[1].RiskHigh != 0 || stats[1].Testable != 1 {
		t.Fatalf("model-b stats wrong: %+v", stats[1])
	}
}
