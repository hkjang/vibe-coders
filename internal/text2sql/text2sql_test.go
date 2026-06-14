package text2sql

import "testing"

func TestValidateSQL(t *testing.T) {
	opts := ValidateOptions{DefaultLimit: 100, MaxLimit: 1000}
	cases := []struct {
		name   string
		sql    string
		wantOK bool
	}{
		{"simple select", "SELECT * FROM users", true},
		{"aggregate with limit", "SELECT count(*) FROM orders LIMIT 5", true},
		{"cte select", "WITH c AS (SELECT id FROM t) SELECT * FROM c", true},
		{"drop", "DROP TABLE users", false},
		{"update", "UPDATE users SET x = 1", false},
		{"insert", "INSERT INTO users VALUES (1)", false},
		{"delete", "DELETE FROM users", false},
		{"stacked", "SELECT 1; DROP TABLE users", false},
		{"two selects", "SELECT 1; SELECT 2", false},
		{"select into", "SELECT * INTO backup FROM users", false},
		{"pg_sleep", "SELECT pg_sleep(10)", false},
		{"dblink", "SELECT * FROM dblink('...', 'select 1')", false},
		{"not a select", "EXPLAIN SELECT 1", false},
		{"empty", "   ", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ValidateSQL(c.sql, opts)
			if got.OK != c.wantOK {
				t.Fatalf("ValidateSQL(%q).OK = %v, want %v (reason: %s)", c.sql, got.OK, c.wantOK, got.Reason)
			}
		})
	}
}

func TestValidateSQLLimitInjection(t *testing.T) {
	r := ValidateSQL("SELECT * FROM users", ValidateOptions{DefaultLimit: 50})
	if !r.OK || !r.LimitAdded {
		t.Fatalf("expected limit injected: %+v", r)
	}
	if want := "LIMIT 50"; !contains(r.SQL, want) {
		t.Errorf("SQL should contain %q, got %q", want, r.SQL)
	}
	// Existing LIMIT is not doubled.
	r2 := ValidateSQL("SELECT * FROM users LIMIT 10", ValidateOptions{DefaultLimit: 50})
	if r2.LimitAdded {
		t.Errorf("should not add a second LIMIT: %q", r2.SQL)
	}
}

func TestValidateSQLMaxLimit(t *testing.T) {
	r := ValidateSQL("SELECT * FROM t LIMIT 99999", ValidateOptions{MaxLimit: 1000})
	if r.OK {
		t.Errorf("LIMIT above MaxLimit should be rejected: %+v", r)
	}
}

func TestValidateSQLAllowedTables(t *testing.T) {
	r := ValidateSQL("SELECT * FROM secret_table", ValidateOptions{AllowedTables: []string{"orders", "users"}})
	if r.OK {
		t.Errorf("disallowed table should be rejected: %+v", r)
	}
	r2 := ValidateSQL("SELECT * FROM users u JOIN orders o ON o.uid = u.id", ValidateOptions{AllowedTables: []string{"orders", "users"}})
	if !r2.OK {
		t.Errorf("allowed tables should pass: %+v", r2)
	}
}

func TestValidateSQLStringLiteralScrubbing(t *testing.T) {
	opts := ValidateOptions{DefaultLimit: 100}
	// Forbidden keywords inside a string literal must NOT trigger rejection.
	if r := ValidateSQL("SELECT name FROM users WHERE note = 'please drop the table'", opts); !r.OK {
		t.Errorf("keyword inside a string literal should not be rejected: %+v", r)
	}
	// A semicolon inside a string is not a second statement.
	if r := ValidateSQL("SELECT name FROM users WHERE sep = ';'", opts); !r.OK {
		t.Errorf("semicolon inside a string should not count as multi-statement: %+v", r)
	}
	// A real second statement is still caught.
	if r := ValidateSQL("SELECT 1 FROM users; DROP TABLE users", opts); r.OK {
		t.Error("a real stacked statement must still be rejected")
	}
	// Doubled-quote escape handled.
	if r := ValidateSQL("SELECT id FROM t WHERE name = 'O''Brien drop'", opts); !r.OK {
		t.Errorf("doubled-quote escaped literal should be handled: %+v", r)
	}
}

