package proxy

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"

	"vibe-coders/internal/store"
)

// AI Code Output Verification Gate (1차).
//
// 게이트웨이가 모델 응답에서 코드블록을 추출해 언어별 정적 점검(위험 API·파괴적 명령·하드코딩
// 시크릿·구문 균형)을 수행하고, 위험도와 테스트 가능성 힌트를 산출한다. 폐쇄망에서 동작하도록
// 외부 컴파일러·린터를 호출하지 않고 의존성 0의 규칙 기반으로만 평가한다. 원문 코드는 저장하지
// 않으며 해시·줄수·발견 항목(규칙명·줄번호)만 남긴다 — 표준 제약(원문 미저장)과 일치.

// codeBlock is a fenced code block extracted from a model response (raw content kept only
// in-memory for analysis; never persisted).
type codeBlock struct {
	Lang    string
	Content string
	Lines   int
}

// codeFinding is one static-analysis hit. It carries the rule name and line number only —
// never the matched source text — so it is safe to store and return.
type codeFinding struct {
	Severity string `json:"severity"` // high | medium | info
	Category string `json:"category"` // destructive | exec | injection | secret | syntax | quality
	Rule     string `json:"rule"`
	Lang     string `json:"lang"`
	Line     int    `json:"line"` // 1-based; 0 = block-level
	Detail   string `json:"detail"`
}

// codeBlockReport is the per-block verdict (safe metadata only).
type codeBlockReport struct {
	Index    int           `json:"index"`
	Lang     string        `json:"lang"`
	Lines    int           `json:"lines"`
	Hash     string        `json:"hash"` // sha256 prefix of normalized content
	Findings []codeFinding `json:"findings"`
	Risk     string        `json:"risk"`     // high | medium | low
	Testable bool          `json:"testable"` // looks like runnable/standalone code (heuristic)
}

// codeVerifyReport is the response-level verdict.
type codeVerifyReport struct {
	HasCode    bool              `json:"has_code"`
	BlockCount int               `json:"block_count"`
	Languages  []string          `json:"languages"`
	Risk       string            `json:"risk"` // high | medium | low | none
	Counts     map[string]int    `json:"counts"`
	Blocks     []codeBlockReport `json:"blocks"`
	Note       string            `json:"note"`
}

var codeFenceRe = regexp.MustCompile("(?s)```([A-Za-z0-9_+#.-]*)\\n(.*?)```")

// extractCodeBlocks pulls fenced code blocks (with their info-string language) out of a
// markdown-ish response. Language is normalized to a canonical key.
func extractCodeBlocks(text string) []codeBlock {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	blocks := []codeBlock{}
	for _, m := range codeFenceRe.FindAllStringSubmatch(text, -1) {
		content := m[2]
		if strings.TrimSpace(content) == "" {
			continue
		}
		blocks = append(blocks, codeBlock{
			Lang:    canonicalLang(m[1], content),
			Content: content,
			Lines:   strings.Count(strings.TrimRight(content, "\n"), "\n") + 1,
		})
	}
	return blocks
}

// canonicalLang maps a fence info-string to a canonical language key, falling back to a
// lightweight content heuristic when the fence carries no language.
func canonicalLang(fence, content string) string {
	f := strings.ToLower(strings.TrimSpace(fence))
	switch f {
	case "py", "python", "python3":
		return "python"
	case "js", "javascript", "jsx", "node":
		return "javascript"
	case "ts", "typescript", "tsx":
		return "typescript"
	case "go", "golang":
		return "go"
	case "java":
		return "java"
	case "sql", "mysql", "postgresql", "psql", "plpgsql":
		return "sql"
	case "sh", "bash", "shell", "zsh", "console":
		return "shell"
	case "":
		return guessLang(content)
	default:
		return f
	}
}

func guessLang(content string) string {
	c := content
	switch {
	case strings.Contains(c, "package ") && strings.Contains(c, "func "):
		return "go"
	case strings.Contains(c, "def ") || strings.Contains(c, "import ") && strings.Contains(c, ":"):
		return "python"
	case strings.Contains(c, "public class ") || strings.Contains(c, "System.out."):
		return "java"
	case regexp.MustCompile(`(?i)\b(select|insert|update|delete|create|drop)\b`).MatchString(c) && strings.Contains(c, ";"):
		return "sql"
	case strings.Contains(c, "function ") || strings.Contains(c, "const ") || strings.Contains(c, "=>"):
		return "javascript"
	case strings.HasPrefix(strings.TrimSpace(c), "#!") || strings.Contains(c, "sudo ") || strings.Contains(c, "apt-get"):
		return "shell"
	default:
		return "unknown"
	}
}

