package store

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// Index coverage.
//
// Drift asks whether the database matches the declared schema. This asks the question
// before that one: is the declared schema right? An index nobody declared is not drift —
// it is a gap, and gaps of this kind are invisible until a table is big enough for the
// scan to hurt, which is exactly when it is most expensive to fix.
//
// The check reads the store's own SQL and works out which columns it filters and sorts
// on, then asks whether each has an index to start from. That is evidence rather than
// suspicion: no hand-written list of "columns that look important", just the queries that
// are actually there.
//
// Scope is deliberately narrow. A scan of a twelve-row settings table costs nothing, so
// demanding an index for it would be noise that trains people to add exemptions without
// reading them. The tables that matter are the ones that grow without bound, and the
// codebase already classifies those: retentionDecisions lists every table that is purged
// with its request or swept by its own expiry, which is the same set. Reusing it means
// there is no second list of "big tables" to keep in step.
//
// What this found on its first run: of the eleven request-scoped tables the retention
// purge deletes with `WHERE request_id IN (...)`, nine had an index on request_id and
// three did not — response_logs, language_stats and domain_routing_decisions. Same query
// shape, same growth rate, no reason for the difference. They are indexed now.

// indexCoverageDecisions records the filtered columns deliberately left without a leading
// index, and why. An entry is a decision, not a suppression: it should say what makes the
// scan acceptable, so the next person can tell whether the reason still holds.
var indexCoverageDecisions = map[string]string{
	// The two expiry sweeps filter `expires_at < ? OR (revoked_at IS NOT NULL AND
	// revoked_at < ?)`. An OR across two columns cannot be driven by a single index, so
	// indexing either one leaves the sweep scanning anyway. The sweep runs on a timer,
	// not on the request path, and both tables are bounded by that sweep.
	"auth_sessions.expires_at":       "swept by an OR predicate that no single-column index can drive",
	"auth_sessions.revoked_at":       "swept by an OR predicate that no single-column index can drive",
	"refresh_tokens.expires_at":      "swept by an OR predicate that no single-column index can drive",
	"refresh_tokens.revoked_at":      "swept by an OR predicate that no single-column index can drive",
	"chat_semantic_cache.expires_at": "swept on a timer; the cache is bounded by its own eviction",

	// created_at filters that are already narrowed by an indexed column first, or that
	// run from admin screens rather than the request path.
	"auth_sessions.created_at":       "admin listing of sessions, already narrowed by user_id",
	"chat_semantic_cache.created_at": "cache statistics for the admin console, not the request path",
	"code_verify_results.created_at": "admin analytics; the request_id index carries the request path",
	"language_stats.created_at":      "admin analytics over a whole window, which scans by design",
	"prompt_logs.created_at":         "admin analytics; the request_id index carries the request path and the purge",
	"response_logs.created_at":       "admin analytics; the request_id index carries the request path and the purge",
	"token_usage.created_at":         "admin analytics over a whole window, which scans by design",

	// Tables that grow with traffic but are read from admin screens only, where a scan
	// over a bounded window is the intended shape.
	"approvals.created_at":               "admin listing, ordered for display; approvals is operator-sized",
	"approvals.expires_at":               "swept on a timer, and approvals is bounded by operator activity rather than traffic",
	"request_notes.updated_at":           "admin listing, operator-sized",
	"text2sql_replay_bundles.created_at": "admin listing with its own retention setting",
	"text2sql_spans.created_at":          "trace detail, read by the query id it belongs to",
	"text2sql_query_logs.api_key_id":     "analytics, always paired with a created_at range",
	"text2sql_query_logs.team":           "analytics, always paired with a created_at range",
	"text2sql_query_logs.valid":          "boolean",
	"text2sql_query_logs.explain_risk":   "a handful of risk levels",

	// Low-cardinality columns. An index over a handful of distinct values does not narrow
	// enough to beat a scan, and costs a write on every insert.
	"language_stats.confidence":   "a score, filtered by threshold across the whole window",
	"request_logs.endpoint":       "two values in practice; too low-cardinality to narrow",
	"request_logs.status_code":    "low cardinality, and always paired with an indexed created_at range",
	"request_logs.first_chunk_ms": "an analytics threshold over an already time-bounded window",

	// Tables whose access is already indexed by a different column in the same query.
	"text2sql_cache.schema_name":  "bounded by the number of registered schemas",
	"tool_invocations.api_key_id": "analytics; the request_id index carries the request path and the purge",
}

