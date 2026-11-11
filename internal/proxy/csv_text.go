package proxy

import (
	"strings"
	"unicode"
)

// Spreadsheet applications may ignore leading whitespace/control characters
// before interpreting a formula. CSV quoting alone does not neutralize formulas.
// Apply this to text columns; server-formatted numeric columns retain their type.
func csvTextCell(value string) string {
	trimmed := strings.TrimLeftFunc(value, func(r rune) bool { return unicode.IsSpace(r) || r <= 32 || r == 127 || r == '\ufeff' })
	if (len(trimmed) > 0 && strings.ContainsRune("=+-@", rune(trimmed[0]))) ||
		(len(value) > 0 && strings.ContainsRune("\t\r\n", rune(value[0]))) {
		return "'" + value
	}
	return value
}
