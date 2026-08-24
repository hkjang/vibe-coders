package audit

import (
	"strings"
	"testing"
)

// The literal prefilter must never cause a miss.
//
// Three rules are skipped when a literal they require is absent, which is only safe if
// the literal really is required and the check really is case-insensitive. A wrong
// prefilter does not fail loudly — it lets a secret through — so the cases that would
// break it are checked directly rather than inferred from the pattern text.

func TestBearerIsRedactedInEveryCasing(t *testing.T) {
	for _, prefix := range []string{"Bearer", "bearer", "BEARER", "BeArEr", "bEARER"} {
		in := "Authorization: " + prefix + " abcdef0123456789token"
		got := Redact(in)
		if strings.Contains(got, "abcdef0123456789token") {
			t.Errorf("%q was not redacted: %q", prefix, got)
		}
	}
}

func TestBasicIsRedactedInEveryCasing(t *testing.T) {
	for _, prefix := range []string{"Basic", "basic", "BASIC", "BaSiC"} {
		in := "Authorization: " + prefix + " dXNlcjpwYXNzd29yZA=="
		got := Redact(in)
		if strings.Contains(got, "dXNlcjpwYXNzd29yZA==") {
			t.Errorf("%q was not redacted: %q", prefix, got)
		}
	}
}

// The literal can sit anywhere, not only at the start, and can be preceded by text that
// nearly matches it.
func TestPrefilterFindsTheLiteralAnywhere(t *testing.T) {
	for _, in := range []string{
		"note: bearer aaaaaaaaaaaaaaaa",
		"beare bearer aaaaaaaaaaaaaaaa",                        // a near-miss before the real one
		strings.Repeat("x", 5000) + " Bearer aaaaaaaaaaaaaaaa", // far into a long body
		"BEARERbearer aaaaaaaaaaaaaaaa",
	} {
		if got := Redact(in); strings.Contains(got, "aaaaaaaaaaaaaaaa") {
			t.Errorf("token survived in %q: %q", in, got)
		}
	}
}

// A prompt with none of the literals must come back untouched — the skip is the point,
// and it must not alter text.
func TestTextWithoutTheLiteralsIsUnchanged(t *testing.T) {
	in := "plain prose with no credentials in it at all, just words and 1234"
	if got := Redact(in); got != in {
		t.Errorf("text with nothing to redact was modified:\n  in:  %q\n  out: %q", in, got)
	}
}

func TestContainsFoldASCII(t *testing.T) {
	for _, tc := range []struct {
		s, lower string
		want     bool
	}{
		{"Bearer x", "bearer", true},
		{"xxBEARERxx", "bearer", true},
		{"bearе r", "bearer", false}, // Cyrillic 'е' — must not match
		{"bear", "bearer", false},
		{"", "bearer", false},
		{"anything", "", true},
		{"BASIC", "basic", true},
	} {
		if got := containsFoldASCII(tc.s, tc.lower); got != tc.want {
			t.Errorf("containsFoldASCII(%q, %q) = %v, want %v", tc.s, tc.lower, got, tc.want)
		}
	}
}

// Every keyword the key=value rules accept must survive the prefilter.
//
// Those three rules are skipped unless the text contains key, token, secret, password or
// passwd. That is only sound if every branch of their alternation contains one of them,
// so each branch is exercised here rather than argued from the pattern source — including
// the separator and quoting variants, since the rules differ only in those.
func TestEveryKeyValueKeywordStillRedacts(t *testing.T) {
	keywords := []string{
		"api_key", "api-key", "apikey",
		"access_key", "access-key", "accesskey",
		"secret_key", "secret-key", "secretkey",
		"token", "secret", "password", "passwd",
		"client_secret", "client-secret", "clientsecret",
		"private_key", "private-key", "privatekey",
	}
	const value = "s3cr3tvalue0123456789"
	for _, kw := range keywords {
		for _, form := range []string{
			kw + `="` + value + `"`,
			kw + `='` + value + `'`,
			kw + `=` + value,
			kw + `: ` + value,
			strings.ToUpper(kw) + `=` + value,
			strings.Title(kw) + `=` + value, //nolint:staticcheck // ASCII only, adequate here
		} {
			if got := Redact("config " + form); strings.Contains(got, value) {
				t.Errorf("%q was not redacted: %q", form, got)
			}
		}
	}
}

// And the skip has to actually happen, or the test above would pass for the wrong reason.
func TestKeyValueRulesAreSkippedWhenNoKeywordIsPresent(t *testing.T) {
	var guarded int
	for _, p := range redactPatterns {
		if len(p.mustContainAny) > 0 {
			guarded++
		}
	}
	if guarded < 5 {
		t.Fatalf("only %d patterns carry a literal requirement; the prefilter is not in use", guarded)
	}
	// Text with a separator but none of the keywords: the key=value rules must not run,
	// and nothing may change.
	in := "value = 42; ratio: 0.5"
	if got := Redact(in); got != in {
		t.Errorf("text with no credential keyword was modified:\n  in:  %q\n  out: %q", in, got)
	}
}

