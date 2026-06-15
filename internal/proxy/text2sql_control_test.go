package proxy

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
	"vibe-coders/internal/text2sql"
)

func TestApplyPermissionEffect(t *testing.T) {
	allowed := []string{"orders", "salaries", "users"}
	blocked := []string{"ssn", "salary"}
	eff := store.Text2SQLPermissionEffect{
		DeniedTables:   []string{"salaries"},
		DeniedColumns:  []string{"email"},
		AllowedColumns: []string{"salary"}, // grant: remove from blocked
	}
	out := applyPermissionEffect(allowed, &blocked, eff)
	if containsP(out, "salaries") {
		t.Errorf("denied table should be removed: %v", out)
	}
	if !containsP(out, "orders") || !containsP(out, "users") {
		t.Errorf("non-denied tables should remain: %v", out)
	}
	if !containsP(blocked, "email") {
		t.Errorf("denied column should be blocked: %v", blocked)
	}
	if !containsP(blocked, "ssn") {
		t.Errorf("ssn should remain blocked: %v", blocked)
	}
	if containsP(blocked, "salary") {
		t.Errorf("granted column should be unblocked: %v", blocked)
	}

	// schema-wide deny empties the allowlist.
	b2 := []string{}
	out2 := applyPermissionEffect([]string{"a", "b"}, &b2, store.Text2SQLPermissionEffect{DeniedTables: []string{"*"}})
	if len(out2) != 0 {
		t.Errorf("schema-wide deny should clear allowlist, got %v", out2)
	}
}

func TestClassifyText2SQLFailure(t *testing.T) {
	cases := []struct {
		v        text2sql.ValidationResult
		executed bool
		rows     int64
		errMsg   string
		want     string
	}{
		{text2sql.ValidationResult{OK: false, Reason: "table not allowed: x"}, false, 0, "", "permission_denied"},
		{text2sql.ValidationResult{OK: false, Reason: "forbidden keyword: drop"}, false, 0, "", "syntax_error"},
		{text2sql.ValidationResult{OK: false, Reason: "upstream error"}, false, 0, "", "generation_error"},
		{text2sql.ValidationResult{OK: true}, false, 0, "EXPLAIN risk 80/100", "cost_exceeded"},
		{text2sql.ValidationResult{OK: true}, false, 0, "context deadline exceeded", "timeout"},
		{text2sql.ValidationResult{OK: true}, false, 0, `column "foo" does not exist`, "unknown_column"},
		{text2sql.ValidationResult{OK: true}, true, 0, "", "empty_result"},
		{text2sql.ValidationResult{OK: true}, true, 5, "", ""},
	}
	for i, c := range cases {
		if got := classifyText2SQLFailure(c.v, c.executed, c.rows, c.errMsg); got != c.want {
			t.Errorf("case %d: got %q, want %q", i, got, c.want)
		}
	}
}

func TestAuditEvidenceFooter(t *testing.T) {
	// Empty inputs → no footer.
	if got := auditEvidenceFooter("", 0, "", "", 0, nil); got != "" {
		t.Errorf("expected empty footer, got %q", got)
	}
	got := auditEvidenceFooter("analytics", 3, "permabc", "glossxyz", 55, []string{"salary"})
	for _, want := range []string{"analytics", "v3", "permabc", "glossxyz", "55", "salary", "감사 근거"} {
		if !containsP2(got, want) {
			t.Errorf("footer missing %q: %s", want, got)
		}
	}
}

func TestWhereConditions(t *testing.T) {
	// Extracts the WHERE clause up to the next major clause.
	if got := whereConditions("SELECT * FROM t WHERE dept = 'sales' GROUP BY x ORDER BY y LIMIT 10"); got != "dept = 'sales'" {
		t.Errorf("whereConditions = %q", got)
	}
	// No WHERE → empty.
	if got := whereConditions("SELECT count(*) FROM t"); got != "" {
		t.Errorf("expected empty, got %q", got)
	}
	// WHERE with no following clause runs to end.
	if got := whereConditions("SELECT * FROM t WHERE a = 1 AND b = 2"); got != "a = 1 AND b = 2" {
		t.Errorf("whereConditions = %q", got)
	}
}

