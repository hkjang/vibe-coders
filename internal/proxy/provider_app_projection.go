package proxy

import (
	"fmt"
	"net/url"
	"strings"
)

// The app editor receives display projections, never the originals behind them.
// Share the projection between GET, POST, audit and exact round-trip matching.
type providerEditableProjection struct {
	BaseURL       string
	ModelPatterns string
	FailoverGroup string
}

func (s *Server) providerEditableFieldsForApp(name, baseURL, modelPatterns, failoverGroup string) providerEditableProjection {
	args := s.externalCredentialProjectionArgs(name)
	return providerEditableProjection{
		BaseURL:       s.sanitizeProviderBaseURLForConfig(baseURL),
		ModelPatterns: boundedExternalProviderText(modelPatterns, args...),
		FailoverGroup: boundedExternalProviderText(failoverGroup, args...),
	}
}

// An unchanged display value means keep the current stored value, not write a
// redaction marker. This is deliberately not a revision/CAS check. A different
// input (including empty or omitted metadata) keeps the existing trim/clear rule.
func providerAppMetadataWriteValue(submitted, original, public string) string {
	if original != public && submitted == public {
		return original
	}
	return strings.TrimSpace(submitted)
}

func (s *Server) validateProviderBaseURLForApp(raw string) error {
	if err := validateProviderBaseURL(raw); err != nil {
		return err
	}
	parsed, _ := parseProviderBaseURL(raw)
	// Inspect the raw representation before any host canonicalization as well as
	// separate decoded components. A literal percent in one component must not
	// prevent decoding an unrelated credential-bearing component.
	components := []string{raw, parsed.Host, parsed.EscapedPath(), parsed.Path, parsed.RawQuery}
	for key, values := range parsed.Query() {
		if providerAppURLQueryKeyIsSensitive(key) {
			return fmt.Errorf("provider URL must not contain credential query parameters")
		}
		components = append(components, key)
		components = append(components, values...)
	}
	prefixes := uiCredentialPrefixes(s.cfg.Auth)
	for _, component := range components {
		if providerAppURLComponentHasCredential(component, prefixes) {
			return fmt.Errorf("provider URL must not contain credentials")
		}
	}
	return nil
}

func (s *Server) sanitizeProviderBaseURLForConfig(raw string) string {
	if s.validateProviderBaseURLForApp(raw) != nil {
		return invalidProviderURLDisplay
	}
	parsed, _ := parseProviderBaseURL(raw)
	return parsed.String()
}

// Query names have broader credential semantics than arbitrary URL components
// (for example token_value). Preserve that distinction at every assessed layer;
// decoding the key and checking only token-shaped values would miss those names.
func providerAppURLQueryKeyIsSensitive(key string) bool {
	if len(key) > maxProviderCredentialScanBytes {
		return true
	}
	for round := 0; round <= 8; round++ {
		if providerURLQueryKeyIsSensitive(key) {
			return true
		}
		next, changed := providerAppURLDecodeLayer(key)
		if !changed {
			return false
		}
		if round == 8 {
			return true
		}
		key = next
	}
	return false
}

// Keep each bounded decoding layer so a configured prefix containing a literal
// escape (for example svc%41_) is checked before it becomes another string.
// This stronger URL-boundary check does not change legacy write validation or
// the common metadata scanner's established behavior.
func providerAppURLComponentHasCredential(value string, prefixes []string) bool {
	if len(value) > maxProviderCredentialScanBytes {
		return true
	}
	for round := 0; round <= 8; round++ {
		if providerURLComponentHasCredential(value) {
			return true
		}
		for _, prefix := range prefixes {
			if providerTextContainsConfiguredCredentialPrefix(value, prefix) {
				return true
			}
		}
		next, changed := providerAppURLDecodeLayer(value)
		if !changed {
			return false
		}
		if round == 8 {
			return true // Do not reflect unassessed deeper encoded input.
		}
		value = next
	}
	return false
}

func providerAppURLDecodeLayer(value string) (string, bool) {
	// Decode valid escapes independently; an unrelated literal or malformed '%'
	// is ordinary metadata at this layer, not permission to skip later escapes.
	var decoded strings.Builder
	changed := false
	for index := 0; index < len(value); index++ {
		if value[index] == '%' && index+2 < len(value) {
			if part, err := url.PathUnescape(value[index : index+3]); err == nil {
				decoded.WriteString(part)
				index += 2
				changed = true
				continue
			}
		}
		decoded.WriteByte(value[index])
	}
	return decoded.String(), changed
}
