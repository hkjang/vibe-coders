package audit

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
)

var redactPatterns = []struct {
	re          *regexp.Regexp
	replacement string
}{
	// Generic key=value, must come before specific token rules so the value is wiped together
	{regexp.MustCompile(`(?i)(api[_-]?key|access[_-]?key|secret[_-]?key|token|secret|password|passwd|client[_-]?secret|private[_-]?key)\s*[:=]\s*"[^"\n]+"`), `$1="[REDACTED]"`},
	{regexp.MustCompile(`(?i)(api[_-]?key|access[_-]?key|secret[_-]?key|token|secret|password|passwd|client[_-]?secret|private[_-]?key)\s*[:=]\s*'[^'\n]+'`), `$1='[REDACTED]'`},
	{regexp.MustCompile(`(?i)(api[_-]?key|access[_-]?key|secret[_-]?key|token|secret|password|passwd|client[_-]?secret|private[_-]?key)\s*[:=]\s*[^"'\s,}\]]+`), `$1=[REDACTED]`},
	{regexp.MustCompile(`(?i)bearer\s+[a-z0-9._\-]+`), `Bearer [REDACTED]`},
	{regexp.MustCompile(`(?i)basic\s+[a-z0-9+/=]{8,}`), `Basic [REDACTED]`},

	// LLM / cloud / VCS API tokens
	{regexp.MustCompile(`sk-ant-[A-Za-z0-9_\-]{20,}`), `[REDACTED_ANTHROPIC_KEY]`},
	{regexp.MustCompile(`sk-[A-Za-z0-9_\-]{16,}`), `[REDACTED_OPENAI_KEY]`},
	{regexp.MustCompile(`AKIA[0-9A-Z]{16}`), `[REDACTED_AWS_ACCESS_KEY]`},
	{regexp.MustCompile(`gh[pousr]_[A-Za-z0-9]{20,}`), `[REDACTED_GITHUB_TOKEN]`},
	{regexp.MustCompile(`xox[abprs]-[A-Za-z0-9\-]{10,}`), `[REDACTED_SLACK_TOKEN]`},
	{regexp.MustCompile(`AIza[0-9A-Za-z_\-]{35}`), `[REDACTED_GOOGLE_KEY]`},
	// JWT (header.payload.signature)
	{regexp.MustCompile(`eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+`), `[REDACTED_JWT]`},
	// PEM private key block (multi-line)
	{regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----`), `[REDACTED_PRIVATE_KEY]`},

	// Korean RRN (주민등록번호) — 6자리-7자리 (성별식별 1~4)
	{regexp.MustCompile(`\b\d{6}-[1-4]\d{6}\b`), `[REDACTED_RRN]`},
	// 한국 휴대전화 010-xxxx-xxxx (또는 hyphen 없는 11자리)
	{regexp.MustCompile(`\b01[016789][-\s]?\d{3,4}[-\s]?\d{4}\b`), `[REDACTED_PHONE_KR]`},
	// 한국 일반 전화 02/03x/04x/0xx- ... (대표적인 패턴만)
	{regexp.MustCompile(`\b0(2|3[1-3]|4[1-4]|5[1-5]|6[1-4])[-\s]\d{3,4}[-\s]\d{4}\b`), `[REDACTED_PHONE_KR]`},
	// 사업자등록번호 xxx-xx-xxxxx
	{regexp.MustCompile(`\b\d{3}-\d{2}-\d{5}\b`), `[REDACTED_BIZNO]`},
	// US SSN
	{regexp.MustCompile(`\b\d{3}-\d{2}-\d{4}\b`), `[REDACTED_SSN]`},
	// 카드번호 13~19자리, 4자리씩 공백/하이픈 구분 또는 연속
	{regexp.MustCompile(`\b(?:\d[ -]?){12,18}\d\b`), `[REDACTED_CARD]`},
	// 이메일
	{regexp.MustCompile(`\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b`), `[REDACTED_EMAIL]`},
	// IPv4 (사설망/링크로컬은 그대로 두기 위해 0/127/10/192.168/172.16-31 제외)
	{regexp.MustCompile(`\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b`), `[REDACTED_IPV4]`},
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
