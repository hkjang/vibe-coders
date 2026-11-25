package dlp

// CredentialFinding is one credential found by the credentials profile.
type CredentialFinding struct {
	ID    string
	Value string
}

// FindCredentials runs the credentials profile's entries over text, skipping the
// ones listed in skip. It is how the gateway's always-on secret firewall, which
// predates DLP and keeps its own rule names, picks up the credential formats added
// here without changing what it already reports.
func FindCredentials(text string, skip map[string]bool) []CredentialFinding {
	lower := asciiLower(text)
	out := []CredentialFinding{}
	for _, entry := range ProfileEntries("credentials") {
		if skip[entry.ID] {
			continue
		}
		for _, m := range entry.find(0, text, lower) {
			out = append(out, CredentialFinding{ID: entry.ID, Value: m.value})
		}
	}
	return out
}

// MaskCredentials replaces what FindCredentials would report with each entry's label.
func MaskCredentials(text string, skip map[string]bool) string {
	lower := asciiLower(text)
	matches := []Match{}
	for _, entry := range ProfileEntries("credentials") {
		if skip[entry.ID] {
			continue
		}
		matches = append(matches, entry.find(0, text, lower)...)
	}
	if len(matches) == 0 {
		return text
	}
	return (&Engine{}).Mask([]string{text}, matches)[0]
}
