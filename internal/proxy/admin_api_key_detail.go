package proxy

import (
	"net/http"
	"net/url"
)

func validAPIKeyDetailID(id string) bool {
	if len(id) == 0 || len(id) > 512 {
		return false
	}
	for _, c := range id {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == ':' || c == '-') {
			return false
		}
	}
	return true
}

// A present but invalid ID must never fall back to the complete key catalog.
func apiKeyDetailQuery(r *http.Request) (*string, bool) {
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return nil, false
	}
	values, present := query["id"]
	if !present {
		return nil, true
	}
	if len(values) != 1 || !validAPIKeyDetailID(values[0]) {
		return nil, false
	}
	return &values[0], true
}
