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
	Text                     string // raw captured bytes; used for cache replay
	CompletionText           string // extracted content text; used for display/logging
	FinishReason             string
	Usage                    audit.Usage
	HasUsage                 bool
	CompletionTokensEstimate int
	ToolCalls                []parsedTool
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
	toolCalls    []parsedTool
	// streaming tool_calls arrive in fragments keyed by index; we accumulate names.
	streamToolNames map[int]string
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
	completionText := a.completion.String()
	// finalize any streamed tool-call names that were assembled across chunks
	for _, name := range a.streamToolNames {
		if name == "" {
			continue
		}
		server, tool, isMCP := classifyToolName(name)
		a.toolCalls = append(a.toolCalls, parsedTool{Server: server, Tool: tool, Source: "call", IsMCP: isMCP})
	}

	return ResponseAnalysis{
		Hash:                     hex.EncodeToString(a.hasher.Sum(nil)),
		Text:                     text,
		CompletionText:           completionText,
		FinishReason:             a.finishReason,
		Usage:                    a.usage,
		HasUsage:                 a.hasUsage,
		CompletionTokensEstimate: audit.EstimateTokens(completionText),
		ToolCalls:                a.toolCalls,
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
				Content   any `json:"content"`
				ToolCalls []struct {
					Index    int    `json:"index"`
					Type     string `json:"type"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"delta"`
			Message struct {
				Content   any `json:"content"`
				ToolCalls []struct {
					Type     string `json:"type"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
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

		// Non-streaming: message.tool_calls carries complete names.
		for _, tc := range choice.Message.ToolCalls {
			if tc.Function.Name != "" {
				server, tool, isMCP := classifyToolName(tc.Function.Name)
				a.toolCalls = append(a.toolCalls, parsedTool{Server: server, Tool: tool, Source: "call", IsMCP: isMCP, ArgHash: hashArgs(tc.Function.Arguments)})
			}
		}
		// Streaming: delta.tool_calls fragments — accumulate by index, name appears once.
		for _, tc := range choice.Delta.ToolCalls {
			if tc.Function.Name != "" {
				if a.streamToolNames == nil {
					a.streamToolNames = map[int]string{}
				}
				if a.streamToolNames[tc.Index] == "" {
					a.streamToolNames[tc.Index] = tc.Function.Name
				}
			}
		}

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
