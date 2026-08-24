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
