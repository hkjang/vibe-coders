package proxy

import (
	"encoding/json"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

// parsedTool is the intermediate result before it becomes a store.ToolInvocation.
type parsedTool struct {
	Server    string
	Tool      string
	Source    string // definition | call | result
	IsMCP     bool
	IsError   bool
	Sensitive bool // arguments / result contain secret or PII markers
	ArgHash   string
}

// argsString normalizes a tool arguments value into text for hashing / scanning.
func argsString(value any) string {
	if value == nil {
		return ""
	}
	if s, ok := value.(string); ok {
		return s
	}
	return jsonString(value)
}

// classifyToolName splits a flat tool name into (server, tool, isMCP).
// Recognizes the common MCP bridge conventions used by Claude Code, Cline, Roo Code:
//   - "mcp__<server>__<tool>"      (double-underscore namespacing)
//   - "<server>.<tool>"            (dotted namespacing, e.g. github.create_issue)
//   - "<server>/<tool>"            (slash namespacing)
//
// Anything else is treated as a plain function (isMCP=false, server="").
func classifyToolName(name string) (server string, tool string, isMCP bool) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", "", false
	}
	if strings.HasPrefix(name, "mcp__") {
		rest := strings.TrimPrefix(name, "mcp__")
		if idx := strings.Index(rest, "__"); idx > 0 {
			return rest[:idx], rest[idx+2:], true
		}
		return rest, rest, true
	}
	// Dotted or slashed namespacing: only treat as MCP-ish if there is exactly one
	// separator and both halves look like identifiers. We keep isMCP=false here
	// because plain dotted names also appear in non-MCP function calling; the
	// server label is still useful for grouping.
	for _, sep := range []string{"/", "."} {
		if idx := strings.Index(name, sep); idx > 0 && idx < len(name)-1 {
			left := name[:idx]
			right := name[idx+1:]
			if isToolIdent(left) && isToolIdent(right) {
				return left, right, false
			}
		}
	}
	return "", name, false
}

func isToolIdent(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if !(r == '_' || r == '-' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')) {
			return false
		}
	}
	return true
}

// extractRequestTools pulls tool definitions, prior tool calls, and tool-result
// messages out of an OpenAI-compatible request body.
func extractRequestTools(body []byte) []parsedTool {
	if len(body) == 0 {
		return nil
	}
	var root map[string]any
	if err := json.Unmarshal(body, &root); err != nil {
		return nil
	}
	out := []parsedTool{}

	// 1) tools[] definitions (chat/completions + Responses API)
	if tools, ok := root["tools"].([]any); ok {
		for _, item := range tools {
			t, _ := item.(map[string]any)
			if t == nil {
				continue
			}
			out = append(out, toolDefinitionFromEntry(t)...)
		}
	}
	// 2) legacy functions[] definitions
	if functions, ok := root["functions"].([]any); ok {
		for _, item := range functions {
			fn, _ := item.(map[string]any)
			if fn == nil {
				continue
			}
			if name, _ := fn["name"].(string); name != "" {
				server, tool, isMCP := classifyToolName(name)
				out = append(out, parsedTool{Server: server, Tool: tool, Source: "definition", IsMCP: isMCP})
			}
		}
	}
	// 3) messages: prior assistant tool_calls + role:tool results
	if messages, ok := root["messages"].([]any); ok {
		for _, item := range messages {
			msg, _ := item.(map[string]any)
			if msg == nil {
				continue
			}
			role, _ := msg["role"].(string)
			if calls, ok := msg["tool_calls"].([]any); ok {
				for _, c := range calls {
					if call, ok := c.(map[string]any); ok {
						out = append(out, toolCallFromEntry(call, "call")...)
					}
				}
			}
			if fnCall, ok := msg["function_call"].(map[string]any); ok {
				if name, _ := fnCall["name"].(string); name != "" {
					server, tool, isMCP := classifyToolName(name)
					out = append(out, parsedTool{Server: server, Tool: tool, Source: "call", IsMCP: isMCP,
						Sensitive: audit.Contains(argsString(fnCall["arguments"])), ArgHash: hashArgs(fnCall["arguments"])})
				}
			}
			if role == "tool" || role == "function" {
				name, _ := msg["name"].(string)
				server, tool, isMCP := classifyToolName(name)
				content := flattenContent(msg["content"])
				out = append(out, parsedTool{
					Server:    server,
					Tool:      tool,
					Source:    "result",
					IsMCP:     isMCP,
					IsError:   looksLikeToolError(content),
					Sensitive: audit.Contains(content),
					ArgHash:   audit.HashText(content),
				})
			}
		}
	}
	return out
}