// dangerRule is a per-language static-analysis rule (substring or regex). Air-gapped: pure
// pattern matching, no external process.
type dangerRule struct {
	langs    []string // empty = all languages
	re       *regexp.Regexp
	severity string
	category string
	rule     string
	detail   string
}

var codeDangerRules = []dangerRule{
	// Destructive / dangerous shell.
	{langs: []string{"shell"}, re: regexp.MustCompile(`\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r`), severity: "high", category: "destructive", rule: "rm_rf", detail: "재귀 강제 삭제(rm -rf)"},
	{langs: []string{"shell"}, re: regexp.MustCompile(`:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`), severity: "high", category: "destructive", rule: "fork_bomb", detail: "포크 폭탄"},
	{langs: []string{"shell"}, re: regexp.MustCompile(`\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b`), severity: "high", category: "exec", rule: "curl_pipe_sh", detail: "원격 스크립트 직접 실행(curl|sh)"},
	{langs: []string{"shell"}, re: regexp.MustCompile(`\bchmod\s+(-R\s+)?777\b`), severity: "medium", category: "quality", rule: "chmod_777", detail: "과도한 권한(chmod 777)"},
	{langs: []string{"shell"}, re: regexp.MustCompile(`\b(dd\s+if=|mkfs\.|>\s*/dev/sd)`), severity: "high", category: "destructive", rule: "disk_write", detail: "디스크 직접 쓰기"},
	// Python.
	{langs: []string{"python"}, re: regexp.MustCompile(`\b(eval|exec)\s*\(`), severity: "high", category: "exec", rule: "py_eval_exec", detail: "동적 코드 실행(eval/exec)"},
	{langs: []string{"python"}, re: regexp.MustCompile(`\bos\.system\s*\(`), severity: "high", category: "exec", rule: "py_os_system", detail: "셸 명령 실행(os.system)"},
	{langs: []string{"python"}, re: regexp.MustCompile(`shell\s*=\s*True`), severity: "high", category: "injection", rule: "py_shell_true", detail: "subprocess shell=True(주입 위험)"},
	{langs: []string{"python"}, re: regexp.MustCompile(`\bpickle\.(load|loads)\s*\(`), severity: "medium", category: "injection", rule: "py_pickle", detail: "신뢰 불가 역직렬화(pickle)"},
	{langs: []string{"python"}, re: regexp.MustCompile(`\byaml\.load\s*\((?:[^)]*)\)`), severity: "medium", category: "injection", rule: "py_yaml_load", detail: "yaml.load(SafeLoader 미지정)"},
	// JS/TS.
	{langs: []string{"javascript", "typescript"}, re: regexp.MustCompile(`\beval\s*\(`), severity: "high", category: "exec", rule: "js_eval", detail: "동적 코드 실행(eval)"},
	{langs: []string{"javascript", "typescript"}, re: regexp.MustCompile(`child_process|\.exec(Sync)?\s*\(`), severity: "high", category: "exec", rule: "js_child_process", detail: "셸 명령 실행(child_process)"},
	{langs: []string{"javascript", "typescript"}, re: regexp.MustCompile(`dangerouslySetInnerHTML|\.innerHTML\s*=`), severity: "medium", category: "injection", rule: "js_innerhtml", detail: "XSS 위험(innerHTML)"},
	// Go.
	{langs: []string{"go"}, re: regexp.MustCompile(`exec\.Command\s*\(`), severity: "medium", category: "exec", rule: "go_exec_command", detail: "외부 명령 실행(exec.Command)"},
	{langs: []string{"go"}, re: regexp.MustCompile(`\bunsafe\.`), severity: "medium", category: "quality", rule: "go_unsafe", detail: "unsafe 패키지 사용"},
	{langs: []string{"go"}, re: regexp.MustCompile(`os\.RemoveAll\s*\(`), severity: "medium", category: "destructive", rule: "go_removeall", detail: "재귀 삭제(os.RemoveAll)"},
	// Java.
	{langs: []string{"java"}, re: regexp.MustCompile(`Runtime\.getRuntime\(\)\.exec|new\s+ProcessBuilder`), severity: "high", category: "exec", rule: "java_exec", detail: "셸 명령 실행(Runtime/ProcessBuilder)"},
	{langs: []string{"java"}, re: regexp.MustCompile(`new\s+ObjectInputStream`), severity: "medium", category: "injection", rule: "java_deser", detail: "역직렬화 위험(ObjectInputStream)"},
	// SQL.
	{langs: []string{"sql"}, re: regexp.MustCompile(`(?i)\bdrop\s+(table|database|schema)\b`), severity: "high", category: "destructive", rule: "sql_drop", detail: "스키마 파괴(DROP)"},
	{langs: []string{"sql"}, re: regexp.MustCompile(`(?i)\btruncate\s+table\b`), severity: "high", category: "destructive", rule: "sql_truncate", detail: "테이블 비우기(TRUNCATE)"},
	{langs: []string{"sql"}, re: regexp.MustCompile(`(?i)\bgrant\s+all\b`), severity: "medium", category: "quality", rule: "sql_grant_all", detail: "과도한 권한 부여(GRANT ALL)"},
	{langs: []string{"sql"}, re: regexp.MustCompile(`(?i)\bor\s+1\s*=\s*1\b|;\s*--`), severity: "high", category: "injection", rule: "sql_injection", detail: "SQL 주입 의심 패턴"},
}

