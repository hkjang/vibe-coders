package proxy

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

// What a proxied call leaves behind for operators: prompts, the answer, tokens, cost and the
// reason it failed. These run the real pipeline against a fake upstream and read back what
// was stored, because each defect here was invisible from the client's side of the call.

type captureEnv struct {
	url    string
	db     *store.SQLStore
	server *Server
}

func newCaptureEnv(t *testing.T, upstream http.HandlerFunc, mutate func(*config.Config)) *captureEnv {
	t.Helper()
	fake := httptest.NewServer(upstream)
	t.Cleanup(fake.Close)
	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 64, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()); db.Close() })
	cfg := testConfig(fake.URL, "s")
	cfg.Logging.ResponseMaxBytes = 1 << 20
	if mutate != nil {
		mutate(&cfg)
	}
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	t.Cleanup(proxy.Close)
	return &captureEnv{url: proxy.URL, db: db, server: server}
}

// post goes through the bare transport so a header the test sets, or leaves out, is what the
// gateway receives and the body comes back exactly as the gateway wrote it.
func (e *captureEnv) post(t *testing.T, path string, body any, headers ...string) (*http.Response, []byte) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, e.url+path, bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	resp, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp, data
}

// newest waits for the nth logged request and returns the newest row's detail.
func (e *captureEnv) newest(t *testing.T, n int) store.RequestDetail {
	t.Helper()
	var rows []store.RecentRequest
	deadline := time.Now().Add(5 * time.Second)
	for {
		var err error
		rows, err = e.db.RecentRequests(context.Background(), store.RequestFilter{Limit: 50})
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) >= n || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(rows) < n {
		t.Fatalf("expected %d logged requests, got %d", n, len(rows))
	}
	detail, err := e.db.RequestDetail(context.Background(), rows[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	return detail
}

func writeEvents(w http.ResponseWriter, events ...string) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	for _, event := range events {
		_, _ = io.WriteString(w, event)
		if flusher != nil {
			flusher.Flush()
		}
	}
}

func writeJSONBody(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

func oneUserMessage(extra map[string]any) map[string]any {
	body := map[string]any{"model": "test-model", "messages": []any{map[string]any{"role": "user", "content": "hi"}}}
	for key, value := range extra {
		body[key] = value
	}
	return body
}

// maskedViewer is a request from a caller allowed to read the detail but not raw text.
func maskedViewer() *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/admin/requests/x", nil)
	req.Header.Set("Authorization", "Bearer readonly")
	return req
}

func withMaskedViewer(c *config.Config) {
	c.Auth.AdminToken = "admin"
	c.Auth.AdminReadonlyToken = "readonly"
}

// Redaction ------------------------------------------------------------------------------

func TestExtractAuditRedactsSecretsInToolMessages(t *testing.T) {
	body, _ := json.Marshal(map[string]any{"model": "m", "messages": []any{
		map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"id": "c", "type": "function",
			"function": map[string]any{"name": "login", "arguments": `{"password":"hunter2"}`}}}},
		map[string]any{"role": "tool", "tool_call_id": "c", "content": `{"token":"tok_live_abcdef"}`},
	}})
	_, _, prompts, _ := extractAudit(body, "/v1/chat/completions", false)
	if len(prompts) != 2 {
		t.Fatalf("expected 2 prompts, got %d", len(prompts))
	}
	for _, prompt := range prompts {
		if strings.Contains(prompt.RedactedText, "hunter2") || strings.Contains(prompt.RedactedText, "tok_live_abcdef") {
			t.Errorf("redacted_text holds a raw secret: %s", prompt.RedactedText)
		}
	}
	if !strings.Contains(prompts[0].RedactedText, "login") {
		t.Errorf("redaction took the rest of the call with it: %s", prompts[0].RedactedText)
	}
}

// Response cache -------------------------------------------------------------------------

func withEmbeddingCache(c *config.Config) {
	c.Cache.EmbeddingEnabled = true
	c.Cache.EmbeddingTTL = time.Hour
	c.Cache.EmbeddingMaxBytes = 1 << 20
}

// Capture stopped at exactly the cache's own limit, so its size check never tripped. With
// the shipped defaults, retrying a large batch got HTTP 200 with half a JSON document for 24h.
func TestOversizedEmbeddingResponseIsNotCached(t *testing.T) {
	whole := `{"data":[{"embedding":[` + strings.Repeat("0.123456789,", 150000) + `0.1]}],"usage":{"prompt_tokens":5,"total_tokens":5}}`
	e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {
		writeJSONBody(w, http.StatusOK, whole)
	}, withEmbeddingCache)
	body := map[string]any{"model": "test-model", "input": "x"}

	if _, first := e.post(t, "/v1/embeddings", body); len(first) != len(whole) {
		t.Fatalf("the first caller got %d of %d bytes", len(first), len(whole))
	}
	e.newest(t, 1)
	resp, second := e.post(t, "/v1/embeddings", body)
	if resp.Header.Get("X-Cache") == "HIT" {
		t.Errorf("a cut-off capture was replayed from the cache")
	}
	if !json.Valid(second) {
		t.Errorf("the retry got invalid JSON (%d of %d bytes)", len(second), len(whole))
	}
}

