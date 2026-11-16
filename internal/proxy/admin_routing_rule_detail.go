package proxy

import (
	"errors"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"
)

func validRoutingRuleDetailID(id string) bool {
	return id != "" && id == strings.TrimSpace(id) && utf8.ValidString(id) && len(id) <= 2048 && utf8.RuneCountInString(id) <= 512 && strings.IndexFunc(id, func(r rune) bool { return unicode.IsControl(r) || unicode.Is(unicode.Cf, r) }) < 0
}

func routingRuleDetailQuery(raw string) (string, bool, error) {
	// Preserve legacy collection queries when no id key was supplied, but never
	// let an invalid encoded detail value silently turn into a full-list read.
	present := false
	for _, part := range strings.Split(raw, "&") {
		key, err := url.QueryUnescape(strings.SplitN(part, "=", 2)[0])
		if err == nil && key == "id" {
			present = true
			break
		}
	}
	if !present {
		return "", false, nil
	}
	query, err := url.ParseQuery(raw)
	if err != nil || len(query) != 1 || len(query["id"]) != 1 || !validRoutingRuleDetailID(query.Get("id")) {
		return "", true, errors.New("invalid routing detail query")
	}
	return query.Get("id"), true, nil
}
