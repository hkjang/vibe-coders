package text2sql

import (
	"fmt"
	"strings"
	"testing"
)

// A blocked column is not named by `SELECT *`, so the per-column check never sees it: the
// wildcard guard is the only thing between it and the caller.
//
// Every test that exercised that guard configured both a blocked list and an
// aggregate-only list. A schema with just one of them — the ordinary case of "these two
// columns are sensitive" — was never tried, and the guard could be narrowed to require
// both without a test failing.
func TestWildcardIsRefusedUnderAnyColumnPolicy(t *testing.T) {
	policies := []struct {
		name string
		opts ValidateOptions
	}{
		{"blocked columns only", ValidateOptions{DefaultLimit: 100, BlockedColumns: []string{"ssn"}}},
		{"aggregate-only columns only", ValidateOptions{DefaultLimit: 100, AggregateOnlyColumns: []string{"salary"}}},
		{"both", ValidateOptions{DefaultLimit: 100,
			BlockedColumns: []string{"ssn"}, AggregateOnlyColumns: []string{"salary"}}},
	}
	queries := []string{
		"SELECT * FROM employees",
		"SELECT e.* FROM employees e",
		"select  *  from employees",
	}
	for _, p := range policies {
		for _, q := range queries {
			t.Run(fmt.Sprintf("%s/%s", p.name, q), func(t *testing.T) {
				got := ValidateSQL(q, p.opts)
				if got.OK {
					t.Fatalf("%q was allowed under a column policy; a blocked column comes back "+
						"in the result without ever being named", q)
				}
			})
		}
	}

	// With no column policy at all there is nothing to protect, and refusing here would
	// make the assertions above pass for a validator that refuses every wildcard.
	if got := ValidateSQL("SELECT * FROM employees", ValidateOptions{DefaultLimit: 100}); !got.OK {
		t.Fatalf("select * was refused with no column policy configured: %s", got.Reason)
	}
}

// The LIMIT ceiling is a maximum, so a query asking for exactly it is within bounds and one
// asking for a single row more is not. Reading the boundary the other way quietly reduces
// every operator's configured ceiling by one row.
func TestTheLimitCeilingIsAMaximum(t *testing.T) {
	opts := ValidateOptions{MaxLimit: 1000}

	if got := ValidateSQL("SELECT id FROM t LIMIT 1000", opts); !got.OK {
		t.Errorf("LIMIT 1000 was refused against a maximum of 1000: %s", got.Reason)
	}
	if got := ValidateSQL("SELECT id FROM t LIMIT 1001", opts); got.OK {
		t.Error("LIMIT 1001 was allowed against a maximum of 1000")
	}
	if got := ValidateSQL("SELECT id FROM t LIMIT 1", opts); !got.OK {
		t.Errorf("LIMIT 1 was refused against a maximum of 1000: %s", got.Reason)
	}

	// No ceiling configured means no ceiling, not a ceiling of zero.
	if got := ValidateSQL("SELECT id FROM t LIMIT 999999", ValidateOptions{}); !got.OK {
		t.Errorf("a large LIMIT was refused with no maximum configured: %s", got.Reason)
	}
}

// A default LIMIT is appended only when the query has none, and only when one is
// configured. Appending "LIMIT 0" because none was set would turn every answer empty.
func TestTheDefaultLimitIsOnlyAddedWhenItIsConfiguredAndMissing(t *testing.T) {
	added := ValidateSQL("SELECT id FROM t", ValidateOptions{DefaultLimit: 100})
	if !added.OK || !added.LimitAdded {
		t.Fatalf("no default LIMIT was added to a query without one: %+v", added)
	}
	if !strings.Contains(added.SQL, "LIMIT 100") {
		t.Errorf("the added limit is not the configured one: %q", added.SQL)
	}

	kept := ValidateSQL("SELECT id FROM t LIMIT 5", ValidateOptions{DefaultLimit: 100})
	if !kept.OK || kept.LimitAdded {
		t.Fatalf("a default LIMIT was added to a query that had one: %+v", kept)
	}

	none := ValidateSQL("SELECT id FROM t", ValidateOptions{})
	if !none.OK || none.LimitAdded {
		t.Fatalf("a LIMIT was added with none configured: %+v", none)
	}
	if strings.Contains(strings.ToUpper(none.SQL), "LIMIT") {
		t.Errorf("a LIMIT appeared with none configured: %q", none.SQL)
	}
}

