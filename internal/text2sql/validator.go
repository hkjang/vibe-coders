// Package text2sql holds the provider-agnostic Text2SQL helpers: virtual-model
// profile resolution, SQL-generation prompt building, SQL extraction from LLM
// output, and read-only SQL validation. It has no dependency on the proxy/server
// so it stays unit-testable in isolation.
package text2sql

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// ValidateOptions tunes SQL validation.
type ValidateOptions struct {
	DefaultLimit         int      // when > 0, a LIMIT is appended to SELECTs whose own result is unbounded
	AllowedTables        []string // when non-empty, every referenced table must be in this set
	BlockedColumns       []string // sensitive columns that must not appear anywhere in the SQL
	AggregateOnlyColumns []string // columns that may appear ONLY inside an aggregate function
	MaxLimit             int      // when > 0, any explicit LIMIT larger than this is rejected
}

// ValidationResult is the outcome of validating a generated SQL statement.
type ValidationResult struct {
	OK         bool     `json:"ok"`
	SQL        string   `json:"sql"`    // normalized SQL (LIMIT injected when applicable)
	Reason     string   `json:"reason"` // why it was rejected, when !OK
	Tables     []string `json:"tables"` // referenced tables (best-effort)
	LimitAdded bool     `json:"limit_added"`
}

// forbiddenKeywords are statement types that must never run through a read-only
// Text2SQL path. Matched as whole words, case-insensitive.
var forbiddenKeywords = []string{
	"insert", "update", "delete", "drop", "alter", "create", "truncate",
	"grant", "revoke", "merge", "replace", "call", "exec", "execute",
	"attach", "detach", "pragma", "vacuum", "copy", "into", "commit", "rollback",
}

// dangerousFunctions are functions that can read files, sleep, or reach the network.
var dangerousFunctions = []string{
	"pg_read_file", "pg_sleep", "pg_ls_dir", "dblink", "lo_import", "lo_export",
	"load_extension", "readfile", "writefile",
}

var (
	wordRe = regexp.MustCompile(`[a-zA-Z_][a-zA-Z0-9_]*`)
	// The row count is captured so it can be parsed straight out of the match: \s+ spans
	// newlines, and an LLM that breaks the line after LIMIT produced a match that
	// fmt.Sscanf("limit %d") could not read back, silently yielding 0.
	limitRe = regexp.MustCompile(`(?is)\blimit\s+(\d+)`)
	// Captures the table reference after FROM/JOIN, allowing double-quoted and
	// schema-qualified identifiers (e.g. FROM "Sales"."Orders" o). A leading "(" is
	// not matched, so subquery sources are skipped.
	fromJoin = regexp.MustCompile(`(?is)\b(?:from|join)\s+("?[a-zA-Z_][a-zA-Z0-9_]*"?(?:\."?[a-zA-Z_][a-zA-Z0-9_]*"?)*)`)
	// The FROM clause runs until the next clause keyword. Everything between is a
	// comma-separated list of table references, which is why matching only the first
	// name after FROM is not enough.
	fromClause   = regexp.MustCompile(`(?is)\bfrom\s+(.*?)(?:\bwhere\b|\bgroup\s+by\b|\bhaving\b|\border\s+by\b|\blimit\b|\boffset\b|\bunion\b|\bintersect\b|\bexcept\b|\bwindow\b|\bfetch\b|$)`)
	tableRef     = regexp.MustCompile(`^\s*("?[a-zA-Z_][a-zA-Z0-9_]*"?(?:\."?[a-zA-Z_][a-zA-Z0-9_]*"?)*)`)
	lineComment  = regexp.MustCompile(`--[^\n]*`)
	blockComment = regexp.MustCompile(`(?s)/\*.*?\*/`)
	// aggFuncRe matches an aggregate function name immediately followed by its opening
	// paren; stripAggregateBodies then removes the balanced parenthesized body so nested
	// calls (e.g. sum(coalesce(col,0))) are fully accounted for.
	aggFuncRe = regexp.MustCompile(`(?is)\b(?:count|sum|avg|min|max|stddev|variance|var_pop|var_samp)\s*\(`)

	// A star used as a projection: directly after SELECT or a comma, optionally
	// qualified by a table alias. Multiplication never matches, because it has an
	// operand in front of the star.
	// A qualified star anywhere, including inside a call like ROW(c.*), where the
	// projection form above does not reach.
	qualifiedStar  = regexp.MustCompile(`(?is)("?[a-zA-Z_][a-zA-Z0-9_]*"?)\s*\.\s*\*`)
	starProjection = regexp.MustCompile(`(?is)(?:\bselect\b|,)\s*(?:"?[a-zA-Z_][a-zA-Z0-9_]*"?\s*\.\s*)?\*`)

	// Names introduced by a WITH clause. A CTE is not a table: it is defined inline and
	// resolves to whatever its body selects from, which the allowlist checks separately.
	// Matching "WITH x AS (", "WITH RECURSIVE x AS (" and each ", y AS (" that follows.
	cteNameRe = regexp.MustCompile(`(?is)(?:\bwith\s+(?:recursive\s+)?|,\s*)("?[a-zA-Z_][a-zA-Z0-9_]*"?)\s*(?:\([^)]*\)\s*)?as\s*\(`)
)

