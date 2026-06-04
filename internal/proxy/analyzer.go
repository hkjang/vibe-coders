package proxy

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"hash"
	"strings"

	"vibe-coders/internal/audit"
)

type ResponseAnalysis struct {
	Hash                     string
	Text                     string
	FinishReason             string
	Usage                    audit.Usage
	HasUsage                 bool
	CompletionTokensEstimate int
}

type ResponseAnalyzer struct {
	stream       bool
	captureText  bool
	maxBytes     int
	hasher       hash.Hash
	capture      bytes.Buffer
	lineBuffer   []byte
	finishReason string
	completion   strings.Builder
	usage        audit.Usage
	hasUsage     bool
}

func NewResponseAnalyzer(stream bool, captureText bool, maxBytes int) *ResponseAnalyzer {
	return &ResponseAnalyzer{
		stream:      stream,
		captureText: captureText,
		maxBytes:    maxBytes,
		hasher:      sha256.New(),
	}
}

func (a *ResponseAnalyzer) Write(p []byte) {
	_, _ = a.hasher.Write(p)
	if a.capture.Len() < a.maxBytes {
		remaining := a.maxBytes - a.capture.Len()
		if remaining > len(p) {
			remaining = len(p)
		}
		a.capture.Write(p[:remaining])
	}

	if a.stream {
		a.consumeSSE(p)
	}
}

func (a *ResponseAnalyzer) Finalize() ResponseAnalysis {
	if a.stream && len(a.lineBuffer) > 0 {
		a.consumeSSELine(string(a.lineBuffer))
		a.lineBuffer = nil
	}
	if !a.stream {
		a.parseJSONResponse(a.capture.Bytes())
	}

	text := ""
	if a.captureText {
		text = a.capture.String()
	}
	return ResponseAnalysis{
		Hash:                     hex.EncodeToString(a.hasher.Sum(nil)),
		Text:                     text,
		FinishReason:             a.finishReason,
		Usage:                    a.usage,
		HasUsage:                 a.hasUsage,
		CompletionTokensEstimate: audit.EstimateTokens(a.completion.String()),
	}
}

func (a *ResponseAnalyzer) consumeSSE(p []byte) {
	a.lineBuffer = append(a.lineBuffer, p...)
	for {
		idx := bytes.IndexByte(a.lineBuffer, '\n')
		if idx < 0 {
			return
		}
		line := string(a.lineBuffer[:idx])
		a.lineBuffer = a.lineBuffer[idx+1:]
		a.consumeSSELine(line)
	}
}

func (a *ResponseAnalyzer) consumeSSELine(line string) {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "data:") {
		return
	}
	payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
	if payload == "" || payload == "[DONE]" {
		return
	}
	a.parseChunk([]byte(payload))
}

func (a *ResponseAnalyzer) parseJSONResponse(payload []byte) {
	a.parseChunk(payload)
}

func (a *ResponseAnalyzer) parseChunk(payload []byte) {
	var chunk struct {
		Choices []struct {
			Delta struct {
				Content any `json:"content"`
			} `json:"delta"`
			Message struct {
				Content any `json:"content"`
			} `json:"message"`
			Text         any `json:"text"`
			FinishReason any `json:"finish_reason"`
		} `json:"choices"`
		Usage *struct {
			PromptTokens        int `json:"prompt_tokens"`
			CompletionTokens    int `json:"completion_tokens"`
			TotalTokens         int `json:"total_tokens"`
			PromptTokensDetails *struct {
				CachedTokens int `json:"cached_tokens"`
				AudioTokens  int `json:"audio_tokens"`
			} `json:"prompt_tokens_details"`
			CompletionTokensDetails *struct {
				ReasoningTokens int `json:"reasoning_tokens"`
				AudioTokens     int `json:"audio_tokens"`
			} `json:"completion_tokens_details"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(payload, &chunk); err != nil {
		return
	}
	for _, choice := range chunk.Choices {
		a.completion.WriteString(contentString(choice.Delta.Content))
		a.completion.WriteString(contentString(choice.Message.Content))
		a.completion.WriteString(contentString(choice.Text))
		if choice.FinishReason == nil {
			continue
		}
		if value, ok := choice.FinishReason.(string); ok && value != "" {
			a.finishReason = value
		}
	}
	if chunk.Usage != nil {
		usage := audit.Usage{
			PromptTokens:     chunk.Usage.PromptTokens,
			CompletionTokens: chunk.Usage.CompletionTokens,
			TotalTokens:      chunk.Usage.TotalTokens,
			Source:           "usage",
		}
		if chunk.Usage.PromptTokensDetails != nil {
			usage.CachedTokens = chunk.Usage.PromptTokensDetails.CachedTokens
		}
		if chunk.Usage.CompletionTokensDetails != nil {
			usage.ReasoningTokens = chunk.Usage.CompletionTokensDetails.ReasoningTokens
		}
		a.usage = usage
		a.hasUsage = true
	}
}

func contentString(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case []any:
		var builder strings.Builder
		for _, item := range v {
			builder.WriteString(contentString(item))
		}
		return builder.String()
	default:
		return ""
	}
}
