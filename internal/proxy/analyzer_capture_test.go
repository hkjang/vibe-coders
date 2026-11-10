package proxy

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"

	"vibe-coders/internal/audit"
)

func analyzeStream(events ...string) ResponseAnalysis {
	analyzer := NewResponseAnalyzer(true, false, 4096)
	for _, event := range events {
		analyzer.Write([]byte(event))
	}
	return analyzer.Finalize()
}

// /v1/responses names its counts differently, and only total_tokens matched the chat names,
// so a non-stream call was recorded as prompt 0, completion 0, cost 0.
func TestResponseAnalyzerReadsResponsesAPIBody(t *testing.T) {
	analyzer := NewResponseAnalyzer(false, false, 4096)
	analyzer.Write([]byte(`{"id":"resp_1","object":"response","status":"completed","error":null,"output":[
		{"type":"reasoning","summary":[]},
		{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello there"}]},
		{"type":"function_call","id":"fc_1","call_id":"call_1","name":"search","arguments":"{\"q\":\"x\"}"}
	],"usage":{"input_tokens":1000,"output_tokens":500,"total_tokens":1500,
		"input_tokens_details":{"cached_tokens":300},"output_tokens_details":{"reasoning_tokens":200}}}`))

	analysis := analyzer.Finalize()

	if !analysis.HasUsage || analysis.Usage.PromptTokens != 1000 || analysis.Usage.CompletionTokens != 500 ||
		analysis.Usage.TotalTokens != 1500 || analysis.Usage.CachedTokens != 300 || analysis.Usage.ReasoningTokens != 200 {
		t.Fatalf("unexpected usage: %#v", analysis.Usage)
	}
	if analysis.CompletionText != "hello there" {
		t.Fatalf("unexpected text: %q", analysis.CompletionText)
	}
	if analysis.FinishReason != "stop" {
		t.Fatalf("unexpected finish reason: %q", analysis.FinishReason)
	}
	if len(analysis.ToolOutputs) != 1 || analysis.ToolOutputs[0].Name != "search" || analysis.ToolOutputs[0].Arguments != `{"q":"x"}` {
		t.Fatalf("unexpected tool calls: %#v", analysis.ToolOutputs)
	}
	if analysis.UpstreamError != "" {
		t.Fatalf(`"error":null must not read as a failure, got %q`, analysis.UpstreamError)
	}
}

// The completed event repeats the whole answer. Reading both would store everything twice.
func TestResponseAnalyzerResponsesStreamDoesNotDoubleText(t *testing.T) {
	analysis := analyzeStream(
		"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hel\"}\n\n",
		"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"lo\"}\n\n",
		"event: response.output_text.done\ndata: {\"type\":\"response.output_text.done\",\"text\":\"hello\"}\n\n",
		`event: response.completed`+"\n"+`data: {"type":"response.completed","response":{"status":"completed","error":null,"output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]}],"usage":{"input_tokens":10,"output_tokens":4,"total_tokens":14,"input_tokens_details":{"cached_tokens":2},"output_tokens_details":{"reasoning_tokens":1}}}}`+"\n\n",
	)

	if analysis.CompletionText != "hello" {
		t.Fatalf("expected the answer once, got %q", analysis.CompletionText)
	}
	if !analysis.HasUsage || analysis.Usage.PromptTokens != 10 || analysis.Usage.CompletionTokens != 4 ||
		analysis.Usage.TotalTokens != 14 || analysis.Usage.CachedTokens != 2 || analysis.Usage.ReasoningTokens != 1 {
		t.Fatalf("unexpected usage: %#v", analysis.Usage)
	}
	if analysis.FinishReason != "stop" {
		t.Fatalf("unexpected finish reason: %q", analysis.FinishReason)
	}
}

func TestResponseAnalyzerResponsesStreamWithoutDeltasReadsCompletedOutput(t *testing.T) {
	analysis := analyzeStream(`data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message","content":[{"type":"output_text","text":"partial"}]}]}}` + "\n\n")

	if analysis.CompletionText != "partial" {
		t.Fatalf("unexpected text: %q", analysis.CompletionText)
	}
	if analysis.FinishReason != "max_output_tokens" {
		t.Fatalf("unexpected finish reason: %q", analysis.FinishReason)
	}
}

