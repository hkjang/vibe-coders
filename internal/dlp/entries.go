// Package dlp finds sensitive data in AI prompts and responses.
//
// Detection is organized the way Cloudflare DLP organizes it: detection entries
// (one kind of data, such as a card number) grouped into profiles (financial
// information, government identifiers, ...), which policies select and act on.
// Every entry here is a regular expression plus, where one exists, the check digit
// or structural rule the real identifier must satisfy, so that a number that merely
// has the right shape does not count as a card or a resident registration number.
package dlp

import (
	"regexp"
	"strconv"
	"strings"
)

// Confidence is how sure a match is. A profile ignores matches below its threshold.
type Confidence int

const (
	ConfidenceNone Confidence = iota
	ConfidenceLow
	ConfidenceMedium
	ConfidenceHigh
)

func (c Confidence) String() string {
	switch c {
	case ConfidenceHigh:
		return "high"
	case ConfidenceMedium:
		return "medium"
	case ConfidenceLow:
		return "low"
	}
	return "none"
}

// ParseConfidence reads "low" | "medium" | "high"; anything else is ok=false.
func ParseConfidence(value string) (Confidence, bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "low":
		return ConfidenceLow, true
	case "medium":
		return ConfidenceMedium, true
	case "high":
		return ConfidenceHigh, true
	}
	return ConfidenceNone, false
}

// Verdict is what an entry's structural check says about one match.
type Verdict int

const (
	// Reject means the text has the shape but is not the identifier (bad check digit).
	Reject Verdict = iota
	// Keep means the shape is right and no stronger evidence exists.
	Keep
	// Strong means a check digit or registry rule confirmed it.
	Strong
)

// Entry is one kind of sensitive data.
type Entry struct {
	ID          string
	Profile     string
	Name        string
	Description string
	pattern     *regexp.Regexp
	// group is the capture group holding the sensitive value; 0 is the whole match.
	// A key=value entry masks only the value so the key stays readable.
	group int
	// base is the confidence without context. ConfidenceNone means the entry only
	// counts when one of its context words is nearby (a bare 10-digit number is not a
	// bank account; one next to "계좌" is).
	base    Confidence
	context []string
	check   func(string) Verdict
	// around rejects a match by what surrounds it (text and the match's byte span),
	// for shapes that are only sensitive outside some construct.
	around func(text string, start, end int) bool
	mask   string
	// prefilter lists lowercase literals one of which every match contains; when none
	// is present the regular expression is skipped.
	prefilter []string
	// Example is a synthetic value that matches, used by the console's test scan.
	// Token-shaped examples are written in two pieces so secret scanners that read
	// this source do not mistake them for leaked credentials.
	Example string
}

// RequiresContext reports whether the entry only matches near a context word.
func (e *Entry) RequiresContext() bool { return e.base == ConfidenceNone }

// BaseConfidence is the confidence of a match without context.
func (e *Entry) BaseConfidence() Confidence { return e.base }

// ContextWords lists the words that raise this entry's confidence.
func (e *Entry) ContextWords() []string { return append([]string(nil), e.context...) }

// MaskLabel is what replaces a masked match.
func (e *Entry) MaskLabel() string { return e.mask }

// ---- structural checks ----

// insideURLAuthority reports whether a user@host shape is the credentials part of a
// URL ("postgres://app:pw@db", "ssh://git@host"): the address is a login, not a
// person's mailbox, and the credentials profile already covers the URL.
func insideURLAuthority(text string, start, _ int) bool {
	from := start
	for from > 0 {
		c := text[from-1]
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '"' || c == '\'' || c == '<' || c == '(' {
			break
		}
		from--
	}
	prefix := text[from:start]
	i := strings.Index(prefix, "://")
	if i < 0 {
		return false
	}
	return !strings.ContainsAny(prefix[i+3:], "/?#")
}

