package store

import (
	"database/sql/driver"
	"errors"
	"strings"
	"time"

	"modernc.org/sqlite"
)

func init() {
	// SQLite's built-in LOWER only handles ASCII. Register before opening any
	// connections; the pinned pure-Go driver needs no runtime ICU extension.
	sqlite.MustRegisterDeterministicScalarFunction("vibe_unicode_lower", 1,
		func(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
			if args[0] == nil {
				return nil, nil
			}
			value, ok := args[0].(string)
			if !ok {
				return nil, errors.New("metadata search requires text")
			}
			return strings.ToLower(value), nil
		})
}

// expression is supplied exclusively by the metadata query's field allowlist
// (or a bound-argument placeholder), never by search text or a request parameter.
func (s *SQLStore) metadataLowerSQL(expression string) string {
	if s.dialect == "sqlite" {
		return "vibe_unicode_lower(" + expression + ")"
	}
	return "LOWER(" + expression + ")"
}

// formatTime persists UTC RFC3339Nano text with variable fractional width.
// Compare fixed-width fractions without rewriting stored or returned metadata.
// Both supported databases implement these string operations; unlike a native
// timestamp cast, this retains every stored nanosecond on PostgreSQL as well.
func metadataTimestampOrderSQL(field string) string {
	// Keep PostgreSQL's explicit operator grouping, including the expression-index
	// wrapper, so its catalog definition and SQLite's original SQL have the same
	// index-drift signature. The operations and nanosecond ordering are unchanged.
	return "(((SUBSTR(" + field + ", 1, 19) || '.') || SUBSTR((SUBSTR(REPLACE(" + field + ", 'Z', ''), 21) || '000000000'), 1, 9)))"
}

// Retain the ordinary created_at index before applying precise nanosecond
// bounds. UTC second prefixes include every fractional representation in the
// boundary seconds; the exact comparison then excludes the extra edge rows.
// field is an internal SQL identifier, never a caller-supplied expression.
func metadataTimestampWindowSQL(field string, since, until time.Time) (string, []any) {
	const secondPrefix = "2006-01-02T15:04:05"
	const precise = "2006-01-02T15:04:05.000000000"
	normalized := metadataTimestampOrderSQL(field)
	return field + " >= ? AND " + field + " < ? AND " + normalized + " >= ? AND " + normalized + " < ?", []any{
		since.UTC().Format(secondPrefix),
		until.UTC().Truncate(time.Second).Add(time.Second).Format(secondPrefix),
		since.UTC().Format(precise), until.UTC().Format(precise),
	}
}