func TestResponseAnalyzerResponsesStreamAssemblesToolArguments(t *testing.T) {
	analysis := analyzeStream(
		`data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","name":"search","arguments":""}}`+"\n\n",
		`data: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"{\"q\":"}`+"\n\n",
		`data: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"\"x\"}"}`+"\n\n",
		`data: {"type":"response.function_call_arguments.done","output_index":0,"item_id":"fc_1","arguments":"{\"q\":\"x\"}"}`+"\n\n",
		`data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","name":"search","arguments":"{\"q\":\"x\"}"}}`+"\n\n",
		`data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call","id":"fc_1","name":"search","arguments":"{\"q\":\"x\"}"}]}}`+"\n\n",
	)

	if len(analysis.ToolOutputs) != 1 || analysis.ToolOutputs[0].Name != "search" || analysis.ToolOutputs[0].Arguments != `{"q":"x"}` {
		t.Fatalf("expected one call with its arguments once, got %#v", analysis.ToolOutputs)
	}
	if len(analysis.ToolCalls) != 1 || analysis.ToolCalls[0].ArgHash != audit.HashText(`{"q":"x"}`) {
		t.Fatalf("unexpected tool invocation: %#v", analysis.ToolCalls)
	}
}

// Dropping the raw fallback would have blanked Anthropic Messages traffic, which reaches the
// upstream through the /v1/ catch-all, so its shape is read too.
func TestResponseAnalyzerReadsAnthropicMessages(t *testing.T) {
	analyzer := NewResponseAnalyzer(false, false, 4096)
	analyzer.Write([]byte(`{"type":"message","role":"assistant","stop_reason":"tool_use","content":[{"type":"text","text":"looking"},{"type":"tool_use","id":"t1","name":"search","input":{"q":"x"}}],"usage":{"input_tokens":10,"output_tokens":4}}`))
	whole := analyzer.Finalize()
	if whole.CompletionText != "looking" || whole.FinishReason != "tool_use" || len(whole.ToolOutputs) != 1 || whole.ToolOutputs[0].Arguments != `{"q":"x"}` {
		t.Fatalf("unexpected body analysis: %#v", whole)
	}
	if whole.Usage.TotalTokens != 14 {
		t.Fatalf("expected the total derived from both sides, got %#v", whole.Usage)
	}

	stream := analyzeStream(
		`data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}`+"\n\n",
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}`+"\n\n",
		`data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"search"}}`+"\n\n",
		`data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"q\":"}}`+"\n\n",
		`data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"x\"}"}}`+"\n\n",
		`data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":25}}`+"\n\n",
	)
	if stream.CompletionText != "hi" || stream.FinishReason != "tool_use" || len(stream.ToolOutputs) != 1 || stream.ToolOutputs[0].Arguments != `{"q":"x"}` {
		t.Fatalf("unexpected stream analysis: %#v", stream)
	}
	if stream.Usage.PromptTokens != 10 || stream.Usage.CompletionTokens != 25 || stream.Usage.TotalTokens != 35 {
		t.Fatalf("expected input and output usage merged, got %#v", stream.Usage)
	}
}

func TestResponseAnalyzerAssemblesChatToolArguments(t *testing.T) {
	analysis := analyzeStream(
		`data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"second","arguments":"{\"b\":"}}]}}]}`+"\n\n",
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"first","arguments":"{\"a\":"}}]}}]}`+"\n\n",
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}`+"\n\n",
		`data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"2}"}}]}}]}`+"\n\n",
	)

	if len(analysis.ToolOutputs) != 2 || analysis.ToolOutputs[0].Name != "first" || analysis.ToolOutputs[0].Arguments != `{"a":1}` ||
		analysis.ToolOutputs[1].Name != "second" || analysis.ToolOutputs[1].Arguments != `{"b":2}` {
		t.Fatalf("unexpected calls: %#v", analysis.ToolOutputs)
	}
	if analysis.ToolCalls[0].ArgHash != audit.HashText(`{"a":1}`) {
		t.Fatalf("a streamed call should hash its arguments like a whole one: %#v", analysis.ToolCalls[0])
	}
}