// toolDefinitionFromEntry handles both chat-style {type:function, function:{name}}
// and Responses-API MCP entries {type:mcp, server_label, ...}.
func toolDefinitionFromEntry(t map[string]any) []parsedTool {
	typ, _ := t["type"].(string)
	switch typ {
	case "mcp", "mcp_call", "mcp_list_tools", "mcp_approval_request":
		server, _ := t["server_label"].(string)
		if server == "" {
			server, _ = t["server"].(string)
		}
		name, _ := t["name"].(string)
		if name == "" {
			name = "*"
		}
		return []parsedTool{{Server: strings.TrimSpace(server), Tool: name, Source: "definition", IsMCP: true}}
	case "function", "":
		fn, _ := t["function"].(map[string]any)
		name := ""
		if fn != nil {
			name, _ = fn["name"].(string)
		}
		if name == "" {
			name, _ = t["name"].(string)
		}
		if name == "" {
			return nil
		}
		server, tool, isMCP := classifyToolName(name)
		return []parsedTool{{Server: server, Tool: tool, Source: "definition", IsMCP: isMCP}}
	default:
		// built-in tool types like "web_search", "code_interpreter", "file_search"
		return []parsedTool{{Server: "builtin", Tool: typ, Source: "definition", IsMCP: false}}
	}
}

func toolCallFromEntry(call map[string]any, source string) []parsedTool {
	// chat style: {function:{name, arguments}}
	if fn, ok := call["function"].(map[string]any); ok {
		name, _ := fn["name"].(string)
		if name == "" {
			return nil
		}
		server, tool, isMCP := classifyToolName(name)
		return []parsedTool{{Server: server, Tool: tool, Source: source, IsMCP: isMCP,
			Sensitive: audit.Contains(argsString(fn["arguments"])), ArgHash: hashArgs(fn["arguments"])}}
	}
	// Responses API style: {type:"mcp_call", server_label, name, arguments}
	if name, ok := call["name"].(string); ok && name != "" {
		server, _ := call["server_label"].(string)
		isMCP := server != ""
		stool := name
		if server == "" {
			server, stool, isMCP = classifyToolName(name)
		}
		return []parsedTool{{Server: strings.TrimSpace(server), Tool: stool, Source: source, IsMCP: isMCP,
			Sensitive: audit.Contains(argsString(call["arguments"])), ArgHash: hashArgs(call["arguments"])}}
	}
	return nil
}

func hashArgs(value any) string {
	if value == nil {
		return ""
	}
	switch v := value.(type) {
	case string:
		if v == "" {
			return ""
		}
		return audit.HashText(v)
	default:
		return audit.HashText(jsonString(v))
	}
}

