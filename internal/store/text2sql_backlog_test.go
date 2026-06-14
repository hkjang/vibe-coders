package store

import (
	"context"
	"testing"
	"time"
)

func TestText2SQLCache(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	key := Text2SQLCacheKey("부서별 매출", "global", "preview", 1)
	// Different schema version → different key (invalidation).
	if key == Text2SQLCacheKey("부서별 매출", "global", "preview", 2) {
		t.Fatal("schema version must affect the cache key")
	}

	// Miss before put.
	if _, ok, err := db.GetText2SQLCache(ctx, key); err != nil || ok {
		t.Fatalf("expected miss before put: ok=%v err=%v", ok, err)
	}

	if err := db.PutText2SQLCache(ctx, key, "global", "preview", "SELECT 1", time.Hour); err != nil {
		t.Fatal(err)
	}
	sql, ok, err := db.GetText2SQLCache(ctx, key)
	if err != nil || !ok || sql != "SELECT 1" {
		t.Fatalf("expected hit: sql=%q ok=%v err=%v", sql, ok, err)
	}

	// Expired entry → miss.
	expKey := Text2SQLCacheKey("만료", "global", "preview", 1)
	if err := db.PutText2SQLCache(ctx, expKey, "global", "preview", "SELECT 2", -time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := db.GetText2SQLCache(ctx, expKey); ok {
		t.Fatal("expired entry should miss")
	}
}

func TestText2SQLBusinessTerms(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	if err := db.UpsertText2SQLBusinessTerm(ctx, Text2SQLBusinessTerm{ID: "t1", SchemaName: "global", Term: "상담", Mapping: "tickets 테이블", Description: "고객 문의"}); err != nil {
		t.Fatal(err)
	}
	// Empty schema name → global wildcard "*".
	if err := db.UpsertText2SQLBusinessTerm(ctx, Text2SQLBusinessTerm{ID: "t2", Term: "활성 사용자", Mapping: "users WHERE active=1"}); err != nil {
		t.Fatal(err)
	}

	terms, err := db.ListText2SQLBusinessTerms(ctx, "global")
	if err != nil {
		t.Fatal(err)
	}
	// Both the global-scoped term and the wildcard term apply.
	if len(terms) != 2 {
		t.Fatalf("expected 2 terms for global schema, got %d: %+v", len(terms), terms)
	}

	gloss, err := db.BuildGlossaryText(ctx, "global")
	if err != nil {
		t.Fatal(err)
	}
	if !containsStore(gloss, "상담") || !containsStore(gloss, "tickets") {
		t.Errorf("glossary text missing term/mapping: %q", gloss)
	}

	// Update via upsert.
	if err := db.UpsertText2SQLBusinessTerm(ctx, Text2SQLBusinessTerm{ID: "t1", SchemaName: "global", Term: "상담", Mapping: "support_tickets"}); err != nil {
		t.Fatal(err)
	}
	gloss2, _ := db.BuildGlossaryText(ctx, "global")
	if !containsStore(gloss2, "support_tickets") {
		t.Errorf("upsert should replace mapping: %q", gloss2)
	}

	// Delete.
	if err := db.DeleteText2SQLBusinessTerm(ctx, "t1"); err != nil {
		t.Fatal(err)
	}
	terms, _ = db.ListText2SQLBusinessTerms(ctx, "global")
	if len(terms) != 1 {
		t.Fatalf("expected 1 term after delete, got %d", len(terms))
	}
}

func TestRiskyText2SQLLogs(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	// Clean, low-risk request — should NOT appear in the queue.
	if err := db.InsertText2SQLLog(ctx, Text2SQLQueryLog{ID: "ok", Valid: true, ExplainRisk: 5, CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	// Rejected request.
	if err := db.InsertText2SQLLog(ctx, Text2SQLQueryLog{ID: "rejected", Valid: false, RejectReason: "DROP", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	// High EXPLAIN risk.
	if err := db.InsertText2SQLLog(ctx, Text2SQLQueryLog{ID: "risky", Valid: true, ExplainRisk: 80, CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	// Classified failure.
	if err := db.InsertText2SQLLog(ctx, Text2SQLQueryLog{ID: "failed", Valid: true, FailureCategory: "execution_error", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}

	logs, err := db.RiskyText2SQLLogs(ctx, now.Add(-time.Hour), 50, 100)
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for _, l := range logs {
		ids[l.ID] = true
	}
	if ids["ok"] {
		t.Error("clean low-risk request should not be in the risk queue")
	}
	for _, want := range []string{"rejected", "risky", "failed"} {
		if !ids[want] {
			t.Errorf("risk queue should include %q: got %+v", want, ids)
		}
	}
}

func containsStore(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