// Some compatible providers send every call at index 0 and tell them apart only by id.
// Concatenating them would store arguments no call ever had.
func TestResponseAnalyzerKeepsCallsApartByIDAtTheSameIndex(t *testing.T) {
	analysis := analyzeStream(
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"first","arguments":"{}"}}]}}]}`+"\n\n",
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"b","function":{"name":"second","arguments":"[]"}}]}}]}`+"\n\n",
	)
	if len(analysis.ToolOutputs) != 2 || analysis.ToolOutputs[0].Arguments != "{}" || analysis.ToolOutputs[1].Arguments != "[]" {
		t.Fatalf("unexpected calls: %#v", analysis.ToolOutputs)
	}
}

// Parts of a refusal or a legacy function call used to survive only through the raw fallback.
func TestResponseAnalyzerReadsRefusalAndLegacyFunctionCall(t *testing.T) {
	refusal := analyzeStream(`data: {"choices":[{"delta":{"refusal":"I can't"}}]}` + "\n\n")
	if refusal.CompletionText != "I can't" {
		t.Fatalf("unexpected refusal text: %q", refusal.CompletionText)
	}
	legacy := analyzeStream(
		`data: {"choices":[{"delta":{"function_call":{"name":"f","arguments":"{\"a\""}}}]}`+"\n\n",
		`data: {"choices":[{"delta":{"function_call":{"arguments":":1}"}}}]}`+"\n\n",
	)
	if len(legacy.ToolOutputs) != 1 || legacy.ToolOutputs[0].Name != "f" || legacy.ToolOutputs[0].Arguments != `{"a":1}` {
		t.Fatalf("unexpected legacy call: %#v", legacy.ToolOutputs)
	}
}

// The persisted limit must not decide whether usage can be read: usage sits at the end of a
// JSON body, so a body cut there no longer parses and the call reads as unmetered.
func TestResponseAnalyzerParsesBodyPastTheDisplayLimit(t *testing.T) {
	for _, limit := range []int{0, 64} {
		analyzer := NewResponseAnalyzer(false, true, limit)
		analyzer.Write([]byte(`{"choices":[{"message":{"content":"` + strings.Repeat("a", 4096) + `"},"finish_reason":"length"}],`))
		analyzer.Write([]byte(`"usage":{"prompt_tokens":10,"completion_tokens":1000,"total_tokens":1010}}`))

		analysis := analyzer.Finalize()

		if !analysis.HasUsage || analysis.Usage.TotalTokens != 1010 || analysis.FinishReason != "length" {
			t.Fatalf("limit %d: metering lost: %#v finish=%q", limit, analysis.Usage, analysis.FinishReason)
		}
		if len(analysis.Text) != limit || !analysis.Truncated {
			t.Fatalf("limit %d: raw capture should stop at the limit and say so, got %d bytes truncated=%v", limit, len(analysis.Text), analysis.Truncated)
		}
	}
}

func TestResponseAnalyzerTruncatedOnlyWhenTheBodyOutgrewTheCapture(t *testing.T) {
	analyzer := NewResponseAnalyzer(false, true, 8)
	analyzer.Write([]byte(`12345678`))
	if analysis := analyzer.Finalize(); analysis.Truncated || analysis.Text != "12345678" {
		t.Fatalf("a body exactly at the limit is whole: %#v", analysis)
	}
}

func TestResponseAnalyzerBoundsStreamMemory(t *testing.T) {
	const limit = 1024
	const fragment = 100

	analyzer := NewResponseAnalyzer(true, false, 16)
	analyzer.parseLimit = limit
	line := fmt.Sprintf(`data: {"choices":[{"delta":{"content":%q}}]}`+"\n\n", strings.Repeat("x", fragment))
	const fragments = 200
	for i := 0; i < fragments; i++ {
		analyzer.Write([]byte(line))
	}
	if analyzer.completion.Len() > limit {
		t.Fatalf("completion grew to %d past the %d limit", analyzer.completion.Len(), limit)
	}
	if analyzer.raw.Len() != 0 {
		t.Fatalf("nothing asked for the raw stream, yet %d bytes were kept", analyzer.raw.Len())
	}

	analysis := analyzer.Finalize()

	// The estimate has to keep counting past the cut, or a long stream reads as a short one.
	want := audit.EstimateTokens(strings.Repeat("x", fragment*fragments))
	if analysis.CompletionTokensEstimate < want-2 || analysis.CompletionTokensEstimate > want+2 {
		t.Fatalf("estimate = %d, want about %d", analysis.CompletionTokensEstimate, want)
	}

	// A stream that never sends a newline must not grow the line buffer forever, and the
	// next complete line still parses.
	endless := NewResponseAnalyzer(true, false, 16)
	endless.parseLimit = limit
	for i := 0; i < 100; i++ {
		endless.Write([]byte(strings.Repeat("y", 512)))
		if len(endless.lineBuffer) > limit {
			t.Fatalf("line buffer grew to %d past the %d limit", len(endless.lineBuffer), limit)
		}
	}
	endless.Write([]byte("\n" + `data: {"choices":[{"delta":{"content":"after"}}]}` + "\n"))
	if got := endless.Finalize(); got.CompletionText != "after" {
		t.Fatalf("the line after an oversized one was lost: %q", got.CompletionText)
	}
}

