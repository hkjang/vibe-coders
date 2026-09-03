package proxy

import (
	"fmt"
	"strings"
	"testing"
)

func TestResponseAnalyzerParsesStreamingUsage(t *testing.T) {
	analyzer := NewResponseAnalyzer(true, true, 4096)
	analyzer.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n"))
	analyzer.Write([]byte("data: {\"choices\":[{\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":4,\"total_tokens\":14}}\n\n"))
	analyzer.Write([]byte("data: [DONE]\n\n"))

	analysis := analyzer.Finalize()

	if !analysis.HasUsage {
		t.Fatal("expected usage")
	}
	if analysis.Usage.PromptTokens != 10 || analysis.Usage.CompletionTokens != 4 || analysis.Usage.TotalTokens != 14 {
		t.Fatalf("unexpected usage: %#v", analysis.Usage)
	}
	if analysis.FinishReason != "stop" {
		t.Fatalf("unexpected finish reason: %q", analysis.FinishReason)
	}
	if analysis.Hash == "" {
		t.Fatal("expected response hash")
	}
	if analysis.Text == "" {
		t.Fatal("expected captured text")
	}
}

// Providers that answer with structured content parts used to yield an empty
// CompletionText, which zeroed the completion estimate the pipeline falls back on when
// a response carries no usage block.
func TestResponseAnalyzerFlattensStreamedContentParts(t *testing.T) {
	analyzer := NewResponseAnalyzer(true, false, 4096)
	analyzer.Write([]byte(`data: {"choices":[{"delta":{"content":[{"type":"text","text":"hello "},{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}},{"type":"text","text":"world"}]}}]}` + "\n\n"))
	analyzer.Write([]byte("data: [DONE]\n\n"))

	analysis := analyzer.Finalize()

	if analysis.CompletionText != "hello world" {
		t.Fatalf("expected content parts flattened, got %q", analysis.CompletionText)
	}
	if analysis.CompletionTokensEstimate == 0 {
		t.Fatal("expected a non-zero completion token estimate")
	}
}

func TestResponseAnalyzerFlattensNonStreamedContentParts(t *testing.T) {
	analyzer := NewResponseAnalyzer(false, false, 4096)
	analyzer.Write([]byte(`{"choices":[{"message":{"content":[{"type":"output_text","text":"final answer"}]},"finish_reason":"stop"}]}`))

	analysis := analyzer.Finalize()

	if analysis.CompletionText != "final answer" {
		t.Fatalf("expected content parts flattened, got %q", analysis.CompletionText)
	}
	if analysis.FinishReason != "stop" {
		t.Fatalf("unexpected finish reason: %q", analysis.FinishReason)
	}
}

// Streamed tool-call names are accumulated in a map keyed by delta index; emitting them
// by ranging that map put the tool_invocations rows of one response in a different order
// on every run. The chunks below arrive out of order on purpose.
func TestResponseAnalyzerOrdersStreamedToolCallsByIndex(t *testing.T) {
	want := []string{"alpha", "bravo", "charlie", "delta", "echo", "foxtrot"}
	order := []int{4, 0, 5, 2, 1, 3}

	for attempt := 0; attempt < 20; attempt++ {
		analyzer := NewResponseAnalyzer(true, false, 8192)
		for _, index := range order {
			analyzer.Write([]byte(fmt.Sprintf(
				`data: {"choices":[{"delta":{"tool_calls":[{"index":%d,"type":"function","function":{"name":%q}}]}}]}`+"\n\n",
				index, want[index])))
		}
		analyzer.Write([]byte("data: [DONE]\n\n"))

		analysis := analyzer.Finalize()

		got := make([]string, 0, len(analysis.ToolCalls))
		for _, call := range analysis.ToolCalls {
			got = append(got, call.Tool)
		}
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Fatalf("attempt %d: expected tool calls in index order %v, got %v", attempt, want, got)
		}
	}
}
