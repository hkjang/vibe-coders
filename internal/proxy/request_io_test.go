package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestExtractRequestOutputReadsEveryStoredShape(t *testing.T) {
	tests := []struct {
		name   string
		raw    string
		status int
		kind   string
		text   string
		tools  []requestIOToolCall
	}{
		{name: "empty", raw: "  ", status: 200, kind: requestOutputKindNone},
		{name: "clean text from the analyzer", raw: "안녕하세요\n두 번째 줄", status: 200, kind: requestOutputKindText, text: "안녕하세요\n두 번째 줄"},
		{
			name:   "chat tool call stored as raw JSON",
			raw:    `{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"search_orders","arguments":"{\"id\":1}"}}]}}]}`,
			status: 200, kind: requestOutputKindToolCalls,
			tools: []requestIOToolCall{{Name: "search_orders", Arguments: `{"id":1}`}},
		},
		{
			name: "chat stream tool call fragments stored as raw SSE",
			raw: "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"lookup\",\"arguments\":\"\"}}]}}]}\n\n" +
				"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"a\\\"\"}}]}}]}\n\n" +
				"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\":1}\"}}]}}]}\n\n" +
				"data: [DONE]\n\n",
			status: 200, kind: requestOutputKindToolCalls,
			tools: []requestIOToolCall{{Name: "lookup", Arguments: `{"a":1}`}},
		},
		{
			name:   "responses API JSON",
			raw:    `{"object":"response","output":[{"type":"reasoning","summary":[]},{"type":"message","content":[{"type":"output_text","text":"답변입니다"}]},{"type":"function_call","id":"f1","name":"run","arguments":"{}"}]}`,
			status: 200, kind: requestOutputKindText, text: "답변입니다",
			tools: []requestIOToolCall{{Name: "run", Arguments: "{}"}},
		},
		{
			name: "responses API stream does not double the completed event",
			raw: "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"안녕\"}\n\n" +
				"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"하세요\"}\n\n" +
				"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"안녕하세요\"}]}]}}\n\n",
			status: 200, kind: requestOutputKindText, text: "안녕하세요",
		},
		{
			name:   "responses API stream with only a completed event",
			raw:    "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"완료\"}]}]}}\n\n",
			status: 200, kind: requestOutputKindText, text: "완료",
		},
		{
			name:   "responses API failed stream",
			raw:    "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"server_error\",\"message\":\"boom\"}}}\n\n",
			status: 200, kind: requestOutputKindError, text: "boom (server_error)",
		},
		{name: "upstream error", raw: `{"error":{"message":"rate limit reached","type":"rate_limit_error"}}`, status: 429, kind: requestOutputKindError, text: "rate limit reached (rate_limit_error)"},
		{name: "upstream error string", raw: `{"error":"bad gateway"}`, status: 502, kind: requestOutputKindError, text: "bad gateway"},
		{name: "JSON-mode answer is not mistaken for a failure", raw: `{"error":"none","score":1}`, status: 200, kind: requestOutputKindText, text: `{"error":"none","score":1}`},
		{name: "plain answer starting with data colon", raw: "data: 분기 보고서 요약입니다", status: 200, kind: requestOutputKindText, text: "data: 분기 보고서 요약입니다"},
		{name: "plain answer starting with a brace", raw: "{정리} 세 가지입니다", status: 200, kind: requestOutputKindText, text: "{정리} 세 가지입니다"},
		{name: "embeddings", raw: `{"object":"list","data":[{"embedding":[0.1,0.2,0.3]},{"embedding":[0.1,0.2,0.3]}]}`, status: 200, kind: requestOutputKindEmbedding, text: "임베딩 벡터 2개 · 3차원"},
		{name: "images", raw: `{"data":[{"url":"https://example.test/a.png"}]}`, status: 200, kind: requestOutputKindImage, text: "생성된 이미지 1개"},
		{
			name:   "anthropic style blocks",
			raw:    `{"content":[{"type":"text","text":"네"},{"type":"tool_use","name":"lookup","input":{"a":1}}]}`,
			status: 200, kind: requestOutputKindText, text: "네",
			tools: []requestIOToolCall{{Name: "lookup", Arguments: `{"a":1}`}},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := extractRequestOutput(test.raw, test.status)
			if got.Kind != test.kind || got.Text != test.text {
				t.Fatalf("kind=%q text=%q, want kind=%q text=%q", got.Kind, got.Text, test.kind, test.text)
			}
			if len(got.ToolCalls) != len(test.tools) {
				t.Fatalf("tools=%+v, want %+v", got.ToolCalls, test.tools)
			}
			for index, tool := range test.tools {
				if got.ToolCalls[index] != tool {
					t.Fatalf("tool %d=%+v, want %+v", index, got.ToolCalls[index], tool)
				}
			}
		})
	}
}