func TestValidText2SQLSensitivity(t *testing.T) {
	for _, ok := range []string{"normal", "mask", "aggregate_only", "approval_required", "exclude"} {
		if !validText2SQLSensitivity(ok) {
			t.Errorf("%q should be a valid sensitivity", ok)
		}
	}
	for _, bad := range []string{"secret", "hidden", "AGGREGATE_ONLY", ""} {
		if validText2SQLSensitivity(bad) {
			t.Errorf("%q should be rejected", bad)
		}
	}
}

func TestSuggestText2SQLFixes(t *testing.T) {
	hasSubstr := func(list []string, sub string) bool {
		for _, s := range list {
			if containsP2(s, sub) {
				return true
			}
		}
		return false
	}
	// Cost-exceeded → suggests narrowing range and aggregation.
	if s := suggestText2SQLFixes(store.Text2SQLQueryLog{FailureCategory: "cost_exceeded", Valid: true}); !hasSubstr(s, "기간") || !hasSubstr(s, "집계") {
		t.Errorf("cost_exceeded suggestions weak: %v", s)
	}
	// Aggregate-only reject → suggests aggregate usage.
	if s := suggestText2SQLFixes(store.Text2SQLQueryLog{RejectReason: "aggregate-only column used outside an aggregate: salary"}); !hasSubstr(s, "집계 함수") {
		t.Errorf("aggregate-only suggestion missing: %v", s)
	}
	// High EXPLAIN risk → suggests index/range.
	if s := suggestText2SQLFixes(store.Text2SQLQueryLog{Valid: true, ExplainRisk: 85}); !hasSubstr(s, "EXPLAIN") {
		t.Errorf("high-risk suggestion missing: %v", s)
	}
	// A clean valid query with nothing wrong → no false suggestions.
	if s := suggestText2SQLFixes(store.Text2SQLQueryLog{Valid: true}); len(s) != 0 {
		t.Errorf("clean query should yield no suggestions: %v", s)
	}
}