var (
	covSQLLiteralRe = regexp.MustCompile("(?s)`([^`]*)`")
	covFromRe       = regexp.MustCompile(`(?is)\bFROM\s+([a-z_][a-z0-9_]*)`)
	covUpdateRe     = regexp.MustCompile(`(?is)\bUPDATE\s+([a-z_][a-z0-9_]*)`)
	covWhereRe      = regexp.MustCompile(`(?is)\bWHERE\b(.*?)(?:\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|\bRETURNING\b|$)`)
	covOrderByRe    = regexp.MustCompile(`(?is)\bORDER\s+BY\s+([a-z_][a-z0-9_]*)`)
	covJoinRe       = regexp.MustCompile(`(?i)\bJOIN\b`)
	covPredicateRe  = regexp.MustCompile(`(?i)\b([a-z_][a-z0-9_]*)\s*(?:=|>=|<=|>|<|!=|<>|\bLIKE\b|\bIN\b|\bIS\b|\bBETWEEN\b)`)
)

// storeSQLLiterals returns every SQL statement written as a raw string literal in the
// store package. Statements built at runtime are not visible here and are out of scope:
// this check is about the queries that are fixed at compile time.
func storeSQLLiterals(t *testing.T) []string {
	t.Helper()
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("read %s: %v", f, err)
		}
		for _, m := range covSQLLiteralRe.FindAllStringSubmatch(string(raw), -1) {
			s := strings.TrimSpace(m[1])
			switch up := strings.ToUpper(s); {
			case strings.HasPrefix(up, "SELECT"), strings.HasPrefix(up, "UPDATE"), strings.HasPrefix(up, "DELETE"):
				out = append(out, s)
			}
		}
	}
	return out
}

// filteredColumns maps "table.column" to the number of statements that filter or sort on
// it. Statements with a JOIN are skipped: an unqualified column in a joined query cannot
// be attributed to a table without resolving aliases, and attributing it to the wrong one
// would produce confident nonsense.
func filteredColumns(t *testing.T) map[string]int {
	t.Helper()
	tables := DeclaredTables()
	pairs := map[string]int{}
	for _, q := range storeSQLLiterals(t) {
		if covJoinRe.MatchString(q) {
			continue
		}
		var table string
		if m := covUpdateRe.FindStringSubmatch(q); m != nil {
			table = normalizeIdent(m[1])
		} else if m := covFromRe.FindStringSubmatch(q); m != nil {
			table = normalizeIdent(m[1])
		}
		decl, known := tables[table]
		if !known {
			continue
		}
		cols := map[string]bool{}
		if w := covWhereRe.FindStringSubmatch(q); w != nil {
			for _, p := range covPredicateRe.FindAllStringSubmatch(w[1], -1) {
				cols[normalizeIdent(p[1])] = true
			}
		}
		if o := covOrderByRe.FindStringSubmatch(q); o != nil {
			cols[normalizeIdent(o[1])] = true
		}
		for c := range cols {
			// Only real columns of that table. This is what keeps subquery aliases,
			// function results and system catalogs out of the result.
			if decl.HasColumn(c) {
				pairs[table+"."+c]++
			}
		}
	}
	return pairs
}

