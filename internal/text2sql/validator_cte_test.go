package text2sql

import "testing"

// Common table expressions and the table allowlist.
//
// The product advertises both — generated SQL may be a SELECT or a CTE, and the tables it
// touches can be restricted — but together they did not work. The allowlist treated the
// CTE's own name as a table, so any query using WITH was refused with "table not allowed:
// recent", naming something the user never wrote. An LLM writes a CTE for anything
// non-trivial, so with an allowlist configured that was most non-trivial questions.
//
// Fixing it needs scope rather than a name exemption, and the difference is not academic.
// The first attempt exempted the name everywhere, which let this through:
//
//	WITH secrets AS (SELECT * FROM secrets) SELECT * FROM secrets
//
// One name covering both the CTE and the real table read inside its own body — an
// allowlist bypass introduced while fixing an over-block. A CTE is only visible to what
// follows its definition, so each body is checked against the CTEs declared before it,
// and only the outer query sees them all.

func cteTestOptions() ValidateOptions {
	return ValidateOptions{
		DefaultLimit: 100, MaxLimit: 1000,
		AllowedTables:        []string{"orders", "customers"},
		BlockedColumns:       []string{"ssn"},
		AggregateOnlyColumns: []string{"salary"},
	}
}

func TestCTEsWorkWithATableAllowlist(t *testing.T) {
	for _, tc := range []struct{ label, sql string }{
		{"single", "WITH recent AS (SELECT id FROM orders) SELECT * FROM recent"},
		{"two", "WITH a AS (SELECT id FROM orders), b AS (SELECT id FROM customers) SELECT * FROM a JOIN b ON a.id = b.id"},
		{"recursive", "WITH RECURSIVE t AS (SELECT id FROM orders) SELECT * FROM t"},
		{"column list", "WITH x (a) AS (SELECT id FROM orders) SELECT * FROM x"},
		{"later cte reads earlier one", "WITH a AS (SELECT id FROM orders), b AS (SELECT id FROM a) SELECT * FROM b"},
	} {
		res := ValidateSQL(tc.sql, cteTestOptions())
		if !res.OK {
			t.Errorf("%s: a CTE over allowed tables was refused (%q). Every table it reads is "+
				"on the allowlist; the CTE name is not a table.", tc.label, res.Reason)
		}
	}
}

// The allowlist still has to hold. These are the ways a CTE could be used to get around
// it, including naming the CTE after the table it is trying to reach.
func TestCTEsCannotEvadeTheAllowlist(t *testing.T) {
	for _, tc := range []struct{ label, sql string }{
		{"shadowing name", "WITH secrets AS (SELECT * FROM secrets) SELECT * FROM secrets"},
		{"body reads forbidden", "WITH x AS (SELECT * FROM secrets) SELECT * FROM x"},
		{"second body forbidden", "WITH a AS (SELECT id FROM orders), b AS (SELECT * FROM secrets) SELECT * FROM a JOIN b ON 1=1"},
		{"recursive body forbidden", "WITH RECURSIVE t AS (SELECT * FROM secrets) SELECT * FROM t"},
		{"column list body forbidden", "WITH x (a) AS (SELECT id FROM secrets) SELECT * FROM x"},
		{"forward reference", "WITH a AS (SELECT id FROM b), b AS (SELECT id FROM orders) SELECT * FROM a"},
	} {
		if res := ValidateSQL(tc.sql, cteTestOptions()); res.OK {
			t.Errorf("%s: reached a table outside the allowlist through a CTE:\n  %s", tc.label, tc.sql)
		}
	}
}

// The other guards must still see through a CTE.
func TestCTEsDoNotHideBlockedColumns(t *testing.T) {
	if res := ValidateSQL("WITH x AS (SELECT ssn FROM customers) SELECT * FROM x", cteTestOptions()); res.OK {
		t.Error("a blocked column was reachable by putting it inside a CTE")
	}
	if res := ValidateSQL("WITH x AS (SELECT salary AS s FROM customers) SELECT * FROM x", cteTestOptions()); res.OK {
		t.Error("an aggregate-only column was used raw inside a CTE")
	}
}