func TestOversizedChatResponseIsNotCached(t *testing.T) {
	whole := `{"choices":[{"message":{"content":"` + strings.Repeat("a", 2<<20) + `"},"finish_reason":"stop"}]}`
	e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {
		writeJSONBody(w, http.StatusOK, whole)
	}, func(c *config.Config) {
		c.Cache.ChatEnabled = true
		c.Cache.ChatTTL = time.Hour
		c.Cache.EmbeddingMaxBytes = 1 << 20
	})
	body := oneUserMessage(map[string]any{"temperature": 0})

	e.post(t, "/v1/chat/completions", body)
	e.newest(t, 1)
	resp, second := e.post(t, "/v1/chat/completions", body)
	if resp.Header.Get("X-Cache") == "HIT" || !json.Valid(second) {
		t.Errorf("a cut-off capture was replayed: x-cache=%q, %d bytes", resp.Header.Get("X-Cache"), len(second))
	}
}

func TestPartialUpstreamBodyIsNotCached(t *testing.T) {
	e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {
		conn, buffered, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		fmt.Fprintf(buffered, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{\"data\":[{\"embedding\":[0.1,0.2")
		buffered.Flush()
	}, withEmbeddingCache)
	body := map[string]any{"model": "test-model", "input": "x"}

	e.post(t, "/v1/embeddings", body)
	if row := e.newest(t, 1); row.Request.Error == "" {
		t.Errorf("the failed copy left no error on the row")
	}
	resp, second := e.post(t, "/v1/embeddings", body)
	if resp.Header.Get("X-Cache") == "HIT" {
		t.Errorf("a partial upstream body was replayed as a 200: %q", second)
	}
}

// The guard must not stop the cache from working on the bodies it exists for.
func TestCompleteResponsesAreStillCached(t *testing.T) {
	e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {
		writeJSONBody(w, http.StatusOK, `{"data":[{"embedding":[0.1]}],"usage":{"prompt_tokens":5,"total_tokens":5}}`)
	}, withEmbeddingCache)
	body := map[string]any{"model": "test-model", "input": "x"}

	e.post(t, "/v1/embeddings", body)
	e.newest(t, 1)
	if resp, _ := e.post(t, "/v1/embeddings", body); resp.Header.Get("X-Cache") != "HIT" {
		t.Errorf("a whole response should have been served from the cache")
	}
}

// Input capture --------------------------------------------------------------------------

func TestExtractAuditReadsResponsesInput(t *testing.T) {
	body, _ := json.Marshal(map[string]any{
		"model":        "m",
		"instructions": "be nice",
		"input": []any{
			"loose string",
			map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "input_text", "text": "what is this"},
				map[string]any{"type": "input_image", "image_url": "data:image/png;base64,AAAA"},
			}},
			map[string]any{"role": "assistant", "type": "message", "content": []any{map[string]any{"type": "output_text", "text": "a cat"}}},
			map[string]any{"role": "developer", "content": "short answers"},
			map[string]any{"type": "reasoning", "summary": []any{}},
			map[string]any{"type": "function_call", "call_id": "c1", "name": "search", "arguments": `{"q":"cats"}`},
			map[string]any{"type": "function_call_output", "call_id": "c1", "output": "three results"},
			map[string]any{"type": "item_reference", "id": "x"},
		},
	})

	_, _, prompts, _ := extractAudit(body, "/v1/responses", false)

	want := [][2]string{
		{"system", "be nice"},
		{"user", "loose string"},
		{"user", "what is this\n[이미지 첨부]"},
		{"assistant", "a cat"},
		{"developer", "short answers"},
		{"assistant", `[{"function":{"arguments":"{\"q\":\"cats\"}","name":"search"},"type":"function"}]`},
		{"tool", "three results"},
	}
	if len(prompts) != len(want) {
		t.Fatalf("expected %d prompts, got %#v", len(want), prompts)
	}
	for i, prompt := range prompts {
		if prompt.Role != want[i][0] || prompt.RedactedText != want[i][1] {
			t.Errorf("prompt %d = %s %q, want %s %q", i, prompt.Role, prompt.RedactedText, want[i][0], want[i][1])
		}
	}

	stringInput, _ := json.Marshal(map[string]any{"model": "m", "input": "just text"})
	_, _, prompts, _ = extractAudit(stringInput, "/v1/responses", false)
	if len(prompts) != 1 || prompts[0].Role != "user" || prompts[0].RedactedText != "just text" {
		t.Errorf("a string input should be one user prompt: %#v", prompts)
	}
}

func TestExtractAuditReadsCompletionsPrompt(t *testing.T) {
	for _, tc := range []struct {
		prompt any
		want   string
	}{
		{"once upon a time", "once upon a time"},
		{[]any{"first", "second"}, "first\nsecond"},
	} {
		body, _ := json.Marshal(map[string]any{"model": "m", "prompt": tc.prompt})
		_, _, prompts, _ := extractAudit(body, "/v1/completions", false)
		if len(prompts) != 1 || prompts[0].Role != "user" || prompts[0].RedactedText != tc.want {
			t.Errorf("prompt %v: got %#v", tc.prompt, prompts)
		}
	}
}

func TestExtractAuditKeepsRawResponsesInputOnlyWhenAsked(t *testing.T) {
	body, _ := json.Marshal(map[string]any{"model": "m", "input": `password = hunter2`})
	_, _, masked, _ := extractAudit(body, "/v1/responses", false)
	_, _, raw, _ := extractAudit(body, "/v1/responses", true)
	if len(masked) != 1 || len(raw) != 1 {
		t.Fatalf("expected one prompt each way, got %d and %d", len(masked), len(raw))
	}
	if masked[0].ContentText != "" || strings.Contains(masked[0].RedactedText, "hunter2") {
		t.Errorf("raw prompts off: %#v", masked[0])
	}
	if !strings.Contains(raw[0].ContentText, "hunter2") {
		t.Errorf("raw prompts on: %#v", raw[0])
	}
}

// /v1/responses metering ------------------------------------------------------------------

