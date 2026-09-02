package proxy

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"unicode"
)

const invalidProviderURLDisplay = "[invalid or redacted provider URL]"

var providerURLCredentialPatterns = []*regexp.Regexp{
	// Authorization header values accidentally pasted into a path or query value.
	regexp.MustCompile(`(?i)(?:^|[^a-z0-9])bearer(?:\s|%20|\+)+[a-z0-9._~+/=-]{8,}`),
	// OpenAI-compatible secret keys, including project and service-account forms.
	regexp.MustCompile(`(?i)(?:^|[^a-z0-9])sk-(?:proj-|svcacct-|ant-)?[a-z0-9_-]{8,}`),
	// A nested URL with userinfo can otherwise bypass the top-level User check
	// when it is percent-encoded inside a redirect parameter.
	regexp.MustCompile(`(?i)https?://[^/?#@\s]+@`),
	// JWTs. Requiring three non-trivial base64url segments avoids treating dotted
	// hostnames, versions, and ordinary filenames as credentials.
	regexp.MustCompile(`(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:$|[^A-Za-z0-9_-])`),
	// Credentials nested in redirect URLs or path parameters. A separator and an
	// assignment operator are both required, so paths such as /docs/tokenization
	// and /secret-management remain valid.
	regexp.MustCompile(`(?i)(?:^|[^a-z0-9])(?:access[_-]?token|refresh[_-]?token|bearer[_-]?token|api[_-]?key|subscription[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret|password|passwd|credentials?|authorization|auth|signature|sig|secret|token)\s*[:=]\s*[^\s?&#;]+`),
}

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

// providerURLComponentHasCredential checks both the decoded component and a
// small, bounded number of additional decoding layers. This catches credentials
// hidden in encoded redirect URLs without permitting adversarial unbounded work.
func providerURLComponentHasCredential(component string) bool {
	candidates := []string{component}
	seen := map[string]struct{}{component: {}}
	for round := 0; round < 2; round++ {
		for _, candidate := range append([]string(nil), candidates...) {
			for _, decode := range []func(string) (string, error){url.QueryUnescape, url.PathUnescape} {
				decoded, err := decode(candidate)
				if err != nil || decoded == candidate {
					continue
				}
				if _, exists := seen[decoded]; !exists {
					seen[decoded] = struct{}{}
					candidates = append(candidates, decoded)
				}
			}
		}
	}
	for _, candidate := range candidates {
		for _, pattern := range providerURLCredentialPatterns {
			if pattern.MatchString(candidate) {
				return true
			}
		}
	}
	return false
}

func providerURLQueryKeyHasSensitiveName(key string) bool {
	if providerURLQueryKeyIsSensitive(key) {
		return true
	}
	for round := 0; round < 2; round++ {
		decoded, err := url.QueryUnescape(key)
		if err != nil || decoded == key {
			return false
		}
		if providerURLQueryKeyIsSensitive(decoded) {
			return true
		}
		key = decoded
	}
	return false
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
	if providerURLComponentHasCredential(parsed.EscapedPath()) || providerURLComponentHasCredential(parsed.Path) {
		return fmt.Errorf("provider URL path must not contain credentials")
	}
	query, err := url.ParseQuery(parsed.RawQuery)
	if err != nil {
		return fmt.Errorf("provider URL contains an invalid query")
	}
	for key, values := range query {
		if providerURLQueryKeyHasSensitiveName(key) {
			return fmt.Errorf("provider URL must not contain credential query parameters")
		}
		for _, value := range values {
			if providerURLComponentHasCredential(value) {
				return fmt.Errorf("provider URL query values must not contain credentials")
			}
		}
	}
	return nil
}

// sanitizeProviderBaseURL is a final response-boundary defense for rows that
// predate validation. Any URL that current storage validation would reject is
// replaced in full, so no credential-bearing component is reflected to a
// browser, audit entry, knowledge document, or generated test target.
func sanitizeProviderBaseURL(raw string) string {
	if err := validateProviderBaseURL(raw); err != nil {
		return invalidProviderURLDisplay
	}
	parsed, _ := parseProviderBaseURL(raw)
	return parsed.String()
}