func digitsOnly(value string) string {
	var b strings.Builder
	for _, r := range value {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func luhnValid(digits string) bool {
	if len(digits) < 12 {
		return false
	}
	sum := 0
	double := false
	for i := len(digits) - 1; i >= 0; i-- {
		d := int(digits[i] - '0')
		if double {
			d *= 2
			if d > 9 {
				d -= 9
			}
		}
		sum += d
		double = !double
	}
	return sum%10 == 0
}

// cardIssuerKnown checks the leading digits against the major networks' ranges.
func cardIssuerKnown(d string) bool {
	prefix := func(n int) int {
		if len(d) < n {
			return -1
		}
		v, _ := strconv.Atoi(d[:n])
		return v
	}
	switch {
	case d[0] == '4' && (len(d) == 13 || len(d) == 16 || len(d) == 19): // Visa
		return true
	case (prefix(2) >= 51 && prefix(2) <= 55 || prefix(4) >= 2221 && prefix(4) <= 2720) && len(d) == 16: // Mastercard
		return true
	case (prefix(2) == 34 || prefix(2) == 37) && len(d) == 15: // American Express
		return true
	case (prefix(4) == 6011 || prefix(2) == 65 || prefix(3) >= 644 && prefix(3) <= 649) && len(d) >= 16: // Discover
		return true
	case prefix(4) >= 3528 && prefix(4) <= 3589 && len(d) >= 16: // JCB
		return true
	case prefix(2) == 62 && len(d) >= 16: // UnionPay
		return true
	case (prefix(2) == 36 || prefix(2) == 38 || prefix(3) >= 300 && prefix(3) <= 305) && len(d) == 14: // Diners Club
		return true
	case prefix(4) >= 9400 && prefix(4) <= 9499 && len(d) == 16: // 국내 전용 카드 BIN
		return true
	}
	return false
}

func checkCard(match string) Verdict {
	d := digitsOnly(match)
	if len(d) < 13 || len(d) > 19 || !luhnValid(d) || !cardIssuerKnown(d) {
		return Reject
	}
	return Strong
}

func validDate(yy, mm, dd int, century int) bool {
	if mm < 1 || mm > 12 || dd < 1 {
		return false
	}
	year := century + yy
	days := []int{31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31}
	if year%4 == 0 && (year%100 != 0 || year%400 == 0) {
		days[1] = 29
	}
	return dd <= days[mm-1]
}

// checkRRN validates a Korean resident (or foreigner) registration number. Numbers
// issued since October 2020 no longer carry a check digit, so a valid birth date and
// sex digit keep the match; a matching check digit makes it strong.
func checkRRN(match string) Verdict {
	d := digitsOnly(match)
	if len(d) != 13 {
		return Reject
	}
	yy, _ := strconv.Atoi(d[0:2])
	mm, _ := strconv.Atoi(d[2:4])
	dd, _ := strconv.Atoi(d[4:6])
	century := 0
	switch d[6] {
	case '1', '2', '5', '6':
		century = 1900
	case '3', '4', '7', '8':
		century = 2000
	case '9', '0':
		century = 1800
	}
	if !validDate(yy, mm, dd, century) {
		return Reject
	}
	weights := []int{2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5}
	sum := 0
	for i, w := range weights {
		sum += int(d[i]-'0') * w
	}
	if (11-sum%11)%10 == int(d[12]-'0') {
		return Strong
	}
	return Keep
}

// checkBizNo validates a Korean business registration number's check digit.
func checkBizNo(match string) Verdict {
	d := digitsOnly(match)
	if len(d) != 10 {
		return Reject
	}
	weights := []int{1, 3, 7, 1, 3, 7, 1, 3, 5}
	sum := 0
	for i, w := range weights {
		sum += int(d[i]-'0') * w
	}
	sum += int(d[8]-'0') * 5 / 10
	if (10-sum%10)%10 == int(d[9]-'0') {
		return Strong
	}
	return Reject
}

func checkUSSSN(match string) Verdict {
	d := digitsOnly(match)
	if len(d) != 9 {
		return Reject
	}
	area, _ := strconv.Atoi(d[0:3])
	if area == 0 || area == 666 || area >= 900 || d[3:5] == "00" || d[5:] == "0000" {
		return Reject
	}
	return Keep
}

func checkIBAN(match string) Verdict {
	compact := strings.ToUpper(strings.ReplaceAll(match, " ", ""))
	if len(compact) < 15 || len(compact) > 34 {
		return Reject
	}
	rearranged := compact[4:] + compact[:4]
	remainder := 0
	for _, r := range rearranged {
		var value int
		switch {
		case r >= '0' && r <= '9':
			value = int(r - '0')
		case r >= 'A' && r <= 'Z':
			value = int(r-'A') + 10
		default:
			return Reject
		}
		if value >= 10 {
			remainder = (remainder*100 + value) % 97
		} else {
			remainder = (remainder*10 + value) % 97
		}
	}
	if remainder == 1 {
		return Strong
	}
	return Reject
}

func checkABARouting(match string) Verdict {
	d := digitsOnly(match)
	if len(d) != 9 {
		return Reject
	}
	n := func(i int) int { return int(d[i] - '0') }
	if (3*(n(0)+n(3)+n(6))+7*(n(1)+n(4)+n(7))+(n(2)+n(5)+n(8)))%10 != 0 {
		return Reject
	}
	return Keep
}

func checkKRDriverLicense(match string) Verdict {
	d := digitsOnly(match)
	if len(d) != 12 {
		return Reject
	}
	region, _ := strconv.Atoi(d[0:2])
	if region < 11 || region > 28 {
		return Reject
	}
	return Keep
}

func checkPublicIPv4(match string) Verdict {
	parts := strings.Split(match, ".")
	if len(parts) != 4 {
		return Reject
	}
	octet := func(i int) int { v, _ := strconv.Atoi(parts[i]); return v }
	a, b := octet(0), octet(1)
	switch {
	case a == 0 || a == 10 || a == 127 || a >= 224:
		return Reject
	case a == 169 && b == 254, a == 172 && b >= 16 && b <= 31, a == 192 && b == 168, a == 100 && b >= 64 && b <= 127:
		return Reject
	}
	return Keep
}

// checkNotRepeated drops runs such as 000000000 or 1111111111 that fill forms.
func checkNotRepeated(match string) Verdict {
	d := digitsOnly(match)
	if d == "" || strings.Count(d, string(d[0])) == len(d) {
		return Reject
	}
	return Keep
}

// ---- the catalog ----

var builtinEntries = []*Entry{
	// 자격 증명·비밀 (credentials)
	{ID: "private_key", Profile: "credentials", Name: "PEM 개인 키", Description: "-----BEGIN ... PRIVATE KEY----- 블록", pattern: regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----`), base: ConfidenceHigh, mask: "[REDACTED_PRIVATE_KEY]", prefilter: []string{"private key"}, Example: "-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAexample\n-----END PRIVATE KEY-----"},
	{ID: "jwt", Profile: "credentials", Name: "JWT", Description: "서명된 JSON Web Token", pattern: regexp.MustCompile(`eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}`), base: ConfidenceHigh, mask: "[REDACTED_JWT]", prefilter: []string{"eyj"}, Example: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkbHAtdGVzdCJ9.c2lnbmF0dXJlLXNhbXBsZQ"},
	{ID: "anthropic_api_key", Profile: "credentials", Name: "Anthropic API 키", pattern: regexp.MustCompile(`sk-ant-[A-Za-z0-9_\-]{20,}`), base: ConfidenceHigh, mask: "[REDACTED_ANTHROPIC_KEY]", prefilter: []string{"sk-ant-"}, Example: "sk-ant-api03-EXAMPLEexampleEXAMPLEexample00"},
	{ID: "openai_api_key", Profile: "credentials", Name: "OpenAI API 키", pattern: regexp.MustCompile(`sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_\-]{16,}`), base: ConfidenceHigh, mask: "[REDACTED_OPENAI_KEY]", prefilter: []string{"sk-"}, check: func(m string) Verdict {
		if strings.HasPrefix(m, "sk-ant-") {
			return Reject
		}
		return Strong
	}, Example: "sk-proj-EXAMPLEexample1234567890abcd"},
	{ID: "vibe_api_key", Profile: "credentials", Name: "게이트웨이 API 키", Description: "이 게이트웨이가 발급한 vc_sk_/vc_sa_ 키", pattern: regexp.MustCompile(`vc_(?:sk|sa)_[A-Za-z0-9_\-]{20,}`), base: ConfidenceHigh, mask: "[REDACTED_VIBE_KEY]", prefilter: []string{"vc_s"}, Example: "vc_sk_EXAMPLEexampleEXAMPLE0001"},
	{ID: "aws_access_key", Profile: "credentials", Name: "AWS 액세스 키 ID", pattern: regexp.MustCompile(`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`), base: ConfidenceHigh, mask: "[REDACTED_AWS_ACCESS_KEY]", prefilter: []string{"akia", "asia"}, Example: "AKIAEXAMPLE000000001"},
	{ID: "aws_secret", Profile: "credentials", Name: "AWS 비밀 액세스 키", pattern: regexp.MustCompile(`(?i)aws.{0,20}(?:secret|access).{0,20}[:=]\s*["']?([A-Za-z0-9/+=]{30,})`), group: 1, base: ConfidenceHigh, mask: "[REDACTED]", prefilter: []string{"aws"}, Example: "aws_secret_access_key=EXAMPLEexampleEXAMPLEexample00000000000"},
	{ID: "github_token", Profile: "credentials", Name: "GitHub 토큰", pattern: regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,})`), base: ConfidenceHigh, mask: "[REDACTED_GITHUB_TOKEN]", prefilter: []string{"gh", "github_pat_"}, Example: "ghp_EXAMPLEexampleEXAMPLE000000000000"},
	{ID: "gitlab_token", Profile: "credentials", Name: "GitLab 토큰", pattern: regexp.MustCompile(`\bglpat-[A-Za-z0-9_\-]{20,}`), base: ConfidenceHigh, mask: "[REDACTED_GITLAB_TOKEN]", prefilter: []string{"glpat-"}, Example: "glpat-EXAMPLEexampleEXAMPLE00"},
	{ID: "slack_token", Profile: "credentials", Name: "Slack 토큰", pattern: regexp.MustCompile(`\b(?:xox[abeprs]|xapp|xwfp)-[A-Za-z0-9\-]{10,}`), base: ConfidenceHigh, mask: "[REDACTED_SLACK_TOKEN]", prefilter: []string{"xox", "xapp", "xwfp"}, Example: "xox" + "b-000000000000-EXAMPLEexample"},
	{ID: "slack_webhook", Profile: "credentials", Name: "Slack 웹훅 URL", pattern: regexp.MustCompile(`https://hooks\.slack\.com/services/[A-Za-z0-9/_\-]{20,}`), base: ConfidenceHigh, mask: "[REDACTED_SLACK_WEBHOOK]", prefilter: []string{"hooks.slack.com"}, Example: "https://hooks.slack.com/services/T00000000/B00000000/EXAMPLEexample00"},
	{ID: "discord_webhook", Profile: "credentials", Name: "Discord 웹훅 URL", pattern: regexp.MustCompile(`https://(?:canary\.|ptb\.)?discord(?:app)?\.com/api/webhooks/\d+/[A-Za-z0-9_\-]{20,}`), base: ConfidenceHigh, mask: "[REDACTED_DISCORD_WEBHOOK]", prefilter: []string{"discord"}, Example: "https://discord.com/api/webhooks/000000000000/EXAMPLEexampleEXAMPLE00"},
	{ID: "google_api_key", Profile: "credentials", Name: "Google API 키", pattern: regexp.MustCompile(`\bAIza[0-9A-Za-z_\-]{35}\b`), base: ConfidenceHigh, mask: "[REDACTED_GOOGLE_KEY]", prefilter: []string{"aiza"}, Example: "AIzaSyEXAMPLEexampleEXAMPLEexample00000"},
	{ID: "stripe_key", Profile: "credentials", Name: "Stripe 비밀 키", pattern: regexp.MustCompile(`\b(?:sk|rk)_live_[A-Za-z0-9]{20,}`), base: ConfidenceHigh, mask: "[REDACTED_STRIPE_KEY]", prefilter: []string{"_live_"}, Example: "sk_" + "live_EXAMPLEexampleEXAMPLE0000"},
	{ID: "cloudflare_api_token", Profile: "credentials", Name: "Cloudflare API 토큰", Description: "cfk_ · cfut_ · cfat_ 접두사 형식", pattern: regexp.MustCompile(`\b(?:cfk|cfut|cfat)_[A-Za-z0-9]{32,}`), base: ConfidenceHigh, mask: "[REDACTED_CLOUDFLARE_TOKEN]", prefilter: []string{"cfk_", "cfut_", "cfat_"}, Example: "cfat_EXAMPLEexampleEXAMPLEexampleEXAMPLE00"},
	{ID: "huggingface_token", Profile: "credentials", Name: "Hugging Face 토큰", pattern: regexp.MustCompile(`\bhf_[A-Za-z0-9]{30,}`), base: ConfidenceHigh, mask: "[REDACTED_HF_TOKEN]", prefilter: []string{"hf_"}, Example: "hf_EXAMPLEexampleEXAMPLEexample0000"},
	{ID: "npm_token", Profile: "credentials", Name: "npm 토큰", pattern: regexp.MustCompile(`\bnpm_[A-Za-z0-9]{36}\b`), base: ConfidenceHigh, mask: "[REDACTED_NPM_TOKEN]", prefilter: []string{"npm_"}, Example: "npm_EXAMPLEexampleEXAMPLEexample00000000"},
	{ID: "azure_storage_key", Profile: "credentials", Name: "Azure 저장소 연결 문자열 키", pattern: regexp.MustCompile(`(?i)AccountKey=([A-Za-z0-9+/=]{40,})`), group: 1, base: ConfidenceHigh, mask: "[REDACTED]", prefilter: []string{"accountkey="}, Example: "DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=EXAMPLEexampleEXAMPLEexampleEXAMPLEexample00=="},
	{ID: "db_connection_string", Profile: "credentials", Name: "DB 연결 문자열", pattern: regexp.MustCompile(`(?i)\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|mssql|sqlserver)://[^\s"'<>]+`), base: ConfidenceHigh, mask: "[REDACTED_DB_CONNECTION]", prefilter: []string{"://"}, Example: "postgres://app:EXAMPLEpassword@db.internal:5432/main"},
	{ID: "access_token", Profile: "credentials", Name: "액세스·갱신 토큰 값", pattern: regexp.MustCompile(`(?i)(?:access[_-]?token|refresh[_-]?token|bearer)\s*[:= ]\s*["']?([A-Za-z0-9._\-]{20,})`), group: 1, base: ConfidenceMedium, mask: "[REDACTED]", prefilter: []string{"token", "bearer"}, Example: "Authorization: Bearer EXAMPLEexampleEXAMPLEexample"},
	{ID: "password", Profile: "credentials", Name: "비밀번호 값", pattern: regexp.MustCompile(`(?i)(?:password|passwd|pwd|비밀번호)\s*[:=]\s*["']?([^"',}\]\s]{6,})`), group: 1, base: ConfidenceMedium, mask: "[REDACTED]", prefilter: []string{"pass", "pwd", "비밀번호"}, Example: "password=EXAMPLE-pass-01"},
	{ID: "api_key", Profile: "credentials", Name: "API 키 값", pattern: regexp.MustCompile(`(?i)(?:api[_-]?key|x-api-key|secret[_-]?key|client[_-]?secret)\s*[:=]\s*["']?([A-Za-z0-9._\-]{16,})`), group: 1, base: ConfidenceMedium, mask: "[REDACTED]", prefilter: []string{"key", "secret"}, Example: "api_key=EXAMPLEexample00000000"},

	// 금융 정보 (financial)
	{ID: "credit_card", Profile: "financial", Name: "카드 번호", Description: "국제 브랜드 범위와 Luhn 검증을 통과한 13~19자리", pattern: regexp.MustCompile(`\b\d(?:[ -]?\d){12,18}\b`), base: ConfidenceHigh, check: checkCard, mask: "[REDACTED_CARD]", context: []string{"카드", "card", "결제", "visa", "master"}, Example: "4111 1111 1111 1111"},
	{ID: "kr_bank_account", Profile: "financial", Name: "국내 계좌 번호", Description: "계좌·입금·은행 같은 단어 근처의 계좌 형식 숫자", pattern: regexp.MustCompile(`\b\d{2,6}-\d{2,6}-\d{2,7}(?:-\d{1,3})?\b`), base: ConfidenceNone, check: checkNotRepeated, mask: "[REDACTED_ACCOUNT]", context: []string{"계좌", "입금", "송금", "은행", "account", "bank"}, Example: "입금 계좌: 110-123-456789"},
	{ID: "iban", Profile: "financial", Name: "IBAN", Description: "mod-97 검증을 통과한 국제 계좌 번호", pattern: regexp.MustCompile(`\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b`), base: ConfidenceHigh, check: checkIBAN, mask: "[REDACTED_IBAN]", Example: "GB82 WEST 1234 5698 7654 32"},
	{ID: "us_routing_number", Profile: "financial", Name: "미국 은행 라우팅 번호", pattern: regexp.MustCompile(`\b\d{9}\b`), base: ConfidenceNone, check: checkABARouting, mask: "[REDACTED_ROUTING]", context: []string{"routing", "aba", "transit"}, Example: "ABA routing 021000021"},

	// 정부 식별번호 (government)
	{ID: "kr_rrn", Profile: "government", Name: "주민·외국인등록번호", Description: "생년월일·성별 자리가 유효한 13자리(검증 숫자 일치 시 높은 신뢰도)", pattern: regexp.MustCompile(`\b\d{6}[- ]?[0-9]\d{6}\b`), base: ConfidenceMedium, check: checkRRN, mask: "[REDACTED_RRN]", context: []string{"주민", "외국인등록", "rrn", "resident"}, Example: "900101-1234561"},
	{ID: "kr_business_number", Profile: "government", Name: "사업자등록번호", Description: "검증 숫자가 맞는 10자리", pattern: regexp.MustCompile(`\b\d{3}-\d{2}-\d{5}\b`), base: ConfidenceMedium, check: checkBizNo, mask: "[REDACTED_BIZNO]", context: []string{"사업자", "business"}, Example: "123-45-67891"},
	{ID: "kr_driver_license", Profile: "government", Name: "운전면허번호", pattern: regexp.MustCompile(`\b\d{2}-\d{2}-\d{6}-\d{2}\b`), base: ConfidenceMedium, check: checkKRDriverLicense, mask: "[REDACTED_DRIVER_LICENSE]", context: []string{"운전면허", "면허", "driver"}, Example: "11-23-456789-01"},
	{ID: "kr_passport", Profile: "government", Name: "여권 번호", pattern: regexp.MustCompile(`\b[MSRODG]\d{3}[A-Z]?\d{4,5}\b`), base: ConfidenceNone, mask: "[REDACTED_PASSPORT]", context: []string{"여권", "passport"}, Example: "여권번호 M12345678"},
	{ID: "us_ssn", Profile: "government", Name: "미국 사회보장번호(SSN)", pattern: regexp.MustCompile(`\b\d{3}-\d{2}-\d{4}\b`), base: ConfidenceMedium, check: checkUSSSN, mask: "[REDACTED_SSN]", context: []string{"ssn", "social security"}, Example: "SSN 123-45-6789"},
	{ID: "us_itin", Profile: "government", Name: "미국 개인납세자번호(ITIN)", pattern: regexp.MustCompile(`\b9\d{2}-(?:5\d|6[0-5]|7\d|8[0-8]|9[0-2]|9[4-9])-\d{4}\b`), base: ConfidenceMedium, mask: "[REDACTED_ITIN]", context: []string{"itin", "taxpayer"}, Example: "ITIN 912-70-1234"},

	// 개인정보 (pii)
	{ID: "email", Profile: "pii", Name: "이메일 주소", pattern: regexp.MustCompile(`\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b`), base: ConfidenceHigh, around: insideURLAuthority, mask: "[REDACTED_EMAIL]", prefilter: []string{"@"}, Example: "kim.minsu@example.com"},
	{ID: "kr_mobile", Profile: "pii", Name: "휴대전화 번호", pattern: regexp.MustCompile(`\b01[016789][-. ]?\d{3,4}[-. ]?\d{4}\b`), base: ConfidenceHigh, mask: "[REDACTED_PHONE_KR]", context: []string{"전화", "연락처", "휴대", "phone", "mobile"}, Example: "010-1234-5678"},
	{ID: "kr_landline", Profile: "pii", Name: "유선 전화번호", pattern: regexp.MustCompile(`\b0(?:2|3[1-3]|4[1-4]|5[1-5]|6[1-4]|70)[-. ]\d{3,4}[-. ]\d{4}\b`), base: ConfidenceMedium, mask: "[REDACTED_PHONE_KR]", context: []string{"전화", "연락처", "tel", "phone"}, Example: "02-1234-5678"},
	{ID: "intl_phone", Profile: "pii", Name: "국제 형식 전화번호", pattern: regexp.MustCompile(`\+\d{1,3}[ -]?\(?\d{1,4}\)?[ -]?\d{3,4}[ -]?\d{4}\b`), base: ConfidenceLow, mask: "[REDACTED_PHONE]", context: []string{"phone", "tel", "전화", "연락처"}, prefilter: []string{"+"}, Example: "+82 10 1234 5678"},
	{ID: "kr_address", Profile: "pii", Name: "도로명 주소", pattern: regexp.MustCompile(`(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[가-힣]*\s+[가-힣]+(?:시|군|구)\s+(?:[가-힣]+(?:구|읍|면)\s+)?[가-힣0-9]+(?:로|길)\s*\d+(?:-\d+)?`), base: ConfidenceMedium, mask: "[REDACTED_ADDRESS]", context: []string{"주소", "거주", "배송", "address"}, Example: "서울특별시 강남구 테헤란로 123"},
	{ID: "date_of_birth", Profile: "pii", Name: "생년월일", pattern: regexp.MustCompile(`\b(?:19|20)\d{2}[-./년 ]\s?(?:0?[1-9]|1[0-2])[-./월 ]\s?(?:0?[1-9]|[12]\d|3[01])일?`), base: ConfidenceNone, mask: "[REDACTED_DOB]", context: []string{"생년월일", "생일", "출생", "birth", "dob"}, Example: "생년월일 1990-01-01"},
	{ID: "ipv4_public", Profile: "pii", Name: "공인 IP 주소", pattern: regexp.MustCompile(`\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b`), base: ConfidenceLow, check: checkPublicIPv4, mask: "[REDACTED_IPV4]", context: []string{"ip", "접속", "address"}, Example: "203.0.113.45"},

	// 의료 정보 (health)
	{ID: "kr_health_insurance", Profile: "health", Name: "건강보험 증 번호", pattern: regexp.MustCompile(`\b\d{1}-?\d{10}\b`), base: ConfidenceNone, check: checkNotRepeated, mask: "[REDACTED_HEALTH_ID]", context: []string{"건강보험", "보험증", "health insurance"}, Example: "건강보험증 번호 5-1234567890"},
	{ID: "medical_record_number", Profile: "health", Name: "환자·의무기록 번호", pattern: regexp.MustCompile(`\b[A-Z]{0,3}\d{6,12}\b`), base: ConfidenceNone, check: checkNotRepeated, mask: "[REDACTED_MRN]", context: []string{"환자번호", "등록번호", "의무기록", "차트번호", "mrn", "medical record", "patient id"}, Example: "환자번호 20230045123"},
	{ID: "diagnosis_code", Profile: "health", Name: "진단 코드(ICD-10/KCD)", pattern: regexp.MustCompile(`\b[A-TV-Z]\d{2}(?:\.\d{1,2})?\b`), base: ConfidenceNone, mask: "[REDACTED_DIAGNOSIS]", context: []string{"진단", "상병", "질병코드", "kcd", "icd", "diagnosis"}, Example: "진단 코드 E11.9"},
}

// ProfileInfo describes a predefined profile.
type ProfileInfo struct {
	ID          string
	Name        string
	Description string
	// DefaultMinConfidence and DefaultMinMatches are what a profile uses until an
	// operator tunes it.
	DefaultMinConfidence Confidence
	DefaultMinMatches    int
	// RecordOf, when set, makes this a record profile: it matches when at least
	// RecordDistinct different entries from RecordOf occur within RecordWindow
	// bytes of each other — a row of personal data rather than one stray value.
	RecordOf       []string
	RecordDistinct int
	RecordWindow   int
}

var builtinProfiles = []ProfileInfo{
	{ID: "credentials", Name: "자격 증명·비밀", Description: "API 키, 토큰, 개인 키, 비밀번호, DB 연결 문자열, 웹훅 URL", DefaultMinConfidence: ConfidenceLow, DefaultMinMatches: 1},
	{ID: "financial", Name: "금융 정보", Description: "카드 번호(Luhn), 계좌 번호, IBAN(mod-97), 라우팅 번호", DefaultMinConfidence: ConfidenceMedium, DefaultMinMatches: 1},
	{ID: "government", Name: "정부 식별번호", Description: "주민·외국인등록번호, 사업자등록번호, 운전면허·여권 번호, SSN·ITIN", DefaultMinConfidence: ConfidenceMedium, DefaultMinMatches: 1},
	{ID: "pii", Name: "개인 식별 정보", Description: "이메일, 전화번호, 주소, 생년월일, 공인 IP", DefaultMinConfidence: ConfidenceMedium, DefaultMinMatches: 1},
	{ID: "health", Name: "의료 정보", Description: "건강보험 번호, 환자·의무기록 번호, 진단 코드 (문맥 단어가 있을 때만)", DefaultMinConfidence: ConfidenceMedium, DefaultMinMatches: 1},
	{ID: "pii_record", Name: "개인정보 레코드", Description: "서로 다른 개인정보 3종 이상이 가까이 함께 나올 때만 탐지 — 한 사람의 정보 묶음", DefaultMinConfidence: ConfidenceMedium, DefaultMinMatches: 1,
		RecordOf:       []string{"email", "kr_mobile", "kr_landline", "kr_address", "date_of_birth", "kr_rrn", "kr_driver_license", "kr_passport", "us_ssn", "credit_card", "kr_bank_account"},
		RecordDistinct: 3, RecordWindow: 400},
}

var entryByID = func() map[string]*Entry {
	out := make(map[string]*Entry, len(builtinEntries))
	for _, e := range builtinEntries {
		out[e.ID] = e
	}
	return out
}()

// BuiltinEntries returns the predefined detection entries in catalog order.
func BuiltinEntries() []*Entry { return append([]*Entry(nil), builtinEntries...) }

// BuiltinProfiles returns the predefined profiles in catalog order.
func BuiltinProfiles() []ProfileInfo { return append([]ProfileInfo(nil), builtinProfiles...) }

// LookupEntry returns a predefined entry by id.
func LookupEntry(id string) (*Entry, bool) {
	e, ok := entryByID[id]
	return e, ok
}

// ProfileEntries lists the predefined entries of a predefined profile. A record
// profile has none of its own; it reads the entries it is a record of.
func ProfileEntries(profileID string) []*Entry {
	out := []*Entry{}
	for _, e := range builtinEntries {
		if e.Profile == profileID {
			out = append(out, e)
		}
	}
	return out
}

func builtinProfile(id string) (ProfileInfo, bool) {
	for _, p := range builtinProfiles {
		if p.ID == id {
			return p, true
		}
	}
	return ProfileInfo{}, false
}