func TestResponsesEndpointIsMetered(t *testing.T) {
	const usage = `"usage":{"input_tokens":1000,"output_tokens":500,"total_tokens":1500}`
	priced := func(c *config.Config) {
		c.Pricing["test-model"] = config.ModelPrice{InputKRWPer1M: 1_000_000, OutputKRWPer1M: 1_000_000}
		c.Logging.ResponseText = true
	}
	check := func(t *testing.T, detail store.RequestDetail) {
		t.Helper()
		if detail.Request.PromptTokens != 1000 || detail.Request.CompletionTokens != 500 || detail.Request.TotalTokens != 1500 {
			t.Errorf("tokens = %d/%d/%d, want 1000/500/1500", detail.Request.PromptTokens, detail.Request.CompletionTokens, detail.Request.TotalTokens)
		}
		if detail.Request.TokenSource != "usage" {
			t.Errorf("token source = %q", detail.Request.TokenSource)
		}
		if detail.Request.EstimatedCost != 1500 {
			t.Errorf("cost = %v, want 1500", detail.Request.EstimatedCost)
		}
		if detail.Response.ResponseTextOptional != "hello there" {
			t.Errorf("response text = %.80q", detail.Response.ResponseTextOptional)
		}
		if detail.Response.FinishReason != "stop" {
			t.Errorf("finish reason = %q", detail.Response.FinishReason)
		}
		if len(detail.Prompts) != 2 || detail.Prompts[0].Role != "system" || detail.Prompts[1].RedactedText != "question" {
			t.Errorf("prompts = %#v", detail.Prompts)
		}
	}
	request := map[string]any{"model": "test-model", "instructions": "be nice", "input": "question"}

	t.Run("json", func(t *testing.T) {
		e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {
			writeJSONBody(w, http.StatusOK, `{"object":"response","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hello there"}]}],`+usage+`}`)
		}, priced)
		e.post(t, "/v1/responses", request)
		check(t, e.newest(t, 1))
	})
	t.Run("stream", func(t *testing.T) {
		e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {
			writeEvents(w,
				"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hello \"}\n\n",
				"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"there\"}\n\n",
				`event: response.completed`+"\n"+`data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"hello there"}]}],`+usage+`}}`+"\n\n")
		}, priced)
		streaming := map[string]any{"stream": true}
		for key, value := range request {
			streaming[key] = value
		}
		e.post(t, "/v1/responses", streaming)
		check(t, e.newest(t, 1))
	})
}

// Response text ---------------------------------------------------------------------------

