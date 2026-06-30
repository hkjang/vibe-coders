package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func TestRequestDetailReadabilityCapturesParametersHeadersAndRouting(t *testing.T) {
	var upstreamAuth string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Upstream-Trace", "upstream-visible")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig(upstream.URL, "upstream-secret-value")
	cfg.Logging.RawBodies = true
	cfg.Pricing["gpt-4.1-mini"] = config.ModelPrice{InputKRWPer1M: 1, OutputKRWPer1M: 2}
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	chatResp := postJSON(t, proxy.URL+"/v1/chat/completions", "sk-client-secret-abcdef1234", map[string]any{
		"model":       "gpt-4.1-mini",
		"temperature": 0.2,
		"top_p":       1,
		"max_tokens":  2048,
		"stream":      true,
		"messages": []map[string]any{
			{"role": "system", "content": "Use concise answers."},
			{"role": "user", "content": "hello"},
		},
		"tools":           []map[string]any{{"type": "function", "function": map[string]any{"name": "lookup_ticket"}}},
		"response_format": map[string]any{"type": "json_object"},
		"metadata":        map[string]any{"api_key": "should-not-leak"},
	})
	defer chatResp.Body.Close()
	if chatResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(chatResp.Body)
		t.Fatalf("chat status %d: %s", chatResp.StatusCode, body)
	}
	_, _ = io.Copy(io.Discard, chatResp.Body)
	if upstreamAuth != "Bearer upstream-secret-value" {
		t.Fatalf("upstream auth mismatch: %q", upstreamAuth)
	}

	waitFor(t, time.Second, func() bool {
		recent, _ := db.RecentRequests(context.Background(), store.RequestFilter{Limit: 1})
		return len(recent) == 1
	})
	recent, err := db.RecentRequests(context.Background(), store.RequestFilter{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	id := recent[0].ID

	listResp, err := http.Get(proxy.URL + "/admin/requests?ids=" + id + "&limit=1")
	if err != nil {
		t.Fatal(err)
	}
	defer listResp.Body.Close()
	var listOut struct {
		Requests []store.RecentRequest `json:"requests"`
	}
	if err := json.NewDecoder(listResp.Body).Decode(&listOut); err != nil {
		t.Fatal(err)
	}
	if len(listOut.Requests) != 1 || listOut.Requests[0].ID != id {
		t.Fatalf("ids filter did not return request %s: %+v", id, listOut.Requests)
	}
	foundUserPreview := false
	for _, p := range listOut.Requests[0].Prompts {
		if p.Role == "user" && strings.Contains(p.RedactedText, "hello") {
			foundUserPreview = true
		}
	}
	if !foundUserPreview {
		t.Fatalf("expected user prompt preview for xview selection list: %+v", listOut.Requests[0].Prompts)
	}

	detailResp, err := http.Get(proxy.URL + "/admin/requests/" + id)
	if err != nil {
		t.Fatal(err)
	}
	defer detailResp.Body.Close()
	var detail store.RequestDetail
	if err := json.NewDecoder(detailResp.Body).Decode(&detail); err != nil {
		t.Fatal(err)
	}
	if detail.Readability == nil {
		t.Fatal("expected readability projection")
	}
	if detail.Request.RequestedModel != "gpt-4.1-mini" || detail.Request.ResolvedModel != "gpt-4.1-mini" || detail.Request.UpstreamModel != "gpt-4.1-mini" {
		t.Fatalf("model projection mismatch: %+v", detail.Request)
	}
	if detail.Request.Temperature == nil || *detail.Request.Temperature != 0.2 || detail.Request.MaxTokens != 2048 || detail.Request.ToolCount != 1 {
		t.Fatalf("parameter projection mismatch: %+v", detail.Request)
	}
	params := detail.Readability.Parameters
	if params["temperature_label"] != "낮음" || params["response_format_type"] != "json_object" {
		t.Fatalf("readability params mismatch: %+v", params)
	}
	headers := detail.Readability.Headers
	encodedHeaders, _ := json.Marshal(headers)
	if strings.Contains(string(encodedHeaders), "sk-client-secret-abcdef1234") || strings.Contains(string(encodedHeaders), "upstream-secret-value") || strings.Contains(string(encodedHeaders), "should-not-leak") {
		t.Fatalf("sensitive value leaked in headers/body projection: %s", encodedHeaders)
	}
	if !strings.Contains(string(encodedHeaders), "Bearer sk-****1234") {
		t.Fatalf("masked Authorization not present: %s", encodedHeaders)
	}

	headersResp, err := http.Get(proxy.URL + "/admin/requests/" + id + "/headers")
	if err != nil {
		t.Fatal(err)
	}
	defer headersResp.Body.Close()
	var headersOut map[string]any
	if err := json.NewDecoder(headersResp.Body).Decode(&headersOut); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(headersOut)
	if strings.Contains(string(b), "upstream-secret-value") {
		t.Fatalf("subresource leaked upstream secret: %s", b)
	}

	bodyResp, err := http.Get(proxy.URL + "/admin/requests/" + id + "/body")
	if err != nil {
		t.Fatal(err)
	}
	defer bodyResp.Body.Close()
	var bodyOut map[string]any
	if err := json.NewDecoder(bodyResp.Body).Decode(&bodyOut); err != nil {
		t.Fatal(err)
	}
	bodyJSON, _ := json.Marshal(bodyOut)
	if strings.Contains(string(bodyJSON), "should-not-leak") {
		t.Fatalf("body subresource leaked secret: %s", bodyJSON)
	}

	exportResp := postJSON(t, proxy.URL+"/admin/requests/"+id+"/export", "", map[string]any{})
	defer exportResp.Body.Close()
	exportBody, _ := io.ReadAll(exportResp.Body)
	if exportResp.StatusCode != http.StatusOK {
		t.Fatalf("export status %d: %s", exportResp.StatusCode, exportBody)
	}
	if strings.Contains(string(exportBody), "sk-client-secret-abcdef1234") || strings.Contains(string(exportBody), "should-not-leak") {
		t.Fatalf("export leaked secret: %s", exportBody)
	}
}
