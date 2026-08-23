package text2sql

import "testing"

// Constructs that reach data without naming it.
//
// Every check in this validator works by looking for a name — the table after FROM, the
// column in the select list. Two releases running, the finding was a piece of ordinary
// SQL that reaches the same data without writing that name, so this file collects the
// class rather than the instance.
//
// Two more were found the same way. A FROM clause is a comma-separated list and only the
// first entry was read, so "FROM orders o, secrets s" reported one table and the allowlist
// never heard about the other. And PostgreSQL lets a query name the row itself:
// "SELECT c FROM customers c" returns every column as a composite, to_jsonb(c) turns it
// into readable JSON, and neither writes a column name at all.

func namelessOptions() ValidateOptions {
	return ValidateOptions{
		DefaultLimit: 100, MaxLimit: 1000,
		AllowedTables:        []string{"customers", "orders"},
		BlockedColumns:       []string{"ssn"},
		AggregateOnlyColumns: []string{"salary"},
	}
}

// A FROM clause lists more than one table, and each of them counts.
func TestEveryTableInAFromListIsChecked(t *testing.T) {
	for _, tc := range []struct{ label, sql string }{
		{"comma join", "SELECT o.id FROM orders o, secrets s"},
		{"three tables", "SELECT a.id FROM orders a, customers b, secrets c"},
		{"cross join", "SELECT o.id FROM orders o CROSS JOIN secrets s"},
		{"lateral subquery", "SELECT x.id FROM orders o, LATERAL (SELECT id FROM secrets) x"},
	} {
		if res := ValidateSQL(tc.sql, namelessOptions()); res.OK {
			t.Errorf("%s: a table outside the allowlist was read:\n  %s", tc.label, tc.sql)
		}
	}
}

// A row reference returns every column, including the ones a policy hides, without
// naming any of them.
func TestWholeRowReferencesAreRefused(t *testing.T) {
	for _, tc := range []struct{ label, sql string }{
		{"bare alias", "SELECT c FROM customers c"},
		{"row constructor", "SELECT ROW(c.*) FROM customers c"},
		{"to_jsonb", "SELECT to_jsonb(c) FROM customers c"},
		{"aliased with AS", "SELECT c FROM customers AS c"},
	} {
		if res := ValidateSQL(tc.sql, namelessOptions()); res.OK {
			t.Errorf("%s: every column came back without one being named:\n  %s", tc.label, tc.sql)
		}
	}
}

// The rules above are aggressive, so what they must not break is worth as much space.
// An alias is normal SQL and appears in almost every generated query.
func TestOrdinaryQueriesAreNotCaughtByTheAliasRules(t *testing.T) {
	for _, sql := range []string{
		"SELECT id FROM orders",
		"SELECT o.id FROM orders o",
		"SELECT o.id, c.name FROM orders o JOIN customers c ON o.id = c.id",
		"SELECT o.id FROM orders AS o WHERE o.id > 10",
		"SELECT COUNT(*) FROM orders o",
		"SELECT SUM(salary) FROM customers c",
		"SELECT c.name FROM customers c ORDER BY c.name LIMIT 10",
		"SELECT o.id FROM orders o WHERE o.id IN (SELECT c.id FROM customers c)",
		"SELECT o.id FROM orders o LEFT JOIN customers c ON o.id = c.id",
		"SELECT name FROM customers WHERE name LIKE 'a%'",
		"WITH a AS (SELECT id FROM orders o) SELECT a.id FROM a",
		"WITH recent AS (SELECT id FROM orders) SELECT * FROM recent",
		"WITH recent AS (SELECT id FROM orders) SELECT r.* FROM recent r",
	} {
		if res := ValidateSQL(sql, namelessOptions()); !res.OK {
			t.Errorf("a legitimate query was refused (%q):\n  %s", res.Reason, sql)
		}
	}
}

// With no column policy there is nothing for these rules to protect, so they must not
// fire at all.
func TestNamelessRulesOnlyApplyWithColumnPolicies(t *testing.T) {
	opts := ValidateOptions{DefaultLimit: 100, AllowedTables: []string{"customers"}}
	for _, sql := range []string{
		"SELECT c FROM customers c",
		"SELECT c.* FROM customers c",
		"SELECT * FROM customers",
	} {
		if res := ValidateSQL(sql, opts); !res.OK {
			t.Errorf("refused with no column policy configured (%q): %s", res.Reason, sql)
		}
	}
}