// A tool-only stream used to be stored as the raw SSE. The reader needs the assembled calls,
// and a key split across deltas could not be seen by the redactor, so a viewer without raw
// access could read it back fragment by fragment.
func TestToolCallStreamIsStoredAssembledAndRedacted(t *testing.T) {
	const key = "sk-proabc123def456ghi789jkl012"
	e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {
		events := []string{`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"deploy","arguments":""}}]}}]}` + "\n\n"}
		for _, fragment := range []string{"sk", "-pro", "abc123", "def456", "ghi789", "jkl012"} {
			events = append(events, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"`+fragment+`"}}]}}]}`+"\n\n")
		}
		events = append(events, `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`+"\n\ndata: [DONE]\n\n")
		writeEvents(w, events...)
	}, func(c *config.Config) {
		c.Logging.ResponseText = true
		withMaskedViewer(c)
	})

	e.post(t, "/v1/chat/completions", oneUserMessage(map[string]any{"stream": true}))
	detail := e.newest(t, 1)

	stored := detail.Response.ResponseTextOptional
	if strings.HasPrefix(stored, "data:") {
		t.Fatalf("raw SSE was persisted: %.60q", stored)
	}
	// The key is reassembled from its fragments and then masked before it is stored.
	if strings.Contains(stored, key) {
		t.Fatalf("the reassembled key was stored: %s", stored)
	}
	output := extractRequestOutput(stored, 200)
	if output.Kind != requestOutputKindToolCalls || len(output.ToolCalls) != 1 || output.ToolCalls[0].Name != "deploy" || output.ToolCalls[0].Arguments != audit.Redact(key) {
		t.Fatalf("the stored envelope reads back as %#v", output)
	}
	if detail.Response.FinishReason != "tool_calls" {
		t.Errorf("finish reason = %q", detail.Response.FinishReason)
	}

	viewer := maskedViewer()
	if e.server.canViewRawPrompts(viewer) {
		t.Fatal("the test viewer should not have raw access")
	}
	e.server.maskRequestDetail(viewer, &detail)
	for _, fragment := range []string{key, "abc123", "jkl012"} {
		if strings.Contains(detail.Response.ResponseTextOptional, fragment) {
			t.Errorf("a masked viewer can read %q in %s", fragment, detail.Response.ResponseTextOptional)
		}
	}
}

// Text next to tool calls has to survive with them; storing either one alone loses half of
// what the model said.
func TestTextAndToolCallsAreStoredTogether(t *testing.T) {
	e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {
		writeJSONBody(w, http.StatusOK, `{"choices":[{"message":{"content":"let me look","tool_calls":[{"type":"function","function":{"name":"search","arguments":"{\"q\":1}"}}]},"finish_reason":"tool_calls"}]}`)
	}, func(c *config.Config) { c.Logging.ResponseText = true })

	e.post(t, "/v1/chat/completions", oneUserMessage(nil))
	output := extractRequestOutput(e.newest(t, 1).Response.ResponseTextOptional, 200)
	if output.Text != "let me look" || len(output.ToolCalls) != 1 || output.ToolCalls[0].Arguments != `{"q":1}` {
		t.Fatalf("stored answer reads back as %#v", output)
	}
}

func TestUnrecognizedSuccessBodyIsNotStoredRaw(t *testing.T) {
	e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {
		writeJSONBody(w, http.StatusOK, `{"object":"audio.speech","result":{"unknown":"shape"}}`)
	}, func(c *config.Config) { c.Logging.ResponseText = true })

	e.post(t, "/v1/audio/speech", map[string]any{"model": "test-model", "input": "x"})
	if stored := e.newest(t, 1).Response.ResponseTextOptional; stored != "" {
		t.Fatalf("a body with no answer in it was stored raw: %q", stored)
	}
}

// The vectors are not worth keeping, but an empty output would read as "not captured".
func TestEmbeddingResponseIsStoredAsASummary(t *testing.T) {
	e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {
		writeJSONBody(w, http.StatusOK, `{"data":[{"embedding":[0.1,0.2,0.3]},{"embedding":[0.4,0.5,0.6]}]}`)
	}, func(c *config.Config) { c.Logging.ResponseText = true })

	e.post(t, "/v1/embeddings", map[string]any{"model": "test-model", "input": "x"})
	if stored := e.newest(t, 1).Response.ResponseTextOptional; stored != "임베딩 벡터 2개 · 3차원" {
		t.Fatalf("stored=%q", stored)
	}
}

func TestErrorBodyIsStoredAsItArrived(t *testing.T) {
	const body = `{"error":{"message":"maximum context length exceeded","code":"bad"}}`
	for _, stream := range []bool{false, true} {
		t.Run(fmt.Sprintf("stream=%v", stream), func(t *testing.T) {
			e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {
				writeJSONBody(w, http.StatusBadRequest, body)
			}, func(c *config.Config) { c.Logging.ResponseText = true })

			e.post(t, "/v1/chat/completions", oneUserMessage(map[string]any{"stream": stream}))
			detail := e.newest(t, 1)
			if detail.Response.ResponseTextOptional != body {
				t.Fatalf("stored %q", detail.Response.ResponseTextOptional)
			}
			if output := extractRequestOutput(detail.Response.ResponseTextOptional, 400); output.Kind != requestOutputKindError {
				t.Fatalf("the reader did not see an error: %#v", output)
			}
		})
	}
}

// Limits ----------------------------------------------------------------------------------

// Usage sits at the end of the body, so a body cut at the display limit stopped parsing and
// 700,010 billed tokens were recorded as an estimate of one.
func TestOversizedBodyKeepsMeteringAndCutsOnlyTheText(t *testing.T) {
	const limit = 1 << 20
	e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {
		writeJSONBody(w, http.StatusOK, `{"choices":[{"message":{"content":"`+strings.Repeat("a", 2<<20)+`"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":700000,"total_tokens":700010}}`)
	}, func(c *config.Config) { c.Logging.ResponseText = true })

	e.post(t, "/v1/chat/completions", oneUserMessage(nil))
	detail := e.newest(t, 1)

	if detail.Request.TotalTokens != 700010 || detail.Request.TokenSource != "usage" || detail.Response.FinishReason != "stop" {
		t.Errorf("metering lost: total=%d source=%q finish=%q", detail.Request.TotalTokens, detail.Request.TokenSource, detail.Response.FinishReason)
	}
	stored := detail.Response.ResponseTextOptional
	if len(stored) != limit || strings.HasPrefix(stored, "{") {
		t.Errorf("expected %d bytes of clean text, got %d: %.30q", limit, len(stored), stored)
	}
}

func TestZeroResponseMaxBytesKeepsMetering(t *testing.T) {
	e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {
		writeJSONBody(w, http.StatusOK, `{"choices":[{"message":{"content":"hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`)
	}, func(c *config.Config) {
		c.Logging.ResponseText = true
		c.Logging.ResponseMaxBytes = 0
	})

	e.post(t, "/v1/chat/completions", oneUserMessage(nil))
	detail := e.newest(t, 1)
	if detail.Request.TotalTokens != 15 || detail.Response.FinishReason != "stop" {
		t.Errorf("metering lost: total=%d finish=%q", detail.Request.TotalTokens, detail.Response.FinishReason)
	}
	if detail.Response.ResponseTextOptional != "" {
		t.Errorf("a zero limit should store no text, got %q", detail.Response.ResponseTextOptional)
	}
}

func TestStreamedTextHonorsResponseMaxBytes(t *testing.T) {
	const limit = 4097 // not a multiple of the 3 bytes in each character below
	chunk := `data: {"choices":[{"delta":{"content":"` + strings.Repeat("한", 300) + `"}}]}` + "\n\n"
	e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {
		writeEvents(w, strings.Repeat(chunk, 50))
	}, func(c *config.Config) {
		c.Logging.ResponseText = true
		c.Logging.ResponseMaxBytes = limit
	})

	e.post(t, "/v1/chat/completions", oneUserMessage(map[string]any{"stream": true}))
	detail := e.newest(t, 1)

	stored := detail.Response.ResponseTextOptional
	if len(stored) > limit || len(stored) < limit-2 {
		t.Errorf("stored %d bytes with a %d limit", len(stored), limit)
	}
	if !utf8.ValidString(stored) {
		t.Errorf("the cut split a character")
	}
	// The whole 15,000-character answer still counts toward the estimate.
	if detail.Request.CompletionTokens < 3000 {
		t.Errorf("completion estimate = %d; it should count what was streamed, not what was stored", detail.Request.CompletionTokens)
	}
}

// Compression -----------------------------------------------------------------------------

