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

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
