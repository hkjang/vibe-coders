package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/dlp"
	"vibe-coders/internal/store"
)

// Regression tests for an independent review of the DLP integration. The values
// used here are ones the older, always-on redaction did not recognise (GitLab and
// Hugging Face tokens, passport numbers), so only DLP stands between them and the
// request log.

const (
	reviewGitLab = "glpat-EXAMPLEexampleEXAMPLE00"
	reviewHF     = "hf_EXAMPLEexampleEXAMPLEexample0000"
)

// switchUpstream lets a test choose the provider's raw reply per request.
type switchUpstream struct {
	mu    sync.Mutex
	reply func(w http.ResponseWriter, r *http.Request)
	calls int
	last  string
}

func (u *switchUpstream) handler(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	u.mu.Lock()
	reply := u.reply
	u.calls++
	u.last = string(body)
	u.mu.Unlock()
	reply(w, r)
}

func (u *switchUpstream) lastBody() string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.last
}

func (u *switchUpstream) set(reply func(w http.ResponseWriter, r *http.Request)) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.reply = reply
}

func jsonReply(content string) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, _ *http.Request) {
		encoded, _ := json.Marshal(content)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"c1","object":"chat.completion","model":"test-model","choices":[{"index":0,"message":{"role":"assistant","content":`+string(encoded)+`},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}`)
	}
}

func newReviewEnv(t *testing.T, mutate func(*config.Config)) (*captureEnv, *switchUpstream) {
	t.Helper()
	upstream := &switchUpstream{reply: jsonReply("안내했습니다")}
	return newCaptureEnv(t, upstream.handler, mutate), upstream
}

func storedRequest(t *testing.T, env *captureEnv, requestID string) string {
	t.Helper()
	detail, err := env.db.RequestDetail(context.Background(), requestID)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(detail)
	return string(raw)
}

func policy(id string, action dlp.Action, profiles []string, checks ...dlp.Check) dlp.Policy {
	return dlp.Policy{ID: id, Enabled: true, Action: action, Profiles: profiles, Check: checks}
}

// Findings 1, 2 and 12: no matched value is kept in any stored field — including the
// body summary the console shows and an answer that repeats a prompt's value — and a
// DLP block is logged as one.
func TestDLPReviewLogKeepsNoMatchedValue(t *testing.T) {
	env, upstream := newReviewEnv(t, func(cfg *config.Config) { cfg.Logging.ResponseText = true })
	saveDLP(t, env, 0, dlpPolicies(
		policy("flag-keys", dlp.ActionFlag, []string{"credentials"}, dlp.CheckRequest),
		policy("block-ids", dlp.ActionBlock, []string{"government"}, dlp.CheckRequest),
	))

	upstream.set(jsonReply("확인했습니다. 토큰 " + reviewHF + " 도 그대로 쓰세요"))
	resp, data := dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", chatWith("토큰 "+reviewGitLab+" 와 "+reviewHF+" 확인", false))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("flagged request: %d %s", resp.StatusCode, data)
	}
	resp, data = dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", chatWith("여권번호 M12345678 과 토큰 "+reviewGitLab, false))
	if resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(data), "dlp_request_blocked") {
		t.Fatalf("blocked request: %d %s", resp.StatusCode, data)
	}

	events := dlpEventsFor(t, env.db, 3)
	requests := map[string]bool{}
	for _, e := range events {
		requests[e.RequestID] = true
	}
	if len(requests) != 2 {
		t.Fatalf("events for two requests expected: %+v", events)
	}
	for id := range requests {
		stored := storedRequest(t, env, id)
		for _, value := range []string{reviewGitLab, reviewHF, "M12345678"} {
			if strings.Contains(stored, value) {
				t.Fatalf("request %s stored %q: %s", id, value, stored)
			}
		}
		if strings.Contains(stored, `"BlockedBy":"government"`) || strings.Contains(stored, "early_blocked") {
			t.Fatalf("request %s: the block is recorded as a DLP block: %s", id, stored)
		}
	}
	for _, e := range events {
		if e.Action == "BLOCK" {
			if stored := storedRequest(t, env, e.RequestID); !strings.Contains(stored, "dlp_request_blocked") {
				t.Fatalf("blocked request error code: %s", stored)
			}
		}
	}
}

// Finding 4: characters whose lowercase is shorter (the Kelvin sign) once shifted
// offsets and panicked inside DLP, dropping the request's log record.
func TestDLPReviewCaseChangingCharacters(t *testing.T) {
	env, _ := newReviewEnv(t, nil)
	saveDLP(t, env, 0, dlpPolicies(policy("flag-ids", dlp.ActionFlag, []string{"government"}, dlp.CheckRequest, dlp.CheckResponse)))
	content := strings.Repeat("K", 200) + " 여권번호 M12345678"
	for _, stream := range []bool{false, true} {
		resp, data := dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", chatWith(content, stream))
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("stream=%v: %d %s", stream, resp.StatusCode, data)
		}
		if header := parseDLPHeader(t, resp); header.Action != dlp.ActionFlag {
			t.Fatalf("stream=%v header: %+v", stream, header)
		}
	}
	for _, e := range dlpEventsFor(t, env.db, 2) {
		if stored := storedRequest(t, env, e.RequestID); strings.Contains(stored, "M12345678") {
			t.Fatalf("passport number stored: %s", stored)
		}
	}
}

// Finding 5: a value split across one choice's chunks while another choice's chunks
// interleave, or carried in reasoning text, is still read whole.
func TestDLPReviewStreamsAreReadPerChoice(t *testing.T) {
	env, upstream := newReviewEnv(t, nil)
	saveDLP(t, env, 0, dlpPolicies(policy("block-cards", dlp.ActionBlock, []string{"financial"}, dlp.CheckResponse)))
	chunk := func(index int, field, text string) string {
		encoded, _ := json.Marshal(text)
		return `data: {"id":"c1","object":"chat.completion.chunk","model":"test-model","choices":[{"index":` + string(rune('0'+index)) + `,"delta":{"` + field + `":` + string(encoded) + `}}]}` + "\n\n"
	}
	for name, events := range map[string][]string{
		"interleaved choices": {
			chunk(0, "content", "카드 4111 "), chunk(1, "content", "다른 답 "),
			chunk(0, "content", "1111 1111 "), chunk(1, "content", "입니다 "),
			chunk(0, "content", "1111 결제"), "data: [DONE]\n\n",
		},
		"index after delta (alphabetical keys)": {
			`data: {"choices":[{"delta":{"content":"카드 4111 "},"index":0}]}` + "\n\n",
			`data: {"choices":[{"delta":{"content":"다른 답 "},"index":1}]}` + "\n\n",
			`data: {"choices":[{"delta":{"content":"1111 1111 "},"index":0}]}` + "\n\n",
			`data: {"choices":[{"delta":{"content":"입니다 "},"index":1}]}` + "\n\n",
			`data: {"choices":[{"delta":{"content":"1111 결제"},"index":0}]}` + "\n\n",
			"data: [DONE]\n\n",
		},
		"reasoning": {
			chunk(0, "reasoning_content", "카드번호 4111 1111 "), chunk(0, "reasoning_content", "1111 1111 를 쓰자"),
			chunk(0, "content", "결제했습니다"), "data: [DONE]\n\n",
		},
	} {
		upstream.set(func(w http.ResponseWriter, _ *http.Request) { writeEvents(w, events...) })
		resp, data := dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", chatWith("결제해 줘", true))
		if resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(data), "dlp_response_blocked") || strings.Contains(string(data), "4111") {
			t.Fatalf("%s: %d %s", name, resp.StatusCode, data)
		}
	}
}

// Finding 6: inside tool inputs every string is content, whatever its key.
func TestDLPReviewToolInputsAreInspected(t *testing.T) {
	env, upstream := newReviewEnv(t, nil)
	saveDLP(t, env, 0, dlpPolicies(policy("block-ids", dlp.ActionBlock, []string{"government"}, dlp.CheckRequest)))
	body := map[string]any{"model": "test-model", "max_tokens": 16, "messages": []any{
		map[string]any{"role": "user", "content": "조회해 줘"},
		map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "tool_use", "id": "toolu_1", "name": "lookup", "input": map[string]any{"id": "900101-1234561"}}}},
	}}
	resp, data := dlpRequest(t, env, http.MethodPost, "/v1/messages", body)
	if resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(data), "dlp_request_blocked") {
		t.Fatalf("tool input: %d %s", resp.StatusCode, data)
	}
	if upstream.calls != 0 {
		t.Fatal("the blocked request reached the provider")
	}
}

// Findings 7 and 11: a masked answer keeps no copy of the value in logprobs, and a
// plain-text answer is masked rather than refused.
func TestDLPReviewMaskCoversLogprobsAndPlainText(t *testing.T) {
	env, upstream := newReviewEnv(t, nil)
	saveDLP(t, env, 0, dlpPolicies(policy("mask-pii", dlp.ActionMask, []string{"pii"}, dlp.CheckResponse)))
	upstream.set(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"c1","object":"chat.completion","model":"test-model","choices":[{"index":0,"message":{"role":"assistant","content":"메일 kim.minsu@example.com"},"logprobs":{"content":[{"token":" kim","logprob":-0.1,"bytes":[32,107,105,109]},{"token":".minsu","logprob":-0.1,"bytes":[46]},{"token":"@example","logprob":-0.1,"bytes":[64]},{"token":".com","logprob":-0.1,"bytes":[46]}]},"finish_reason":"stop"}]}`)
	})
	resp, data := dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", chatWith("연락처 알려줘", false))
	if resp.StatusCode != http.StatusOK || strings.Contains(string(data), "minsu") || !strings.Contains(string(data), `"logprobs":null`) || !strings.Contains(string(data), "[REDACTED_EMAIL]") {
		t.Fatalf("logprobs: %d %s", resp.StatusCode, data)
	}

	upstream.set(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = io.WriteString(w, "연락처는 kim.minsu@example.com 입니다")
	})
	resp, data = dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", chatWith("연락처 알려줘", false))
	if resp.StatusCode != http.StatusOK || string(data) != "연락처는 [REDACTED_EMAIL] 입니다" {
		t.Fatalf("plain text: %d %q", resp.StatusCode, data)
	}
}