// The fold covers exactly A-Z and nothing next to it.
//
// A prefilter literal is compared against text one byte at a time with the uppercase range
// folded down. Getting either end of that range wrong makes the check miss a literal that
// is present, the pattern is skipped, and whatever it was meant to redact is stored as it
// arrived. '@' and '[' sit either side of the range in ASCII and must not be folded into
// letters.
func TestTheASCIIFoldCoversTheWholeUppercaseRangeAndNoMore(t *testing.T) {
	for c := byte('A'); c <= 'Z'; c++ {
		upper := string([]byte{c})
		lower := strings.ToLower(upper)
		if !containsFoldASCII("xx"+upper+"yy", lower) {
			t.Errorf("%q is not folded to %q; a literal containing it would be missed", upper, lower)
		}
	}
	// The bytes on either side of A-Z. Folding them would turn '@' into '`' and '[' into
	// '{', so a literal containing those characters would match text that does not have it.
	for _, c := range []byte{'@', '[', '`', '{'} {
		s := string([]byte{c})
		if containsFoldASCII(s, strings.ToLower(s)) != (strings.ToLower(s) == s) {
			t.Errorf("%q is treated as a letter by the fold", s)
		}
	}
	if containsFoldASCII("@", "`") {
		t.Error("'@' folded to '`'; the range starts below 'A'")
	}
	if containsFoldASCII("[", "{") {
		t.Error("'[' folded to '{'; the range ends above 'Z'")
	}
}

// Every keyword a prefiltered rule can match has to contain one of the literals that rule
// is screened by.
//
// The screen skips a pattern when none of its literals is in the text, which is only sound
// if the pattern could not have matched. TestEveryKeyValueKeywordStillRedacts checks that
// by exercising each keyword it knows about; this checks it against the pattern source, so
// a keyword added to the alternation later cannot slip past the screen unnoticed. Adding
// `credential` to the rule without adding a literal for it would let every
// `credential=...` through, silently, with the table still looking correct.
func TestEveryPrefilteredAlternativeContainsARequiredLiteral(t *testing.T) {
	checked := 0
	for _, pattern := range redactPatterns {
		if len(pattern.mustContainAny) == 0 {
			continue
		}
		for _, alternative := range topLevelAlternatives(pattern.re.String()) {
			plain := strings.ToLower(stripRegexSyntax(alternative))
			ok := false
			for _, literal := range pattern.mustContainAny {
				if strings.Contains(plain, literal) {
					ok = true
					break
				}
			}
			checked++
			if !ok {
				t.Errorf("rule %s is skipped unless the text contains one of %v, but it can match "+
					"%q, which contains none of them — anything that alternative matches would be "+
					"stored unredacted",
					pattern.re.String(), pattern.mustContainAny, alternative)
			}
		}
	}
	if checked < 10 {
		t.Fatalf("only %d alternatives were checked; the extractor has stopped matching", checked)
	}
}

// topLevelAlternatives returns the branches of the first parenthesised group in a pattern,
// or the whole pattern when it has none. It is deliberately simple: these rules are one
// flat alternation of keywords, and anything more elaborate should fail loudly here rather
// than be parsed approximately.
func topLevelAlternatives(source string) []string {
	// Skip the non-capturing and flag groups a pattern opens with, e.g. "(?i)", so the
	// keyword alternation itself is the group that gets split.
	open := -1
	for i := 0; i < len(source); i++ {
		if source[i] == '(' && (i+1 >= len(source) || source[i+1] != '?') {
			open = i
			break
		}
	}
	if open < 0 {
		return []string{source}
	}
	depth, close := 0, -1
	for i := open; i < len(source); i++ {
		switch source[i] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				close = i
			}
		}
		if close >= 0 {
			break
		}
	}
	if close < 0 {
		return []string{source}
	}
	group := source[open+1 : close]
	if !strings.Contains(group, "|") {
		// A single-branch group carries no alternation; the whole pattern is the thing
		// that has to contain a literal.
		return []string{source}
	}
	return strings.Split(group, "|")
}

// stripRegexSyntax removes the character classes and quantifiers these keyword
// alternations use, leaving the letters a match must contain.
func stripRegexSyntax(s string) string {
	var out strings.Builder
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '[':
			for i < len(s) && s[i] != ']' {
				i++
			}
		case '?', '*', '+', '\\':
			// quantifier or escape: the character it applies to is optional or literal
		default:
			out.WriteByte(s[i])
		}
	}
	return out.String()
}