// stripAggregateBodies blanks out the (balanced-parenthesis) argument list of every
// aggregate function call in the SQL, leaving the rest intact. Used to detect raw use
// of aggregate-only columns: anything still present after stripping is outside an
// aggregate. Operates on already-scrubbed SQL (string literals removed).
func stripAggregateBodies(sql string) string {
	b := []byte(sql)
	locs := aggFuncRe.FindAllStringIndex(sql, -1)
	for _, loc := range locs {
		// loc[1]-1 is the index of the opening '('. Walk to its matching ')'.
		open := loc[1] - 1
		depth := 0
		for i := open; i < len(b); i++ {
			switch b[i] {
			case '(':
				depth++
			case ')':
				depth--
			}
			if i > open || b[i] != '(' {
				b[i] = ' '
			}
			if depth == 0 {
				break
			}
		}
	}
	return string(b)
}

// ValidateSQL enforces that the generated SQL is a single, read-only SELECT (or a
// CTE that resolves to a SELECT), rejects dangerous statements/functions, optionally
// checks the referenced tables against an allowlist, and injects a default LIMIT.
func ValidateSQL(raw string, opts ValidateOptions) ValidationResult {
	sql := strings.TrimSpace(raw)
	if sql == "" {
		return ValidationResult{Reason: "empty SQL"}
	}
	// Scrub comments AND single-quoted string literals before any keyword/structure
	// analysis, so values like '...drop table...' or a ';' inside a string can't
	// trigger a false rejection or hide a real second statement. Double-quoted
	// identifiers are preserved (they are names, not data).
	stripped := scrubSQL(sql)
	if multiStatement(stripped) {
		return ValidationResult{Reason: "multiple statements are not allowed"}
	}
	// Structural sanity (in-tree, no external parser): balanced parentheses and
	// double-quoted identifiers. Catches SQL truncated mid-generation (an unclosed
	// subquery/CTE/identifier) before it reaches the database.
	if reason := structuralCheck(stripped); reason != "" {
		return ValidationResult{Reason: reason}
	}
	sql = strings.TrimRight(strings.TrimSpace(sql), ";")
	stripped = strings.TrimRight(strings.TrimSpace(scrubSQL(sql)), ";")
	lower := strings.ToLower(stripped)

	// Must begin with SELECT or WITH (CTE → SELECT).
	if !strings.HasPrefix(lower, "select") && !strings.HasPrefix(lower, "with") {
		return ValidationResult{Reason: "only SELECT statements are allowed"}
	}
	// A WITH chain must still ultimately SELECT (no writable CTE).
	if strings.HasPrefix(lower, "with") && !strings.Contains(lower, "select") {
		return ValidationResult{Reason: "CTE must resolve to a SELECT"}
	}

	words := map[string]bool{}
	for _, m := range wordRe.FindAllString(lower, -1) {
		words[m] = true
	}
	for _, kw := range forbiddenKeywords {
		if words[kw] {
			return ValidationResult{Reason: "forbidden keyword: " + kw}
		}
	}
	for _, fn := range dangerousFunctions {
		if strings.Contains(lower, fn) {
			return ValidationResult{Reason: "dangerous function: " + fn}
		}
	}
	// A wildcard projection defeats every column policy at once. The checks below look
	// for the column by name, and "SELECT *" never names it: a column marked exclude or
	// approval_required comes back in full, and an aggregate-only column arrives raw.
	// The validator cannot know what * expands to -- it has no schema -- so when column
	// policies exist the only safe answer is to require the columns be named. The schema
	// context handed to the model already lists the readable columns, so naming them is
	// what it does anyway once told.
	//
	// COUNT(*) is left alone. It returns no column values, and stripping aggregate call
	// bodies first is what separates the two cases. So is multiplication: a projection
	// star follows SELECT or a comma, while "price * qty" has an operand before it.
	if len(opts.BlockedColumns) > 0 || len(opts.AggregateOnlyColumns) > 0 {
		if alias := wholeRowReference(lower, cteNames(lower)); alias != "" {
			return ValidationResult{Reason: "whole-row reference is not allowed when column policies apply: " + alias}
		}

		if wildcardOverRealTable(lower) {
			return ValidationResult{Reason: "select * is not allowed when column policies apply; name the columns"}
		}
	}
	for _, col := range opts.BlockedColumns {
		if c := strings.ToLower(strings.TrimSpace(col)); c != "" && words[c] {
			return ValidationResult{Reason: "sensitive column not allowed: " + c}
		}
	}
	// aggregate-only columns may appear only inside an aggregate call. Strip aggregate
	// call bodies (balanced parens, so nested calls like sum(coalesce(col,0)) are fully
	// removed), then any remaining occurrence is a raw (disallowed) use. A column in a
	// window OVER(...) clause stays raw on purpose — it is not an aggregated reference.
	if len(opts.AggregateOnlyColumns) > 0 {
		nonAgg := map[string]bool{}
		for _, m := range wordRe.FindAllString(stripAggregateBodies(lower), -1) {
			nonAgg[m] = true
		}
		for _, col := range opts.AggregateOnlyColumns {
			if c := strings.ToLower(strings.TrimSpace(col)); c != "" && nonAgg[c] {
				return ValidationResult{Reason: "aggregate-only column used outside an aggregate: " + c}
			}
		}
	}

	tables := referencedTables(stripped)
	if len(opts.AllowedTables) > 0 {
		// A CTE name is not a table: it is defined inline and resolves to whatever its
		// body selects from. Without allowing for that, an allowlist rejects every query
		// using WITH -- which an LLM writes for anything non-trivial -- and reports
		// "table not allowed: recent" about a name the user never wrote.
		//
		// Scope matters, and getting it wrong is worse than the over-blocking it fixes.
		// Exempting the name everywhere lets "WITH secrets AS (SELECT * FROM secrets)"
		// through: the same name covers both the CTE and the real table read inside its
		// own body. A CTE is only visible to what comes after its definition, so each
		// body is checked against the CTEs declared before it, and only the outer query
		// sees them all.
		allowed := map[string]bool{}
		for _, t := range opts.AllowedTables {
			allowed[strings.ToLower(strings.TrimSpace(t))] = true
		}
		if reason := checkCTEScopes(stripped, allowed); reason != "" {
			return ValidationResult{Reason: reason, Tables: tables}
		}
		ctes := cteNames(stripped)
		for _, t := range tables {
			// compare on the unqualified table name and the full reference
			base := t
			if i := strings.LastIndex(t, "."); i >= 0 {
				base = t[i+1:]
			}
			if ctes[t] {
				continue
			}
			if !allowed[t] && !allowed[base] {
				return ValidationResult{Reason: "table not allowed: " + t, Tables: tables}
			}
		}
	}

	result := ValidationResult{OK: true, SQL: sql, Tables: tables}

	limits := statementLimits(lower)

	// Enforce the ceiling on every LIMIT, not just the first one in the text. Reading only
	// the first match let a subquery answer for the outer query, because a subquery is
	// written before the LIMIT that bounds the statement.
	if opts.MaxLimit > 0 {
		for _, l := range limits {
			if l.overflow || l.rows > opts.MaxLimit {
				return ValidationResult{Reason: fmt.Sprintf("LIMIT %s exceeds max %d", l.text, opts.MaxLimit)}
			}
		}
	}
	// Inject a default LIMIT when the statement's own result is unbounded. A LIMIT inside a
	// subquery or a CTE body bounds that body alone, so leaving the outer query untouched
	// on account of it hands the database an unbounded scan (and an ORDER BY over the whole
	// table) for exactly the queries the default is there to bound.
	if opts.DefaultLimit > 0 && !hasTopLevelLimit(limits) {
		result.SQL = result.SQL + fmt.Sprintf("\nLIMIT %d", opts.DefaultLimit)
		result.LimitAdded = true
	}
	return result
}

