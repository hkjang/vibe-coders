package proxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

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

func TestClickhouseAggregate(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("100\t1000\t50.5\n"))
	}))
	defer srv.Close()
	req, tok, cost, err := clickhouseAggregate(context.Background(), http.DefaultClient,
		config.ClickHouseConfig{URL: srv.URL, Database: "a", Table: "t"}, "2026-06-01")
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