// A call that outgrows the budget keeps what fits, and has no hash: a hash of half the
// arguments would match nothing.
func TestResponseAnalyzerCutToolArgumentsHaveNoHash(t *testing.T) {
	analyzer := NewResponseAnalyzer(true, false, 16)
	analyzer.parseLimit = 256
	analyzer.Write([]byte(fmt.Sprintf(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"f","arguments":%q}}]}}]}`+"\n\n", strings.Repeat("z", 150))))
	analyzer.Write([]byte(fmt.Sprintf(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":%q}}]}}]}`+"\n\n", strings.Repeat("z", 150))))

	analysis := analyzer.Finalize()

	if got := len(analysis.ToolOutputs[0].Arguments); got == 0 || got > 256 {
		t.Fatalf("arguments should be cut to the budget: %d bytes", got)
	}
	if analysis.ToolCalls[0].ArgHash != "" {
		t.Fatalf("a cut call should have no hash: %q", analysis.ToolCalls[0].ArgHash)
	}
}

func TestResponseAnalyzerToolOnlyStreamEstimatesFromArguments(t *testing.T) {
	arguments := strings.Repeat("lorem ipsum ", 400)
	analysis := analyzeStream(fmt.Sprintf(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"search","arguments":%q}}]}}]}`+"\n\n", arguments))

	if want := audit.EstimateTokens(arguments); analysis.CompletionTokensEstimate != want {
		t.Fatalf("estimate = %d, want %d from the arguments", analysis.CompletionTokensEstimate, want)
	}
}

func TestResponseAnalyzerRecognizesInBandErrors(t *testing.T) {
	for _, tc := range []struct{ name, event, want string }{
		{"chat chunk", `{"error":{"message":"overloaded","type":"server_error"}}`, "overloaded (server_error)"},
		{"string error", `{"error":"overloaded"}`, "overloaded"},
		{"responses error event", `{"type":"error","code":"rate_limited","message":"slow down"}`, "slow down (rate_limited)"},
		{"responses failed event", `{"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"boom"}}}`, "boom (server_error)"},
		{"anthropic error event", `{"type":"error","error":{"type":"overloaded_error","message":"busy"}}`, "busy (overloaded_error)"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			analysis := analyzeStream(`data: {"choices":[{"delta":{"content":"par"}}]}`+"\n\n", "data: "+tc.event+"\n\n")
			if analysis.UpstreamError != tc.want {
				t.Fatalf("UpstreamError = %q, want %q", analysis.UpstreamError, tc.want)
			}
		})
	}

	// A model talking about an error is not an error: its text arrives escaped inside content.
	quiet := analyzeStream(`data: {"choices":[{"delta":{"content":"{\"error\":\"none\"}"}}]}` + "\n\n")
	if quiet.UpstreamError != "" || quiet.CompletionText != `{"error":"none"}` {
		t.Fatalf("a JSON-mode answer was mistaken for a failure: %#v", quiet)
	}
}