func TestValidateSQLStructural(t *testing.T) {
	opts := ValidateOptions{DefaultLimit: 100}
	// Truncated subquery (unclosed paren) → rejected.
	if r := ValidateSQL("SELECT * FROM t WHERE id IN (SELECT id FROM u", opts); r.OK {
		t.Errorf("unbalanced parentheses should be rejected: %+v", r)
	}
	// Extra closing paren → rejected.
	if r := ValidateSQL("SELECT count(*)) FROM t", opts); r.OK {
		t.Errorf("extra ')' should be rejected: %+v", r)
	}
	// Unterminated quoted identifier → rejected.
	if r := ValidateSQL(`SELECT "col FROM t`, opts); r.OK {
		t.Errorf("unterminated quoted identifier should be rejected: %+v", r)
	}
	// Well-formed nested query → passes.
	if r := ValidateSQL("SELECT * FROM t WHERE id IN (SELECT id FROM u)", opts); !r.OK {
		t.Errorf("balanced nested query should pass: %+v", r)
	}
	// A ')' inside a string literal must not trip the balance check.
	if r := ValidateSQL("SELECT name FROM t WHERE note = 'a) b ('", opts); !r.OK {
		t.Errorf("parens inside a string literal should be ignored: %+v", r)
	}
}

func TestValidateSQLAggregateOnly(t *testing.T) {
	opts := ValidateOptions{DefaultLimit: 100, AggregateOnlyColumns: []string{"salary"}}
	// Raw select of an aggregate-only column → rejected.
	if r := ValidateSQL("SELECT dept, salary FROM employees", opts); r.OK {
		t.Errorf("raw aggregate-only column should be rejected: %+v", r)
	}
	// Inside an aggregate → allowed.
	if r := ValidateSQL("SELECT dept, avg(salary) FROM employees GROUP BY dept", opts); !r.OK {
		t.Errorf("aggregate use should pass: %+v", r)
	}
	// Nested inside an aggregate (balanced-paren body) → allowed.
	if r := ValidateSQL("SELECT dept, sum(coalesce(salary,0)) FROM employees GROUP BY dept", opts); !r.OK {
		t.Errorf("aggregate-only column nested in an aggregate should pass: %+v", r)
	}
	// Aggregate-only column in a window PARTITION BY (raw, not aggregated) → rejected.
	if r := ValidateSQL("SELECT dept, sum(amount) OVER (PARTITION BY salary) FROM employees", opts); r.OK {
		t.Errorf("aggregate-only column in OVER(PARTITION BY ...) should be rejected: %+v", r)
	}
}

func TestNeedsClarification(t *testing.T) {
	if need, _ := NeedsClarification("부서별 매출", false); need {
		t.Error("a reasonable question without date requirement should not need clarification")
	}
	if need, missing := NeedsClarification("부서별 매출", true); !need || len(missing) == 0 {
		t.Errorf("date required but missing → should clarify: %v", missing)
	}
	if need, _ := NeedsClarification("지난달 부서별 매출", true); need {
		t.Error("question with a time qualifier should pass the date requirement")
	}
	if need, _ := NeedsClarification("?", false); !need {
		t.Error("a too-short question should need clarification")
	}
}

func TestWithGlossary(t *testing.T) {
	msgs := []Message{{Role: "system", Content: "schema"}, {Role: "user", Content: "상담 건수"}}
	out := WithGlossary(msgs, "상담 → tickets 테이블")
	if len(out) != 3 || !contains(out[1].Content, "tickets") {
		t.Errorf("glossary should be injected after the first system message: %+v", out)
	}
}

