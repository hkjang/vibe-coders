package text2sql

import "testing"

// Wildcard projections and column policies.
//
// Every column check in this validator works by looking for the column's name, and
// "SELECT *" never names anything. A column marked exclude or approval_required came back
// in full, and an aggregate-only column arrived raw — five wildcard shapes, including one
// hidden in a subquery and one behind a CTE. Nothing downstream removed them either: the
// result masking covers sensitivity=mask, which is a different policy.
//
// The validator has no schema, so it cannot know what * expands to. When column policies
// exist the only safe answer is to require the columns be named, which is what the model
// does once the refusal tells it to — the schema context it was given already lists the
// readable columns.

func wildcardOptions() ValidateOptions {
	return ValidateOptions{
		DefaultLimit: 100, MaxLimit: 1000,
		AllowedTables:        []string{"customers", "orders"},
		BlockedColumns:       []string{"ssn"},
		AggregateOnlyColumns: []string{"salary"},
	}
}

func TestWildcardCannotBypassColumnPolicies(t *testing.T) {
	for _, tc := range []struct{ label, sql string }{
		{"plain", "SELECT * FROM customers"},
		{"qualified", "SELECT c.* FROM customers c"},
		{"alongside named columns", "SELECT id, * FROM customers"},
		{"inside a subquery", "SELECT id FROM (SELECT * FROM customers) t"},
		{"behind a CTE", "WITH x AS (SELECT * FROM customers) SELECT * FROM x"},
		{"quoted qualifier", `SELECT "c".* FROM customers c`},
	} {
		if res := ValidateSQL(tc.sql, wildcardOptions()); res.OK {
			t.Errorf("%s: a wildcard returned every column while a policy restricts some:\n  %s",
				tc.label, tc.sql)
		}
	}
}

// COUNT(*) returns no column values, so it must keep working — refusing it would break
// the most common question there is.
func TestCountStarIsStillAllowed(t *testing.T) {
	for _, sql := range []string{
		"SELECT COUNT(*) FROM customers",
		"SELECT COUNT(*) AS n FROM orders",
		"SELECT count(*) FROM customers WHERE id > 1",
	} {
		if res := ValidateSQL(sql, wildcardOptions()); !res.OK {
			t.Errorf("COUNT(*) was refused (%q): %s", res.Reason, sql)
		}
	}
}

// Multiplication is not a projection. A star with an operand in front of it is arithmetic.
func TestMultiplicationIsNotMistakenForAWildcard(t *testing.T) {
	for _, sql := range []string{
		"SELECT price * qty AS total FROM orders",
		"SELECT id, price * 2 FROM orders",
		"SELECT SUM(price * qty) FROM orders",
	} {
		if res := ValidateSQL(sql, wildcardOptions()); !res.OK {
			t.Errorf("an arithmetic expression was read as a wildcard (%q): %s", res.Reason, sql)
		}
	}
}

// Deployments with no column policy keep SELECT * — there is nothing there to protect,
// and refusing it would be a gratuitous restriction.
func TestWildcardStillWorksWithoutColumnPolicies(t *testing.T) {
	opts := ValidateOptions{DefaultLimit: 100, MaxLimit: 1000, AllowedTables: []string{"customers"}}
	if res := ValidateSQL("SELECT * FROM customers", opts); !res.OK {
		t.Errorf("SELECT * was refused with no column policy configured: %q", res.Reason)
	}
}

// A star over a CTE is fine: the CTE exposes only what its own body selected, and that
// body went through the same checks. Refusing it would reinstate the over-block that made
// allowlists and CTEs unusable together.
func TestWildcardOverACTEIsAllowed(t *testing.T) {
	for _, tc := range []struct{ label, sql string }{
		{"single", "WITH recent AS (SELECT id FROM orders) SELECT * FROM recent"},
		{"two", "WITH a AS (SELECT id FROM orders), b AS (SELECT id FROM customers) SELECT * FROM a JOIN b ON a.id = b.id"},
		{"qualified star over a cte", "WITH a AS (SELECT id FROM orders) SELECT a.* FROM a"},
	} {
		if res := ValidateSQL(tc.sql, wildcardOptions()); !res.OK {
			t.Errorf("%s: a star over a CTE was refused (%q). The CTE body was already "+
				"checked, so its columns carry no unchecked policy.\n  %s", tc.label, res.Reason, tc.sql)
		}
	}
}

// But a star that also covers a real table is still a wildcard over that table.
func TestWildcardMixingACTEWithARealTableIsRefused(t *testing.T) {
	for _, tc := range []struct{ label, sql string }{
		{"star inside the CTE body", "WITH a AS (SELECT * FROM customers) SELECT * FROM a"},
		{"outer star spans a join to a real table",
			"WITH a AS (SELECT id FROM orders) SELECT * FROM a JOIN customers c ON a.id = c.id"},
	} {
		if res := ValidateSQL(tc.sql, wildcardOptions()); res.OK {
			t.Errorf("%s: a wildcard reached a real table's columns:\n  %s", tc.label, tc.sql)
		}
	}
}