// sqlLimit is one LIMIT found in a statement.
type sqlLimit struct {
	text     string // the row count as written, for the rejection message
	rows     int
	overflow bool // the literal does not fit in an int, so it cannot be shown to be in range
	topLevel bool // sits outside every parenthesis, i.e. bounds the statement's own result
}

// statementLimits lists every LIMIT in already-scrubbed SQL, marking the ones that are not
// nested inside a subquery or a CTE body.
func statementLimits(stripped string) []sqlLimit {
	depths := parenDepths(stripped)
	var out []sqlLimit
	for _, loc := range limitRe.FindAllStringSubmatchIndex(stripped, -1) {
		text := stripped[loc[2]:loc[3]]
		rows, err := strconv.Atoi(text)
		out = append(out, sqlLimit{text: text, rows: rows, overflow: err != nil, topLevel: depths[loc[0]] == 0})
	}
	return out
}

func hasTopLevelLimit(limits []sqlLimit) bool {
	for _, l := range limits {
		if l.topLevel {
			return true
		}
	}
	return false
}

// parenDepths returns, for each byte of the SQL, how many parentheses are open before it.
// Parentheses inside string literals and comments are already gone by the time this runs.
func parenDepths(stripped string) []int {
	out := make([]int, len(stripped))
	depth := 0
	for i := 0; i < len(stripped); i++ {
		out[i] = depth
		switch stripped[i] {
		case '(':
			depth++
		case ')':
			if depth > 0 {
				depth--
			}
		}
	}
	return out
}