// sqlNoWhereRe flags DELETE/UPDATE without a WHERE clause (best-effort, per statement).
var (
	sqlDeleteRe = regexp.MustCompile(`(?is)\b(delete\s+from|update)\s+[^;]*`)
	sqlWhereRe  = regexp.MustCompile(`(?i)\bwhere\b`)
)

func ruleAppliesTo(r dangerRule, lang string) bool {
	if len(r.langs) == 0 {
		return true
	}
	for _, l := range r.langs {
		if l == lang {
			return true
		}
	}
	return false
}

// analyzeBlock runs the static rules over a single block and produces a safe report.
func analyzeBlock(idx int, b codeBlock) codeBlockReport {
	findings := []codeFinding{}
	lines := strings.Split(b.Content, "\n")

	addPatternFindings := func() {
		for _, rule := range codeDangerRules {
			if !ruleAppliesTo(rule, b.Lang) {
				continue
			}
			for i, ln := range lines {
				if rule.re.MatchString(ln) {
					findings = append(findings, codeFinding{
						Severity: rule.severity, Category: rule.category, Rule: rule.rule,
						Lang: b.Lang, Line: i + 1, Detail: rule.detail,
					})
				}
			}
		}
	}
	addPatternFindings()

	// SQL DELETE/UPDATE without WHERE.
	if b.Lang == "sql" {
		for _, stmt := range sqlDeleteRe.FindAllString(b.Content, -1) {
			if !sqlWhereRe.MatchString(stmt) {
				findings = append(findings, codeFinding{
					Severity: "high", Category: "destructive", Rule: "sql_no_where",
					Lang: "sql", Line: 0, Detail: "WHERE 없는 DELETE/UPDATE(전체 행 영향)",
				})
				break
			}
		}
	}

	// Hardcoded secrets (reuse the secret firewall detector; store types only, never values).
	for _, t := range findingTypes(detectSecretsInText(b.Content)) {
		findings = append(findings, codeFinding{
			Severity: "high", Category: "secret", Rule: "hardcoded_" + t,
			Lang: b.Lang, Line: 0, Detail: "하드코딩된 시크릿(" + t + ")",
		})
	}

	// Syntax sanity: unbalanced brackets / unclosed fence-ish content.
	if cat := bracketImbalance(b.Content); cat != "" {
		findings = append(findings, codeFinding{
			Severity: "medium", Category: "syntax", Rule: "unbalanced_" + cat,
			Lang: b.Lang, Line: 0, Detail: "괄호 불균형(" + cat + ")",
		})
	}

	risk := "low"
	for _, f := range findings {
		if f.Severity == "high" {
			risk = "high"
			break
		}
		if f.Severity == "medium" {
			risk = "medium"
		}
	}

	norm := strings.Join(strings.Fields(b.Content), " ")
	sum := sha256.Sum256([]byte(b.Lang + "|" + norm))

	return codeBlockReport{
		Index:    idx,
		Lang:     b.Lang,
		Lines:    b.Lines,
		Hash:     hex.EncodeToString(sum[:])[:16],
		Findings: findings,
		Risk:     risk,
		Testable: looksTestable(b),
	}
}

// bracketImbalance returns the first bracket kind found unbalanced, or "" if balanced.
// String/char literals are not parsed (best-effort), so this only flags gross imbalance.
func bracketImbalance(content string) string {
	pairs := []struct {
		open, close byte
		name        string
	}{{'(', ')', "paren"}, {'{', '}', "brace"}, {'[', ']', "bracket"}}
	for _, p := range pairs {
		bal := 0
		for i := 0; i < len(content); i++ {
			switch content[i] {
			case p.open:
				bal++
			case p.close:
				bal--
			}
			if bal < 0 {
				return p.name
			}
		}
		if bal != 0 {
			return p.name
		}
	}
	return ""
}

