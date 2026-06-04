package proxy

import "testing"

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
