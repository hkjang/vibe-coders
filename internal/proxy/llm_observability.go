package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

type llmMetadata struct {
	SessionID           string
	PromptName          string
	PromptVersion       string
	PromptVariablesHash string
	ToolCount           int
}

func llmRequestMetadata(r *http.Request, body []byte, traceID string) llmMetadata {
	meta := llmMetadata{
		SessionID:     firstNonEmptyHeader(r, "X-LLM-Session-ID", "X-Datadog-Session-ID", "X-Session-ID"),
		PromptName:    firstNonEmptyHeader(r, "X-LLM-Prompt-Name", "X-Prompt-Name"),
		PromptVersion: firstNonEmptyHeader(r, "X-LLM-Prompt-Version", "X-Prompt-Version"),
	}
	if meta.SessionID == "" {
		meta.SessionID = "trace:" + traceID
	}
	if meta.PromptName == "" {
		meta.PromptName = "ad-hoc"
	}
	meta.PromptVariablesHash = firstNonEmptyHeader(r, "X-LLM-Prompt-Variables-Hash", "X-Prompt-Variables-Hash")

	var root map[string]any
	if err := json.Unmarshal(body, &root); err == nil {
		meta.ToolCount = countRequestTools(root)
		applyStructuredPromptMetadata(&meta, root)
		if meta.PromptVariablesHash == "" {
			if metadata, ok := root["metadata"].(map[string]any); ok {
				if value, ok := metadata["prompt_variables"]; ok {
					meta.PromptVariablesHash = audit.HashText(jsonString(value))
				}
			}
		}
	}
	if meta.PromptVariablesHash == "" && len(body) > 0 {
		meta.PromptVariablesHash = audit.HashText(string(body))
	}
	return meta
}

func applyStructuredPromptMetadata(meta *llmMetadata, root map[string]any) {
	metadata, _ := root["metadata"].(map[string]any)
	if metadata == nil {
		return
	}
	for _, key := range []string{"prompt", "prompt_tracking", "_dd.ml_obs.prompt_tracking"} {
		value, ok := metadata[key]
		if !ok {
			continue
		}
		prompt, ok := promptMetadataMap(value)
		if !ok {
			continue
		}
		if meta.PromptName == "" || meta.PromptName == "ad-hoc" {
			meta.PromptName = firstPromptField(prompt, "id", "name")
		}
		if meta.PromptVersion == "" {
			meta.PromptVersion = firstPromptField(prompt, "version")
		}
		if meta.PromptVariablesHash == "" {
			if variables, ok := prompt["variables"]; ok {
				meta.PromptVariablesHash = audit.HashText(jsonString(variables))
			}
		}
	}
	if meta.PromptName == "" {
		meta.PromptName = "ad-hoc"
	}
}

func promptMetadataMap(value any) (map[string]any, bool) {
	switch typed := value.(type) {
	case map[string]any:
		return typed, true
	case string:
		var decoded map[string]any
		if err := json.Unmarshal([]byte(typed), &decoded); err == nil {
			return decoded, true
		}
	}
	return nil, false
}

func firstPromptField(prompt map[string]any, fields ...string) string {
	for _, field := range fields {
		if value, ok := prompt[field]; ok {
			if text := strings.TrimSpace(fmt.Sprint(value)); text != "" && text != "<nil>" {
				return text
			}
		}
	}
	return ""
}

func firstNonEmptyHeader(r *http.Request, names ...string) string {
	for _, name := range names {
		if value := strings.TrimSpace(r.Header.Get(name)); value != "" {
			return value
		}
	}
	return ""
}

func countRequestTools(root map[string]any) int {
	count := 0
	if tools, ok := root["tools"].([]any); ok {
		count += len(tools)
	}
	if functions, ok := root["functions"].([]any); ok {
		count += len(functions)
	}
	if messages, ok := root["messages"].([]any); ok {
		for _, item := range messages {
			message, _ := item.(map[string]any)
			if toolCalls, ok := message["tool_calls"].([]any); ok {
				count += len(toolCalls)
			}
			if _, ok := message["function_call"]; ok {
				count++
			}
		}
	}
	return count
}