// How a table allowlist matches a schema-qualified name, written down because it is a
// decision rather than an accident.
//
// A qualified name matches on its bare form too, which is what lets an allowlist written as
// "orders" accept "public.orders". The other side of that is the case at the end: a bare
// entry accepts the table in any schema the connection can reach. That is fine for the
// single-schema setup this is normally used in, and worth knowing about before pointing it
// at a connection that can see more than one.
func TestHowTheTableAllowlistMatchesQualifiedNames(t *testing.T) {
	cases := []struct {
		name    string
		allowed []string
		sql     string
		wantOK  bool
	}{
		{"bare entry, bare reference", []string{"orders"}, "SELECT id FROM orders", true},
		{"bare entry, qualified reference", []string{"orders"}, "SELECT id FROM public.orders", true},
		{"qualified entry, qualified reference", []string{"public.orders"}, "SELECT id FROM public.orders", true},
		{"qualified entry, other schema", []string{"public.orders"}, "SELECT id FROM secret.orders", false},
		{"a table nobody allowed", []string{"orders"}, "SELECT id FROM payroll", false},
		// The consequence of matching on the bare form.
		{"bare entry reaches another schema", []string{"orders"}, "SELECT id FROM secret.orders", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ValidateSQL(tc.sql, ValidateOptions{DefaultLimit: 100, AllowedTables: tc.allowed})
			if got.OK != tc.wantOK {
				t.Fatalf("allowed=%v want %v (%s)", got.OK, tc.wantOK, got.Reason)
			}
		})
	}
}

// A CTE body is checked against the allowlist by its own copy of the rule, because a WITH
// clause is where a disallowed table hides: the outer query only names the CTE. That copy
// has to match qualified names the same way the outer check does, or the two disagree about
// what the same allowlist means depending on where the table is written.
func TestCTEBodiesAreCheckedAgainstTheAllowlistTheSameWay(t *testing.T) {
	cases := []struct {
		name    string
		allowed []string
		sql     string
		wantOK  bool
	}{
		{"a CTE reading an allowed table",
			[]string{"orders"}, "WITH x AS (SELECT id FROM orders) SELECT id FROM x", true},
		{"a CTE reading a table nobody allowed",
			[]string{"orders"}, "WITH x AS (SELECT id FROM payroll) SELECT id FROM x", false},
		{"a CTE reading a qualified form of an allowed table",
			[]string{"orders"}, "WITH x AS (SELECT id FROM public.orders) SELECT id FROM x", true},
		{"a CTE reading another schema when the entry is qualified",
			[]string{"public.orders"}, "WITH x AS (SELECT id FROM secret.orders) SELECT id FROM x", false},
		{"a later CTE may read an earlier one",
			[]string{"orders"},
			"WITH a AS (SELECT id FROM orders), b AS (SELECT id FROM a) SELECT id FROM b", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ValidateSQL(tc.sql, ValidateOptions{DefaultLimit: 100, AllowedTables: tc.allowed})
			if got.OK != tc.wantOK {
				t.Fatalf("allowed=%v want %v (%s)", got.OK, tc.wantOK, got.Reason)
			}
		})
	}
}

// The other half of every guard above: a validator that refuses everything satisfies all of
// them and is useless. These are the queries a column policy is meant to leave alone.
//
// They also cover the direction the refusal tests cannot. A guard made too strict still
// refuses what it should, so only a case that expects a query through will notice.
func TestOrdinaryQueriesStillPassUnderAColumnPolicy(t *testing.T) {
	opts := ValidateOptions{
		DefaultLimit:         100,
		BlockedColumns:       []string{"ssn"},
		AggregateOnlyColumns: []string{"salary"},
	}
	for _, sql := range []string{
		"SELECT name, department FROM employees",
		"SELECT department, count(*) FROM employees GROUP BY department",
		"SELECT department, avg(salary) FROM employees GROUP BY department",
		"SELECT e.name FROM employees e",
		"SELECT e.name, d.title FROM employees e JOIN departments d ON d.id = e.department_id",
		"WITH recent AS (SELECT name, department FROM employees) SELECT name FROM recent",
		"WITH recent AS (SELECT name FROM employees) SELECT r.name FROM recent r",
	} {
		t.Run(sql, func(t *testing.T) {
			if got := ValidateSQL(sql, opts); !got.OK {
				t.Fatalf("an ordinary query was refused under a column policy: %s", got.Reason)
			}
		})
	}
}