// structuralCheck does a lightweight in-tree structural validation on already-scrubbed
// SQL (comments and string literals removed): parentheses must be balanced and never
// close below zero, and double-quoted identifiers must be paired. It returns an empty
// string when the structure is well-formed, else a rejection reason.
func structuralCheck(stripped string) string {
	depth := 0
	quotes := 0
	for _, c := range stripped {
		switch c {
		case '(':
			depth++
		case ')':
			depth--
			if depth < 0 {
				return "unbalanced parentheses (unexpected ')')"
			}
		case '"':
			quotes++
		}
	}
	if depth != 0 {
		return "unbalanced parentheses (unclosed '(')"
	}
	if quotes%2 != 0 {
		return "unterminated quoted identifier"
	}
	return ""
}

func stripComments(sql string) string {
	sql = lineComment.ReplaceAllString(sql, " ")
	sql = blockComment.ReplaceAllString(sql, " ")
	return sql
}

// stringLiteral matches a single-quoted SQL string, including doubled-quote (”)
// escapes inside it.
var stringLiteral = regexp.MustCompile(`'(?:[^']|'')*'`)

// scrubSQL removes comments and blanks out single-quoted string literals (keeping
// the quotes so token boundaries are preserved), leaving structure + identifiers.
func scrubSQL(sql string) string {
	sql = stripComments(sql)
	sql = stringLiteral.ReplaceAllString(sql, "''")
	return sql
}

// multiStatement reports whether the (comment-stripped) SQL contains more than one
// statement — i.e. a non-trailing semicolon followed by more SQL.
func multiStatement(sql string) bool {
	trimmed := strings.TrimRight(strings.TrimSpace(sql), ";")
	return strings.Contains(trimmed, ";")
}

// ReferencedTables returns the table names referenced by a SQL statement (best-effort),
// scrubbing comments/string literals first. Exported for callers (e.g. gateway memory)
// that need to summarize which tables a user tends to query.
func ReferencedTables(sql string) []string {
	return referencedTables(strings.TrimRight(strings.TrimSpace(scrubSQL(sql)), ";"))
}