// looksLikeToolError heuristically flags tool result payloads that represent an error.
func looksLikeToolError(content string) bool {
	if content == "" {
		return false
	}
	lower := strings.ToLower(content)
	// Structured: {"isError":true} (MCP), {"error":...}, {"status":"error"}
	for _, marker := range []string{
		"\"iserror\":true", "\"iserror\": true",
		"\"is_error\":true", "\"is_error\": true",
		"\"status\":\"error\"", "\"status\": \"error\"",
	} {
		if strings.Contains(strings.ReplaceAll(lower, " ", ""), strings.ReplaceAll(marker, " ", "")) {
			return true
		}
	}
	// Common textual error prefixes
	for _, marker := range []string{"error:", "exception:", "traceback (most recent call last)", "command failed", "tool error"} {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

// taskTypeKeywords maps a coding task class to its trigger keywords (Korean + English).
// First class whose keyword is found (in declaration order) wins; order encodes priority
// so that more specific intents (debug/test) beat generic ones (generate/explain).
var taskTypeKeywords = []struct {
	kind     string
	keywords []string
}{
	{"debug", []string{"버그", "오류", "에러", "고쳐", "고쳐줘", "수정", "디버그", "bug", "error", "fix", "debug", "broken", "exception", "stack trace", "traceback"}},
	{"test", []string{"테스트", "단위 테스트", "유닛", "test", "unit test", "tests", "spec", "coverage"}},
	{"refactor", []string{"리팩터", "리팩토링", "정리", "개선", "최적화", "refactor", "clean up", "cleanup", "optimi", "simplify", "rename"}},
	{"translate", []string{"번역", "변환", "포팅", "마이그레이션", "translate", "convert", "port ", "migrate", "rewrite in"}},
	{"docs", []string{"문서", "주석", "설명서", "readme", "document", "docstring", "comment", "javadoc"}},
	{"review", []string{"리뷰", "검토", "review", "audit", "critique", "code review"}},
	{"explain", []string{"설명", "분석", "이해", "무엇", "왜", "explain", "analyze", "analyse", "what does", "how does", "understand", "describe"}},
	{"generate", []string{"생성", "만들어", "작성", "추가", "구현", "create", "generate", "implement", "build", "add ", "write ", "scaffold", "controller", "endpoint", "function", "class"}},
}

// classifyTaskType infers the coding task class from the prompt text. Heuristic
// (keyword) only — documented as such in the UI, like the complexity score.
func classifyTaskType(prompts []store.PromptLog) string {
	var b strings.Builder
	for _, p := range prompts {
		text := p.RedactedText
		if text == "" {
			text = p.ContentText
		}
		b.WriteString(text)
		b.WriteByte('\n')
	}
	lower := strings.ToLower(b.String())
	if strings.TrimSpace(lower) == "" {
		return "other"
	}
	for _, c := range taskTypeKeywords {
		for _, kw := range c.keywords {
			if strings.Contains(lower, kw) {
				return c.kind
			}
		}
	}
	return "other"
}

// fingerprintStopwords are generic instruction words dropped before fingerprinting,
// so the fingerprint keys on salient domain vocabulary rather than filler/verbs
// (the intent verb is already captured by task_type, which is folded in separately).
var fingerprintStopwords = map[string]bool{
	// English filler / generic verbs
	"the": true, "a": true, "an": true, "to": true, "of": true, "for": true, "and": true, "or": true,
	"in": true, "on": true, "is": true, "are": true, "this": true, "that": true, "with": true, "please": true,
	"me": true, "my": true, "you": true, "your": true, "it": true, "be": true, "do": true, "can": true,
	"make": true, "create": true, "write": true, "add": true, "generate": true, "implement": true,
	"build": true, "fix": true, "refactor": true, "explain": true, "analyze": true, "review": true,
	"code": true, "following": true, "below": true, "above": true, "give": true,
	// Korean filler / generic verbs (task intent captured by task_type)
	"만들어": true, "만들어줘": true, "생성": true, "생성해줘": true, "작성": true, "작성해줘": true,
	"해줘": true, "해": true, "좀": true, "주세요": true, "다음": true, "아래": true, "위": true,
	"코드": true, "이": true, "그": true, "을": true, "를": true, "의": true, "에": true, "는": true, "은": true,
	"가": true, "와": true, "과": true, "수": true, "있게": true, "대해": true, "관련": true,
}

var fingerprintCodeFence = regexp.MustCompile("(?s)```.*?```|`[^`]*`")
var fingerprintNonWord = regexp.MustCompile(`[^\p{L}\p{Nd}]+`)

// Korean object/topic particles and verb endings, longest-first, stripped once each
// so agglutinated forms collapse to the noun stem ("리팩토링해줘" → "리팩토링",
// "버그를" → "버그"). Heuristic, not a real morphological analyzer.
var krParticles = []string{"으로", "에서", "에게", "이라", "라고", "에", "를", "을", "이", "가", "은", "는", "의", "와", "과", "도", "로", "만"}
var krVerbEndings = []string{"해주세요", "해줄래", "해줘요", "해주라", "해주는", "해주", "해줘", "해라", "하라", "합니다", "하세요", "했어요", "했어", "해요", "하기", "하는", "한다", "했", "해", "줄래", "줘요", "주세요", "줘"}

func hasHangul(s string) bool {
	for _, r := range s {
		if r >= 0xAC00 && r <= 0xD7A3 {
			return true
		}
	}
	return false
}

// normalizeKoreanToken trims one trailing particle and one trailing verb ending
// from a Hangul token, guarding a 2-rune minimum so stems aren't over-truncated.
func normalizeKoreanToken(tok string) string {
	if !hasHangul(tok) {
		return tok
	}
	for _, p := range krParticles {
		if strings.HasSuffix(tok, p) && len([]rune(tok))-len([]rune(p)) >= 2 {
			tok = tok[:len(tok)-len(p)]
			break
		}
	}
	for _, suf := range krVerbEndings {
		if strings.HasSuffix(tok, suf) && len([]rune(tok))-len([]rune(suf)) >= 2 {
			tok = tok[:len(tok)-len(suf)]
			break
		}
	}
	return tok
}

// promptFingerprint derives a deterministic lexical fingerprint that groups
// near-identical / structurally-similar task prompts (the canned templates that
// coding tools and users repeat). Heuristic, NOT semantic embeddings — documented
// as such in the UI. Strips pasted code, drops filler/verb stopwords, then hashes
// the task type plus the canonical set of salient keywords.
func promptFingerprint(prompts []store.PromptLog) string {
	var b strings.Builder
	for _, p := range prompts {
		if p.Role == "assistant" || p.Role == "tool" {
			continue // fingerprint the instruction, not model/tool output
		}
		text := p.RedactedText
		if text == "" {
			text = p.ContentText
		}
		b.WriteString(text)
		b.WriteByte('\n')
	}
	raw := b.String()
	if strings.TrimSpace(raw) == "" {
		return ""
	}
	raw = fingerprintCodeFence.ReplaceAllString(raw, " ") // drop pasted code
	lower := strings.ToLower(raw)
	tokens := fingerprintNonWord.Split(lower, -1)
	freq := map[string]int{}
	for _, tok := range tokens {
		tok = normalizeKoreanToken(tok) // strip particles / verb endings so 노운+해줘 == 노운
		if len(tok) < 2 || fingerprintStopwords[tok] {
			continue
		}
		if _, err := strconv.Atoi(tok); err == nil {
			continue // pure numbers vary; ignore
		}
		freq[tok]++
	}
	// keep the most frequent salient tokens, then sort for determinism
	type kv struct {
		tok string
		n   int
	}
	salient := make([]kv, 0, len(freq))
	for t, n := range freq {
		salient = append(salient, kv{t, n})
	}
	sort.Slice(salient, func(i, j int) bool {
		if salient[i].n != salient[j].n {
			return salient[i].n > salient[j].n
		}
		return salient[i].tok < salient[j].tok
	})
	const topK = 10
	if len(salient) > topK {
		salient = salient[:topK]
	}
	keys := make([]string, 0, len(salient))
	for _, s := range salient {
		keys = append(keys, s.tok)
	}
	sort.Strings(keys)
	canonical := classifyTaskType(prompts) + "|" + strings.Join(keys, " ")
	return "fp_" + audit.HashText(canonical)[:10]
}

// previewModelComplexity does a lightweight parse to get (model, complexity) before
// any routing rewrite. Complexity depends only on prompts/tools, so it is stable
// across a model-only rewrite.
func previewModelComplexity(body []byte, endpoint string) (string, int) {
	model, _, prompts, _ := extractAudit(body, endpoint, false)
	toolCount := 0
	var root map[string]any
	if json.Unmarshal(body, &root) == nil {
		toolCount = countRequestTools(root)
	}
	return model, complexityScore(prompts, toolCount)
}

// toolInvocations stamps parsed tools with the request's identity context.
func toolInvocations(req store.RequestLog, tools []parsedTool) []store.ToolInvocation {
	if len(tools) == 0 {
		return nil
	}
	out := make([]store.ToolInvocation, 0, len(tools))
	for _, t := range tools {
		if t.Tool == "" {
			continue
		}
		out = append(out, store.ToolInvocation{
			ID:           newID("tool"),
			RequestID:    req.ID,
			TraceID:      req.TraceID,
			APIKeyID:     req.APIKeyID,
			ServerLabel:  t.Server,
			ToolName:     t.Tool,
			Source:       t.Source,
			IsMCP:        t.IsMCP,
			IsError:      t.IsError,
			ArgSensitive: t.Sensitive,
			ArgHash:      t.ArgHash,
			CreatedAt:    req.CreatedAt,
		})
	}
	return out
}
