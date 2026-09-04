package proxy

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"unicode"
)

const invalidProviderURLDisplay = "[invalid or redacted provider URL]"
const maxProviderCredentialScanBytes = 64 << 10

var providerBasicCredentialPattern = regexp.MustCompile(`(?i)(?:^|[^a-z0-9])basic(?:\s|%20|\+)+([a-z0-9+/]{4,}={0,2})`)
var providerBearerCredentialPattern = regexp.MustCompile(`(?i)(?:^|[^a-z0-9])bearer(?:\s|%20|\+)+([a-z0-9._~+/=-]+)(?:$|[^a-z0-9._~+/=-])`)

var providerURLCredentialPatterns = []*regexp.Regexp{
	// OpenAI-compatible secret keys, including project and service-account forms.
	regexp.MustCompile(`(?i)(?:^|[^a-z0-9])sk-(?:proj-|svcacct-|ant-)?[a-z0-9_-]{8,}`),
	// Common vendor token formats that can otherwise look like ordinary provider labels.
	regexp.MustCompile(`(?:^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}(?:$|[^A-Za-z0-9])`),
	regexp.MustCompile(`(?:^|[^A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}(?:$|[^A-Za-z0-9_])`),
	regexp.MustCompile(`(?:^|[^A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?:$|[^A-Za-z0-9])`),
	regexp.MustCompile(`(?:^|[^A-Za-z0-9])(?:xox[abprs]|xapp|xwfp)-[A-Za-z0-9-]{10,}(?:$|[^A-Za-z0-9-])`),
	regexp.MustCompile(`(?:^|[^A-Za-z0-9])xoxe(?:\.[A-Za-z0-9.-]{8,}|-[A-Za-z0-9-]{8,})(?:$|[^A-Za-z0-9.-])`),
	regexp.MustCompile(`(?:^|[^A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?:$|[^A-Za-z0-9_-])`),
	regexp.MustCompile(`(?:^|[^A-Za-z0-9])vc_(?:sk|sa)_[A-Za-z0-9_-]{32,}(?:$|[^A-Za-z0-9_-])`),
	regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----`),
	// Nested URLs with userinfo can otherwise bypass the top-level User check
	// when they are percent-encoded inside a redirect parameter. Cover every URI
	// scheme because legacy provider names may contain database connection URLs.
	regexp.MustCompile(`(?i)[a-z][a-z0-9+.-]*://[^/?#@\s]+@`),
	// Legacy metadata sometimes contains userinfo without a URI scheme.
	regexp.MustCompile(`(?i)(?:^|[^a-z0-9])[^:/@\s]+:[^/@\s]+@[a-z0-9.-]+(?::[0-9]+)?(?:$|[/\s?#])`),
	// JWTs. Requiring three non-trivial base64url segments avoids treating dotted
	// hostnames, versions, and ordinary filenames as credentials.
	regexp.MustCompile(`(?:^|[^A-Za-z0-9])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:$|[^A-Za-z0-9_-])`),
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
	if len(component) > maxProviderCredentialScanBytes {
		return true
	}
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
		if providerBasicAuthorizationHasCredential(candidate) || providerBearerAuthorizationHasCredential(candidate) {
			return true
		}
		for _, pattern := range providerURLCredentialPatterns {
			if pattern.MatchString(candidate) {
				return true
			}
		}
	}
	return false
}

// providerTextContainsConfiguredCredentialPrefix detects runtime-configured API-key
// prefixes followed by a generated-key-sized base64url suffix in decoded legacy
// metadata. A prefix can be an ordinary word such as "corp_" or "api_", so the
// suffix requirement is intentional and avoids suppressing legitimate labels.
func providerTextContainsConfiguredCredentialPrefix(value, prefix string) bool {
	if prefix == "" {
		return false
	}
	if len(value) > maxProviderCredentialScanBytes || len(prefix) > maxProviderCredentialScanBytes {
		return true
	}
	candidates := []string{value}
	seen := map[string]struct{}{value: {}}
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
		searchFrom := 0
		for searchFrom <= len(candidate) {
			relative := strings.Index(candidate[searchFrom:], prefix)
			if relative < 0 {
				break
			}
			start := searchFrom + relative
			if providerGeneratedCredentialSuffix(candidate[start+len(prefix):]) {
				return true
			}
			searchFrom = start + 1
		}
	}
	return false
}

func providerGeneratedCredentialSuffix(value string) bool {
	length := 0
	for length < len(value) {
		character := value[length]
		if !((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') || character == '_' || character == '-') {
			break
		}
		length++
	}
	return length >= 32
}

func providerBearerAuthorizationHasCredential(candidate string) bool {
	for _, match := range providerBearerCredentialPattern.FindAllStringSubmatch(candidate, -1) {
		token := match[1]
		if len(token) > 8<<10 {
			return true
		}
		if providerBearerDescription(token) {
			continue
		}
		return true
	}
	return false
}

func providerBearerDescription(value string) bool {
	words := strings.FieldsFunc(strings.ToLower(value), func(character rune) bool {
		return character == '-'
	})
	if len(words) == 0 {
		return false
	}
	allowed := map[string]bool{
		"auth": true, "authentication": true, "authorization": true, "compatible": true,
		"endpoint": true, "provider": true, "service": true,
		"support": true, "supported": true,
	}
	for _, word := range words {
		if !allowed[word] {
			return false
		}
	}
	return true
}

func providerBasicAuthorizationHasCredential(candidate string) bool {
	for _, match := range providerBasicCredentialPattern.FindAllStringSubmatch(candidate, -1) {
		encoded := match[1]
		// An authorization value this large is not useful provider metadata. Treat it
		// as sensitive without allocating a proportionally large decode buffer.
		if len(encoded) > 8<<10 {
			return true
		}
		for _, encoding := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding} {
			decoded, err := encoding.DecodeString(encoded)
			if err == nil && basicAuthorizationPayload(decoded) {
				return true
			}
		}
	}
	return false
}

func basicAuthorizationPayload(decoded []byte) bool {
	// RFC 7617 credentials are user-pass, but deployments commonly use an API
	// token as the user with an empty password ("token:") and older clients can
	// still send an ISO-8859-1-compatible byte sequence. Any decodable Basic
	// payload containing the required colon is credential material.
	if bytes.IndexByte(decoded, ':') < 0 {
		return false
	}
	for _, character := range decoded {
		if character <= 31 || character == 127 {
			return false
		}
	}
	return true
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