// Finding 9: an answer that cannot be read whole is a transport failure, not a DLP
// block, and records no DLP event.
func TestDLPReviewReadFailureIsNotABlock(t *testing.T) {
	env, upstream := newReviewEnv(t, nil)
	saveDLP(t, env, 0, dlpPolicies(policy("flag-pii", dlp.ActionFlag, []string{"pii"}, dlp.CheckResponse)))
	upstream.set(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Length", "4096")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"id":"c1","choices":[`)
		w.(http.Flusher).Flush()
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			_ = conn.Close()
		}
	})
	resp, data := dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", chatWith("안녕", false))
	if resp.StatusCode != http.StatusBadGateway || !strings.Contains(string(data), "upstream_read_failed") {
		t.Fatalf("read failure: %d %s", resp.StatusCode, data)
	}
	if events, _ := env.db.ListDLPEvents(context.Background(), store.DLPEventFilter{}); len(events) != 0 {
		t.Fatalf("a read failure recorded DLP events: %+v", events)
	}
}

// Finding 8: handlers that answer by themselves (Text2SQL, MCP discovery, agent
// routes) are inspected like a provider and their log records get the DLP events.
func TestDLPReviewSelfAnsweringHandlers(t *testing.T) {
	env, _ := newReviewEnv(t, nil)
	cfg := dlpPolicies(
		policy("flag-keys", dlp.ActionFlag, []string{"credentials"}, dlp.CheckRequest),
		policy("block-ids", dlp.ActionBlock, []string{"government"}, dlp.CheckResponse),
		policy("mask-pii", dlp.ActionMask, []string{"pii"}, dlp.CheckResponse),
	)
	engine, issues := dlp.Compile(cfg)
	if len(issues) > 0 {
		t.Fatal(issues)
	}
	run := func(answer string) (*httptest.ResponseRecorder, store.LogRecord) {
		prompt := "토큰 " + reviewGitLab
		req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"vibe/text2sql-demo"}`))
		rec := httptest.NewRecorder()
		state := &dlpState{engine: engine, inspectResponse: true}
		state.request = engine.Evaluate(dlp.CheckRequest, dlp.Scope{}, []string{prompt})
		rc := &requestPipeline{s: env.server, r: req, w: rec, dlpState: state}
		var logged store.LogRecord
		rc.serveUnderDLP(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			encoded, _ := json.Marshal(answer)
			_, _ = io.WriteString(w, `{"choices":[{"index":0,"message":{"role":"assistant","content":`+string(encoded)+`}}]}`)
			record := store.LogRecord{Request: store.RequestLog{ID: newID("req"), Endpoint: "/v1/chat/completions", Model: "vibe/text2sql-demo", StatusCode: 200}}
			record.Prompts = []store.PromptLog{{ID: newID("prm"), RequestID: record.Request.ID, RedactedText: prompt}}
			env.server.enqueueFor(r, record)
			logged = record
		})
		return rec, logged
	}

	rec, record := run("조회 결과: kim.minsu@example.com")
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), "kim.minsu") || !strings.Contains(rec.Body.String(), "[REDACTED_EMAIL]") || rec.Header().Get("X-Vibe-DLP") == "" {
		t.Fatalf("masked answer: %d %s", rec.Code, rec.Body.String())
	}
	rec, _ = run("조회 결과: 900101-1234561")
	if rec.Code != http.StatusBadRequest || strings.Contains(rec.Body.String(), "900101") {
		t.Fatalf("blocked answer: %d %s", rec.Code, rec.Body.String())
	}
	events := dlpEventsFor(t, env.db, 4)
	if len(events) < 4 {
		t.Fatalf("request and response events for both answers: %+v", events)
	}
	stored := storedRequest(t, env, record.Request.ID)
	if strings.Contains(stored, reviewGitLab) || !strings.Contains(stored, "[REDACTED_GITLAB_TOKEN]") {
		t.Fatalf("handler's log record was not completed: %s", stored)
	}
}

// Finding 8, second half: the follow-up requests an agent run sends to the provider
// carry tool results; request policies apply to them too.
func TestDLPReviewOutboundToolResults(t *testing.T) {
	env, _ := newReviewEnv(t, nil)
	engine, issues := dlp.Compile(dlpPolicies(
		policy("block-ids", dlp.ActionBlock, []string{"government"}, dlp.CheckRequest),
		policy("mask-pii", dlp.ActionMask, []string{"pii"}, dlp.CheckRequest),
	))
	if len(issues) > 0 {
		t.Fatal(issues)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	state := &dlpState{engine: engine}
	rc := &requestPipeline{s: env.server, r: req, w: rec, dlpState: state}
	var masked []byte
	var maskErr, blockErr error
	rc.serveUnderDLP(func(w http.ResponseWriter, r *http.Request) {
		masked, maskErr = inspectOutbound(r, []byte(`{"messages":[{"role":"tool","tool_call_id":"c1","content":"담당자 kim.minsu@example.com"}]}`))
		_, blockErr = inspectOutbound(r, []byte(`{"messages":[{"role":"tool","tool_call_id":"c2","content":"주민번호 900101-1234561"}]}`))
		w.WriteHeader(http.StatusOK)
	})
	if maskErr != nil || strings.Contains(string(masked), "kim.minsu") || !strings.Contains(string(masked), "[REDACTED_EMAIL]") {
		t.Fatalf("masked tool result: %s %v", masked, maskErr)
	}
	if blockErr == nil {
		t.Fatal("a tool result with a registration number must not be sent")
	}
	if state.request.Action != dlp.ActionBlock || len(state.request.Hits) != 2 {
		t.Fatalf("the run's request decision covers its tool results: %+v", state.request)
	}
	// Outside a DLP run nothing changes.
	if out, err := inspectOutbound(req, []byte(`{"a":"900101-1234561"}`)); err != nil || string(out) != `{"a":"900101-1234561"}` {
		t.Fatalf("no hook: %s %v", out, err)
	}
}

// Finding 3, second half: with the public development secret the fingerprint key
// would be known, so no fingerprints are kept.
func TestDLPReviewNoFingerprintsWithDefaultSecret(t *testing.T) {
	env, _ := newReviewEnv(t, func(cfg *config.Config) { cfg.Secret.GatewaySecret = config.DefaultGatewaySecret })
	saveDLP(t, env, 0, dlpPolicies(policy("flag-pii", dlp.ActionFlag, []string{"pii"}, dlp.CheckRequest)))
	if resp, data := dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", chatWith("메일 kim.minsu@example.com", false)); resp.StatusCode != http.StatusOK {
		t.Fatalf("%d %s", resp.StatusCode, data)
	}
	events := dlpEventsFor(t, env.db, 1)
	if len(events) != 1 || len(events[0].Hashes) != 0 || len(events[0].Evidence) != 1 {
		t.Fatalf("default secret keeps previews only: %+v", events)
	}
}

// Error answers are inspected too: a provider's error can quote the prompt.
func TestDLPReviewErrorAnswersAreInspected(t *testing.T) {
	env, upstream := newReviewEnv(t, nil)
	saveDLP(t, env, 0, dlpPolicies(policy("mask-pii", dlp.ActionMask, []string{"pii"}, dlp.CheckResponse)))
	upstream.set(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = io.WriteString(w, `{"error":{"message":"invalid recipient kim.minsu@example.com","type":"invalid_request_error"}}`)
	})
	resp, data := dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", chatWith("보내 줘", false))
	if resp.StatusCode != http.StatusUnprocessableEntity || strings.Contains(string(data), "kim.minsu") || !strings.Contains(string(data), "[REDACTED_EMAIL]") {
		t.Fatalf("error answer: %d %s", resp.StatusCode, data)
	}
}

// Knowledge and context expansion run after the DLP step; what they add is
// inspected before the request leaves.
func TestDLPKnowledgeExpansionIsInspected(t *testing.T) {
	env, upstream := newReviewEnv(t, nil)
	if err := env.db.UpsertKnowledge(context.Background(), store.KnowledgeSnippet{ID: "vip", Name: "VIP", Content: "담당 고객 주민번호 900101-1234561", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	env.server.invalidateKnowledgeCache()
	saveDLP(t, env, 0, dlpPolicies(policy("block-ids", dlp.ActionBlock, []string{"government"}, dlp.CheckRequest)))
	resp, data := dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", chatWith("{{kb:vip}} 요약해 줘", false))
	if resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(data), "dlp_request_blocked") {
		t.Fatalf("expanded knowledge: %d %s", resp.StatusCode, data)
	}
	if upstream.calls != 0 {
		t.Fatal("the expanded request reached the provider")
	}
}

// A value split across two messages is found, and the log keeps neither half.
func TestDLPValuesSplitAcrossMessages(t *testing.T) {
	env, upstream := newReviewEnv(t, func(cfg *config.Config) { cfg.Logging.RawPrompts = true })
	saveDLP(t, env, 0, dlpPolicies(
		policy("block-ids", dlp.ActionBlock, []string{"government"}, dlp.CheckRequest),
		policy("flag-pii", dlp.ActionFlag, []string{"pii"}, dlp.CheckRequest),
	))
	twoMessages := func(a, b string) map[string]any {
		return map[string]any{"model": "test-model", "messages": []map[string]string{{"role": "user", "content": a}, {"role": "user", "content": b}}}
	}
	resp, data := dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", twoMessages("주민번호 앞자리 900101-", "1234561 입니다"))
	if resp.StatusCode != http.StatusBadRequest || upstream.calls != 0 {
		t.Fatalf("split registration number: %d %s", resp.StatusCode, data)
	}
	resp, data = dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", twoMessages("연락처 010-1234-", "5678 로 주세요"))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("split phone number: %d %s", resp.StatusCode, data)
	}
	if header := parseDLPHeader(t, resp); header.Action != dlp.ActionFlag {
		t.Fatalf("split phone number is flagged: %+v", header)
	}
	// Checked with their separators: bare digits such as "5678" also turn up in the
	// random hexadecimal ids of a stored record.
	for _, e := range dlpEventsFor(t, env.db, 2) {
		stored := storedRequest(t, env, e.RequestID)
		for _, half := range []string{"900101-", "1234561 입니다", "010-1234-", "5678 로"} {
			if strings.Contains(stored, half) {
				t.Fatalf("a half of a split value (%q) was stored: %s", half, stored)
			}
		}
	}
}

// slowStream answers like a provider streaming a slow answer: headers at once,
// then the events after delay.
func slowStream(delay time.Duration, contents ...string) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		time.Sleep(delay)
		for _, c := range contents {
			encoded, _ := json.Marshal(c)
			_, _ = io.WriteString(w, `data: {"choices":[{"index":0,"delta":{"content":`+string(encoded)+`}}]}`+"\n\n")
			w.(http.Flusher).Flush()
		}
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}
}

// A held stream that takes long starts early with comment lines, so idle timeouts
// do not cut the client off; the inspected stream follows and the DLP result comes
// as trailers.
func TestDLPHeldStreamKeepalive(t *testing.T) {
	env, upstream := newReviewEnv(t, nil)
	env.server.dlpKeepalive = 30 * time.Millisecond
	saveDLP(t, env, 0, dlpPolicies(policy("mask-pii", dlp.ActionMask, []string{"pii"}, dlp.CheckResponse)))
	upstream.set(slowStream(200*time.Millisecond, "메일은 kim.mi", "nsu@example.com 입니다"))

	resp, data := dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", chatWith("연락처", true))
	body := string(data)
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(body, ": vibe-dlp:") || strings.Contains(body, "kim.mi") || !strings.Contains(body, "[REDACTED_EMAIL]") || !strings.Contains(body, "[DONE]") {
		t.Fatalf("held stream: %d %q", resp.StatusCode, body)
	}
	if resp.Header.Get("X-Vibe-DLP-Stream") != "held" {
		t.Fatalf("started stream is marked: %v", resp.Header)
	}
	var trailer dlp.HeaderValue
	if err := json.Unmarshal([]byte(resp.Trailer.Get("X-Vibe-Dlp")), &trailer); err != nil || trailer.Action != dlp.ActionMask || resp.Trailer.Get("Cf-Aig-Dlp") == "" {
		t.Fatalf("DLP result as trailers: %v %v", resp.Trailer, err)
	}

	// A short answer is not started early: the normal status and headers apply.
	upstream.set(slowStream(0, "메일 kim.minsu@example.com"))
	resp, data = dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", chatWith("연락처", true))
	if strings.HasPrefix(string(data), ":") || resp.Header.Get("X-Vibe-DLP") == "" {
		t.Fatalf("fast stream: %v %q", resp.Header, data)
	}
}

// A block found after the stream started is an error event in the stream.
func TestDLPHeldStreamBlockedAfterStart(t *testing.T) {
	env, upstream := newReviewEnv(t, nil)
	env.server.dlpKeepalive = 30 * time.Millisecond
	saveDLP(t, env, 0, dlpPolicies(policy("block-cards", dlp.ActionBlock, []string{"financial"}, dlp.CheckResponse)))
	upstream.set(slowStream(200*time.Millisecond, "카드 4111 1111 ", "1111 1111 결제"))
	resp, data := dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", chatWith("결제", true))
	body := string(data)
	if resp.StatusCode != http.StatusOK || !strings.Contains(body, `"code":"dlp_response_blocked"`) || !strings.HasSuffix(body, "data: [DONE]\n\n") || strings.Contains(body, "4111") {
		t.Fatalf("blocked after start: %d %q", resp.StatusCode, body)
	}
	events := dlpEventsFor(t, env.db, 1)
	if len(events) != 1 || events[0].Action != "BLOCK" {
		t.Fatalf("block recorded: %+v", events)
	}
	if stored := storedRequest(t, env, events[0].RequestID); !strings.Contains(stored, "dlp_response_blocked") {
		t.Fatalf("log: %s", stored)
	}
}

// Text a compatible provider puts in content_block_start continues in the deltas.
func TestDLPBlockStartJoinsItsDeltas(t *testing.T) {
	body := []byte("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"카드 4111 1111\"}}\n\n" +
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" 1111 1111\"}}\n\n")
	texts := responseSegments(body, "text/event-stream")
	if !strings.Contains(strings.Join(texts, "|"), "카드 4111 1111 1111 1111") {
		t.Fatalf("block start and delta joined: %q", texts)
	}
}

// Handlers that answer by themselves run while the client waits too: a streamed
// agent run is kept alive, and a handler that panics does not take the server down.
func TestDLPSelfAnsweringStreamKeepaliveAndPanic(t *testing.T) {
	env, _ := newReviewEnv(t, nil)
	env.server.dlpKeepalive = 30 * time.Millisecond
	engine, issues := dlp.Compile(dlpPolicies(policy("mask-pii", dlp.ActionMask, []string{"pii"}, dlp.CheckResponse)))
	if len(issues) > 0 {
		t.Fatal(issues)
	}
	run := func(serve func(w http.ResponseWriter, r *http.Request)) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{}`))
		rec := httptest.NewRecorder()
		rc := &requestPipeline{s: env.server, r: req, w: &dlpStreamWriter{ResponseWriter: rec, path: req.URL.Path}, body: []byte(`{"model":"agent/x","stream":true}`), dlpState: &dlpState{engine: engine, inspectResponse: true}}
		rc.serveUnderDLP(serve)
		return rec
	}
	rec := run(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(150 * time.Millisecond)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, `data: {"choices":[{"index":0,"delta":{"content":"담당자 kim.minsu@example.com"}}]}`+"\n\ndata: [DONE]\n\n")
	})
	if body := rec.Body.String(); rec.Code != http.StatusOK || !strings.HasPrefix(body, ": vibe-dlp:") || strings.Contains(body, "kim.minsu") || !strings.Contains(body, "[REDACTED_EMAIL]") {
		t.Fatalf("agent stream: %d %q", rec.Code, body)
	}
	rec = run(func(http.ResponseWriter, *http.Request) { panic("boom") })
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), "internal_error") {
		t.Fatalf("handler panic: %d %q", rec.Code, rec.Body.String())
	}
}