func TestValidateSQLBlockedColumns(t *testing.T) {
	opts := ValidateOptions{DefaultLimit: 100, BlockedColumns: []string{"ssn", "salary"}}
	if r := ValidateSQL("SELECT name, salary FROM employees", opts); r.OK {
		t.Errorf("query referencing a blocked column should be rejected: %+v", r)
	}
	if r := ValidateSQL("SELECT name, dept FROM employees", opts); !r.OK {
		t.Errorf("query without blocked columns should pass: %+v", r)
	}
}

func TestExtractSQL(t *testing.T) {
	cases := map[string]string{
		"```sql\nSELECT 1\n```":         "SELECT 1",
		"prose\n```\nSELECT 2\n```more": "SELECT 2",
		`{"sql": "SELECT 3"}`:           "SELECT 3",
		"SELECT 4":                      "SELECT 4",
	}
	for in, want := range cases {
		if got := ExtractSQL(in); got != want {
			t.Errorf("ExtractSQL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestResolveProfile(t *testing.T) {
	m := Models{Preview: "gpt-4.1-mini", Execute: "gpt-4.1", Accurate: "claude-sonnet-4", Local: "qwen-coder", Summary: "gpt-4.1-mini"}
	if p := ResolveProfile("vibe/text2sql-preview", m); p.Mode != ModePreview || p.UpstreamModel != "gpt-4.1-mini" {
		t.Errorf("preview profile = %+v", p)
	}
	if p := ResolveProfile("vibe/text2sql-execute", m); p.Mode != ModeExecute || p.UpstreamModel != "gpt-4.1" {
		t.Errorf("execute profile = %+v", p)
	}
	if p := ResolveProfile("vibe/text2sql-accurate", m); p.UpstreamModel != "claude-sonnet-4" {
		t.Errorf("accurate profile = %+v", p)
	}
	if p := ResolveProfile("vibe/text2sql-auto", m); !p.Auto {
		t.Errorf("auto profile should set Auto: %+v", p)
	}
	if p := ResolveProfile("vibe/text2sql-unknown", m); p.Mode != ModePreview || p.UpstreamModel != "gpt-4.1-mini" {
		t.Errorf("unknown variant should fall back to preview: %+v", p)
	}
}

func TestIsModelAndQuestion(t *testing.T) {
	if !IsModel("vibe/text2sql-preview") || IsModel("gpt-4.1-mini") {
		t.Error("IsModel detection wrong")
	}
	body := []byte(`{"model":"vibe/text2sql-preview","messages":[{"role":"system","content":"x"},{"role":"user","content":"부서별 건수"}]}`)
	if q := LastUserQuestion(body); q != "부서별 건수" {
		t.Errorf("LastUserQuestion = %q", q)
	}
}

func TestSelectExamples(t *testing.T) {
	all := []Example{
		{Question: "부서별 ITSM 요청 건수", SQL: "SELECT ..."},
		{Question: "월별 매출 합계", SQL: "SELECT ..."},
		{Question: "부서별 평균 처리 시간", SQL: "SELECT ..."},
	}
	got := SelectExamples(all, "지난달 부서별 ITSM 요청 건수를 알려줘", 2)
	if len(got) == 0 {
		t.Fatal("expected at least one relevant example")
	}
	// The exact-overlap example should rank first.
	if got[0].Question != "부서별 ITSM 요청 건수" {
		t.Errorf("most relevant example should rank first, got %q", got[0].Question)
	}
	// Unrelated question → no examples.
	if ex := SelectExamples(all, "xyzzy foobar", 2); len(ex) != 0 {
		t.Errorf("expected no examples for unrelated question, got %d", len(ex))
	}
}

func TestWithExamples(t *testing.T) {
	msgs := []Message{{Role: "system", Content: "sys"}, {Role: "user", Content: "q"}}
	out := WithExamples(msgs, []Example{{Question: "x", SQL: "SELECT 1"}})
	if len(out) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(out))
	}
	// examples injected just before the final user message
	if out[len(out)-1].Role != "user" {
		t.Error("user message should remain last")
	}
	if !contains(out[1].Content, "SELECT 1") {
		t.Errorf("example SQL should be injected: %q", out[1].Content)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
