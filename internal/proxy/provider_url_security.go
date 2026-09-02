package proxy

import (
	"fmt"
	"net/url"
	"strings"
	"unicode"
)

const redactedProviderURLValue = "***"
const invalidProviderURLDisplay = "[invalid or redacted provider URL]"

// providerURLQueryKeyIsSensitive deliberately works on key segments instead of
// substrings. This catches common credential names (for example
// X-Amz-Credential and subscription-key) without treating api-version as a
// secret merely because it contains the word "api".
func providerURLQueryKeyIsSensitive(key string) bool {
	var separated strings.Builder
	var previous rune
	for index, r := range key {
		if index > 0 && unicode.IsUpper(r) && (unicode.IsLower(previous) || unicode.IsDigit(previous)) {
			separated.WriteByte(' ')
		}
		separated.WriteRune(r)
		previous = r
	}
	normalized := strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return unicode.ToLower(r)
		}
		return ' '
	}, separated.String())
	parts := strings.Fields(normalized)
	sensitiveTerms := []string{
		"authorization", "credentials", "credential", "password", "passwd", "signature", "secret", "token", "auth", "sig", "key",
	}
	containedTerms := []string{"authorization", "credential", "password", "signature", "secret", "token"}
	for _, part := range parts {
		for _, term := range sensitiveTerms {
			if strings.HasPrefix(part, term) || strings.HasSuffix(part, term) {
				return true
			}
		}
		for _, term := range containedTerms {
			if strings.Contains(part, term) {
				return true
			}
		}
	}
	collapsed := strings.Join(parts, "")
	switch collapsed {
	case "apikey", "accesstoken", "authtoken", "bearertoken", "clientsecret", "subscriptionkey":
		return true
	default:
		return false
	}
}

func parseProviderBaseURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if strings.ContainsAny(raw, "\r\n\x00\\") {
		return nil, fmt.Errorf("provider URL contains invalid characters")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.Opaque != "" {
		return nil, fmt.Errorf("must be an absolute provider URL")
	}
	if !strings.EqualFold(parsed.Scheme, "http") && !strings.EqualFold(parsed.Scheme, "https") {
		return nil, fmt.Errorf("provider URL scheme must be http or https")
	}
	return parsed, nil
}

func validateProviderBaseURL(raw string) error {
	parsed, err := parseProviderBaseURL(raw)
	if err != nil {
		return err
	}
	if parsed.User != nil {
		return fmt.Errorf("provider URL must not contain user credentials")
	}
	if parsed.Fragment != "" {
		return fmt.Errorf("provider URL must not contain a fragment")
	}
	query, err := url.ParseQuery(parsed.RawQuery)
	if err != nil {
		return fmt.Errorf("provider URL contains an invalid query")
	}
	for key := range query {
		if providerURLQueryKeyIsSensitive(key) {
			return fmt.Errorf("provider URL must not contain credential query parameters")
		}
	}
	return nil
}

// sanitizeProviderBaseURL is a final response-boundary defense for rows that
// predate validation. Invalid URLs fail closed, credentials are removed, and
// fragments are never returned to an administrator's browser.
func sanitizeProviderBaseURL(raw string) string {
	parsed, err := parseProviderBaseURL(raw)
	if err != nil {
		return invalidProviderURLDisplay
	}
	changed := false
	if parsed.User != nil {
		parsed.User = nil
		changed = true
	}
	query, queryErr := url.ParseQuery(parsed.RawQuery)
	if queryErr != nil {
		// Do not reflect an unparseable raw query: it may contain a credential
		// hidden in a component url.Values deliberately discarded.
		parsed.RawQuery = ""
		changed = true
	}
	for key := range query {
		if providerURLQueryKeyIsSensitive(key) {
			query.Set(key, redactedProviderURLValue)
			changed = true
		}
	}
	if changed {
		// Re-encoding also drops malformed query components that Query could not
		// parse, rather than reflecting their raw values.
		parsed.RawQuery = query.Encode()
	}
	parsed.Fragment = ""
	return parsed.String()
}