func buildLLMEvaluations(record store.LogRecord, analysis ResponseAnalysis) []store.LLMEvaluation {
	now := time.Now().UTC()
	promptText := promptsText(record.Prompts)
	responseText := analysis.Text
	evaluations := []store.LLMEvaluation{
		evalBool(record, "prompt.pii", "safety", !strings.Contains(promptText, "[REDACTED"), "no_pii_detected", "prompt redaction markers indicate sensitive data", now),
		evalBool(record, "prompt.injection", "security", !keywordHit(promptText, promptInjectionKeywords), "no_injection_detected", "prompt contains jailbreak or instruction override keywords", now),
		evalBool(record, "prompt.toxicity", "safety", !keywordHit(promptText, toxicKeywords), "no_toxicity_detected", "prompt contains toxic content keywords", now),
		evalBool(record, "response.completed", "quality", record.Request.StatusCode >= 200 && record.Request.StatusCode < 300 && record.Request.Error == "" && analysis.FinishReason != "content_filter", "completed", "upstream returned error, copy error, or content_filter finish reason", now),
		evalBool(record, "cost.has_usage", "cost", analysis.HasUsage || record.Usage != nil, "usage_present", "provider did not return usage; gateway used estimates where possible", now),
		evalScore(record, "performance.first_chunk_ms", "performance", latencyScore(record.Request.FirstChunkMS, 1500), latencyLabel(record.Request.FirstChunkMS, 1500), "first response chunk latency", now),
	}
	if responseText != "" {
		redacted := audit.Redact(responseText)
		evaluations = append(evaluations,
			evalBool(record, "response.pii", "safety", !strings.Contains(redacted, "[REDACTED"), "no_pii_detected", "response text contains sensitive data markers", now),
			evalBool(record, "response.toxicity", "safety", !keywordHit(responseText, toxicKeywords), "no_toxicity_detected", "response contains toxic content keywords", now),
		)
	}
	// MCP / tool evaluations
	if hasToolResults(record.Tools) {
		evaluations = append(evaluations,
			evalBool(record, "tools.no_error", "tools", !hasToolError(record.Tools), "no_tool_error", "an MCP/tool result returned an error", now),
		)
	}
	if hasToolActivity(record.Tools) {
		evaluations = append(evaluations,
			evalBool(record, "tools.args_no_secret", "security", !hasSensitiveToolArgs(record.Tools), "no_secret_in_tool_io", "a tool call argument or result contained secret/PII markers", now),
		)
	}
	if mcpServers := distinctMCPServers(record.Tools); mcpServers > 0 {
		// informational evaluation: passes always, label carries the server count
		evaluations = append(evaluations, evalScore(record, "tools.mcp_servers", "tools", 1, "servers="+itoaProxy(mcpServers), "", now))
	}
	return evaluations
}

func hasToolResults(tools []store.ToolInvocation) bool {
	for _, t := range tools {
		if t.Source == "result" {
			return true
		}
	}
	return false
}

func hasToolError(tools []store.ToolInvocation) bool {
	for _, t := range tools {
		if t.IsError {
			return true
		}
	}
	return false
}

func hasToolActivity(tools []store.ToolInvocation) bool {
	for _, t := range tools {
		if t.Source == "call" || t.Source == "result" {
			return true
		}
	}
	return false
}

func hasSensitiveToolArgs(tools []store.ToolInvocation) bool {
	for _, t := range tools {
		if t.ArgSensitive {
			return true
		}
	}
	return false
}

func distinctMCPServers(tools []store.ToolInvocation) int {
	seen := map[string]bool{}
	for _, t := range tools {
		if t.IsMCP && t.ServerLabel != "" {
			seen[t.ServerLabel] = true
		}
	}
	return len(seen)
}

func itoaProxy(v int) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	buf := [20]byte{}
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func promptsText(prompts []store.PromptLog) string {
	parts := make([]string, 0, len(prompts))
	for _, prompt := range prompts {
		parts = append(parts, prompt.RedactedText)
	}
	return strings.Join(parts, "\n")
}

var promptInjectionKeywords = []string{
	"ignore previous", "ignore all previous", "disregard previous", "system prompt",
	"developer message", "jailbreak", "dan mode", "reveal your instructions",
	"exfiltrate", "override instruction", "prompt injection", "이전 지시", "시스템 프롬프트",
}

var toxicKeywords = []string{
	"kill yourself", "nazi", "terrorist", "인종차별", "자살해", "죽어라",
}

func keywordHit(text string, keywords []string) bool {
	lower := strings.ToLower(text)
	for _, keyword := range keywords {
		if strings.Contains(lower, strings.ToLower(keyword)) {
			return true
		}
	}
	return false
}

func evalBool(record store.LogRecord, name string, category string, passed bool, passLabel string, failReason string, now time.Time) store.LLMEvaluation {
	score := 0.0
	label := "fail"
	reason := failReason
	if passed {
		score = 1
		label = passLabel
		reason = ""
	}
	return evalScore(record, name, category, score, label, reason, now)
}

func evalScore(record store.LogRecord, name string, category string, score float64, label string, reason string, now time.Time) store.LLMEvaluation {
	return store.LLMEvaluation{
		ID:        newID("eval"),
		RequestID: record.Request.ID,
		TraceID:   record.Request.TraceID,
		Name:      name,
		Category:  category,
		Evaluator: "gateway-managed",
		Score:     score,
		Label:     label,
		Passed:    score >= 0.5,
		Reason:    reason,
		CreatedAt: now,
	}
}

func latencyScore(ms int64, warnAt int64) float64 {
	if ms <= 0 {
		return 1
	}
	if ms <= warnAt {
		return 1
	}
	if ms <= warnAt*2 {
		return 0.5
	}
	return 0
}

func latencyLabel(ms int64, warnAt int64) string {
	if ms <= warnAt {
		return "ok"
	}
	if ms <= warnAt*2 {
		return "slow"
	}
	return "critical"
}