func gzipped(t *testing.T, body string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := gzip.NewWriter(&buffer)
	if _, err := io.WriteString(writer, body); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

// The gateway meters the body and decodes only gzip. Forwarding a client's br let a provider
// answer in something the analyzer read as noise: no usage, no finish reason, binary text.
func TestUpstreamIsAskedForGzipWhateverTheClientAccepts(t *testing.T) {
	const answer = `{"choices":[{"message":{"content":"hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}`
	for _, accept := range []string{"br, gzip, deflate", "br", "zstd", "identity", ""} {
		t.Run("accept="+accept, func(t *testing.T) {
			seen := make(chan string, 1)
			e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {
				seen <- r.Header.Get("Accept-Encoding")
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Content-Encoding", "gzip")
				_, _ = w.Write(gzipped(t, answer))
			}, func(c *config.Config) { c.Logging.ResponseText = true })

			headers := []string{}
			if accept != "" {
				headers = []string{"Accept-Encoding", accept}
			}
			resp, body := e.post(t, "/v1/chat/completions", oneUserMessage(nil), headers...)

			if got := <-seen; got != "gzip" {
				t.Errorf("the upstream was asked for %q", got)
			}
			if encoding := resp.Header.Get("Content-Encoding"); encoding != "" {
				t.Errorf("the client got Content-Encoding %q on a body the gateway decoded", encoding)
			}
			if string(body) != answer {
				t.Errorf("the client got %q", body)
			}
			detail := e.newest(t, 1)
			if detail.Request.TotalTokens != 15 || detail.Response.FinishReason != "stop" || detail.Response.ResponseTextOptional != "hello" {
				t.Errorf("metering lost: %d %q %q", detail.Request.TotalTokens, detail.Response.FinishReason, detail.Response.ResponseTextOptional)
			}
		})
	}
}

func TestStreamedGzipResponseStaysAStream(t *testing.T) {
	e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Content-Encoding", "gzip")
		writer := gzip.NewWriter(w)
		for _, event := range []string{
			`data: {"choices":[{"delta":{"content":"hel"}}]}` + "\n\n",
			`data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}` + "\n\n",
		} {
			_, _ = io.WriteString(writer, event)
			_ = writer.Flush()
			w.(http.Flusher).Flush()
		}
		_ = writer.Close()
	}, func(c *config.Config) { c.Logging.ResponseText = true })

	resp, body := e.post(t, "/v1/chat/completions", oneUserMessage(map[string]any{"stream": true}), "Accept-Encoding", "br")
	if !strings.Contains(string(body), `"content":"hel"`) || resp.Header.Get("Content-Encoding") != "" {
		t.Fatalf("the client got %q (encoding %q)", body, resp.Header.Get("Content-Encoding"))
	}
	detail := e.newest(t, 1)
	if detail.Response.ResponseTextOptional != "hello" || detail.Request.TotalTokens != 3 {
		t.Errorf("stored %q, %d tokens", detail.Response.ResponseTextOptional, detail.Request.TotalTokens)
	}
}

// With an explicit gzip header the transport stops decoding, and the overflow check would
// have read a compressed error body as noise and never retried.
func TestContextOverflowIsRecognizedInACompressedError(t *testing.T) {
	e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {
		var root map[string]any
		_ = json.NewDecoder(r.Body).Decode(&root)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Encoding", "gzip")
		if root["model"] != "o3" {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write(gzipped(t, `{"error":{"code":"context_length_exceeded","message":"maximum context length exceeded"}}`))
			return
		}
		_, _ = w.Write(gzipped(t, `{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`))
	}, nil)

	resp, _ := e.post(t, "/v1/chat/completions", map[string]any{"model": "tiny", "messages": []any{map[string]any{"role": "user", "content": "hi"}}}, "Accept-Encoding", "gzip")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected the long-context retry to answer, got %d", resp.StatusCode)
	}
}

// Failures --------------------------------------------------------------------------------

func TestInBandStreamErrorIsRecorded(t *testing.T) {
	e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {
		writeEvents(w, `data: {"choices":[{"delta":{"content":"par"}}]}`+"\n\n", `data: {"error":{"message":"overloaded","type":"server_error"}}`+"\n\n")
	}, nil)

	e.post(t, "/v1/chat/completions", oneUserMessage(map[string]any{"stream": true}))
	detail := e.newest(t, 1)
	if detail.Request.StatusCode != http.StatusOK {
		t.Errorf("status = %d; the client was sent a 200", detail.Request.StatusCode)
	}
	if detail.Request.Error != "upstream_error: overloaded (server_error)" {
		t.Errorf("error = %q", detail.Request.Error)
	}
}

func TestUpstreamStatusErrorIsRecordedWithResponseLoggingOff(t *testing.T) {
	message := "invalid key sk-abcdefghijklmnopqrstuvwxyz0123456789 " + strings.Repeat("x", 4000)
	body, _ := json.Marshal(map[string]any{"error": map[string]any{"message": message, "code": "invalid_api_key"}})
	for _, stream := range []bool{false, true} {
		t.Run(fmt.Sprintf("stream=%v", stream), func(t *testing.T) {
			e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {
				writeJSONBody(w, http.StatusUnauthorized, string(body))
			}, nil)

			resp, got := e.post(t, "/v1/chat/completions", oneUserMessage(map[string]any{"stream": stream}))
			if resp.StatusCode != http.StatusUnauthorized || !bytes.Equal(got, body) {
				t.Errorf("the client got %d %.60q", resp.StatusCode, got)
			}
			detail := e.newest(t, 1)
			if detail.Request.StatusCode != http.StatusUnauthorized {
				t.Errorf("status = %d", detail.Request.StatusCode)
			}
			if !strings.HasPrefix(detail.Request.Error, "upstream_401: invalid key [REDACTED_OPENAI_KEY]") {
				t.Errorf("error = %.80q", detail.Request.Error)
			}
			if len(detail.Request.Error) > upstreamErrorMaxBytes {
				t.Errorf("error is %d bytes", len(detail.Request.Error))
			}
			if detail.Response.ResponseTextOptional != "" {
				t.Errorf("response logging is off, yet the body was stored")
			}
		})
	}
}