// referencedTables lists the tables a statement reads.
//
// A FROM clause is a comma-separated list, and matching only the name directly after
// FROM saw just the first of them: "FROM orders o, secrets s" reported [orders] and the
// allowlist never heard about secrets. A comma join is not an exotic construct -- it is
// ordinary SQL that a model writes without prompting -- so the whole clause is scanned.
func referencedTables(sql string) []string {
	seen := map[string]bool{}
	out := []string{}
	add := func(raw string) {
		t := strings.ToLower(strings.TrimSpace(raw))
		t = strings.ReplaceAll(t, `"`, "") // normalize quoted identifiers
		if t == "" || seen[t] {
			return
		}
		seen[t] = true
		out = append(out, t)
	}
	for _, m := range fromJoin.FindAllStringSubmatch(sql, -1) {
		add(m[1])
	}
	for _, m := range fromClause.FindAllStringSubmatch(sql, -1) {
		for _, entry := range splitTopLevel(m[1]) {
			// A parenthesised entry is a subquery or a function call; its own FROM is
			// picked up by the scan above, and a function is not a table to allowlist.
			if strings.HasPrefix(strings.TrimSpace(entry), "(") || strings.Contains(entry, "(") {
				continue
			}
			if ref := tableRef.FindStringSubmatch(entry); ref != nil {
				add(ref[1])
			}
		}
	}
	return out
}

// splitTopLevel splits a FROM clause on commas that are not inside parentheses, so a
// subquery or function argument list stays in one piece.
func splitTopLevel(clause string) []string {
	var out []string
	depth, start := 0, 0
	for i := 0; i < len(clause); i++ {
		switch clause[i] {
		case '(':
			depth++
		case ')':
			depth--
		case ',':
			if depth == 0 {
				out = append(out, clause[start:i])
				start = i + 1
			}
		}
	}
	return append(out, clause[start:])
}

// cteNames returns the names a WITH clause introduces, lowercased and unquoted.
func cteNames(sql string) map[string]bool {
	out := map[string]bool{}
	for _, m := range cteNameRe.FindAllStringSubmatch(sql, -1) {
		name := strings.ToLower(strings.TrimSpace(m[1]))
		name = strings.ReplaceAll(name, `"`, "")
		if name != "" {
			out[name] = true
		}
	}
	return out
}

// cteSpan is one WITH entry: its name and the source text of its body.
type cteSpan struct {
	name string
	body string
}

// cteSpans returns the WITH entries in declaration order, each with the text between
// its "AS (" and the matching ")".
func cteSpans(sql string) []cteSpan {
	var out []cteSpan
	for _, loc := range cteNameRe.FindAllStringSubmatchIndex(sql, -1) {
		name := strings.ToLower(strings.TrimSpace(sql[loc[2]:loc[3]]))
		name = strings.ReplaceAll(name, `"`, "")
		if name == "" {
			continue
		}
		// loc[1]-1 is the opening paren of the body; walk to its match.
		open := loc[1] - 1
		depth, end := 0, -1
		for i := open; i < len(sql); i++ {
			switch sql[i] {
			case '(':
				depth++
			case ')':
				depth--
			}
			if depth == 0 {
				end = i
				break
			}
		}
		if end < 0 {
			continue
		}
		out = append(out, cteSpan{name: name, body: sql[open+1 : end]})
	}
	return out
}

// checkCTEScopes verifies every table referenced inside a CTE body, allowing a body to
// reference CTEs declared before it. Returns "" when everything checks out.
func checkCTEScopes(sql string, allowed map[string]bool) string {
	visible := map[string]bool{}
	for _, cte := range cteSpans(sql) {
		for _, t := range referencedTables(cte.body) {
			if visible[t] {
				continue
			}
			base := t
			if i := strings.LastIndex(t, "."); i >= 0 {
				base = t[i+1:]
			}
			if !allowed[t] && !allowed[base] {
				return "table not allowed: " + t
			}
		}
		// Only now does the name become visible, so a CTE cannot cover a table of the
		// same name that its own body reads.
		visible[cte.name] = true
	}
	return ""
}

// wildcardOverRealTable reports whether a star projects the columns of an actual table.
//
// "SELECT * FROM some_cte" is not a problem: a CTE exposes only what its own body
// selected, and that body was checked by the rules above. Refusing it would reinstate
// the over-block that made allowlists and CTEs unusable together, so the star is judged
// per scope -- inside each CTE body, and again over the outer query, where it is only
// refused if the outer query reads something that is not a CTE.
func wildcardOverRealTable(lower string) bool {
	spans := cteSpans(lower)
	outer := lower
	cteName := map[string]bool{}
	for _, cte := range spans {
		if starProjection.MatchString(stripAggregateBodies(cte.body)) {
			return true // a star inside a CTE body reads a real table
		}
		cteName[cte.name] = true
		outer = strings.Replace(outer, cte.body, " ", 1)
	}
	// A qualified star can sit anywhere, including inside a call like ROW(c.*) where
	// the projection form never matches. Its qualifier says what it expands: a CTE
	// exposes only what the CTE selected, a table alias exposes the table.
	for _, m := range qualifiedStar.FindAllStringSubmatch(lower, -1) {
		qualifier := strings.Trim(strings.TrimSpace(m[1]), `"`)
		if !cteName[qualifier] && !aliasOfCTE(lower, qualifier, cteName) {
			return true
		}
	}
	if !starProjection.MatchString(stripAggregateBodies(outer)) {
		return false
	}
	for _, t := range referencedTables(outer) {
		if !cteName[t] {
			return true // the outer star covers a real table too
		}
	}
	return false
}