func TestPersistedResponseTextShapes(t *testing.T) {
	text := "plain answer"
	calls := []capturedToolCall{{Name: "search", Arguments: `{"q":"x"}`}}

	if got := persistedResponseText(ResponseAnalysis{CompletionText: text, Text: "data: raw"}, 200, 4096); got != text {
		t.Fatalf("clean text expected, got %q", got)
	}
	if got := persistedResponseText(ResponseAnalysis{Text: "data: raw"}, 200, 4096); got != "" {
		t.Fatalf("raw bytes must not be stored as an answer, got %q", got)
	}
	if got := persistedResponseText(ResponseAnalysis{Text: `{"error":"nope"}`, CompletionText: "ignored"}, 400, 4096); got != `{"error":"nope"}` {
		t.Fatalf("an error body stays as it arrived, got %q", got)
	}

	output := extractRequestOutput(persistedResponseText(ResponseAnalysis{ToolOutputs: calls}, 200, 4096), 200)
	if output.Kind != requestOutputKindToolCalls || len(output.ToolCalls) != 1 || output.ToolCalls[0].Name != "search" || output.ToolCalls[0].Arguments != `{"q":"x"}` {
		t.Fatalf("the reader could not read a tool-only envelope: %#v", output)
	}
	output = extractRequestOutput(persistedResponseText(ResponseAnalysis{CompletionText: text, ToolOutputs: calls}, 200, 4096), 200)
	if output.Text != text || len(output.ToolCalls) != 1 {
		t.Fatalf("the reader could not read text with tool calls: %#v", output)
	}
}

func TestToolCallEnvelopeStaysValidAtAnyLimit(t *testing.T) {
	calls := []capturedToolCall{
		{Name: "first", Arguments: strings.Repeat(`한"글\n`, 2000)},
		{Name: "second", Arguments: strings.Repeat("x", 30000)},
	}
	text := strings.Repeat("답변 ", 3000)
	for _, limit := range []int{0, 10, 200, 512, 4096, 65536, 1 << 20} {
		got := toolCallEnvelope(text, calls, limit)
		if len(got) > limit {
			t.Fatalf("limit %d: envelope is %d bytes", limit, len(got))
		}
		if got == "" {
			if limit >= 512 {
				t.Fatalf("limit %d: envelope was dropped when it could have been cut", limit)
			}
			continue
		}
		if !utf8.ValidString(got) || !json.Valid([]byte(got)) {
			t.Fatalf("limit %d: not valid JSON: %.80q", limit, got)
		}
		output := extractRequestOutput(got, 200)
		if len(output.ToolCalls) != 2 || output.ToolCalls[1].Name != "second" {
			t.Fatalf("limit %d: the reader lost the calls: %#v", limit, output.ToolCalls)
		}
	}
	if calls[1].Arguments != strings.Repeat("x", 30000) {
		t.Fatal("cutting the envelope must not change the caller's calls")
	}
}

func TestCutAtUTF8BoundaryNeverSplitsACharacter(t *testing.T) {
	text := strings.Repeat("한", 10)
	for limit := -1; limit <= len(text)+1; limit++ {
		got := cutAtUTF8Boundary(text, limit)
		if !utf8.ValidString(got) || len(got) > max(limit, 0) || len(got)%3 != 0 {
			t.Fatalf("limit %d: got %d bytes (%q)", limit, len(got), got)
		}
	}
}

func TestBoundedUpstreamErrorRedactsBeforeCutting(t *testing.T) {
	// The key straddles the cut. Cutting first would leave a stub too short for the rule.
	message := strings.Repeat("x", upstreamErrorMaxBytes-40) + " sk-abcdefghijklmnopqrstuvwxyz0123456789 " + strings.Repeat("y", 1024)
	got := boundedUpstreamError("upstream_400", message)
	if strings.Contains(got, "sk-") {
		t.Fatalf("part of the key survived: %q", got)
	}
	if len(got) > upstreamErrorMaxBytes {
		t.Fatalf("error is %d bytes", len(got))
	}
	if got := boundedUpstreamError("upstream_502", ""); got != "upstream_502" {
		t.Fatalf("no message should leave the label, got %q", got)
	}
}

func TestUpstreamErrorFromBody(t *testing.T) {
	for _, tc := range []struct{ body, want string }{
		{`{"error":{"message":"too long","code":"context_length_exceeded"}}`, "too long (context_length_exceeded)"},
		{`{"detail":"Not Found"}`, "Not Found"},
		{`{"message":"bad gateway"}`, "bad gateway"},
		{"  plain\n failure  text ", "plain failure text"},
		{"<html><body>502</body></html>", ""},
		{`{"unknown":1}`, ""},
		{"", ""},
	} {
		if got := upstreamErrorFromBody(tc.body); got != tc.want {
			t.Errorf("upstreamErrorFromBody(%q) = %q, want %q", tc.body, got, tc.want)
		}
	}
}