func TestPlainUpstreamFailureKeepsItsStatusAsTheReason(t *testing.T) {
	e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = io.WriteString(w, "<html><body>Bad Gateway</body></html>")
	}, nil)

	e.post(t, "/v1/chat/completions", oneUserMessage(nil))
	if got := e.newest(t, 1).Request.Error; got != "upstream_502" {
		t.Errorf("error = %q", got)
	}
}

func abandonStream(t *testing.T, e *captureEnv, body map[string]any, beforeCancel func()) {
	t.Helper()
	raw, _ := json.Marshal(body)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.url+"/v1/chat/completions", bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	reader := bufio.NewReader(resp.Body)
	for i := 0; i < 6; i++ {
		if _, err := reader.ReadString('\n'); err != nil {
			t.Fatal(err)
		}
	}
	if beforeCancel != nil {
		beforeCancel()
	}
	cancel()
}

func endlessStream(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	flusher := w.(http.Flusher)
	for i := 0; i < 1000; i++ {
		if _, err := fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":\"c%d \"}}]}\n\n", i); err != nil {
			return
		}
		flusher.Flush()
		select {
		case <-r.Context().Done():
			return
		case <-time.After(5 * time.Millisecond):
		}
	}
}

// The error column is what every success rate and error budget reads, so a client leaving
// must not touch it, while the row still has to say the answer was cut short.
func TestClientDisconnectIsMarkedWithoutCountingAsAFailure(t *testing.T) {
	e := newCaptureEnv(t, endlessStream, func(c *config.Config) { c.Logging.ResponseText = true })

	abandonStream(t, e, oneUserMessage(map[string]any{"stream": true}), nil)
	detail := e.newest(t, 1)

	if detail.Response.FinishReason != finishReasonClientDisconnected {
		t.Errorf("finish reason = %q", detail.Response.FinishReason)
	}
	if detail.Request.Error != "" {
		t.Errorf("error = %q; a client leaving is not a provider failure", detail.Request.Error)
	}
	if detail.Request.StatusCode != http.StatusOK {
		t.Errorf("status = %d", detail.Request.StatusCode)
	}
	if detail.Request.TotalTokens == 0 || detail.Response.ResponseTextOptional == "" {
		t.Errorf("what was generated before the client left has to stay: %d tokens, %q", detail.Request.TotalTokens, detail.Response.ResponseTextOptional)
	}
	scores, err := e.db.ProviderHealthScores(context.Background(), time.Now().Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	for _, score := range scores {
		if score.Timeouts != 0 || score.Rate5xx != 0 || score.Fallbacks != 0 {
			t.Errorf("a client leaving moved the provider's health: %#v", score)
		}
	}
}

func TestClientLeavingAfterTheFinalChunkIsNotAbandonment(t *testing.T) {
	e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {
		writeEvents(w, strings.Repeat(`data: {"choices":[{"delta":{"content":"x"}}]}`+"\n\n", 3), `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`+"\n\n")
		<-r.Context().Done()
	}, nil)

	abandonStream(t, e, oneUserMessage(map[string]any{"stream": true}), nil)
	if got := e.newest(t, 1).Response.FinishReason; got != "stop" {
		t.Errorf("finish reason = %q; the client had the whole answer", got)
	}
}

// A provider's own timeout also ends the copy with a context error, but its deadline is the
// provider's and the client is still there. That one is a failure.
func TestProviderTimeoutIsNotMistakenForADisconnect(t *testing.T) {
	e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {
		writeEvents(w, `data: {"choices":[{"delta":{"content":"par"}}]}`+"\n\n")
		<-r.Context().Done()
	}, func(c *config.Config) { c.Upstream.Timeout = 100 * time.Millisecond })

	e.post(t, "/v1/chat/completions", oneUserMessage(map[string]any{"stream": true}))
	detail := e.newest(t, 1)
	if detail.Request.Error == "" {
		t.Errorf("a provider timeout left no error")
	}
	if detail.Response.FinishReason == finishReasonClientDisconnected {
		t.Errorf("a provider timeout was recorded as the client leaving")
	}
}

type failingResponseWriter struct{ http.ResponseWriter }

func (failingResponseWriter) Write([]byte) (int, error) { return 0, errors.New("broken pipe") }

func TestFailedWriteToTheClientIsADisconnect(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	server := &Server{}

	_, _, err := server.copyResponse(failingResponseWriter{recorder}, strings.NewReader("data"), NewResponseAnalyzer(false, false, 16), false, time.Now())
	if !clientDisconnected(request, err) {
		t.Errorf("a failed write should read as the client leaving: %v", err)
	}

	_, _, err = server.copyResponse(recorder, iotestErrReader{}, NewResponseAnalyzer(false, false, 16), false, time.Now())
	if err == nil || clientDisconnected(request, err) {
		t.Errorf("a failed read from the upstream is the provider's failure: %v", err)
	}
}

type iotestErrReader struct{}