// unboundedTables are the ones where a scan actually costs something: they grow with
// traffic rather than with operator activity.
//
// The set comes from the schema, not from an opinion about which tables are big. A table
// carrying request_id gains a row per request by construction; a table swept by expiry is
// filled by whatever traffic creates its rows. Deriving it this way means a new
// request-scoped table is covered the day it is added, with nothing to remember.
func unboundedTables() map[string]bool {
	out := map[string]bool{"request_logs": true}
	for name, decl := range DeclaredTables() {
		if decl.HasColumn("request_id") {
			out[name] = true
		}
	}
	for table, d := range retentionDecisions {
		if d.policy == sweptByExpiry {
			out[table] = true
		}
	}
	return out
}

func TestFilteredColumnsOnGrowingTablesHaveAnIndex(t *testing.T) {
	pairs := filteredColumns(t)
	if len(pairs) < 100 {
		t.Fatalf("only %d filtered columns were extracted; the SQL reader has stopped matching", len(pairs))
	}
	leading := IndexedLeadingColumns()
	hot := unboundedTables()

	var uncovered []string
	for pair, n := range pairs {
		table, column, _ := strings.Cut(pair, ".")
		if !hot[table] || leading[table][column] {
			continue
		}
		if _, decided := indexCoverageDecisions[pair]; decided {
			continue
		}
		uncovered = append(uncovered, pair)
		_ = n
	}
	sort.Strings(uncovered)
	for _, pair := range uncovered {
		table, column, _ := strings.Cut(pair, ".")
		t.Errorf("%s is filtered on %s in %d statement(s) and no index leads with it.\n"+
			"%s grows with traffic, so this is a table scan that gets slower forever.\n"+
			"Either add an index to migrationStatements(), or record why the scan is acceptable "+
			"in indexCoverageDecisions.", table, column, pairs[pair], table)
	}
}

// The reverse drift. A decision that says "no index needed" for a column that now has one
// is a stale note somebody will read as current, and it hides the fact that the reasoning
// was overtaken.
func TestIndexCoverageDecisionsAreStillNeeded(t *testing.T) {
	pairs := filteredColumns(t)
	leading := IndexedLeadingColumns()
	tables := DeclaredTables()
	hot := unboundedTables()

	for pair, why := range indexCoverageDecisions {
		table, column, ok := strings.Cut(pair, ".")
		if !ok {
			t.Errorf("decision key %q is not table.column", pair)
			continue
		}
		decl, known := tables[table]
		if !known {
			t.Errorf("decision for %q: no such table is declared; drop the entry", pair)
			continue
		}
		if !decl.HasColumn(column) {
			t.Errorf("decision for %q: %s has no column %s; drop the entry", pair, table, column)
			continue
		}
		if strings.TrimSpace(why) == "" {
			t.Errorf("decision for %q has no reason", pair)
		}
		if leading[table][column] {
			t.Errorf("decision for %q says no index is needed, but one leads with that column now; "+
				"drop the entry so the list stays readable", pair)
		}
		if !hot[table] {
			t.Errorf("decision for %q: %s is not a table this check covers, so the entry does nothing", pair, table)
		}
		if pairs[pair] == 0 {
			t.Errorf("decision for %q: nothing filters on that column any more; drop the entry", pair)
		}
	}
}

// Every request-scoped child table is deleted by the same `WHERE request_id IN (...)`
// predicate. Three of them were missing the index that predicate needs, on tables that
// grow one row per request forever. Sameness is the point: if a table joins that purge
// list, it needs the same index, and nothing else would say so.
func TestPurgedChildTablesAreIndexedOnRequestID(t *testing.T) {
	leading := IndexedLeadingColumns()
	tables := DeclaredTables()
	checked := 0
	for table, d := range retentionDecisions {
		if d.policy != purgedWithRequest {
			continue
		}
		decl, ok := tables[table]
		if !ok || !decl.HasColumn("request_id") {
			continue
		}
		checked++
		if !leading[table]["request_id"] {
			t.Errorf("%s is purged with `WHERE request_id IN (SELECT id FROM request_logs ...)` "+
				"but no index leads with request_id, so every purge scans the whole table — "+
				"and it holds one row per request.", table)
		}
	}
	if checked < 10 {
		t.Fatalf("only %d purged child tables were checked; the retention registry lookup has broken", checked)
	}
}