func containsP2(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func TestShouldShadowSample(t *testing.T) {
	if shouldShadowSample("q", 0) {
		t.Error("rate 0 should never sample")
	}
	if !shouldShadowSample("q", 1) {
		t.Error("rate 1 should always sample")
	}
	// Deterministic per question.
	if shouldShadowSample("부서별 매출", 0.5) != shouldShadowSample("부서별 매출", 0.5) {
		t.Error("sampling must be deterministic for the same question")
	}
	// A full-rate is inclusive; a near-zero rate excludes essentially everything.
	if shouldShadowSample("anything", 0.0000001) {
		t.Error("near-zero rate should exclude")
	}
}

func TestResultSetsEqual(t *testing.T) {
	a := [][]string{{"1", "x"}, {"2", "y"}}
	// Same rows, different order → equal (order-insensitive).
	if !resultSetsEqual(a, [][]string{{"2", "y"}, {"1", "x"}}) {
		t.Error("row order should not matter")
	}
	// Different row count → not equal.
	if resultSetsEqual(a, [][]string{{"1", "x"}}) {
		t.Error("differing row counts must not be equal")
	}
	// Same multiset shape but different value → not equal.
	if resultSetsEqual(a, [][]string{{"1", "x"}, {"2", "z"}}) {
		t.Error("differing values must not be equal")
	}
	// Duplicate handling: multiset, not set.
	if resultSetsEqual([][]string{{"1"}, {"1"}}, [][]string{{"1"}, {"2"}}) {
		t.Error("duplicates must be counted as a multiset")
	}
}

func TestChooseUpstreamByQuality(t *testing.T) {
	const base, accurate = "gpt-4.1-mini", "claude-sonnet-4"
	// Below the sample threshold → keep base even with a poor valid rate.
	if got := chooseUpstreamByQuality(base, accurate, store.Text2SQLModelMetric{Total: 5, ValidRate: 0.3}); got != base {
		t.Errorf("insufficient samples should keep base, got %q", got)
	}
	// Enough samples + low valid rate → upgrade to accurate.
	if got := chooseUpstreamByQuality(base, accurate, store.Text2SQLModelMetric{Total: 20, ValidRate: 0.5}); got != accurate {
		t.Errorf("low quality should upgrade to accurate, got %q", got)
	}
	// Enough samples + healthy valid rate → keep base.
	if got := chooseUpstreamByQuality(base, accurate, store.Text2SQLModelMetric{Total: 20, ValidRate: 0.95}); got != base {
		t.Errorf("healthy quality should keep base, got %q", got)
	}
	// No accurate model configured → always base.
	if got := chooseUpstreamByQuality(base, "", store.Text2SQLModelMetric{Total: 20, ValidRate: 0.1}); got != base {
		t.Errorf("missing accurate model should keep base, got %q", got)
	}
}

func TestClickhouseText2SQLFactSink(t *testing.T) {
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(200)
	}))
	defer srv.Close()
	cfg := config.ClickHouseConfig{URL: srv.URL, Database: "dw", Table: "analytics_daily", Text2SQLFactTable: "t2s_fact"}
	logs := []store.Text2SQLQueryLog{
		{ID: "a", RequestID: "r1", Team: "sales", Mode: "preview", Valid: true, CostKRW: 5, Question: "월별 매출", CreatedAt: time.Now().UTC()},
		{ID: "b", RequestID: "r2", Team: "ops", Mode: "execute", Valid: false, FailureCategory: "permission_denied", CreatedAt: time.Now().UTC()},
	}
	n, err := clickhouseText2SQLFactSink(context.Background(), srv.Client(), cfg, logs)
	if err != nil || n != 2 {
		t.Fatalf("fact sink = %d, err=%v", n, err)
	}
	// JSONEachRow → two newline-delimited objects; raw question text must NOT be shipped.
	if lines := strings.Count(strings.TrimSpace(gotBody), "\n"); lines != 1 {
		t.Errorf("expected 2 JSON lines (1 newline), got body: %q", gotBody)
	}
	if strings.Contains(gotBody, "월별 매출") {
		t.Error("fact rows must not contain raw question text (masked)")
	}
	if !strings.Contains(gotBody, "question_chars") {
		t.Error("fact rows should carry question_chars")
	}
	// No fact table configured → no-op.
	if n2, _ := clickhouseText2SQLFactSink(context.Background(), srv.Client(), config.ClickHouseConfig{URL: srv.URL}, logs); n2 != 0 {
		t.Errorf("missing fact table should be a no-op, got %d", n2)
	}
}

func TestClickhouseAggregate(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("100\t1000\t50.5\n"))
	}))
	defer srv.Close()
	req, tok, cost, err := clickhouseAggregate(context.Background(), http.DefaultClient,
		config.ClickHouseConfig{URL: srv.URL, Database: "a", Table: "t"}, "2026-06-01", "all")
	if err != nil {
		t.Fatal(err)
	}
	if req != 100 || tok != 1000 || cost != 50.5 {
		t.Errorf("aggregate = %d/%d/%v, want 100/1000/50.5", req, tok, cost)
	}
}

func TestValidateQuotedIdentifierTable(t *testing.T) {
	// Quoted, schema-qualified table resolves against the allowlist.
	r := text2sql.ValidateSQL(`SELECT * FROM "Sales"."Orders" o`, text2sql.ValidateOptions{AllowedTables: []string{"sales.orders"}})
	if !r.OK {
		t.Errorf("quoted schema-qualified table should pass allowlist: %+v", r)
	}
}

func containsP(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}