func (iotestErrReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

// An upstream that ignores stream:true still answers in JSON, and its usage is the real one.
func TestStreamRequestAnsweredInJSONIsMetered(t *testing.T) {
	e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {
		writeJSONBody(w, http.StatusOK, `{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}`)
	}, nil)

	e.post(t, "/v1/chat/completions", oneUserMessage(map[string]any{"stream": true}))
	detail := e.newest(t, 1)
	if detail.Request.TokenSource != "usage" || detail.Request.TotalTokens != 8 || detail.Response.FinishReason != "stop" {
		t.Errorf("source=%q total=%d finish=%q", detail.Request.TokenSource, detail.Request.TotalTokens, detail.Response.FinishReason)
	}
}

// Media and estimates ---------------------------------------------------------------------

func TestFlattenContentNamesMediaInsteadOfCopyingIt(t *testing.T) {
	base64Data := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1, 2, 3, 200}, 1000))
	for _, tc := range []struct {
		name string
		part map[string]any
		want string
	}{
		{"chat image", map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:image/png;base64," + base64Data}}, "[이미지 첨부]"},
		{"responses image", map[string]any{"type": "input_image", "image_url": "data:image/png;base64," + base64Data}, "[이미지 첨부]"},
		{"anthropic image", map[string]any{"type": "image", "source": map[string]any{"data": base64Data}}, "[이미지 첨부]"},
		{"untyped image", map[string]any{"image_url": map[string]any{"url": base64Data}}, "[이미지 첨부]"},
		{"audio", map[string]any{"type": "input_audio", "input_audio": map[string]any{"data": base64Data}}, "[오디오 첨부]"},
		{"video", map[string]any{"type": "video_url", "video_url": map[string]any{"url": base64Data}}, "[영상 첨부]"},
		{"file", map[string]any{"type": "file", "file": map[string]any{"file_data": base64Data}}, "[파일 첨부]"},
		{"responses file", map[string]any{"type": "input_file", "file_data": base64Data}, "[파일 첨부]"},
		{"anthropic document", map[string]any{"type": "document", "source": map[string]any{"data": base64Data}}, "[파일 첨부]"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := flattenContent([]any{map[string]any{"type": "text", "text": "look"}, tc.part})
			if got != "look\n"+tc.want {
				t.Errorf("got %.60q", got)
			}
		})
	}

	// Text parts and parts that are not media stay as they were.
	unchanged := flattenContent([]any{"loose", map[string]any{"type": "text", "text": "typed"}, map[string]any{"input_text": "other"}, map[string]any{"type": "custom", "value": 1}})
	if unchanged != "loose\ntyped\nother\n"+`{"type":"custom","value":1}` {
		t.Errorf("non-media parts changed: %q", unchanged)
	}
	if got := flattenContent(map[string]any{"type": "computer_screenshot", "image_url": "data:image/png;base64," + base64Data}); got != "[이미지 첨부]" {
		t.Errorf("a single media object: %.60q", got)
	}
}

// One photo used to count as a million tokens, enough to trip the budget and cost guards on
// its own, and left megabytes of base64 in redacted_text.
func TestImageDoesNotInflateTheTokenEstimate(t *testing.T) {
	image := "data:image/png;base64," + base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1, 2, 3, 200}, 750000))
	body, _ := json.Marshal(map[string]any{"model": "test-model", "messages": []any{map[string]any{"role": "user", "content": []any{
		map[string]any{"type": "text", "text": "what is this"},
		map[string]any{"type": "image_url", "image_url": map[string]any{"url": image}},
	}}}})

	_, _, prompts, _ := extractAudit(body, "/v1/chat/completions", false)

	if estimate := promptTokenEstimate(prompts); estimate > 100 {
		t.Errorf("one image estimated at %d tokens", estimate)
	}
	if len(prompts[0].RedactedText) > 100 {
		t.Errorf("redacted_text kept %d bytes", len(prompts[0].RedactedText))
	}
}

