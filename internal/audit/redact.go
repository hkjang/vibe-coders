package audit

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
)

// Every request is redacted, so this table runs over the whole prompt each time.
// Profiling a 1 MB prompt put 78% of auditRequest inside Redact, and within Redact the
// three key=value rules alone took 292ms of 430ms -- each is a case-insensitive
// alternation over nine keywords, and Go matches (?i) by folding every rune.
//
// mustContainAny lists literals the pattern cannot match without any one of. When none
// is present the regex is skipped, turning a fold-per-rune scan into a few plain byte
// scans. It only skips work the regex could not have matched: "bearer" and "basic" are
// literal prefixes of their rules, and every branch of the key=value alternation
// contains one of key/token/secret/password/passwd -- api_key and private-key have
// "key", client_secret has "secret", and so on.
//
// Getting one of these wrong does not fail loudly, it lets a secret through, so a rule
// whose literal is not obviously mandatory leaves the field nil and always runs.
var redactPatterns = []struct {
	re          *regexp.Regexp
	replacement string
	mustContainAny []string // lowercase literals, any one of which the pattern requires; nil = always run
}{
	// Generic key=value, must come before specific token rules so the value is wiped together
	{regexp.MustCompile(`(?i)(api[_-]?key|access[_-]?key|secret[_-]?key|token|secret|password|passwd|client[_-]?secret|private[_-]?key)\s*[:=]\s*"[^"\n]+"`), `$1="[REDACTED]"`, []string{"key", "token", "secret", "password", "passwd"}},
	{regexp.MustCompile(`(?i)(api[_-]?key|access[_-]?key|secret[_-]?key|token|secret|password|passwd|client[_-]?secret|private[_-]?key)\s*[:=]\s*'[^'\n]+'`), `$1='[REDACTED]'`, []string{"key", "token", "secret", "password", "passwd"}},
	{regexp.MustCompile(`(?i)(api[_-]?key|access[_-]?key|secret[_-]?key|token|secret|password|passwd|client[_-]?secret|private[_-]?key)\s*[:=]\s*[^"'\s,}\]]+`), `$1=[REDACTED]`, []string{"key", "token", "secret", "password", "passwd"}},
	{regexp.MustCompile(`(?i)bearer\s+[a-z0-9._\-]+`), `Bearer [REDACTED]`, []string{"bearer"}},
	{regexp.MustCompile(`(?i)basic\s+[a-z0-9+/=]{8,}`), `Basic [REDACTED]`, []string{"basic"}},

	// LLM / cloud / VCS API tokens
	{regexp.MustCompile(`sk-ant-[A-Za-z0-9_\-]{20,}`), `[REDACTED_ANTHROPIC_KEY]`, nil},
	{regexp.MustCompile(`sk-[A-Za-z0-9_\-]{16,}`), `[REDACTED_OPENAI_KEY]`, nil},
	{regexp.MustCompile(`AKIA[0-9A-Z]{16}`), `[REDACTED_AWS_ACCESS_KEY]`, nil},
	{regexp.MustCompile(`gh[pousr]_[A-Za-z0-9]{20,}`), `[REDACTED_GITHUB_TOKEN]`, nil},
	{regexp.MustCompile(`xox[abprs]-[A-Za-z0-9\-]{10,}`), `[REDACTED_SLACK_TOKEN]`, nil},
	{regexp.MustCompile(`AIza[0-9A-Za-z_\-]{35}`), `[REDACTED_GOOGLE_KEY]`, nil},
	// JWT (header.payload.signature)
	{regexp.MustCompile(`eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+`), `[REDACTED_JWT]`, nil},
	// PEM private key block (multi-line)
	{regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----`), `[REDACTED_PRIVATE_KEY]`, nil},

	// Korean RRN (주민등록번호) — 6자리-7자리 (성별식별 1~4)
	{regexp.MustCompile(`\b\d{6}-[1-4]\d{6}\b`), `[REDACTED_RRN]`, nil},
	// 한국 휴대전화 010-xxxx-xxxx (또는 hyphen 없는 11자리)
	{regexp.MustCompile(`\b01[016789][-\s]?\d{3,4}[-\s]?\d{4}\b`), `[REDACTED_PHONE_KR]`, nil},
	// 한국 일반 전화 02/03x/04x/0xx- ... (대표적인 패턴만)
	{regexp.MustCompile(`\b0(2|3[1-3]|4[1-4]|5[1-5]|6[1-4])[-\s]\d{3,4}[-\s]\d{4}\b`), `[REDACTED_PHONE_KR]`, nil},
	// 사업자등록번호 xxx-xx-xxxxx
	{regexp.MustCompile(`\b\d{3}-\d{2}-\d{5}\b`), `[REDACTED_BIZNO]`, nil},
	// US SSN
	{regexp.MustCompile(`\b\d{3}-\d{2}-\d{4}\b`), `[REDACTED_SSN]`, nil},
	// 카드번호 13~19자리, 4자리씩 공백/하이픈 구분 또는 연속
	{regexp.MustCompile(`\b(?:\d[ -]?){12,18}\d\b`), `[REDACTED_CARD]`, nil},
	// 이메일
	{regexp.MustCompile(`\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b`), `[REDACTED_EMAIL]`, nil},
	// IPv4 (사설망/링크로컬은 그대로 두기 위해 0/127/10/192.168/172.16-31 제외)
	{regexp.MustCompile(`\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b`), `[REDACTED_IPV4]`, nil},
}

// RedactRules returns the active rule names. Useful for surfacing the policy in admin UI.
func RedactRules() []string {
	names := []string{
		"key=value", "Authorization Bearer", "Authorization Basic",
		"Anthropic key", "OpenAI key", "AWS access key", "GitHub token",
		"Slack token", "Google API key", "JWT", "PEM private key",
		"한국 주민번호", "한국 휴대전화", "한국 일반전화", "사업자등록번호",
		"US SSN", "카드번호", "이메일", "IPv4",
	}
	return names
}

func Redact(text string) string {
	if text == "" {
		return text
	}
	redacted := text
	for _, pattern := range redactPatterns {
		if !containsAnyFoldASCII(redacted, pattern.mustContainAny) {
			continue
		}
		redacted = pattern.re.ReplaceAllString(redacted, pattern.replacement)
	}
	return redacted
}

// HashText returns the sha256 hex of the original text. Used so we can detect duplicate
// prompts/responses without storing the plaintext.
func HashText(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// Contains reports whether the given prompt is likely to contain something the
// redactor would mask. Used by admin UI to highlight sensitive items.
func Contains(text string) bool {
	if text == "" {
		return false
	}
	masked := Redact(text)
	return strings.Contains(masked, "[REDACTED")
}

// containsAnyFoldASCII reports whether s contains any of the given lowercase ASCII
// literals. An empty list means "no requirement", so the pattern always runs.
func containsAnyFoldASCII(s string, literals []string) bool {
	if len(literals) == 0 {
		return true
	}
	for _, lit := range literals {
		if containsFoldASCII(s, lit) {
			return true
		}
	}
	return false
}

// containsFoldASCII reports whether s contains lower, comparing ASCII letters without
// regard to case. lower must already be lowercase and ASCII.
//
// strings.Contains(strings.ToLower(s), lower) would answer the same question but copies
// the whole prompt to do it, which is the allocation this avoids. Only ASCII case is
// folded, which is all these literals need.
func containsFoldASCII(s, lower string) bool {
	n := len(lower)
	if n == 0 {
		return true
	}
	if len(s) < n {
		return false
	}
	for i := 0; i+n <= len(s); i++ {
		matched := true
		for j := 0; j < n; j++ {
			c := s[i+j]
			if c >= 'A' && c <= 'Z' {
				c += 'a' - 'A'
			}
			if c != lower[j] {
				matched = false
				break
			}
		}
		if matched {
			return true
		}
	}
	return false
}
