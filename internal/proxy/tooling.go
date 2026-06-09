package proxy

import (
	"encoding/json"
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

// complexityScore is a 0-100 proxy for request complexity used by the Explainability
// View to justify routing/tier decisions. It blends prompt size (token estimate),
// conversation depth (message count) and tool surface (declared/called tools). It is a
// heuristic, not a model-derived score, and is documented as such in the UI.
func complexityScore(prompts []store.PromptLog, toolCount int) int {
	tokens := 0
	messages := 0
	for _, p := range prompts {
		text := p.RedactedText
		if text == "" {
			text = p.ContentText
		}
		tokens += audit.EstimateTokens(text)
		messages++
	}
	norm := func(x, cap float64) float64 {
		if cap <= 0 {
			return 0
		}
		if x > cap {
			return 1
		}
		return x / cap
	}
	score := 100 * (0.55*norm(float64(tokens), 8000) +
		0.25*norm(float64(messages), 20) +
		0.20*norm(float64(toolCount), 10))
	if score > 100 {
		score = 100
	}
	return int(score + 0.5)
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
