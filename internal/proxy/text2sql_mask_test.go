package proxy

import (
	"strings"
	"testing"
)

// Column-level result masking.
//
// A schema can mark a column sensitivity=mask, which means the query may read it but the
// value must not appear in the result. The mask matched the result column name against
// the policy list — and the result column name is whatever the query called it. So
//
//	SELECT email AS customer_email FROM customers
//
// produced a column named customer_email, matched nothing, and returned the address in
// full. Aliasing is not an attack: it is what generated SQL does by default, and almost
// unavoidable across a join. The protection was declared in the policy and reported in
// the audit footer while being absent from the output, which is worse than not having it.
//
// The SQL is now consulted too, so an alias whose expression mentions a masked column is
// masked as well.

func maskCase(t *testing.T, sql string, cols []string, row []string) []string {
	t.Helper()
	rows := [][]string{append([]string{}, row...)}
	maskResultColumns(cols, rows, []string{"email", "phone"}, sql)
	return rows[0]
}

func TestMaskedColumnsSurviveAliasing(t *testing.T) {
	for _, tc := range []struct{ label, sql string }{
		{"plain", "SELECT email FROM customers"},
		{"alias", "SELECT email AS customer_email FROM customers"},
		{"qualified then aliased", "SELECT c.email AS e FROM customers c"},
		{"wrapped in a function", "SELECT lower(email) AS le FROM customers"},
		{"concatenated with another column", "SELECT name || email AS combo FROM customers"},
		{"upper-case AS", "SELECT email AS Contact FROM customers"},
	} {
		// The column name the database would report for each of those.
		names := map[string]string{
			"plain": "email", "alias": "customer_email", "qualified then aliased": "e",
			"wrapped in a function": "le", "concatenated with another column": "combo",
			"upper-case AS": "contact",
		}
		got := maskCase(t, tc.sql, []string{names[tc.label]}, []string{"alice@example.com"})
		if got[0] != "***" {
			t.Errorf("%s: the masked column came back in the clear as %q.\n  %s",
				tc.label, got[0], tc.sql)
		}
	}
}

// Masking everything that shares a query is not the fix either — a column with no policy
// on it must still be readable, or the feature makes results useless.
func TestUnmaskedColumnsAreLeftAlone(t *testing.T) {
	got := maskCase(t, "SELECT name AS n, email AS e FROM customers",
		[]string{"n", "e"}, []string{"bob", "bob@example.com"})
	if got[0] != "bob" {
		t.Errorf("a column with no mask policy was masked: %q", got[0])
	}
	if got[1] != "***" {
		t.Errorf("the masked column beside it was not masked: %q", got[1])
	}
}

// Empty cells stay empty rather than becoming ***, so a masked NULL does not read as a
// value that was there.
func TestMaskingKeepsEmptyCellsEmpty(t *testing.T) {
	got := maskCase(t, "SELECT email AS e FROM customers", []string{"e"}, []string{""})
	if got[0] != "" {
		t.Errorf("an empty cell became %q, which suggests a value was hidden when none existed", got[0])
	}
}

// The alias scan reads the validated SQL, which is bounded, but a pathological string
// should not hang the response either.
func TestAliasScanTerminatesOnLongInput(t *testing.T) {
	sql := "SELECT " + strings.Repeat("a,", 5000) + "email AS e FROM customers"
	got := maskCase(t, sql, []string{"e"}, []string{"alice@example.com"})
	if got[0] != "***" {
		t.Errorf("the masked alias was missed in a long select list: %q", got[0])
	}
}