func TestDLPRequestGroups(t *testing.T) {
	body := []byte(`{"model":"m","messages":[` +
		`{"role":"system","content":"시스템"},` +
		`{"role":"user","content":"하나"},{"role":"user","content":"둘"},` +
		`{"role":"assistant","content":"셋"},` +
		`{"role":"user","content":[{"type":"text","text":"넷"},{"type":"text","text":"다섯"}]}],` +
		`"metadata":{"note":"여섯"}}`)
	segments, _ := dlp.JSONSegments(body)
	got := [][]string{}
	for _, group := range requestGroups(body) {
		texts := []string{}
		for _, i := range group {
			texts = append(texts, segments[i])
		}
		got = append(got, texts)
	}
	if fmt.Sprint(got) != "[[하나 둘] [넷 다섯]]" {
		t.Fatalf("groups: %v", got)
	}
}

// Review round 3: masking applies every time a value is sent, not only the first.
func TestDLPMaskedValuesStayMaskedWhenResent(t *testing.T) {
	env, upstream := newReviewEnv(t, nil)
	engine, issues := dlp.Compile(dlpPolicies(policy("mask-pii", dlp.ActionMask, []string{"pii"}, dlp.CheckRequest)))
	if len(issues) > 0 {
		t.Fatal(issues)
	}
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{}`))
	state := &dlpState{engine: engine}
	state.request = engine.EvaluateParts(dlp.CheckRequest, dlp.Scope{}, []string{"내 메일 kim.minsu@example.com"}, nil)
	rc := &requestPipeline{s: env.server, r: req, w: httptest.NewRecorder(), dlpState: state}
	turn := []byte(`{"messages":[{"role":"user","content":"내 메일 kim.minsu@example.com"},{"role":"tool","tool_call_id":"c1","content":"담당 kim.minsu@example.com"}]}`)
	rc.serveUnderDLP(func(w http.ResponseWriter, r *http.Request) {
		for range 2 {
			out, err := inspectOutbound(r, turn)
			if err != nil || strings.Contains(string(out), "kim.minsu") {
				t.Fatalf("re-sent value: %s %v", out, err)
			}
		}
		w.WriteHeader(http.StatusOK)
	})

	// Knowledge that repeats a value the prompt had masked is masked as well.
	if err := env.db.UpsertKnowledge(context.Background(), store.KnowledgeSnippet{ID: "card", Name: "명함", Content: "담당자 kim.minsu@example.com", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	env.server.invalidateKnowledgeCache()
	saveDLP(t, env, 0, dlpPolicies(policy("mask-pii", dlp.ActionMask, []string{"pii"}, dlp.CheckRequest)))
	upstream.set(jsonReply("ok"))
	resp, data := dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", chatWith("내 메일 kim.minsu@example.com 과 {{kb:card}}", false))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("%d %s", resp.StatusCode, data)
	}
	sent := upstream.lastBody()
	if strings.Contains(sent, "kim.minsu") || !strings.Contains(sent, "[REDACTED_EMAIL]") {
		t.Fatalf("the provider received: %s", sent)
	}
}

// A self-answering handler that answers in JSON, or fails, after its stream has
// started is turned into stream events.
func TestDLPStartedStreamConvertsJSONAndErrors(t *testing.T) {
	env, _ := newReviewEnv(t, nil)
	env.server.dlpKeepalive = 20 * time.Millisecond
	engine, issues := dlp.Compile(dlpPolicies(policy("mask-pii", dlp.ActionMask, []string{"pii"}, dlp.CheckResponse)))
	if len(issues) > 0 {
		t.Fatal(issues)
	}
	run := func(serve func(w http.ResponseWriter, r *http.Request)) string {
		req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{}`))
		rec := httptest.NewRecorder()
		rc := &requestPipeline{s: env.server, r: req, w: &dlpStreamWriter{ResponseWriter: rec, path: req.URL.Path}, body: []byte(`{"model":"vibe/text2sql-x","stream":true}`), dlpState: &dlpState{engine: engine, inspectResponse: true}}
		rc.serveUnderDLP(serve)
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d", rec.Code)
		}
		return rec.Body.String()
	}
	body := run(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(100 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"c1","object":"chat.completion","model":"vibe/text2sql-x","choices":[{"index":0,"message":{"role":"assistant","content":"담당 kim.minsu@example.com"},"finish_reason":"stop"}],"usage":{"total_tokens":3}}`)
	})
	if !strings.Contains(body, `"object":"chat.completion.chunk"`) || !strings.Contains(body, "[REDACTED_EMAIL]") || strings.Contains(body, "kim.minsu") || !strings.HasSuffix(body, "data: [DONE]\n\n") {
		t.Fatalf("JSON answer as a stream: %q", body)
	}
	body = run(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(100 * time.Millisecond)
		writeOpenAIError(w, http.StatusBadGateway, "agent route failed", "server_error", "agent_route_failed")
	})
	if !strings.Contains(body, `"code":"agent_route_failed"`) || !strings.HasSuffix(body, "data: [DONE]\n\n") {
		t.Fatalf("error after start: %q", body)
	}
}
