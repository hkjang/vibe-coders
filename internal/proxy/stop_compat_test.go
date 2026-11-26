package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// The 400 a pydantic-validated OpenAI-compatible server answers when "stop" has more
// items than it accepts — the error this compatibility layer was written for.
const pydanticStopError = `{"object":"error","message":"2 validation errors: {'type': 'string_type', 'loc': 'body.stop', 'msg': 'Input should be a valid string', 'input': '<list of 10 items>'} {'type': 'too_long', 'loc': 'body.stop', 'msg': 'List should have at most 4 items after validation, not 10', 'input': '<list of 10 items>', 'ctx': {'field_type': 'List', 'max_length': 4, 'actual_length': 10}}","type":"Bad Request","code":400}`

var tenStops = []string{"<fim_prefix>", "<fim_suffix>", "<fim_middle>", "<file_sep>", "<|endoftext|>", "</fim_middle>", "</code>", "\n\n", "\r\n\r\n", "/src/"}

func stopBody(t *testing.T, stream bool, stops any) []byte {
	t.Helper()
	body, err := json.Marshal(map[string]any{"model": "core-glm", "stream": stream, "max_tokens": 64, "seed": 12345678901234567, "stop": stops,
		"messages": []map[string]string{{"role": "user", "content": "<fim_prefix>function a(){<fim_suffix>}<fim_middle>"}}})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func TestStopLimitFromError(t *testing.T) {
	sent := stopBody(t, false, tenStops)
	for name, tc := range map[string]struct {
		body  string
		limit int
		ok    bool
	}{
		"pydantic":         {pydanticStopError, 4, true},
		"openai":           {`{"error":{"message":"Invalid 'stop': array too long. Expected an array with maximum length 4, but got an array with length 10 instead.","type":"invalid_request_error","param":"stop","code":"array_above_max_length"}}`, 4, true},
		"tgi":              {`{"error":"Input validation error: ` + "`stop`" + ` supports up to 4 stop sequences. Given: 10","error_type":"validation"}`, 4, true},
		"single string":    {`{"error":{"message":"stop: Input should be a valid string"}}`, 1, true},
		"another field":    {`{"error":{"message":"max_tokens must be at most 4"}}`, 0, false},
		"context overflow": {`{"error":{"message":"This model's maximum context length is 8192 tokens; please stop sending more."}}`, 0, false},
	} {
		limit, ok := stopLimitFromError([]byte(tc.body), sent)
		if limit != tc.limit || ok != tc.ok {
			t.Fatalf("%s: got %d %v, want %d %v", name, limit, ok, tc.limit, tc.ok)
		}
	}
	// Nothing to limit when the request did not carry several stop sequences.
	if _, ok := stopLimitFromError([]byte(pydanticStopError), stopBody(t, false, "END")); ok {
		t.Fatal("a single stop string cannot be over a list limit")
	}
}

func TestLimitStopsKeepsTheRestOfTheBody(t *testing.T) {
	body := stopBody(t, true, tenStops)
	limited, dropped := limitStops(body, 4)
	stops, _ := requestStops(limited)
	if strings.Join(stops, "|") != strings.Join(tenStops[:4], "|") || strings.Join(dropped, "|") != strings.Join(tenStops[4:], "|") {
		t.Fatalf("kept %q dropped %q", stops, dropped)
	}
	// A 17-digit integer survives: values are carried as raw bytes, never re-parsed.
	if !strings.Contains(string(limited), `"seed":12345678901234567`) || !strings.Contains(string(limited), `"stream":true`) {
		t.Fatalf("other members changed: %s", limited)
	}
	// The prompt reaches the provider byte for byte: "<" stays "<", not \u003c.
	literal := []byte(`{"model":"m","messages":[{"role":"user","content":"<fim_prefix>a <b> & c"}],"stop":["1","2","3","4","5"]}`)
	fitted, _ := limitStops(literal, 4)
	if !strings.Contains(string(fitted), `"messages":[{"role":"user","content":"<fim_prefix>a <b> & c"}]`) || !strings.Contains(string(fitted), `"stop":["1","2","3","4"]`) {
		t.Fatalf("the prompt keeps its exact bytes: %s", fitted)
	}
	one, _ := limitStops(body, 1)
	var single struct {
		Stop any `json:"stop"`
	}
	if err := json.Unmarshal(one, &single); err != nil || single.Stop != "<fim_prefix>" {
		t.Fatalf("a limit of one sends a string: %s", one)
	}
	if same, dropped := limitStops(stopBody(t, false, tenStops[:3]), 4); dropped != nil || len(same) == 0 {
		t.Fatal("a request within the limit is left alone")
	}
}

func TestStopCutterHoldsBackPartialSequences(t *testing.T) {
	c := &stopCutter{stops: []string{"\n\n", "</code>", "끝.끝"}}
	out := ""
	for _, piece := range []string{"return a;", "\n", "}", "\n", "\n", "function b(){}"} {
		emit, stopped := c.feed(piece)
		out += emit
		if stopped {
			break
		}
	}
	if out != "return a;\n}" || !c.done {
		t.Fatalf("cut at the blank line split across pieces: %q", out)
	}
	c = &stopCutter{stops: []string{"</code>", "끝.끝"}}
	emit, _ := c.feed("값은 끝")
	rest, stopped := c.feed(".계속 </co")
	if emit != "값은 " || rest != "끝.계속 " || stopped {
		t.Fatalf("a partial match that does not complete is released: %q %q", emit, rest)
	}
	if tail := c.flush(); tail != "</co" {
		t.Fatalf("held text is delivered at the end: %q", tail)
	}
}

func TestEnforceStopsJSON(t *testing.T) {
	chat := `{"id":"c1","choices":[{"index":0,"message":{"role":"assistant","content":"return a;\n}\n\nfunction b(){}"},"finish_reason":"length"}],"usage":{"total_tokens":20}}`
	out := string(enforceStopsJSON([]byte(chat), []string{"\n\n"}))
	if !strings.Contains(out, `"content":"return a;\n}"`) || !strings.Contains(out, `"finish_reason":"stop"`) || !strings.Contains(out, `"total_tokens":20`) {
		t.Fatalf("chat answer: %s", out)
	}
	legacy := `{"choices":[{"index":0,"text":"x = 1</code> trailing","finish_reason":"length"}]}`
	if out := string(enforceStopsJSON([]byte(legacy), []string{"</code>"})); !strings.Contains(out, `"text":"x = 1"`) {
		t.Fatalf("completion answer: %s", out)
	}
	if untouched := enforceStopsJSON([]byte(chat), []string{"</code>"}); string(untouched) != chat {
		t.Fatal("an answer without the sequence keeps its exact bytes")
	}
}

// stopLimitedUpstream refuses more than 4 stop sequences the way the provider in
// the field did, and otherwise streams (or returns) a completion that runs past a
// blank line.
type stopLimitedUpstream struct {
	mu     sync.Mutex
	bodies []string
}

func (u *stopLimitedUpstream) handler(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	u.mu.Lock()
	u.bodies = append(u.bodies, string(raw))
	u.mu.Unlock()
	var req struct {
		Stream bool `json:"stream"`
	}
	_ = json.Unmarshal(raw, &req)
	if stops, _ := requestStops(raw); len(stops) > 4 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, pydanticStopError)
		return
	}
	if req.Stream {
		events := []string{}
		for _, piece := range []string{"return a;", "\n}", "\n", "\nfunction b(){}", " // never shown"} {
			encoded, _ := json.Marshal(piece)
			events = append(events, `data: {"id":"c1","object":"chat.completion.chunk","model":"core-glm","choices":[{"index":0,"delta":{"content":`+string(encoded)+`},"finish_reason":null}]}`+"\n\n")
		}
		writeEvents(w, append(events, `data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"length"}]}`+"\n\n", "data: [DONE]\n\n")...)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"id":"c1","object":"chat.completion","model":"core-glm","choices":[{"index":0,"message":{"role":"assistant","content":"return a;\n}\n\nfunction b(){}"},"finish_reason":"length"}],"usage":{"prompt_tokens":9,"completion_tokens":9,"total_tokens":18}}`)
}

func (u *stopLimitedUpstream) calls() []string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]string(nil), u.bodies...)
}

// A code-completion request with ten stop sequences works against a provider that
// accepts four: the refusal is absorbed, the provider gets four, the gateway applies
// the other six, and the next request does not pay for a refused round trip.
func TestStopSequencesBeyondProviderLimit(t *testing.T) {
	upstream := &stopLimitedUpstream{}
	env := newCaptureEnv(t, upstream.handler, nil)
	post := func(stream bool) (*http.Response, string) {
		req, _ := http.NewRequest(http.MethodPost, env.url+"/v1/chat/completions", strings.NewReader(string(stopBody(t, stream, tenStops))))
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultTransport.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		data, _ := io.ReadAll(resp.Body)
		return resp, string(data)
	}

	resp, body := post(true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("streamed completion: %d %s", resp.StatusCode, body)
	}
	text := ""
	finish := ""
	for _, line := range strings.Split(body, "\n") {
		payload, ok := strings.CutPrefix(line, "data: ")
		if !ok || payload == "[DONE]" {
			continue
		}
		var chunk struct {
			Choices []struct {
				Delta        struct{ Content string } `json:"delta"`
				FinishReason *string                  `json:"finish_reason"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			t.Fatalf("invalid event %q: %v", payload, err)
		}
		for _, choice := range chunk.Choices {
			text += choice.Delta.Content
			if choice.FinishReason != nil {
				finish = *choice.FinishReason
			}
		}
	}
	if text != "return a;\n}" || finish != "stop" || !strings.HasSuffix(body, "data: [DONE]\n\n") {
		t.Fatalf("the gateway applies the blank-line stop: text %q finish %q body %q", text, finish, body)
	}
	// No provider was changed, so the failover headers stay absent as documented.
	if resp.Header.Get("X-Stop-Compat") != "gateway=6" || resp.Header.Get("X-Failover-Path") != "" {
		t.Fatalf("headers say what happened: %v", resp.Header)
	}
	calls := upstream.calls()
	if len(calls) != 2 {
		t.Fatalf("one refused call, one accepted: %d", len(calls))
	}
	if kept, _ := requestStops([]byte(calls[1])); strings.Join(kept, "|") != strings.Join(tenStops[:4], "|") {
		t.Fatalf("the provider received its four: %q", kept)
	}

	// The limit is remembered: no refused round trip, and non-streamed answers are cut too.
	resp, body = post(false)
	var completion struct {
		Choices []struct {
			Message      struct{ Content string } `json:"message"`
			FinishReason string                   `json:"finish_reason"`
		} `json:"choices"`
		Usage struct {
			TotalTokens int `json:"total_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal([]byte(body), &completion); err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("completion: %d %s %v", resp.StatusCode, body, err)
	}
	if completion.Choices[0].Message.Content != "return a;\n}" || completion.Choices[0].FinishReason != "stop" || completion.Usage.TotalTokens != 18 {
		t.Fatalf("non-streamed answer: %s", body)
	}
	if len(upstream.calls()) != 3 {
		t.Fatalf("the second request went straight through: %d calls", len(upstream.calls()))
	}

	// A request within the limit is relayed untouched.
	req, _ := http.NewRequest(http.MethodPost, env.url+"/v1/chat/completions", strings.NewReader(string(stopBody(t, false, tenStops[:2]))))
	req.Header.Set("Content-Type", "application/json")
	plain, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	defer plain.Body.Close()
	data, _ := io.ReadAll(plain.Body)
	if plain.Header.Get("X-Stop-Compat") != "" || !strings.Contains(string(data), "function b(){}") {
		t.Fatalf("within the limit nothing is cut: %v %s", plain.Header, data)
	}
}
