package audit

import (
	"strings"
	"testing"
)

func TestRedactMasksKnownSecrets(t *testing.T) {
	input := `Authorization: Bearer abc.def-123
api_key="sk-abcdefghijklmnopqrstuvwxyz"
bareKey sk-xxxxxxxxxxxxxxxxxxxx
anthropic = sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
password = hunter2
aws AKIAABCDEFGHIJKLMNOP
github ghp_abcdefghijklmnopqrstuvwxyz1234567890
주민번호 900101-1234567
사업자등록번호 123-45-67890
휴대폰 010-1234-5678
일반전화 02-345-6789
이메일 alice@example.com
카드번호 4111-1111-1111-1111
jwt eyJabc.eyJdef.signaturepart
서버 ip 203.0.113.10
-----BEGIN RSA PRIVATE KEY-----
MIIBOgIBAAJBA...
-----END RSA PRIVATE KEY-----`

	redacted := Redact(input)

	forbidden := []string{
		"abc.def-123", "sk-abcdefghijklmnopqrstuvwxyz", "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
		"hunter2", "AKIAABCDEFGHIJKLMNOP", "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
		"900101-1234567", "123-45-67890", "010-1234-5678", "02-345-6789",
		"alice@example.com", "4111-1111-1111-1111", "eyJabc.eyJdef.signaturepart",
		"203.0.113.10", "MIIBOgIBAAJBA",
	}
	for _, f := range forbidden {
		if strings.Contains(redacted, f) {
			t.Fatalf("redacted text still contains %q\n---\n%s", f, redacted)
		}
	}

	required := []string{
		"[REDACTED_OPENAI_KEY]", "[REDACTED_ANTHROPIC_KEY]",
		"[REDACTED_AWS_ACCESS_KEY]", "[REDACTED_GITHUB_TOKEN]",
		"[REDACTED_RRN]", "[REDACTED_BIZNO]", "[REDACTED_PHONE_KR]",
		"[REDACTED_EMAIL]", "[REDACTED_CARD]", "[REDACTED_JWT]",
		"[REDACTED_IPV4]", "[REDACTED_PRIVATE_KEY]",
	}
	for _, want := range required {
		if !strings.Contains(redacted, want) {
			t.Fatalf("redacted text missing tag %q\n---\n%s", want, redacted)
		}
	}
}

func TestRedactContainsHelper(t *testing.T) {
	if Contains("hello world") {
		t.Fatal("normal text should not be flagged as sensitive")
	}
	if !Contains("Bearer abc.def-123") {
		t.Fatal("Bearer token should be flagged")
	}
}
