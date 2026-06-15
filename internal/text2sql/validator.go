// Package text2sql holds the provider-agnostic Text2SQL helpers: virtual-model
// profile resolution, SQL-generation prompt building, SQL extraction from LLM
// output, and read-only SQL validation. It has no dependency on the proxy/server
// so it stays unit-testable in isolation.
package text2sql

import (
	"fmt"
	"regexp"
	"strings"
)

// ValidateOptions tunes SQL validation.
type ValidateOptions struct {
	DefaultLimit         int      // when > 0, a LIMIT is appended to limit-less SELECTs
	AllowedTables        []string // when non-empty, every referenced table must be in this set
	BlockedColumns       []string // sensitive columns that must not appear anywhere in the SQL
	AggregateOnlyColumns []string // columns that may appear ONLY inside an aggregate function
	MaxLimit             int      // when > 0, an explicit LIMIT larger than this is rejected
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
	wordRe  = regexp.MustCompile(`[a-zA-Z_][a-zA-Z0-9_]*`)
	limitRe = regexp.MustCompile(`(?is)\blimit\s+\d+`)
	// Captures the table reference after FROM/JOIN, allowing double-quoted and
	// schema-qualified identifiers (e.g. FROM "Sales"."Orders" o). A leading "(" is
	// not matched, so subquery sources are skipped.
	fromJoin     = regexp.MustCompile(`(?is)\b(?:from|join)\s+("?[a-zA-Z_][a-zA-Z0-9_]*"?(?:\."?[a-zA-Z_][a-zA-Z0-9_]*"?)*)`)
	lineComment  = regexp.MustCompile(`--[^\n]*`)
	blockComment = regexp.MustCompile(`(?s)/\*.*?\*/`)
	// aggFuncRe matches an aggregate function name immediately followed by its opening
	// paren; stripAggregateBodies then removes the balanced parenthesized body so nested
	// calls (e.g. sum(coalesce(col,0))) are fully accounted for.
	aggFuncRe = regexp.MustCompile(`(?is)\b(?:count|sum|avg|min|max|stddev|variance|var_pop|var_samp)\s*\(`)
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
		allowed := map[string]bool{}
		for _, t := range opts.AllowedTables {
			allowed[strings.ToLower(strings.TrimSpace(t))] = true
		}
		for _, t := range tables {
			// compare on the unqualified table name and the full reference
			base := t
			if i := strings.LastIndex(t, "."); i >= 0 {
				base = t[i+1:]
			}
			if !allowed[t] && !allowed[base] {
				return ValidationResult{Reason: "table not allowed: " + t, Tables: tables}
			}
		}
	}

	result := ValidationResult{OK: true, SQL: sql, Tables: tables}

	// Enforce an explicit-LIMIT ceiling.
	if opts.MaxLimit > 0 {
		if m := limitRe.FindString(lower); m != "" {
			var n int
			fmt.Sscanf(strings.ToLower(m), "limit %d", &n)
			if n > opts.MaxLimit {
				return ValidationResult{Reason: fmt.Sprintf("LIMIT %d exceeds max %d", n, opts.MaxLimit)}
			}
		}
	}
	// Inject a default LIMIT when none is present.
	if opts.DefaultLimit > 0 && !limitRe.MatchString(lower) {
		result.SQL = result.SQL + fmt.Sprintf("\nLIMIT %d", opts.DefaultLimit)
		result.LimitAdded = true
	}
	return result
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

// stringLiteral matches a single-quoted SQL string, including doubled-quote ('')
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

func referencedTables(sql string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, m := range fromJoin.FindAllStringSubmatch(sql, -1) {
		t := strings.ToLower(strings.TrimSpace(m[1]))
		t = strings.ReplaceAll(t, `"`, "") // normalize quoted identifiers
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	return out
}
