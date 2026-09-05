package text2sql

import (
	"strings"
	"testing"
)

// A LIMIT written inside a subquery or a CTE body bounds that body, not the statement.
// Both limit rules used to scan the whole text with no regard for nesting, and a subquery
// is written before the LIMIT that bounds the outer query -- so the nested one answered
// for it: the ceiling was measured against the wrong number, and the default LIMIT was
// withheld from a query that had none of its own.
func TestANestedLimitDoesNotAnswerForTheStatement(t *testing.T) {
	opts := ValidateOptions{DefaultLimit: 100, MaxLimit: 1000}

	overCeiling := ValidateSQL("SELECT * FROM users WHERE id IN (SELECT user_id FROM orders LIMIT 5) LIMIT 999999", opts)
	if overCeiling.OK {
		t.Errorf("an outer LIMIT of 999999 passed a ceiling of 1000 behind a subquery's LIMIT 5")
	}

	cteOverCeiling := ValidateSQL("WITH recent AS (SELECT id FROM orders LIMIT 5) SELECT * FROM recent LIMIT 999999", opts)
	if cteOverCeiling.OK {
		t.Errorf("an outer LIMIT of 999999 passed a ceiling of 1000 behind a CTE body's LIMIT 5")
	}

	unbounded := ValidateSQL("SELECT * FROM users WHERE id IN (SELECT user_id FROM orders LIMIT 5)", opts)
	if !unbounded.OK {
		t.Fatalf("a valid query was refused: %s", unbounded.Reason)
	}
	if !unbounded.LimitAdded || !strings.Contains(unbounded.SQL, "LIMIT 100") {
		t.Errorf("no default LIMIT was added to a statement bounded only inside a subquery: %q", unbounded.SQL)
	}

	cteUnbounded := ValidateSQL("WITH recent AS (SELECT id FROM orders LIMIT 5) SELECT * FROM recent", opts)
	if !cteUnbounded.OK {
		t.Fatalf("a valid CTE query was refused: %s", cteUnbounded.Reason)
	}
	if !cteUnbounded.LimitAdded || !strings.Contains(cteUnbounded.SQL, "LIMIT 100") {
		t.Errorf("no default LIMIT was added to a statement bounded only inside a CTE body: %q", cteUnbounded.SQL)
	}
}

// The statement's own LIMIT still suppresses the default one, whatever else the query
// nests. Adding a second LIMIT to a query that already bounds itself would silently
// override the row count the user asked for.
func TestAStatementLimitStillSuppressesTheDefault(t *testing.T) {
	opts := ValidateOptions{DefaultLimit: 100, MaxLimit: 1000}

	for _, sql := range []string{
		"SELECT id FROM t LIMIT 5",
		"SELECT * FROM users WHERE id IN (SELECT user_id FROM orders LIMIT 5) LIMIT 20",
		"WITH recent AS (SELECT id FROM orders LIMIT 5) SELECT * FROM recent LIMIT 20",
	} {
		got := ValidateSQL(sql, opts)
		if !got.OK {
			t.Fatalf("a valid query was refused: %s (%s)", got.Reason, sql)
		}
		if got.LimitAdded {
			t.Errorf("a default LIMIT was added to a query that bounds itself: %q", got.SQL)
		}
	}
}

// A nested LIMIT above the ceiling is still refused: it is the row count the database is
// asked to materialize, whatever the outer query then keeps.
func TestTheCeilingAppliesToNestedLimitsToo(t *testing.T) {
	got := ValidateSQL("SELECT * FROM (SELECT id FROM orders LIMIT 50000) x LIMIT 10", ValidateOptions{MaxLimit: 1000})
	if got.OK {
		t.Error("a subquery LIMIT of 50000 passed a ceiling of 1000")
	}
}

// LIMIT and its row count may be separated by any whitespace, and generated SQL is
// wrapped. The count used to be read back with fmt.Sscanf("limit %d"), whose literal
// space does not match a newline, so a wrapped LIMIT parsed as 0 and cleared the ceiling.
func TestTheCeilingReadsACountOnTheNextLine(t *testing.T) {
	got := ValidateSQL("SELECT id FROM t\nLIMIT\n999999", ValidateOptions{MaxLimit: 1000})
	if got.OK {
		t.Error("a LIMIT of 999999 written on the line after the keyword passed a ceiling of 1000")
	}
}

// A row count too large to parse cannot be shown to be within the ceiling, so it is
// refused rather than read as zero.
func TestACountTooLargeToParseIsRefused(t *testing.T) {
	got := ValidateSQL("SELECT id FROM t LIMIT 99999999999999999999", ValidateOptions{MaxLimit: 1000})
	if got.OK {
		t.Error("a LIMIT that overflows an int passed a ceiling of 1000")
	}
	if !strings.Contains(got.Reason, "99999999999999999999") {
		t.Errorf("the rejection does not report the offending count: %q", got.Reason)
	}
}
