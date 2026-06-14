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
	DefaultLimit  int      // when > 0, a LIMIT is appended to limit-less SELECTs
	AllowedTables []string // when non-empty, every referenced table must be in this set
	MaxLimit      int      // when > 0, an explicit LIMIT larger than this is rejected
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
	wordRe       = regexp.MustCompile(`[a-zA-Z_][a-zA-Z0-9_]*`)
	limitRe      = regexp.MustCompile(`(?is)\blimit\s+\d+`)
	fromJoin     = regexp.MustCompile(`(?is)\b(?:from|join)\s+([a-zA-Z_][a-zA-Z0-9_\.]*)`)
	lineComment  = regexp.MustCompile(`--[^\n]*`)
	blockComment = regexp.MustCompile(`(?s)/\*.*?\*/`)
)

// ValidateSQL enforces that the generated SQL is a single, read-only SELECT (or a
// CTE that resolves to a SELECT), rejects dangerous statements/functions, optionally
// checks the referenced tables against an allowlist, and injects a default LIMIT.
func ValidateSQL(raw string, opts ValidateOptions) ValidationResult {
	sql := strings.TrimSpace(raw)
	if sql == "" {
		return ValidationResult{Reason: "empty SQL"}
	}
	// Strip a trailing semicolon, then ensure no further statement follows.
	stripped := stripComments(sql)
	if multiStatement(stripped) {
		return ValidationResult{Reason: "multiple statements are not allowed"}
	}
	sql = strings.TrimRight(strings.TrimSpace(sql), ";")
	stripped = strings.TrimRight(strings.TrimSpace(stripComments(sql)), ";")
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

func stripComments(sql string) string {
	sql = lineComment.ReplaceAllString(sql, " ")
	sql = blockComment.ReplaceAllString(sql, " ")
	return sql
}

// multiStatement reports whether the (comment-stripped) SQL contains more than one
// statement — i.e. a non-trailing semicolon followed by more SQL.
func multiStatement(sql string) bool {
	trimmed := strings.TrimRight(strings.TrimSpace(sql), ";")
	return strings.Contains(trimmed, ";")
}

func referencedTables(sql string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, m := range fromJoin.FindAllStringSubmatch(sql, -1) {
		t := strings.ToLower(strings.TrimSpace(m[1]))
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	return out
}