// looksTestable is a heuristic: does the block resemble standalone, runnable code (has a
// function/class/main or test markers) rather than a one-line snippet or pseudo-code?
func looksTestable(b codeBlock) bool {
	if b.Lines < 3 {
		return false
	}
	c := b.Content
	switch b.Lang {
	case "go":
		return strings.Contains(c, "func ")
	case "python":
		return strings.Contains(c, "def ") || strings.Contains(c, "class ")
	case "javascript", "typescript":
		return strings.Contains(c, "function ") || strings.Contains(c, "=>") || strings.Contains(c, "class ")
	case "java":
		return strings.Contains(c, "class ") && strings.Contains(c, "(")
	case "sql":
		return strings.Contains(c, ";")
	case "shell":
		return true
	default:
		return false
	}
}

// verifyCode is the top-level entry: extract code blocks and produce a response-level report.
func verifyCode(text string) codeVerifyReport {
	blocks := extractCodeBlocks(text)
	rep := codeVerifyReport{
		Counts: map[string]int{"high": 0, "medium": 0, "info": 0, "secret": 0, "syntax": 0, "testable": 0},
		Blocks: []codeBlockReport{},
		Note:   "정적 규칙 기반 점검입니다(폐쇄망·외부 컴파일러 미사용). 원문 코드는 저장하지 않고 해시·줄수·발견 규칙만 남깁니다.",
	}
	if len(blocks) == 0 {
		rep.Risk = "none"
		return rep
	}
	rep.HasCode = true
	rep.BlockCount = len(blocks)

	langSeen := map[string]bool{}
	langs := []string{}
	overall := "low"
	for i, b := range blocks {
		br := analyzeBlock(i, b)
		rep.Blocks = append(rep.Blocks, br)
		if !langSeen[b.Lang] {
			langSeen[b.Lang] = true
			langs = append(langs, b.Lang)
		}
		if br.Testable {
			rep.Counts["testable"]++
		}
		for _, f := range br.Findings {
			switch f.Severity {
			case "high":
				rep.Counts["high"]++
			case "medium":
				rep.Counts["medium"]++
			default:
				rep.Counts["info"]++
			}
			if f.Category == "secret" {
				rep.Counts["secret"]++
			}
			if f.Category == "syntax" {
				rep.Counts["syntax"]++
			}
		}
		switch br.Risk {
		case "high":
			overall = "high"
		case "medium":
			if overall != "high" {
				overall = "medium"
			}
		}
	}
	rep.Languages = langs
	rep.Risk = overall
	return rep
}

// buildCodeVerifyLog runs the gate over a response's text and returns a persistable verdict,
// or nil when there is no code to verify. Only safe metadata is stored (risk, counts, and
// per-finding rule/line/detail) — never the raw code. Findings are capped to bound row size.
func buildCodeVerifyLog(requestID, traceID, text string) *store.CodeVerifyLog {
	if strings.TrimSpace(text) == "" {
		return nil
	}
	rep := verifyCode(text)
	if !rep.HasCode {
		return nil
	}
	findings := []codeFinding{}
	for _, b := range rep.Blocks {
		for _, f := range b.Findings {
			findings = append(findings, f)
			if len(findings) >= 100 {
				break
			}
		}
		if len(findings) >= 100 {
			break
		}
	}
	fj, err := json.Marshal(findings)
	if err != nil {
		fj = []byte("[]")
	}
	return &store.CodeVerifyLog{
		ID:            newID("cv"),
		RequestID:     requestID,
		TraceID:       traceID,
		HasCode:       true,
		Risk:          rep.Risk,
		BlockCount:    rep.BlockCount,
		Languages:     strings.Join(rep.Languages, ","),
		HighCount:     rep.Counts["high"],
		MediumCount:   rep.Counts["medium"],
		SyntaxCount:   rep.Counts["syntax"],
		SecretCount:   rep.Counts["secret"],
		TestableCount: rep.Counts["testable"],
		FindingsJSON:  string(fj),
	}
}

// handleCodeVerify lets admins (and internal callers) verify arbitrary text on demand.
// Air-gapped, stateless: nothing is persisted. POST /admin/code-verify {text}
func (s *Server) handleCodeVerify(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "POST required", "invalid_request_error", "method_not_allowed")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "read error", "invalid_request_error", "bad_request")
		return
	}
	var req struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON", "invalid_request_error", "bad_request")
		return
	}
	if strings.TrimSpace(req.Text) == "" {
		writeOpenAIError(w, http.StatusBadRequest, "text required", "invalid_request_error", "bad_request")
		return
	}
	writeJSON(w, http.StatusOK, verifyCode(req.Text))
}