func TestToolOnlyStreamWithoutUsageEstimatesItsArguments(t *testing.T) {
	arguments := strings.Repeat("lorem ipsum dolor ", 200)
	e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {
		writeEvents(w, fmt.Sprintf(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"search","arguments":%q}}]}}]}`+"\n\n", arguments))
	}, nil)

	e.post(t, "/v1/chat/completions", oneUserMessage(map[string]any{"stream": true}))
	detail := e.newest(t, 1)
	if want := audit.EstimateTokens(arguments); detail.Request.CompletionTokens != want || detail.Request.TokenSource != "estimated" {
		t.Errorf("completion = %d (%s), want %d estimated", detail.Request.CompletionTokens, detail.Request.TokenSource, want)
	}
}

// Pricing ---------------------------------------------------------------------------------

func insertPrice(t *testing.T, db *store.SQLStore, id, model string, perMillion float64) {
	t.Helper()
	if err := db.InsertPricingVersion(context.Background(), &store.ModelPricingVersion{ID: id, Model: model, InputKRWPer1M: perMillion, OutputKRWPer1M: perMillion}); err != nil {
		t.Fatal(err)
	}
}

func TestFailedPriceLookupIsNotCached(t *testing.T) {
	e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {}, nil)
	insertPrice(t, e.db, "p1", "db-model", 5)
	e.server.invalidatePricingCache()

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	e.server.pricingMap(cancelled)

	if _, ok := e.server.pricingMap(context.Background())["db-model"]; !ok {
		t.Errorf("one cancelled lookup dropped the database prices for every later caller")
	}
}

func TestFailedPriceLookupKeepsTheLastGoodPrices(t *testing.T) {
	e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {}, nil)
	insertPrice(t, e.db, "p1", "db-model", 5)
	e.server.invalidatePricingCache()
	e.server.pricingMap(context.Background())
	snapshot := e.server.priceCache.Load()
	e.server.priceCache.Store(&pricingSnapshot{prices: snapshot.prices, fetchedAt: time.Now().Add(-2 * pricingSnapshotTTL)})

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, ok := e.server.pricingMap(cancelled)["db-model"]; !ok {
		t.Errorf("a failed refresh should answer from the expired snapshot")
	}
	if got := e.server.priceCache.Load(); time.Since(got.fetchedAt) < pricingSnapshotTTL {
		t.Errorf("a failed refresh must not look like a fresh one")
	}
}

// The client hanging up cancels r.Context(), and that is exactly when the row still has to
// be priced. A long stream outlives the 30s snapshot, so this is not a corner case.
func TestAbandonedStreamIsPricedFromTheDatabase(t *testing.T) {
	e := newCaptureEnv(t, endlessStream, nil)
	insertPrice(t, e.db, "p1", "db-model", 1_000_000)

	body := oneUserMessage(map[string]any{"stream": true, "model": "db-model"})
	abandonStream(t, e, body, e.server.invalidatePricingCache)

	detail := e.newest(t, 1)
	if detail.Request.TotalTokens == 0 {
		t.Fatal("expected estimated tokens")
	}
	if want := float64(detail.Request.TotalTokens); detail.Request.EstimatedCost != want {
		t.Errorf("cost = %v, want %v from the database price", detail.Request.EstimatedCost, want)
	}
}

// Leak ------------------------------------------------------------------------------------

func TestAnonymousModelsPollDoesNotGrowLoggedRequests(t *testing.T) {
	e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {
		writeJSONBody(w, http.StatusOK, `{"object":"list","data":[{"id":"test-model","object":"model"}]}`)
	}, nil)

	for _, path := range []string{"/v1/models", "/v1/models?provider=test"} {
		for i := 0; i < 20; i++ {
			resp, err := http.Get(e.url + path)
			if err != nil {
				t.Fatal(err)
			}
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("%s: status %d", path, resp.StatusCode)
			}
		}
	}

	entries := 0
	e.server.loggedRequests.Range(func(_, _ any) bool {
		entries++
		return true
	})
	if entries != 0 {
		t.Errorf("%d entries left in loggedRequests", entries)
	}
}

// Reasoning -------------------------------------------------------------------------------

func TestExplainListPriceBillsReasoningOnce(t *testing.T) {
	server := &Server{}
	server.cfg.Pricing = map[string]config.ModelPrice{"m": {InputKRWPer1M: 1_000_000, OutputKRWPer1M: 1_000_000}}
	for _, tc := range []struct {
		name  string
		total int64
		want  float64
	}{
		{"inside completion", 1200, 1200},
		{"reported separately", 2000, 2000},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := server.explainCost(store.ExplainData{Model: "m", PromptTokens: 200, CompletionTokens: 1000, ReasoningTokens: 800, TotalTokens: tc.total})
			if got["list_krw"] != tc.want {
				t.Errorf("list price = %v, want %v", got["list_krw"], tc.want)
			}
		})
	}
}

// Personal data and secrets in an answer are masked before response_logs is written, the
// same as prompts, so the database holds nothing a screen would have to hide.
func TestResponseTextIsMaskedBeforeItIsStored(t *testing.T) {
	const (
		phone  = "010-1234-5678"
		email  = "hong@example.com"
		apiKey = "sk-abcdefghijklmnopqrstuvwxyz123456"
		secret = "hunter2-synthetic"
	)
	answer := "연락처 " + phone + ", 메일 " + email + ", 키 " + apiKey
	arguments := `{"email":"` + email + `","password":"` + secret + `"}`
	cases := []struct {
		name   string
		status int
		stream bool
		body   string
	}{
		{name: "answer", status: http.StatusOK, body: `{"choices":[{"message":{"content":` + strconv.Quote(answer) + `},"finish_reason":"stop"}]}`},
		{name: "tool call", status: http.StatusOK, body: `{"choices":[{"message":{"content":null,"tool_calls":[{"type":"function","function":{"name":"register","arguments":` + strconv.Quote(arguments) + `}}]},"finish_reason":"tool_calls"}]}`},
		{name: "stream", status: http.StatusOK, stream: true, body: "data: " + `{"choices":[{"delta":{"content":` + strconv.Quote(answer) + `}}]}` + "\n\ndata: [DONE]\n\n"},
		{name: "error body", status: http.StatusBadRequest, body: `{"error":{"message":` + strconv.Quote("rejected for "+email) + `}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newCaptureEnv(t, func(w http.ResponseWriter, r *http.Request) {
				if tc.stream {
					w.Header().Set("Content-Type", "text/event-stream")
					w.WriteHeader(tc.status)
					_, _ = io.WriteString(w, tc.body)
					return
				}
				writeJSONBody(w, tc.status, tc.body)
			}, func(c *config.Config) { c.Logging.ResponseText = true })
			e.post(t, "/v1/chat/completions", oneUserMessage(map[string]any{"stream": tc.stream}))
			record := e.newest(t, 1)
			stored := record.Response.ResponseTextOptional
			if stored == "" {
				t.Fatal("nothing was stored")
			}
			for _, value := range []string{phone, email, apiKey, secret} {
				if strings.Contains(stored, value) || strings.Contains(record.Request.Error, value) {
					t.Fatalf("%q was stored unmasked: text=%q error=%q", value, stored, record.Request.Error)
				}
			}
			if tc.name == "tool call" {
				output := extractRequestOutput(stored, tc.status)
				if len(output.ToolCalls) != 1 || output.ToolCalls[0].Name != "register" || !strings.Contains(output.ToolCalls[0].Arguments, "[REDACTED") {
					t.Fatalf("masked tool call must still read back: %#v", output)
				}
			}
		})
	}
}
