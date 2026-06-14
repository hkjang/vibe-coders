package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"vibe-coders/internal/audit"
)

type governanceRunResult struct {
	Model            string  `json:"model"`
	Provider         string  `json:"provider"`
	Response         string  `json:"response"`
	PromptTokens     int     `json:"prompt_tokens"`
	CompletionTokens int     `json:"completion_tokens"`
	TotalTokens      int     `json:"total_tokens"`
	CostKRW          float64 `json:"cost_krw"`
	LatencyMS        int64   `json:"latency_ms"`
	StatusCode       int     `json:"status_code"`
	Error            string  `json:"error,omitempty"`
}

func (s *Server) runGovernanceChat(ctx context.Context, r *http.Request, model, prompt string) governanceRunResult {
	result := governanceRunResult{Model: model}
	body, err := replayBodyForModel(prompt, model)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	if expanded, _, _ := s.expandKnowledge(r, body); len(expanded) > 0 {
		body = expanded
	}
	provider, err := s.selectProvider(ctx, r, model)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	result.Provider = provider.Name
	upstreamURL, err := s.upstreamURL(provider.BaseURL, &url.URL{Path: "/v1/chat/completions"})
	if err != nil {
		result.Error = err.Error()
		return result
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, upstreamURL, bytes.NewReader(body))
	if err != nil {
		result.Error = err.Error()
		return result
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+provider.APIKey)
	req.Header.Set("X-Request-ID", traceIDFromRequest(r))

	start := time.Now()
	resp, err := s.client.Do(req)
	result.LatencyMS = time.Since(start).Milliseconds()
	if err != nil {
		result.Error = err.Error()
		return result
	}
	defer resp.Body.Close()
	result.StatusCode = resp.StatusCode
	limit := int64(s.cfg.Logging.ResponseMaxBytes)
	if limit <= 0 || limit > 4<<20 {
		limit = 4 << 20
	}
	raw, readErr := io.ReadAll(io.LimitReader(resp.Body, limit))
	if readErr != nil {
		result.Error = readErr.Error()
		return result
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		result.Error = strings.TrimSpace(string(raw))
		return result
	}

	analyzer := NewResponseAnalyzer(false, true, int(limit))
	analyzer.Write(raw)
	analysis := analyzer.Finalize()
	result.Response = extractChatContent(raw)
	if result.Response == "" {
		result.Response = analysis.Text
	}
	if analysis.HasUsage {
		result.PromptTokens = analysis.Usage.PromptTokens
		result.CompletionTokens = analysis.Usage.CompletionTokens
		result.TotalTokens = analysis.Usage.TotalTokens
		result.CostKRW = audit.EstimateCostKRW(model, analysis.Usage, s.pricingMap(ctx))
		return result
	}
	result.PromptTokens = audit.EstimateTokens(string(body))
	result.CompletionTokens = audit.EstimateTokens(result.Response)
	result.TotalTokens = result.PromptTokens + result.CompletionTokens
	result.CostKRW = audit.EstimateCostKRW(model, audit.Usage{
		PromptTokens:     result.PromptTokens,
		CompletionTokens: result.CompletionTokens,
		TotalTokens:      result.TotalTokens,
		Source:           "estimated",
	}, s.pricingMap(ctx))
	return result
}

func replayBodyForModel(prompt, model string) ([]byte, error) {
	var root map[string]any
	if json.Unmarshal([]byte(prompt), &root) == nil {
		if _, ok := root["messages"]; ok {
			root["model"] = model
			root["stream"] = false
			return json.Marshal(root)
		}
	}
	return json.Marshal(map[string]any{
		"model":  model,
		"stream": false,
		"messages": []map[string]string{
			{"role": "user", "content": prompt},
		},
	})
}

func extractChatContent(raw []byte) string {
	var parsed struct {
		Choices []struct {
			Message struct {
				Content any `json:"content"`
			} `json:"message"`
			Text any `json:"text"`
		} `json:"choices"`
	}
	if json.Unmarshal(raw, &parsed) != nil || len(parsed.Choices) == 0 {
		return ""
	}
	var b strings.Builder
	for _, choice := range parsed.Choices {
		b.WriteString(contentString(choice.Message.Content))
		b.WriteString(contentString(choice.Text))
	}
	return strings.TrimSpace(b.String())
}

func scoreGoldenResponse(expected, response string) (float64, bool) {
	expected = normalizeGoldenText(expected)
	response = normalizeGoldenText(response)
	if expected == "" {
		return 0, true
	}
	if strings.Contains(response, expected) {
		return 1, true
	}
	expectedTerms := uniqueTerms(expected)
	if len(expectedTerms) == 0 {
		return 0, false
	}
	responseTerms := map[string]bool{}
	for _, term := range strings.Fields(response) {
		responseTerms[term] = true
	}
	hits := 0
	for term := range expectedTerms {
		if responseTerms[term] {
			hits++
		}
	}
	score := float64(hits) / float64(len(expectedTerms))
	return score, score >= 0.6
}

func normalizeGoldenText(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	replacer := strings.NewReplacer("\n", " ", "\t", " ", ".", " ", ",", " ", ";", " ", ":", " ", "!", " ", "?", " ", "\"", " ", "'", " ")
	return strings.Join(strings.Fields(replacer.Replace(value)), " ")
}

func uniqueTerms(value string) map[string]bool {
	out := map[string]bool{}
	for _, term := range strings.Fields(value) {
		if len([]rune(term)) < 2 {
			continue
		}
		out[term] = true
	}
	return out
}
