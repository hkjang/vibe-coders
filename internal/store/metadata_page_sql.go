package store

import (
	"database/sql/driver"
	"errors"
	"strings"

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
	return "(SUBSTR(" + field + ", 1, 19) || '.' || SUBSTR(SUBSTR(REPLACE(" + field + ", 'Z', ''), 21) || '000000000', 1, 9))"
}
