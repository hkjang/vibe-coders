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

	key := Text2SQLCacheKey("부서별 매출", "global", "preview", 1, "permA", "glossA")
	// Different schema version → different key (invalidation).
	if key == Text2SQLCacheKey("부서별 매출", "global", "preview", 2, "permA", "glossA") {
		t.Fatal("schema version must affect the cache key")
	}
	// Different permission hash → different key (no cross-subject reuse).
	if key == Text2SQLCacheKey("부서별 매출", "global", "preview", 1, "permB", "glossA") {
		t.Fatal("permission hash must affect the cache key")
	}
	// Different glossary hash → different key.
	if key == Text2SQLCacheKey("부서별 매출", "global", "preview", 1, "permA", "glossB") {
		t.Fatal("glossary hash must affect the cache key")
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
	expKey := Text2SQLCacheKey("만료", "global", "preview", 1, "permA", "glossA")
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

func TestDetectGlossaryConflicts(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	// Same term, two different mappings in the same schema → duplicate_mapping.
	_ = db.UpsertText2SQLBusinessTerm(ctx, Text2SQLBusinessTerm{ID: "c1", SchemaName: "global", Term: "활성", Mapping: "status='active'"})
	_ = db.UpsertText2SQLBusinessTerm(ctx, Text2SQLBusinessTerm{ID: "c2", SchemaName: "global", Term: "활성", Mapping: "is_active=1"})
	// A clean term with one mapping → no conflict.
	_ = db.UpsertText2SQLBusinessTerm(ctx, Text2SQLBusinessTerm{ID: "c3", SchemaName: "global", Term: "상담", Mapping: "tickets"})
	// A schema-specific term shadowing a global one with a different mapping → shadowed.
	_ = db.UpsertText2SQLBusinessTerm(ctx, Text2SQLBusinessTerm{ID: "c4", Term: "매출", Mapping: "revenue"}) // global "*"
	_ = db.UpsertText2SQLBusinessTerm(ctx, Text2SQLBusinessTerm{ID: "c5", SchemaName: "global", Term: "매출", Mapping: "sales"})

	conflicts, err := db.DetectGlossaryConflicts(ctx, "global")
	if err != nil {
		t.Fatal(err)
	}
	byTerm := map[string]Text2SQLGlossaryConflict{}
	for _, c := range conflicts {
		byTerm[c.Term] = c
	}
	if c, ok := byTerm["활성"]; !ok || c.Kind != "duplicate_mapping" || len(c.Mappings) != 2 {
		t.Errorf("활성 should be a duplicate_mapping conflict: %+v", c)
	}
	if _, ok := byTerm["상담"]; ok {
		t.Error("상담 has a single mapping and must not be a conflict")
	}
	if c, ok := byTerm["매출"]; !ok || c.Kind != "shadowed" {
		t.Errorf("매출 should be a shadowed conflict: %+v", c)
	}
}

func TestText2SQLReplayBundle(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	if _, found, _ := db.GetText2SQLReplayBundle(ctx, "missing"); found {
		t.Fatal("expected no bundle before put")
	}
	b := Text2SQLReplayBundle{
		ID: "t2s_1", RequestID: "req_1", SchemaName: "global", SchemaVersion: 3,
		SystemPrompt: `[{"role":"system"}]`, SchemaContext: "t(x)", GlossaryText: "상담 → tickets",
		PermissionSnapshot: `{"allowed_tables":["t"]}`, GeneratedSQL: "SELECT 1",
	}
	if err := db.PutText2SQLReplayBundle(ctx, b); err != nil {
		t.Fatal(err)
	}
	// Fetch by id and by request id.
	for _, key := range []string{"t2s_1", "req_1"} {
		got, found, err := db.GetText2SQLReplayBundle(ctx, key)
		if err != nil || !found {
			t.Fatalf("expected bundle for %q: found=%v err=%v", key, found, err)
		}
		if got.SchemaVersion != 3 || got.GeneratedSQL != "SELECT 1" || got.GlossaryText != "상담 → tickets" {
			t.Errorf("bundle mismatch for %q: %+v", key, got)
		}
	}
}

func TestText2SQLSchemaImpact(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	_ = db.UpsertText2SQLSchema(ctx, Text2SQLSchema{Name: "analytics", SchemaText: "t(x)", Enabled: true})
	_ = db.UpsertText2SQLBusinessTerm(ctx, Text2SQLBusinessTerm{ID: "g1", SchemaName: "analytics", Term: "매출", Mapping: "revenue"})
	_ = db.UpsertText2SQLBusinessTerm(ctx, Text2SQLBusinessTerm{ID: "g2", Term: "공통", Mapping: "x"}) // global "*"
	_ = db.PutText2SQLCache(ctx, Text2SQLCacheKey("q", "analytics", "preview", 1, "", ""), "analytics", "preview", "SELECT 1", time.Hour)

	rep, err := db.Text2SQLSchemaImpact(ctx, "analytics")
	if err != nil {
		t.Fatal(err)
	}
	if rep.GlossaryTerms != 2 { // schema-specific + global wildcard
		t.Errorf("expected 2 glossary terms in impact, got %d", rep.GlossaryTerms)
	}
	if rep.CacheEntries != 1 {
		t.Errorf("expected 1 cache entry in impact, got %d", rep.CacheEntries)
	}
}

func TestPurgeText2SQLReplayBundles(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	if err := db.PutText2SQLReplayBundle(ctx, Text2SQLReplayBundle{ID: "b1", RequestID: "r1", GeneratedSQL: "SELECT 1"}); err != nil {
		t.Fatal(err)
	}
	// days<=0 is a no-op.
	if n, err := db.PurgeText2SQLReplayBundles(ctx, 0); err != nil || n != 0 {
		t.Fatalf("days<=0 should purge nothing: n=%d err=%v", n, err)
	}
	// A fresh bundle is within the 30-day window → survives.
	if n, _ := db.PurgeText2SQLReplayBundles(ctx, 30); n != 0 {
		t.Errorf("fresh bundle should not be purged, deleted %d", n)
	}
	if _, found, _ := db.GetText2SQLReplayBundle(ctx, "b1"); !found {
		t.Error("fresh bundle should still exist after a 30-day purge")
	}
}

func TestText2SQLMiners(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	// Three identical valid questions → a report candidate; plus a one-off.
	for i := 0; i < 3; i++ {
		_ = db.InsertText2SQLLog(ctx, Text2SQLQueryLog{ID: "rep" + itoaStore(i), Question: "부서별 상담 건수", Valid: true, GeneratedSQL: "SELECT dept, count(*) FROM tickets GROUP BY dept", CreatedAt: now})
	}
	_ = db.InsertText2SQLLog(ctx, Text2SQLQueryLog{ID: "one", Question: "오늘 신규 가입자", Valid: true, GeneratedSQL: "SELECT 1", CreatedAt: now})

	reports, err := db.Text2SQLReportCandidates(ctx, now.Add(-time.Hour), 3, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(reports) != 1 || reports[0].Count != 3 {
		t.Fatalf("expected one report candidate with count 3, got %+v", reports)
	}
	// The sample SQL groups by dept → dashboard product recommendation.
	if reports[0].RecommendedProduct != "dashboard" {
		t.Errorf("aggregating query should recommend dashboard, got %q", reports[0].RecommendedProduct)
	}

	// "상담" / "부서별" appear in 3 distinct logs → glossary candidates (above min 3).
	cands, err := db.Text2SQLGlossaryCandidates(ctx, now.Add(-time.Hour), 3, 50)
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, c := range cands {
		found[c.Term] = true
	}
	if !found["상담"] {
		t.Errorf("expected 상담 as a glossary candidate, got %+v", cands)
	}
	// A defined term should be excluded.
	_ = db.UpsertText2SQLBusinessTerm(ctx, Text2SQLBusinessTerm{ID: "k", Term: "상담", Mapping: "tickets"})
	cands2, _ := db.Text2SQLGlossaryCandidates(ctx, now.Add(-time.Hour), 3, 50)
	for _, c := range cands2 {
		if c.Term == "상담" {
			t.Error("defined glossary term should be excluded from candidates")
		}
	}
}

func TestText2SQLAnomalyDetectors(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	base := time.Now().UTC().Add(-time.Hour)
	at := func(i int) time.Time { return base.Add(time.Duration(i) * time.Minute) }

	// api key "k1": one benign lookup, then permission-denied probes ×5 → probing smell + intent drift.
	_ = db.InsertText2SQLLog(ctx, Text2SQLQueryLog{ID: "b0", APIKeyID: "k1", Team: "sales", Question: "부서별 매출", Valid: true, CreatedAt: at(0)})
	for i := 0; i < 5; i++ {
		_ = db.InsertText2SQLLog(ctx, Text2SQLQueryLog{ID: "p" + itoaStore(i), APIKeyID: "k1", Team: "sales", Question: "급여 테이블 조회", Valid: false, FailureCategory: "permission_denied", RejectReason: "table not allowed", CreatedAt: at(1 + i)})
	}
	// api key "k2": same question ×8 → excessive_repetition.
	for i := 0; i < 8; i++ {
		_ = db.InsertText2SQLLog(ctx, Text2SQLQueryLog{ID: "r" + itoaStore(i), APIKeyID: "k2", Team: "ops", Question: "오늘 주문 수", Valid: true, CreatedAt: at(20 + i)})
	}
	// api key "k3": a broad-scope request.
	_ = db.InsertText2SQLLog(ctx, Text2SQLQueryLog{ID: "bs", APIKeyID: "k3", Team: "ops", Question: "전체 스키마 모든 테이블 보여줘", Valid: true, CreatedAt: at(40)})

	smells, err := db.Text2SQLUsageSmells(ctx, base.Add(-time.Minute), 8, 5)
	if err != nil {
		t.Fatal(err)
	}
	cats := map[string]bool{}
	for _, sm := range smells {
		cats[sm.Category] = true
	}
	for _, want := range []string{"excessive_repetition", "permission_probing", "broad_scope"} {
		if !cats[want] {
			t.Errorf("expected smell %q, got %+v", want, smells)
		}
	}

	exposure, err := db.Text2SQLRiskExposureByTeam(ctx, base.Add(-time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	var sales *Text2SQLRiskExposure
	for i := range exposure {
		if exposure[i].Team == "sales" {
			sales = &exposure[i]
		}
	}
	if sales == nil || sales.Probes != 5 || sales.Rejected != 5 {
		t.Errorf("sales risk exposure wrong: %+v", sales)
	}

	drifts, err := db.Text2SQLIntentDrifts(ctx, base.Add(-time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	foundK1 := false
	for _, d := range drifts {
		if d.Subject == "k1" {
			foundK1 = true
		}
	}
	if !foundK1 {
		t.Errorf("expected intent drift for k1 (benign → probing), got %+v", drifts)
	}
}

func TestText2SQLFeatureFlags(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	// Unset flag → absent from map (treated as off by callers).
	m, err := db.Text2SQLFeatureFlagMap(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if m["self_challenge"] {
		t.Error("unset flag should not be enabled")
	}
	if err := db.SetText2SQLFeatureFlag(ctx, "self_challenge", true); err != nil {
		t.Fatal(err)
	}
	m, _ = db.Text2SQLFeatureFlagMap(ctx)
	if !m["self_challenge"] {
		t.Error("flag should be enabled after set")
	}
	// Toggle back off.
	if err := db.SetText2SQLFeatureFlag(ctx, "self_challenge", false); err != nil {
		t.Fatal(err)
	}
	m, _ = db.Text2SQLFeatureFlagMap(ctx)
	if m["self_challenge"] {
		t.Error("flag should be disabled after toggle off")
	}
}

func TestRecentText2SQLSQLByAPIKey(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	_ = db.InsertText2SQLLog(ctx, Text2SQLQueryLog{ID: "a1", APIKeyID: "k1", Valid: true, GeneratedSQL: "SELECT * FROM orders", CreatedAt: now})
	_ = db.InsertText2SQLLog(ctx, Text2SQLQueryLog{ID: "a2", APIKeyID: "k1", Valid: false, GeneratedSQL: "bad", CreatedAt: now})              // invalid → excluded
	_ = db.InsertText2SQLLog(ctx, Text2SQLQueryLog{ID: "a3", APIKeyID: "k1", Valid: true, Mode: "shadow", GeneratedSQL: "x", CreatedAt: now}) // shadow → excluded
	_ = db.InsertText2SQLLog(ctx, Text2SQLQueryLog{ID: "a4", APIKeyID: "k2", Valid: true, GeneratedSQL: "SELECT 1", CreatedAt: now})

	sqls, err := db.RecentText2SQLSQLByAPIKey(ctx, "k1", 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(sqls) != 1 || sqls[0] != "SELECT * FROM orders" {
		t.Fatalf("expected one valid non-shadow SQL for k1, got %+v", sqls)
	}
	if got, _ := db.RecentText2SQLSQLByAPIKey(ctx, "", 50); got != nil {
		t.Error("empty api key should return nil")
	}
}

func TestText2SQLPromptDNAAndRiskCount(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	// Same question asked by 2 users, one rejected → repeated + risky labels.
	_ = db.InsertText2SQLLog(ctx, Text2SQLQueryLog{ID: "d1", APIKeyID: "u1", Question: "월별 매출", Valid: true, Executed: true, CostKRW: 10, CreatedAt: now})
	_ = db.InsertText2SQLLog(ctx, Text2SQLQueryLog{ID: "d2", APIKeyID: "u2", Question: "월별 매출", Valid: true, CostKRW: 10, CreatedAt: now})
	_ = db.InsertText2SQLLog(ctx, Text2SQLQueryLog{ID: "d3", APIKeyID: "u1", Question: "월별 매출", Valid: false, RejectReason: "x", CreatedAt: now})

	dna, err := db.Text2SQLPromptDNAReport(ctx, now.Add(-time.Hour), 3, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(dna) != 1 {
		t.Fatalf("expected 1 DNA entry (count>=3), got %d", len(dna))
	}
	d := dna[0]
	if d.Count != 3 || d.DistinctUser != 2 {
		t.Errorf("DNA aggregation wrong: %+v", d)
	}
	hasLabel := func(l string) bool {
		for _, x := range d.Labels {
			if x == l {
				return true
			}
		}
		return false
	}
	if !hasLabel("repeated") || !hasLabel("risky") {
		t.Errorf("expected repeated+risky labels, got %v", d.Labels)
	}

	// Risky count for u1: one rejected (d3) → 1.
	n, err := db.Text2SQLRiskyCountByAPIKey(ctx, "u1", now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("expected 1 risky request for u1, got %d", n)
	}
	if z, _ := db.Text2SQLRiskyCountByAPIKey(ctx, "", now.Add(-time.Hour)); z != 0 {
		t.Error("empty api key should count 0")
	}
}

func TestText2SQLSavedReports(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	if err := db.UpsertText2SQLSavedReport(ctx, Text2SQLSavedReport{ID: "r1", Name: "월별 매출", Question: "월별 매출 추이", SQL: "SELECT 1", Kind: ""}); err != nil {
		t.Fatal(err)
	}
	reports, err := db.ListText2SQLSavedReports(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(reports) != 1 || reports[0].Name != "월별 매출" || reports[0].Kind != "report" {
		t.Fatalf("saved report not stored correctly (kind should default to report): %+v", reports)
	}
	if err := db.DeleteText2SQLSavedReport(ctx, "r1"); err != nil {
		t.Fatal(err)
	}
	reports, _ = db.ListText2SQLSavedReports(ctx)
	if len(reports) != 0 {
		t.Errorf("expected 0 reports after delete, got %d", len(reports))
	}
}

func TestText2SQLReportSchedule(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	_ = db.UpsertText2SQLSavedReport(ctx, Text2SQLSavedReport{ID: "s1", Name: "daily", SQL: "SELECT 1"})
	// Not scheduled yet → not due.
	if due, _ := db.DueText2SQLReports(ctx, time.Now().UTC()); len(due) != 0 {
		t.Fatalf("unscheduled report should not be due, got %d", len(due))
	}
	// Schedule it → due immediately (never run).
	if err := db.SetText2SQLReportSchedule(ctx, "s1", "24h", true, true); err != nil {
		t.Fatal(err)
	}
	due, err := db.DueText2SQLReports(ctx, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if len(due) != 1 || !due[0].DeliverMattermost {
		t.Fatalf("scheduled report should be due with deliver flag: %+v", due)
	}
	// Mark run now → not due again until interval elapses.
	_ = db.MarkText2SQLReportRun(ctx, "s1", time.Now().UTC().Format(time.RFC3339Nano))
	if d2, _ := db.DueText2SQLReports(ctx, time.Now().UTC()); len(d2) != 0 {
		t.Errorf("just-run report should not be due, got %d", len(d2))
	}
	// A long-past run → due again.
	_ = db.MarkText2SQLReportRun(ctx, "s1", time.Now().UTC().Add(-48*time.Hour).Format(time.RFC3339Nano))
	if d3, _ := db.DueText2SQLReports(ctx, time.Now().UTC()); len(d3) != 1 {
		t.Errorf("report past its interval should be due, got %d", len(d3))
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