func TestExtractRequestOutputRecoversTextFromACutOffBody(t *testing.T) {
	cases := map[string]string{
		"mid text":              `{"id":"x","choices":[{"message":{"role":"assistant","content":"앞부분 답변`,
		"mid escape":            `{"id":"x","choices":[{"message":{"role":"assistant","content":"앞부분 답변\`,
		"mid unicode escape":    `{"id":"x","choices":[{"message":{"role":"assistant","content":"앞부분 답변\u12`,
		"closed string, no end": `{"id":"x","choices":[{"message":{"role":"assistant","content":"앞부분 답변","extra":`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			got := extractRequestOutput(raw, 200)
			if got.Kind != requestOutputKindText || got.Text != "앞부분 답변" || !got.Partial {
				t.Fatalf("got %+v", got)
			}
		})
	}
	if got := extractRequestOutput("{미완성 괄호로 시작하는 평문", 200); got.Partial || got.Text != "{미완성 괄호로 시작하는 평문" {
		t.Fatalf("plain text was treated as a cut-off envelope: %+v", got)
	}
}

func insertRequestIORow(t *testing.T, db *store.SQLStore, id string, status int, prompts []store.PromptLog, response *store.ResponseLog, createdAt time.Time) {
	t.Helper()
	for index := range prompts {
		prompts[index].ID = id + "-prompt-" + string(rune('a'+index))
		prompts[index].RequestID = id
		prompts[index].ContentHash = "hash"
		// One request's messages share a timestamp in production too.
		prompts[index].CreatedAt = createdAt
	}
	if response != nil {
		response.ID = id + "-response"
		response.RequestID = id
		response.StatusCode = status
		response.CreatedAt = createdAt
	}
	err := db.InsertLogRecord(t.Context(), store.LogRecord{
		Request: store.RequestLog{
			ID: id, TraceID: "trace-" + id, APIKeyID: "key-" + id, Method: http.MethodPost, ClientIP: "192.0.2.10",
			UserAgent: "test-agent", Model: "test-model", Endpoint: "/v1/chat/completions", Provider: "provider-a",
			StatusCode: status, LatencyMS: 123, SessionID: "session-" + id, CreatedAt: createdAt,
		},
		Prompts:  prompts,
		Response: response,
		Usage: &store.TokenUsage{ID: "usage-" + id, RequestID: id, PromptTokens: 3, CompletionTokens: 4,
			TotalTokens: 7, EstimatedCost: 1.25, Currency: "KRW", CreatedAt: createdAt},
	})
	if err != nil {
		t.Fatal(err)
	}
}

type requestIOTestResponse struct {
	Previews []requestIOPreview `json:"previews"`
	Capture  requestIOCapture   `json:"capture"`
}

func adminGetJSON(t *testing.T, url, token string, out any) int {
	t.Helper()
	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode == http.StatusOK {
		if cache := response.Header.Get("Cache-Control"); cache != "no-store" {
			t.Fatalf("captured text must not be cached: Cache-Control=%q", cache)
		}
		if err := json.Unmarshal(body, out); err != nil {
			t.Fatalf("decode %s: %v", body, err)
		}
	}
	return response.StatusCode
}

func TestRequestIOPreviewsShowInputOutputAndHonestCaptureState(t *testing.T) {
	_, db, gateway := newAdminModelsTestServer(t, "")
	at := time.Date(2026, 9, 4, 1, 2, 3, 0, time.UTC)
	conversation := func(last string) []store.PromptLog {
		return []store.PromptLog{
			{Role: "system", RedactedText: "시스템 지시"},
			{Role: "user", RedactedText: "첫 질문"},
			{Role: "assistant", RedactedText: "첫 답변"},
			{Role: "user", RedactedText: last},
			{Role: "tools", RedactedText: `[{"type":"function"}]`},
		}
	}
	insertRequestIORow(t, db, "req-text", 200, conversation("마지막 질문"), &store.ResponseLog{FinishReason: "stop", ResponseTextOptional: "모델 답변입니다"}, at)
	insertRequestIORow(t, db, "req-off", 200, conversation("저장 꺼짐 질문"), &store.ResponseLog{FinishReason: "stop", ResponseHash: "abc"}, at.Add(time.Second))
	insertRequestIORow(t, db, "req-none", 403, nil, nil, at.Add(2*time.Second))
	insertRequestIORow(t, db, "req-tool", 200, conversation("도구 질문"), &store.ResponseLog{FinishReason: "tool_calls",
		ResponseTextOptional: `{"choices":[{"message":{"content":null,"tool_calls":[{"function":{"name":"search_orders","arguments":"{}"}}]}}]}`}, at.Add(3*time.Second))
	insertRequestIORow(t, db, "req-error", 429, conversation("한도 질문"), &store.ResponseLog{ResponseTextOptional: `{"error":{"message":"rate limit reached"}}`}, at.Add(4*time.Second))

	var page requestIOTestResponse
	status := adminGetJSON(t, gateway.URL+"/admin/requests/io?ids=req-text,req-off,req-none,req-tool,req-error,req-unknown", "", &page)
	if status != http.StatusOK {
		t.Fatalf("status=%d", status)
	}
	byID := map[string]requestIOPreview{}
	for _, preview := range page.Previews {
		byID[preview.RequestID] = preview
	}
	if _, leaked := byID["req-unknown"]; leaked || len(page.Previews) != 5 {
		t.Fatalf("previews=%+v", page.Previews)
	}

	text := byID["req-text"]
	if text.Input.Text != "마지막 질문" || text.Input.Role != "user" || text.Input.MessageCount != 4 || text.Input.State != requestIOStateCaptured {
		t.Fatalf("input must be the last user message and exclude tool definitions: %+v", text.Input)
	}
	if text.Output.Text != "모델 답변입니다" || text.Output.Kind != requestOutputKindText || text.Output.State != requestIOStateCaptured || text.Output.FinishReason != "stop" {
		t.Fatalf("output=%+v", text.Output)
	}
	if off := byID["req-off"].Output; off.State != requestIOStateNotCaptured || off.Text != "" {
		t.Fatalf("a kept response without a body is not a missing response: %+v", off)
	}
	none := byID["req-none"]
	if none.Output.State != requestIOStateMissing || none.Input.State != requestIOStateMissing {
		t.Fatalf("no row must read as missing: %+v", none)
	}
	if tool := byID["req-tool"].Output; tool.Kind != requestOutputKindToolCalls || len(tool.ToolNames) != 1 || tool.ToolNames[0] != "search_orders" {
		t.Fatalf("tool output=%+v", tool)
	}
	if failed := byID["req-error"].Output; failed.Kind != requestOutputKindError || failed.Text != "rate limit reached" {
		t.Fatalf("error output=%+v", failed)
	}
}

func TestRequestIOPreviewsMaskBeforeCuttingAndBoundText(t *testing.T) {
	_, db, gateway := newAdminModelsTestServer(t, "")
	at := time.Date(2026, 9, 4, 1, 2, 3, 0, time.UTC)
	secretKey := "sk-abcdefghijklmnopqrstuvwxyz123456"
	long := strings.Repeat("가", requestIOPreviewRunes+50)
	insertRequestIORow(t, db, "req-mask", 200,
		[]store.PromptLog{{Role: "user", RedactedText: long}},
		&store.ResponseLog{ResponseTextOptional: "연락처 010-1234-5678 키 " + secretKey + " 끝"}, at)
	var page requestIOTestResponse
	if status := adminGetJSON(t, gateway.URL+"/admin/requests/io?ids=req-mask", "", &page); status != http.StatusOK || len(page.Previews) != 1 {
		t.Fatalf("status=%d page=%+v", status, page)
	}
	preview := page.Previews[0]
	if strings.Contains(preview.Output.Text, secretKey) || strings.Contains(preview.Output.Text, "010-1234-5678") {
		t.Fatalf("output preview leaked: %q", preview.Output.Text)
	}
	if !preview.Input.Truncated || len([]rune(preview.Input.Text)) != requestIOPreviewRunes {
		t.Fatalf("input preview must be cut at the rune limit: %d runes truncated=%v", len([]rune(preview.Input.Text)), preview.Input.Truncated)
	}
}

func TestRequestIOMaskerHidesOnlyWhatItMust(t *testing.T) {
	server, _, _ := newAdminModelsTestServer(t, "")
	mask := server.requestIOMasker("provider-a")

	key := "sk-abcdefghijklmnopqrstuvwxyz123456"
	got := mask("앞 문장\n발급된 키는 " + key + " 입니다\n뒤 문장")
	if strings.Contains(got, key) || !strings.Contains(got, "앞 문장") || !strings.Contains(got, "뒤 문장") || !strings.Contains(got, "발급된 키는") {
		t.Fatalf("a key must be masked in place, not take the answer with it: %q", got)
	}

	long := strings.Repeat("긴 답변 한 줄입니다.\n", 20_000)
	if len(long) <= 64*1024 {
		t.Fatalf("fixture is too short: %d", len(long))
	}
	if masked := mask(long); masked != long {
		t.Fatalf("a long answer must stay readable: %d bytes became %d", len(long), len(masked))
	}

	minified := `{"a":"` + strings.Repeat("가", 80_000) + `"}`
	if masked := mask(minified); masked != minified {
		t.Fatalf("one long line must not be omitted for its length alone: %d bytes became %d", len(minified), len(masked))
	}

	prefix := uiCredentialPrefixes(server.cfg.Auth)
	if len(prefix) == 0 {
		t.Fatal("no configured credential prefix")
	}
	// The projection recognizes generated keys, whose suffix runs to at least 32 characters.
	configured := prefix[0] + strings.Repeat("abcdefgh", 5)
	got = mask("첫 줄\n사용자 키 " + configured + "\n마지막 줄")
	if strings.Contains(got, configured) || !strings.Contains(got, "첫 줄") || !strings.Contains(got, "마지막 줄") {
		t.Fatalf("a configured credential must cost only its line: %q", got)
	}

	if mask("") != "" {
		t.Fatal("empty text must stay empty")
	}
	if crlf := mask("한 줄\r\n둘째 줄\r\n"); crlf != "한 줄\r\n둘째 줄\r\n" {
		t.Fatalf("line endings must survive: %q", crlf)
	}
}

func TestRequestIOPreviewsRejectBadInput(t *testing.T) {
	_, _, gateway := newAdminModelsTestServer(t, "")
	var ignored any
	tooMany := make([]string, requestIOMaxIDs+1)
	for index := range tooMany {
		tooMany[index] = "req-" + strings.Repeat("x", 3) + string(rune('a'+index%26)) + string(rune('a'+index/26))
	}
	if status := adminGetJSON(t, gateway.URL+"/admin/requests/io?ids="+strings.Join(tooMany, ","), "", &ignored); status != http.StatusBadRequest {
		t.Fatalf("too many ids status=%d", status)
	}
	if status := adminGetJSON(t, gateway.URL+"/admin/requests/io?ids="+strings.Repeat("a", requestIOIDListBytes+1), "", &ignored); status != http.StatusBadRequest {
		t.Fatalf("oversized ids status=%d", status)
	}
	var empty requestIOTestResponse
	if status := adminGetJSON(t, gateway.URL+"/admin/requests/io", "", &empty); status != http.StatusOK || len(empty.Previews) != 0 {
		t.Fatalf("no ids status=%d page=%+v", status, empty)
	}
}

func TestRequestIODetailMasksByDefaultAndAuditsReveal(t *testing.T) {
	_, db, gateway := newAdminModelsTestServer(t, "")
	at := time.Date(2026, 9, 4, 1, 2, 3, 0, time.UTC)
	insertRequestIORow(t, db, "req-detail", 200, []store.PromptLog{
		{Role: "system", RedactedText: "시스템 지시"},
		{Role: "user", ContentText: "제 번호는 010-1234-5678", RedactedText: "제 번호는 [REDACTED_PHONE_KR]"},
		{Role: "tools", RedactedText: `[{"type":"function","function":{"name":"lookup"}}]`},
	}, &store.ResponseLog{FinishReason: "tool_calls", ResponseTextOptional: `{"choices":[{"message":{"content":"확인된 번호 010-1234-5678","tool_calls":[{"function":{"name":"lookup","arguments":"{\"phone\":\"010-1234-5678\"}"}}]}}]}`}, at)

	var masked requestIODetail
	if status := adminGetJSON(t, gateway.URL+"/admin/requests/req-detail/io", "", &masked); status != http.StatusOK {
		t.Fatalf("status=%d", status)
	}
	encoded, _ := json.Marshal(masked)
	if strings.Contains(string(encoded), "010-1234-5678") {
		t.Fatalf("masked detail leaked: %s", encoded)
	}
	if !masked.Masked || !masked.RawAllowed || masked.Input.State != requestIOStateCaptured || len(masked.Input.Messages) != 2 {
		t.Fatalf("masked detail=%+v", masked)
	}
	if !strings.Contains(masked.Input.ToolDefinitions, "lookup") {
		t.Fatalf("tool definitions belong apart from the conversation: %+v", masked.Input)
	}
	if !masked.Input.Messages[1].OriginalKept {
		t.Fatalf("the viewer must learn an original exists: %+v", masked.Input.Messages[1])
	}
	if !masked.Output.OriginalKept {
		t.Fatalf("a response stored before masking on write still holds an original: %+v", masked.Output)
	}
	insertRequestIORow(t, db, "req-clean", 200, []store.PromptLog{{Role: "user", RedactedText: "질문"}},
		&store.ResponseLog{FinishReason: "stop", ResponseTextOptional: "마스킹할 것이 없는 답변"}, at)
	var clean requestIODetail
	if status := adminGetJSON(t, gateway.URL+"/admin/requests/req-clean/io", "", &clean); status != http.StatusOK || clean.Output.OriginalKept || clean.Input.Messages[0].OriginalKept {
		t.Fatalf("nothing was masked, so there is no original to reveal: status=%d %+v", status, clean)
	}
	if masked.Output.Kind != requestOutputKindText || masked.Output.FinishReason != "tool_calls" || len(masked.Output.ToolCalls) != 1 || masked.Output.ToolCalls[0].Name != "lookup" {
		t.Fatalf("output=%+v", masked.Output)
	}
	if strings.Contains(masked.Output.ToolCalls[0].Arguments, "010") {
		t.Fatalf("tool arguments must be masked: %+v", masked.Output.ToolCalls[0])
	}

	before, err := db.ListAdminAudit(t.Context(), 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range before {
		if entry.Action == "request.raw_view" {
			t.Fatalf("a masked read must not write a raw view audit: %+v", entry)
		}
	}
	var revealed requestIODetail
	if status := adminGetJSON(t, gateway.URL+"/admin/requests/req-detail/io?reveal=raw", "", &revealed); status != http.StatusOK {
		t.Fatalf("reveal status=%d", status)
	}
	if revealed.Masked || !strings.Contains(revealed.Input.Messages[1].Text, "010-1234-5678") || !strings.Contains(revealed.Output.Text, "010-1234-5678") {
		t.Fatalf("revealed=%+v", revealed)
	}
	after, err := db.ListAdminAudit(t.Context(), 100)
	if err != nil {
		t.Fatal(err)
	}
	audited := false
	for _, entry := range after {
		if entry.Action == "request.raw_view" && strings.Contains(entry.AfterValue, "req-detail") {
			audited = true
			if strings.Contains(entry.AfterValue, "010-1234-5678") {
				t.Fatalf("the audit must not copy the content: %+v", entry)
			}
		}
	}
	if !audited {
		t.Fatal("reveal did not write an audit entry")
	}

	var ignored any
	if status := adminGetJSON(t, gateway.URL+"/admin/requests/req-detail/io?reveal=everything", "", &ignored); status != http.StatusBadRequest {
		t.Fatalf("unknown reveal status=%d", status)
	}
	if status := adminGetJSON(t, gateway.URL+"/admin/requests/req-missing/io", "", &ignored); status != http.StatusNotFound {
		t.Fatalf("missing request status=%d", status)
	}
}
