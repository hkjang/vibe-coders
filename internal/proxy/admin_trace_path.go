package proxy

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// adminTracePathIDMaxBytes preserves compatibility with legacy/imported identifiers while
// still putting a finite bound on path-driven database lookups. The React request projection
// has a tighter 512-byte contract; these legacy admin endpoints intentionally do not reuse it.
const adminTracePathIDMaxBytes = 4 << 10

// adminTracePathID extracts one decoded path segment between prefix and suffix. net/http
// exposes URL.Path in decoded form, so an escaped slash is rejected by the same check as a
// literal slash. No filesystem interpretation is involved, but dot segments are still refused
// because ServeMux may canonicalize them before dispatch.
func adminTracePathID(path, prefix, suffix string) (string, bool) {
	if !strings.HasPrefix(path, prefix) {
		return "", false
	}
	id := strings.TrimPrefix(path, prefix)
	if suffix != "" {
		if !strings.HasSuffix(id, suffix) {
			return "", false
		}
		id = strings.TrimSuffix(id, suffix)
	}
	if !adminTraceIdentifierValid(id) {
		return "", false
	}
	return id, true
}

func adminTraceIdentifierValid(id string) bool {
	if id == "" || id == "." || id == ".." || len(id) > adminTracePathIDMaxBytes ||
		strings.Contains(id, "/") || !utf8.ValidString(id) ||
		strings.IndexFunc(id, unicode.IsControl) >= 0 {
		return false
	}
	return true
}
