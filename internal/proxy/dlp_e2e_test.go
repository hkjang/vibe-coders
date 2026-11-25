package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/dlp"
	"vibe-coders/internal/store"
)

// dlpUpstream answers with a configurable reply and remembers the bodies it received.
type dlpUpstream struct {
	mu     sync.Mutex
	bodies []string
	reply  string
	events []string // when set, the reply streams as these SSE content deltas
}

func (u *dlpUpstream) handler(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	u.mu.Lock()
	u.bodies = append(u.bodies, string(body))
	reply, events := u.reply, u.events
	u.mu.Unlock()
	if len(events) > 0 {
		chunks := []string{}
		for _, delta := range events {
			encoded, _ := json.Marshal(delta)
			chunks = append(chunks, `data: {"id":"c1","object":"chat.completion.chunk","model":"test-model","choices":[{"index":0,"delta":{"content":`+string(encoded)+`}}]}`+"\n\n")
		}
		chunks = append(chunks, "data: [DONE]\n\n")
		writeEvents(w, chunks...)
		return
	}
	encoded, _ := json.Marshal(reply)
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"id":"c1","object":"chat.completion","model":"test-model","choices":[{"index":0,"message":{"role":"assistant","content":`+string(encoded)+`},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}`)
}

func (u *dlpUpstream) set(reply string, events ...string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.reply, u.events = reply, events
}

func (u *dlpUpstream) calls() []string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]string(nil), u.bodies...)
}

func newDLPEnv(t *testing.T, mutate func(*config.Config)) (*captureEnv, *dlpUpstream) {
	t.Helper()
	upstream := &dlpUpstream{reply: "안내했습니다"}
	env := newCaptureEnv(t, upstream.handler, mutate)
	return env, upstream
}

func dlpRequest(t *testing.T, env *captureEnv, method, path string, body any, headers ...string) (*http.Response, []byte) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, env.url+path, reader)
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

// saveDLP stores a configuration through the admin API and returns the new revision.
func saveDLP(t *testing.T, env *captureEnv, revision int, cfg dlp.Config) int {
	t.Helper()
	resp, data := dlpRequest(t, env, http.MethodPut, dlpAdminPath, map[string]any{"config": cfg, "expected_revision": revision})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("save dlp: %d %s", resp.StatusCode, data)
	}
	var out struct {
		Revision int `json:"revision"`
	}
	_ = json.Unmarshal(data, &out)
	return out.Revision
}

func dlpPolicies(policies ...dlp.Policy) dlp.Config {
	cfg := dlp.DefaultConfig()
	cfg.Enabled = true
	cfg.Policies = policies
	return cfg
}

func chatWith(content string, stream bool) map[string]any {
	return map[string]any{"model": "test-model", "stream": stream, "messages": []map[string]string{{"role": "user", "content": content}}}
}

func dlpEventsFor(t *testing.T, db *store.SQLStore, requestCount int) []store.DLPEvent {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		events, err := db.ListDLPEvents(context.Background(), store.DLPEventFilter{Limit: 100})
		if err != nil {
			t.Fatal(err)
		}
		if len(events) >= requestCount || time.Now().After(deadline) {
			return events
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func parseDLPHeader(t *testing.T, resp *http.Response) dlp.HeaderValue {
	t.Helper()
	raw := resp.Header.Get("X-Vibe-DLP")
	if raw == "" || resp.Header.Get("Cf-Aig-Dlp") != raw {
		t.Fatalf("DLP headers missing or different: %q / %q", raw, resp.Header.Get("Cf-Aig-Dlp"))
	}
	var value dlp.HeaderValue
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		t.Fatalf("header is not JSON: %s", raw)
	}
	return value
}

func TestDLPRequestPoliciesBlockMaskAndFlag(t *testing.T) {
	// Raw prompts, raw bodies and response text are all kept, so the test sees every
	// place the log could hold a matched value.
	env, upstream := newDLPEnv(t, func(cfg *config.Config) {
		cfg.Logging.RawPrompts = true
		cfg.Logging.RawBodies = true
		cfg.Logging.ResponseText = true
	})
	revision := saveDLP(t, env, 0, dlpPolicies(
		dlp.Policy{ID: "block-ids", Enabled: true, Action: dlp.ActionBlock, Profiles: []string{"government"}, Check: []dlp.Check{dlp.CheckRequest}},
		dlp.Policy{ID: "mask-keys", Enabled: true, Action: dlp.ActionMask, Profiles: []string{"credentials"}, Check: []dlp.Check{dlp.CheckRequest}},
		dlp.Policy{ID: "flag-pii", Enabled: true, Action: dlp.ActionFlag, Profiles: []string{"pii"}, Check: []dlp.Check{dlp.CheckRequest}},
	))
	if revision != 1 {
		t.Fatalf("first save should be revision 1, got %d", revision)
	}

	// Block: a resident registration number never reaches the provider.
	resp, data := dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", chatWith("고객 주민번호 900101-1234561 로 조회해 줘", false))
	if resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(data), "dlp_request_blocked") {
		t.Fatalf("government id should block: %d %s", resp.StatusCode, data)
	}
	if header := parseDLPHeader(t, resp); header.Action != dlp.ActionBlock || header.Findings[0].Profile.ProfileID != "government" || header.Findings[0].Check != dlp.CheckRequest {
		t.Fatalf("block header: %+v", header)
	}
	if len(upstream.calls()) != 0 {
		t.Fatal("a blocked prompt reached the provider")
	}

	// Mask: the key is replaced before the provider sees the prompt.
	resp, data = dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", chatWith("이 키로 호출해 줘 sk-proj-EXAMPLEexample1234567890abcd", false))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("masked request should pass: %d %s", resp.StatusCode, data)
	}
	calls := upstream.calls()
	if len(calls) != 1 || strings.Contains(calls[0], "sk-proj-") || !strings.Contains(calls[0], "[REDACTED_OPENAI_KEY]") {
		t.Fatalf("provider saw: %v", calls)
	}
	if header := parseDLPHeader(t, resp); header.Action != dlp.ActionMask {
		t.Fatalf("mask header: %+v", header)
	}

	// Flag: the prompt passes unchanged and the match is recorded.
	resp, _ = dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", chatWith("연락처 kim.minsu@example.com 으로 회신", false))
	if resp.StatusCode != http.StatusOK || !strings.Contains(upstream.calls()[1], "kim.minsu@example.com") {
		t.Fatalf("flag must not change the prompt: %d %v", resp.StatusCode, upstream.calls())
	}
	if header := parseDLPHeader(t, resp); header.Action != dlp.ActionFlag {
		t.Fatalf("flag header: %+v", header)
	}

	events := dlpEventsFor(t, env.db, 3)
	if len(events) != 3 {
		t.Fatalf("three events expected, got %d", len(events))
	}
	for _, e := range events {
		raw, _ := json.Marshal(e)
		for _, secret := range []string{"900101-1234561", "sk-proj-EXAMPLE", "kim.minsu@example.com"} {
			if strings.Contains(string(raw), secret) {
				t.Fatalf("an event stored the matched value %q: %s", secret, raw)
			}
		}
		if e.Check != "REQUEST" || len(e.Hashes) == 0 || len(e.Evidence) == 0 || e.RequestID == "" {
			t.Fatalf("event incomplete: %+v", e)
		}
	}
	blocked := events[len(events)-1]
	if blocked.Action != "BLOCK" || blocked.ProfileID != "government" || blocked.PolicyIDs[0] != "block-ids" {
		t.Fatalf("oldest event should be the block: %+v", blocked)
	}
	detail, err := env.db.RequestDetail(context.Background(), blocked.RequestID)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Request.StatusCode != http.StatusBadRequest {
		t.Fatalf("blocked request log status: %d", detail.Request.StatusCode)
	}
	// Whatever the action — blocked, masked or only flagged — the request log keeps
	// none of the matched values, in prompts, raw prompts or the raw body.
	for _, e := range events {
		detail, err := env.db.RequestDetail(context.Background(), e.RequestID)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(detail)
		for _, secret := range []string{"900101-1234561", "sk-proj-EXAMPLE", "kim.minsu@example.com"} {
			if strings.Contains(string(raw), secret) {
				t.Fatalf("request %s (%s) stored %q: %s", e.RequestID, e.Action, secret, raw)
			}
		}
		if !strings.Contains(string(raw), "[REDACTED_") {
			t.Fatalf("request %s (%s) should store the masked prompt: %s", e.RequestID, e.Action, raw)
		}
	}
}

func TestDLPResponseBlockMaskFlagAndStreaming(t *testing.T) {
	env, upstream := newDLPEnv(t, nil)
	saveDLP(t, env, 0, dlpPolicies(
		dlp.Policy{ID: "block-cards", Enabled: true, Action: dlp.ActionBlock, Profiles: []string{"financial"}, Check: []dlp.Check{dlp.CheckResponse}},
		dlp.Policy{ID: "mask-mail", Enabled: true, Action: dlp.ActionMask, Profiles: []string{"pii"}, Check: []dlp.Check{dlp.CheckResponse}},
	))

	upstream.set("결제 카드는 4111 1111 1111 1111 입니다")
	resp, data := dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", chatWith("결제 정보 알려줘", false))
	if resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(data), "dlp_response_blocked") || strings.Contains(string(data), "4111") {
		t.Fatalf("a card in the answer must be withheld: %d %s", resp.StatusCode, data)
	}
	if header := parseDLPHeader(t, resp); header.Action != dlp.ActionBlock || header.Findings[0].Check != dlp.CheckResponse {
		t.Fatalf("response block header: %+v", header)
	}

	upstream.set("담당자 메일은 kim.minsu@example.com 입니다")
	resp, data = dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", chatWith("담당자", false))
	if resp.StatusCode != http.StatusOK || strings.Contains(string(data), "kim.minsu@") || !strings.Contains(string(data), "[REDACTED_EMAIL]") {
		t.Fatalf("an email in the answer should be masked: %d %s", resp.StatusCode, data)
	}
	var parsed map[string]any
	if json.Unmarshal(data, &parsed) != nil || parsed["object"] != "chat.completion" {
		t.Fatalf("masked response must stay a valid completion: %s", data)
	}

	// Streams are buffered whole, masked per event and replayed as a stream.
	upstream.set("", "담당자 메일은 ", "kim.minsu@example.com", " 입니다")
	resp, data = dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", chatWith("담당자", true))
	if resp.StatusCode != http.StatusOK || strings.Contains(string(data), "kim.minsu@") || !strings.Contains(string(data), "[REDACTED_EMAIL]") || !strings.Contains(string(data), "[DONE]") {
		t.Fatalf("streamed email should be masked and the stream kept: %d %s", resp.StatusCode, data)
	}
	// A value the provider split across events is masked whole: no fragment of it
	// survives in either event, and the stream stays a stream.
	upstream.set("", "메일은 kim.min", "su@exam", "ple.com 입니다")
	resp, data = dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", chatWith("담당자", true))
	for _, fragment := range []string{"kim.min", "su@exam", "ple.com"} {
		if strings.Contains(string(data), fragment) {
			t.Fatalf("fragment %q of a split value slipped through: %s", fragment, data)
		}
	}
	if resp.StatusCode != http.StatusOK || strings.Count(string(data), "[REDACTED_EMAIL]") != 1 || strings.Count(string(data), "data: {") != 3 || !strings.Contains(string(data), " 입니다") {
		t.Fatalf("split value should be masked once with event boundaries kept: %d %s", resp.StatusCode, data)
	}

	upstream.set("평범한 답변입니다")
	resp, _ = dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", chatWith("평범한 질문", false))
	if resp.StatusCode != http.StatusOK || resp.Header.Get("X-Vibe-DLP") != "" {
		t.Fatalf("a clean answer has no DLP header: %d %q", resp.StatusCode, resp.Header.Get("X-Vibe-DLP"))
	}

	events := dlpEventsFor(t, env.db, 4)
	actions := map[string]int{}
	for _, e := range events {
		if e.Check != "RESPONSE" {
			t.Fatalf("only response events expected: %+v", e)
		}
		actions[e.Action]++
	}
	if actions["BLOCK"] != 1 || actions["MASK"] != 3 {
		t.Fatalf("response actions: %v", actions)
	}
}

func TestDLPPolicyScopeAndDisabledConfig(t *testing.T) {
	env, upstream := newDLPEnv(t, nil)
	for _, key := range []store.APIKeyRecord{
		{ID: "fin", Name: "fin", KeyHash: hashProxyKey("vc_sk_synthetic_fin"), Role: "developer", Status: "active", Scopes: []string{"chat:completion"}, Team: "team-fin"},
		{ID: "dev", Name: "dev", KeyHash: hashProxyKey("vc_sk_synthetic_dev"), Role: "developer", Status: "active", Scopes: []string{"chat:completion"}, Team: "team-dev"},
	} {
		if err := env.db.UpsertAPIKey(t.Context(), key); err != nil {
			t.Fatal(err)
		}
	}
	revision := saveDLP(t, env, 0, dlpPolicies(dlp.Policy{ID: "fin-only", Enabled: true, Action: dlp.ActionBlock, Profiles: []string{"pii"}, Check: []dlp.Check{dlp.CheckRequest}, Teams: []string{"team-fin"}}))
	prompt := chatWith("메일 kim.minsu@example.com", false)
	if resp, _ := dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", prompt, "Authorization", "Bearer vc_sk_synthetic_fin"); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("the scoped team is blocked: %d", resp.StatusCode)
	}
	if resp, _ := dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", prompt, "Authorization", "Bearer vc_sk_synthetic_dev"); resp.StatusCode != http.StatusOK {
		t.Fatalf("another team is not: %d", resp.StatusCode)
	}
	cfg := dlpPolicies(dlp.Policy{ID: "fin-only", Enabled: true, Action: dlp.ActionBlock, Profiles: []string{"pii"}, Check: []dlp.Check{dlp.CheckRequest}, Teams: []string{"team-fin"}})
	cfg.Enabled = false
	saveDLP(t, env, revision, cfg)
	if resp, _ := dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", prompt, "Authorization", "Bearer vc_sk_synthetic_fin"); resp.StatusCode != http.StatusOK {
		t.Fatalf("a disabled configuration does nothing: %d", resp.StatusCode)
	}
	if len(upstream.calls()) != 2 {
		t.Fatalf("provider calls: %d", len(upstream.calls()))
	}
}

// A cached answer is inspected with the policies in force now, not the ones in force
// when it was cached.
func TestDLPInspectsCacheHitsWithCurrentPolicies(t *testing.T) {
	env, upstream := newDLPEnv(t, func(cfg *config.Config) {
		cfg.Cache.ChatEnabled = true
		cfg.Cache.ChatTTL = time.Hour
		cfg.Cache.EmbeddingMaxBytes = 1 << 20
	})
	upstream.set("메일은 kim.minsu@example.com 입니다")
	revision := saveDLP(t, env, 0, dlpPolicies(dlp.Policy{ID: "flag-pii", Enabled: true, Action: dlp.ActionFlag, Profiles: []string{"pii"}, Check: []dlp.Check{dlp.CheckResponse}}))
	body := chatWith("담당자 메일", false)
	body["temperature"] = 0
	first, _ := dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", body)
	second, _ := dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", body)
	if first.Header.Get("X-Cache") != "MISS" || second.Header.Get("X-Cache") != "HIT" {
		t.Fatalf("flagged answers are cached: %q %q", first.Header.Get("X-Cache"), second.Header.Get("X-Cache"))
	}
	if header := parseDLPHeader(t, second); header.Action != dlp.ActionFlag {
		t.Fatalf("a cache hit carries the DLP result: %+v", header)
	}
	saveDLP(t, env, revision, dlpPolicies(dlp.Policy{ID: "block-pii", Enabled: true, Action: dlp.ActionBlock, Profiles: []string{"pii"}, Check: []dlp.Check{dlp.CheckResponse}}))
	third, data := dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", body)
	if third.StatusCode != http.StatusBadRequest || third.Header.Get("X-Cache") == "HIT" || strings.Contains(string(data), "kim.minsu") {
		t.Fatalf("after tightening, the cached answer must not be served: %d %q %s", third.StatusCode, third.Header.Get("X-Cache"), data)
	}
	if len(upstream.calls()) != 2 {
		t.Fatalf("the blocked request went to the provider again, where it was inspected: %d calls", len(upstream.calls()))
	}
}

func TestDLPAdminAPI(t *testing.T) {
	env, _ := newDLPEnv(t, nil)
	resp, data := dlpRequest(t, env, http.MethodGet, dlpAdminPath, nil)
	var settings struct {
		Config      dlp.Config        `json:"config"`
		Revision    int               `json:"revision"`
		Catalog     []json.RawMessage `json:"catalog"`
		Recommended []dlp.Policy      `json:"recommended_policies"`
	}
	if resp.StatusCode != http.StatusOK || json.Unmarshal(data, &settings) != nil || settings.Revision != 0 || settings.Config.Enabled || len(settings.Catalog) != 6 || len(settings.Recommended) == 0 {
		t.Fatalf("initial settings: %d %s", resp.StatusCode, data)
	}
	invalid := dlpPolicies(dlp.Policy{ID: "Bad", Enabled: true, Action: "ERASE", Profiles: []string{"nope"}, Check: []dlp.Check{"BOTH"}})
	resp, data = dlpRequest(t, env, http.MethodPut, dlpAdminPath, map[string]any{"config": invalid, "expected_revision": 0})
	if resp.StatusCode != http.StatusUnprocessableEntity || !strings.Contains(string(data), "policies[0].action") {
		t.Fatalf("invalid config: %d %s", resp.StatusCode, data)
	}
	cfg := dlp.DefaultConfig()
	cfg.Enabled = true
	cfg.Policies = settings.Recommended
	revision := saveDLP(t, env, 0, cfg)
	resp, _ = dlpRequest(t, env, http.MethodPut, dlpAdminPath, map[string]any{"config": cfg, "expected_revision": revision - 1})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("a stale save must conflict: %d", resp.StatusCode)
	}
	resp, data = dlpRequest(t, env, http.MethodPost, dlpAdminPath+"/test", map[string]any{"text": "키 sk-proj-EXAMPLEexample1234567890abcd 와 주민번호 900101-1234561"})
	var test struct {
		Matches []struct {
			EntryID string `json:"entry_id"`
			Start   int    `json:"start"`
			End     int    `json:"end"`
		} `json:"matches"`
		Request struct {
			Action string `json:"action"`
		} `json:"request"`
		Masked string `json:"masked_request"`
	}
	if resp.StatusCode != http.StatusOK || json.Unmarshal(data, &test) != nil || test.Request.Action != "BLOCK" || len(test.Matches) < 2 {
		t.Fatalf("test scan: %d %s", resp.StatusCode, data)
	}
	text := "키 sk-proj-EXAMPLEexample1234567890abcd 와 주민번호 900101-1234561"
	for _, m := range test.Matches {
		if m.EntryID == "kr_rrn" && text[m.Start:m.End] != "900101-1234561" {
			t.Fatalf("offsets must point into the text: %q", text[m.Start:m.End])
		}
	}
	// Events: one blocked request, filtered by action.
	if resp, _ := dlpRequest(t, env, http.MethodPost, "/v1/chat/completions", chatWith("주민번호 900101-1234561", false)); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("recommended policies block government ids: %d", resp.StatusCode)
	}
	dlpEventsFor(t, env.db, 1)
	resp, data = dlpRequest(t, env, http.MethodGet, dlpAdminPath+"/events?action=BLOCK&hours=1", nil)
	var events struct {
		Events  []store.DLPEvent `json:"events"`
		Summary map[string][]struct {
			Key    string `json:"key"`
			Events int    `json:"events"`
		} `json:"summary"`
	}
	if resp.StatusCode != http.StatusOK || json.Unmarshal(data, &events) != nil || len(events.Events) != 1 || events.Summary["by_action"][0].Key != "BLOCK" {
		t.Fatalf("events: %d %s", resp.StatusCode, data)
	}
	if resp, _ := dlpRequest(t, env, http.MethodGet, dlpAdminPath+"/events?action=DELETE", nil); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid filter accepted: %d", resp.StatusCode)
	}
}