// aliasDecl matches a table reference followed by its alias: "customers c" or
// "customers AS c". The alias is what a whole-row reference uses.
var aliasDecl = regexp.MustCompile(`(?is)\b([a-zA-Z_][a-zA-Z0-9_]*)\s+(?:as\s+)?("?[a-zA-Z_][a-zA-Z0-9_]*"?)\s*(?:,|\)|$|\bon\b|\bwhere\b|\bjoin\b|\bgroup\b|\border\b|\blimit\b)`)

// wholeRowReference finds a bare table alias used as a value, and returns it.
//
// PostgreSQL lets a query name the row itself: "SELECT c FROM customers c" returns
// every column as a composite, and to_jsonb(c) turns it into readable JSON. Neither
// writes a single column name, so every check that looks for one -- blocked columns,
// aggregate-only columns -- sees nothing to object to. It is the same hole the wildcard
// had, reached by a different construct.
//
// The alias appears once where it is declared, so a reference is an occurrence beyond
// that which is not followed by a dot. "SELECT c.id FROM customers c" names a column
// and is left alone.
func wholeRowReference(lower string, ctes map[string]bool) string {
	for _, clause := range fromClause.FindAllStringSubmatch(lower, -1) {
		for _, entry := range splitTopLevel(clause[1]) {
			m := aliasDecl.FindStringSubmatch(entry + ",")
			if m == nil {
				continue
			}
			table := strings.ToLower(strings.TrimSpace(m[1]))
			alias := strings.Trim(strings.TrimSpace(m[2]), `"`)
			// The word before the alias has to be a table name. When the clause span runs
			// past its own query -- which it does when there is no trailing keyword -- a
			// pair like "from recent" otherwise reads as table "from", alias "recent".
			if alias == "" || sqlNoiseWord[alias] || sqlNoiseWord[table] {
				continue
			}
			// A whole-row reference to a CTE exposes only what the CTE selected, and that
			// body was checked by these same rules. Same reasoning as the wildcard.
			if ctes[alias] || ctes[table] {
				continue
			}
			bare := regexp.MustCompile(`(?is)\b` + regexp.QuoteMeta(alias) + `\b\s*(?:[^.a-zA-Z0-9_]|$)`)
			if len(bare.FindAllString(lower, -1)) > 1 {
				return alias
			}
		}
	}
	return ""
}

// sqlNoiseWord lists words the alias matcher can pick up that are not aliases.
var sqlNoiseWord = map[string]bool{
	"as": true, "on": true, "and": true, "or": true, "join": true, "inner": true,
	"left": true, "right": true, "full": true, "outer": true, "cross": true,
	"lateral": true, "natural": true, "using": true, "only": true,
	// Clause keywords, so a span that overshoots its own query does not invent a table.
	"from": true, "select": true, "with": true, "by": true, "order": true, "group": true,
	"where": true, "having": true, "limit": true, "offset": true, "union": true,
}

// aliasOfCTE reports whether qualifier is an alias given to a CTE, as in
// "FROM recent r" where recent is a CTE: r.* then expands to the CTE's columns.
func aliasOfCTE(lower, qualifier string, ctes map[string]bool) bool {
	for _, clause := range fromClause.FindAllStringSubmatch(lower, -1) {
		for _, entry := range splitTopLevel(clause[1]) {
			m := aliasDecl.FindStringSubmatch(entry + ",")
			if m == nil {
				continue
			}
			table := strings.ToLower(strings.TrimSpace(m[1]))
			alias := strings.Trim(strings.TrimSpace(m[2]), `"`)
			if alias == qualifier && ctes[table] {
				return true
			}
		}
	}
	return false
}
