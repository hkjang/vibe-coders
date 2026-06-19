package proxy

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"vibe-coders/internal/store"
)

func TestMCPDiscoveryModelRoutesOnlyRelevantGroundedCandidates(t *testing.T) {
	var policyCalls atomic.Int64
	var legalCalls atomic.Int64
	policyUpstream := fakeDiscoveryMCP(t, "policy vacation evidence", &policyCalls)
	defer policyUpstream.Close()
	legalUpstream := fakeDiscoveryMCP(t, "legal contract evidence", &legalCalls)
	defer legalUpstream.Close()

	s, db := newKnowledgeServer(t)
	proxy := httptest.NewServer(s.Routes())
	defer proxy.Close()

	if err := db.UpsertMCPUpstream(t.Context(), store.MCPUpstream{
		ID: "policy", Name: "Policy MCP", URL: policyUpstream.URL, Enabled: true,
		Metadata: store.MCPUpstreamMetadata{
			Description:   "company vacation policy hr rules",
			Domains:       []string{"policy", "hr"},
			RiskLevel:     "low",
			AllowedModels: []string{"vibe/grounded", "vibe/policy"},
			DefaultTool:   "search",
			MaxResults:    3,
		},
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertMCPUpstream(t.Context(), store.MCPUpstream{
		ID: "legal", Name: "Legal MCP", URL: legalUpstream.URL, Enabled: true,
		Metadata: store.MCPUpstreamMetadata{
			Description:   "legal contracts law litigation",
			Domains:       []string{"legal"},
			RiskLevel:     "low",
			AllowedModels: []string{"vibe/grounded", "vibe/legal"},
			DefaultTool:   "search",
		},
	}); err != nil {
		t.Fatal(err)
	}

	resp := postJSON(t, proxy.URL+"/v1/chat/completions", "", map[string]any{
		"model": "vibe/grounded",
		"messages": []map[string]string{{
			"role": "user", "content": "what is our vacation policy?",
		}},
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("grounded response status=%d body=%s", resp.StatusCode, body)
	}
	if resp.Header.Get("X-Task-Type") != "mcp_discovery" || resp.Header.Get("X-MCP-Grounded") != "true" || resp.Header.Get("X-MCP-Candidates") != "1" {
		t.Fatalf("unexpected discovery headers: task=%s grounded=%s candidates=%s", resp.Header.Get("X-Task-Type"), resp.Header.Get("X-MCP-Grounded"), resp.Header.Get("X-MCP-Candidates"))
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Evidence []MCPEvidence `json:"evidence"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if len(out.Choices) != 1 || !strings.Contains(out.Choices[0].Message.Content, "policy vacation evidence") {
		t.Fatalf("missing policy evidence in response: %+v", out)
	}
	if len(out.Evidence) != 1 || out.Evidence[0].UpstreamID != "policy" || out.Evidence[0].EvidenceScore < 0.75 {
		t.Fatalf("evidence ranking mismatch: %+v", out.Evidence)
	}
	if policyCalls.Load() != 1 {
		t.Fatalf("policy MCP should be called once, got %d", policyCalls.Load())
	}
	if legalCalls.Load() != 0 {
		t.Fatalf("irrelevant legal MCP should not be called, got %d", legalCalls.Load())
	}
	decisions, err := db.ListDomainRoutingDecisions(t.Context(), store.DomainRoutingFilter{Route: "grounded", Limit: 10})
	if err != nil || len(decisions) != 1 || decisions[0].EvidenceCount != 1 || decisions[0].EvidenceScore < 0.75 {
		t.Fatalf("domain routing decision not recorded decisions=%+v err=%v", decisions, err)
	}
	signals, err := db.DomainRoutingSignals(t.Context(), decisions[0].ID)
	if err != nil || len(signals) < 3 {
		t.Fatalf("domain routing signals not recorded signals=%+v err=%v", signals, err)
	}
	examples, err := db.ListDomainExamples(t.Context(), "grounded", 10)
	if err != nil || len(examples) != 1 || !examples[0].AutoPromoted {
		t.Fatalf("domain example not auto-promoted examples=%+v err=%v", examples, err)
	}
	review, err := db.ListDomainReviewQueue(t.Context(), store.DomainRoutingFilter{Status: "pending", Limit: 10})
	if err != nil || len(review) != 0 {
		t.Fatalf("high-confidence grounded route should not enqueue review review=%+v err=%v", review, err)
	}
}

func TestMCPDiscoveryPolicyHelpers(t *testing.T) {
	if !isMCPDiscoveryModel("vibe/grounded") || !isMCPDiscoveryModel("vibe/all-mcp") || !isMCPDiscoveryModel("vibe/all_mcp") || isMCPDiscoveryModel("vibe/auto") {
		t.Fatal("MCP discovery model detection mismatch")
	}
	grounded := mcpDiscoveryPolicyForModel("vibe/grounded")
	// grounded is intentionally broad: agentic mode lets the LLM pick tools from a wider
	// candidate set while static fallback still uses MinSelectorScore as a guard.
	if grounded.Mode != "selective" || grounded.MaxMCPs < 8 || grounded.MinSelectorScore <= 0 || grounded.MinSelectorScore > 0.2 {
		t.Fatalf("grounded policy mismatch: %+v", grounded)
	}
	all := mcpDiscoveryPolicyForModel("vibe/all-mcp")
	if all.Mode != "all_allowed" || all.MaxMCPs < grounded.MaxMCPs {
		t.Fatalf("all-mcp policy mismatch: %+v", all)
	}
	allAlias := mcpDiscoveryPolicyForModel("vibe/all_mcp")
	if allAlias.Model != "vibe/all-mcp" || allAlias.Mode != "all_allowed" {
		t.Fatalf("all_mcp alias policy mismatch: %+v", allAlias)
	}
	if !mcpModelAllowed("vibe/grounded", []string{"vibe/*"}) || !mcpModelAllowed("vibe/all_mcp", []string{"vibe/all-mcp"}) || mcpModelAllowed("vibe/legal", []string{"vibe/policy"}) {
		t.Fatal("model allow matcher mismatch")
	}
	if !mcpAuthModelAllowed("vibe/all_mcp", "vibe/all-mcp", []string{"vibe/all-mcp"}, nil) || mcpAuthModelAllowed("vibe/all_mcp", "vibe/all-mcp", nil, []string{"vibe/all-mcp"}) {
		t.Fatal("MCP discovery alias auth matcher mismatch")
	}
	if !mcpDomainMatches("vibe/policy", []string{"policy"}, "vacation rules") || mcpDomainMatches("vibe/legal", []string{"research"}, "contract") {
		t.Fatal("domain matcher mismatch")
	}
	if score := scoreMCPEvidence(MCPCandidate{SelectorScore: 0.8, HealthScore: 1}, MCPEvidence{Items: []MCPResultItem{{Text: "evidence", URI: "doc://1"}}}); score < 0.75 {
		t.Fatalf("evidence score too low: %v", score)
	}
}

func TestDomainRoutingAdminEndpoints(t *testing.T) {
	s, db := newKnowledgeServer(t)
	proxy := httptest.NewServer(s.Routes())
	defer proxy.Close()

	decision := store.DomainRoutingDecision{
		ID: "drd_admin", RequestID: "req_admin", QueryHash: "hash", Route: "grounded", Confidence: 0.5,
		ToolNames: []string{"policy/search"}, Reason: "low confidence",
	}
	if err := db.InsertDomainRoutingDecision(t.Context(), decision, []store.DomainRoutingSignal{{
		ID: "sig_admin", DecisionID: "drd_admin", Source: "selector", Route: "grounded", Score: 0.5,
	}}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertDomainExample(t.Context(), store.DomainExample{ID: "dex_admin", Route: "grounded", Text: "sample", TextHash: "h", Source: "test", Confidence: 0.9, Approved: true}); err != nil {
		t.Fatal(err)
	}
	if err := db.EnqueueDomainReview(t.Context(), store.DomainReviewQueueItem{ID: "drv_admin", DecisionID: "drd_admin", QueryText: "sample", SuggestedRoute: "grounded", Status: "pending"}); err != nil {
		t.Fatal(err)
	}

	for _, path := range []string{"/admin/routing/domain-decisions", "/admin/routing/domain-examples", "/admin/routing/domain-review"} {
		resp, err := http.Get(proxy.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			t.Fatalf("%s status=%d body=%s", path, resp.StatusCode, body)
		}
		resp.Body.Close()
	}
	resp := postJSON(t, proxy.URL+"/admin/routing/domain-review/drv_admin/approve", "", map[string]any{})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("approve status=%d body=%s", resp.StatusCode, body)
	}
	queue, err := db.ListDomainReviewQueue(t.Context(), store.DomainRoutingFilter{Status: "approved", Limit: 10})
	if err != nil || len(queue) != 1 {
		t.Fatalf("review approval not persisted queue=%+v err=%v", queue, err)
	}
}

func TestMCPDiscoveryAgenticToolCallingLoop(t *testing.T) {
	var mcpCalls atomic.Int64
	mcpUpstream := fakeDiscoveryMCP(t, "vacation evidence", &mcpCalls)
	defer mcpUpstream.Close()

	// Fake backing LLM: first turn issues a tool call against the MCP search tool, second
	// turn (after the tool result is fed back) returns the final grounded answer.
	var llmCalls atomic.Int64
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		// The second turn carries a tool-result message in the conversation.
		if strings.Contains(string(body), "\"role\":\"tool\"") || llmCalls.Load() > 0 {
			llmCalls.Add(1)
			_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"휴가 정책은 근거 기반으로 정리되었습니다."},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":8,"total_tokens":28}}`)
			return
		}
		llmCalls.Add(1)
		_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"kb__search","arguments":"{\"query\":\"vacation policy\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":6,"total_tokens":18}}`)
	}))
	defer llm.Close()

	s, db := newKnowledgeServer(t)
	proxy := httptest.NewServer(s.Routes())
	defer proxy.Close()

	provResp := postJSON(t, proxy.URL+"/admin/providers", "", map[string]any{
		"name": "openai", "base_url": llm.URL, "api_key": "test-key",
		"timeout_ms": 5000, "enabled": true, "model_patterns": "gpt-*,o3",
	})
	if provResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(provResp.Body)
		t.Fatalf("provider upsert failed: %d %s", provResp.StatusCode, body)
	}
	provResp.Body.Close()
	mcpCfg := s.mcpConf()
	mcpCfg.AgenticModel = "qwen-plus"
	s.mcpRuntime.Store(&mcpCfg)
	provResp = postJSON(t, proxy.URL+"/admin/providers", "", map[string]any{
		"name": "qwen", "base_url": llm.URL, "api_key": "test-key",
		"timeout_ms": 5000, "enabled": true, "model_patterns": "qwen-plus",
	})
	if provResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(provResp.Body)
		t.Fatalf("qwen provider upsert failed: %d %s", provResp.StatusCode, body)
	}
	provResp.Body.Close()
	if err := db.UpsertMCPUpstream(t.Context(), store.MCPUpstream{
		ID: "kb", Name: "Knowledge MCP", URL: mcpUpstream.URL, Enabled: true,
		Metadata: store.MCPUpstreamMetadata{
			Description:   "company vacation policy hr rules",
			Domains:       []string{"policy", "hr"},
			RiskLevel:     "low",
			AllowedModels: []string{"vibe/grounded"},
			DefaultTool:   "search",
		},
	}); err != nil {
		t.Fatal(err)
	}

	resp := postJSON(t, proxy.URL+"/v1/chat/completions", "", map[string]any{
		"model": "vibe/grounded",
		"messages": []map[string]string{{
			"role": "user", "content": "what is our vacation policy?",
		}},
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("agentic grounded status=%d body=%s", resp.StatusCode, body)
	}
	if resp.Header.Get("X-MCP-Agentic") != "true" || resp.Header.Get("X-MCP-Backing-Model") != "qwen-plus" {
		t.Fatalf("expected agentic headers, got agentic=%s backing=%s", resp.Header.Get("X-MCP-Agentic"), resp.Header.Get("X-MCP-Backing-Model"))
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Evidence []MCPEvidence `json:"evidence"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if len(out.Choices) != 1 || !strings.Contains(out.Choices[0].Message.Content, "근거 기반") {
		t.Fatalf("expected synthesized final answer, got %+v", out)
	}
	// The evidence records the model's actual per-call arguments for after-the-fact review.
	if len(out.Evidence) != 1 || !strings.Contains(out.Evidence[0].Args, "vacation policy") {
		t.Fatalf("expected evidence with the model's tool args, got %+v", out.Evidence)
	}
	if mcpCalls.Load() != 1 {
		t.Fatalf("MCP search tool should be called once by the agent, got %d", mcpCalls.Load())
	}
	if llmCalls.Load() < 2 {
		t.Fatalf("agentic loop should make at least 2 LLM turns, got %d", llmCalls.Load())
	}
}

func TestMCPDiscoveryAgenticStreamingEmitsStats(t *testing.T) {
	var mcpCalls atomic.Int64
	mcpUpstream := fakeDiscoveryMCP(t, "vacation evidence", &mcpCalls)
	defer mcpUpstream.Close()

	var llmCalls atomic.Int64
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(string(body), "\"role\":\"tool\"") || llmCalls.Load() > 0 {
			llmCalls.Add(1)
			_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"근거 기반 최종 답변."},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}`)
			return
		}
		llmCalls.Add(1)
		_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"kb__search","arguments":"{\"query\":\"vacation\"}"}}]},"finish_reason":"tool_calls"}]}`)
	}))
	defer llm.Close()

	s, db := newKnowledgeServer(t)
	proxy := httptest.NewServer(s.Routes())
	defer proxy.Close()

	provResp := postJSON(t, proxy.URL+"/admin/providers", "", map[string]any{
		"name": "openai", "base_url": llm.URL, "api_key": "test-key",
		"timeout_ms": 5000, "enabled": true, "model_patterns": "gpt-*,o3",
	})
	if provResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(provResp.Body)
		t.Fatalf("provider upsert failed: %d %s", provResp.StatusCode, body)
	}
	provResp.Body.Close()
	if err := db.UpsertMCPUpstream(t.Context(), store.MCPUpstream{
		ID: "kb", Name: "Knowledge MCP", URL: mcpUpstream.URL, Enabled: true,
		Metadata: store.MCPUpstreamMetadata{
			Description: "company vacation policy hr rules", Domains: []string{"policy", "hr"},
			RiskLevel: "low", AllowedModels: []string{"vibe/grounded"}, DefaultTool: "search",
		},
	}); err != nil {
		t.Fatal(err)
	}

	resp := postJSON(t, proxy.URL+"/v1/chat/completions", "", map[string]any{
		"model":    "vibe/grounded",
		"stream":   true,
		"messages": []map[string]string{{"role": "user", "content": "vacation policy?"}},
	})
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected SSE, got ct=%q body=%s", ct, body)
	}
	body, _ := io.ReadAll(resp.Body)
	got := string(body)
	// Reasoning narration (tool call), the final answer content, and the structured stats.
	for _, want := range []string{"reasoning_content", "kb__search", "근거 기반", "x_mcp", "\"tool_calls\":1"} {
		if !strings.Contains(got, want) {
			t.Fatalf("streamed body missing %q; got: %s", want, got)
		}
	}
}

func TestMCPAgenticStreamsUpstreamSSE(t *testing.T) {
	var mcpCalls atomic.Int64
	mcpUpstream := fakeDiscoveryMCP(t, "vacation evidence", &mcpCalls)
	defer mcpUpstream.Close()

	// Fake LLM that actually emits SSE: turn 1 streams a fragmented tool_call, turn 2 streams
	// the final answer content token-by-token. Exercises the real SSE accumulation path
	// (fragmented tool_calls by index) rather than the single-shot JSON fallback.
	var llmCalls atomic.Int64
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		write := func(s string) {
			_, _ = io.WriteString(w, s)
			if flusher != nil {
				flusher.Flush()
			}
		}
		if strings.Contains(string(body), "\"role\":\"tool\"") || llmCalls.Load() > 0 {
			llmCalls.Add(1)
			write("data: {\"choices\":[{\"delta\":{\"content\":\"근거 \"}}]}\n\n")
			write("data: {\"choices\":[{\"delta\":{\"content\":\"기반 답변.\"}}]}\n\n")
			write("data: {\"choices\":[{\"finish_reason\":\"stop\"}]}\n\n")
			write("data: {\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":3,\"total_tokens\":8}}\n\n")
			write("data: [DONE]\n\n")
			return
		}
		llmCalls.Add(1)
		write("data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n")
		write("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"type\":\"function\",\"function\":{\"name\":\"kb__search\",\"arguments\":\"\"}}]}}]}\n\n")
		write("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"query\\\":\"}}]}}]}\n\n")
		write("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"vacation\\\"}\"}}]}}]}\n\n")
		write("data: {\"choices\":[{\"finish_reason\":\"tool_calls\"}]}\n\n")
		write("data: [DONE]\n\n")
	}))
	defer llm.Close()

	s, db := newKnowledgeServer(t)
	proxy := httptest.NewServer(s.Routes())
	defer proxy.Close()

	provResp := postJSON(t, proxy.URL+"/admin/providers", "", map[string]any{
		"name": "openai", "base_url": llm.URL, "api_key": "test-key",
		"timeout_ms": 5000, "enabled": true, "model_patterns": "gpt-*,o3",
	})
	if provResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(provResp.Body)
		t.Fatalf("provider upsert failed: %d %s", provResp.StatusCode, body)
	}
	provResp.Body.Close()
	if err := db.UpsertMCPUpstream(t.Context(), store.MCPUpstream{
		ID: "kb", Name: "Knowledge MCP", URL: mcpUpstream.URL, Enabled: true,
		Metadata: store.MCPUpstreamMetadata{
			Description: "company vacation policy hr rules", Domains: []string{"policy", "hr"},
			RiskLevel: "low", AllowedModels: []string{"vibe/grounded"}, DefaultTool: "search",
		},
	}); err != nil {
		t.Fatal(err)
	}

	resp := postJSON(t, proxy.URL+"/v1/chat/completions", "", map[string]any{
		"model":    "vibe/grounded",
		"stream":   true,
		"messages": []map[string]string{{"role": "user", "content": "vacation policy?"}},
	})
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected SSE, got ct=%q body=%s", ct, body)
	}
	body, _ := io.ReadAll(resp.Body)
	got := string(body)
	for _, want := range []string{"kb__search", "기반 답변", "x_mcp"} {
		if !strings.Contains(got, want) {
			t.Fatalf("streamed body missing %q; got: %s", want, got)
		}
	}
	if mcpCalls.Load() != 1 {
		t.Fatalf("the streamed (fragmented) tool call should reach the MCP once, got %d", mcpCalls.Load())
	}
	if llmCalls.Load() < 2 {
		t.Fatalf("expected at least 2 streaming LLM turns, got %d", llmCalls.Load())
	}
}

func TestMCPAgenticForcesFirstToolAndCachesRepeats(t *testing.T) {
	var mcpCalls atomic.Int64
	mcpUpstream := fakeDiscoveryMCP(t, "vacation evidence", &mcpCalls)
	defer mcpUpstream.Close()

	// Record the tool_choice each turn sends. Turn 1 + turn 2 both issue the SAME tool call
	// (to exercise the result cache); turn 3 returns the final answer.
	var toolChoices []string
	var mu sync.Mutex
	var turn atomic.Int64
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var parsed struct {
			ToolChoice any `json:"tool_choice"`
		}
		_ = json.Unmarshal(body, &parsed)
		mu.Lock()
		toolChoices = append(toolChoices, toString(parsed.ToolChoice))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		n := turn.Add(1)
		switch n {
		case 1, 2:
			_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call_`+toString(n)+`","type":"function","function":{"name":"kb__search","arguments":"{\"query\":\"vacation\"}"}}]},"finish_reason":"tool_calls"}]}`)
		default:
			_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"근거 기반 최종 답변."},"finish_reason":"stop"}]}`)
		}
	}))
	defer llm.Close()

	s, db := newKnowledgeServer(t)
	proxy := httptest.NewServer(s.Routes())
	defer proxy.Close()

	provResp := postJSON(t, proxy.URL+"/admin/providers", "", map[string]any{
		"name": "openai", "base_url": llm.URL, "api_key": "test-key",
		"timeout_ms": 5000, "enabled": true, "model_patterns": "gpt-*,o3",
	})
	if provResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(provResp.Body)
		t.Fatalf("provider upsert failed: %d %s", provResp.StatusCode, body)
	}
	provResp.Body.Close()

	// Enable force-tool-first via the runtime config overlay.
	mcpCfg := s.mcpConf()
	mcpCfg.ForceToolFirst = true
	mcpCfg.MaxAgentSteps = 8
	mcpCfg.MaxTokens = 2048
	s.mcpRuntime.Store(&mcpCfg)

	if err := db.UpsertMCPUpstream(t.Context(), store.MCPUpstream{
		ID: "kb", Name: "Knowledge MCP", URL: mcpUpstream.URL, Enabled: true,
		Metadata: store.MCPUpstreamMetadata{
			Description: "company vacation policy hr rules", Domains: []string{"policy", "hr"},
			RiskLevel: "low", AllowedModels: []string{"vibe/grounded"}, DefaultTool: "search",
		},
	}); err != nil {
		t.Fatal(err)
	}

	resp := postJSON(t, proxy.URL+"/v1/chat/completions", "", map[string]any{
		"model":    "vibe/grounded",
		"messages": []map[string]string{{"role": "user", "content": "vacation policy?"}},
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status=%d body=%s", resp.StatusCode, body)
	}
	_, _ = io.ReadAll(resp.Body)

	mu.Lock()
	defer mu.Unlock()
	if len(toolChoices) == 0 || toolChoices[0] != "required" {
		t.Fatalf("first turn must force tool use (tool_choice=required), got %v", toolChoices)
	}
	// Two identical tool calls were issued but the cache should collapse them to one MCP hit.
	if mcpCalls.Load() != 1 {
		t.Fatalf("repeated identical tool call should be cached to 1 MCP hit, got %d", mcpCalls.Load())
	}
}

func TestMCPDiscoveryAgenticSelectorIsRankingBoostNotGate(t *testing.T) {
	var firstCalls atomic.Int64
	var secondCalls atomic.Int64
	firstMCP := fakeDiscoveryMCP(t, "first evidence", &firstCalls)
	defer firstMCP.Close()
	secondMCP := fakeDiscoveryMCP(t, "second evidence", &secondCalls)
	defer secondMCP.Close()

	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"후보 MCP를 확인했습니다."},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}`)
	}))
	defer llm.Close()

	s, db := newKnowledgeServer(t)
	proxy := httptest.NewServer(s.Routes())
	defer proxy.Close()
	mcpCfg := s.mcpConf()
	mcpCfg.AgenticModel = "qwen-plus"
	s.mcpRuntime.Store(&mcpCfg)
	provResp := postJSON(t, proxy.URL+"/admin/providers", "", map[string]any{
		"name": "qwen", "base_url": llm.URL, "api_key": "test-key",
		"timeout_ms": 5000, "enabled": true, "model_patterns": "qwen-plus",
	})
	if provResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(provResp.Body)
		t.Fatalf("qwen provider upsert failed: %d %s", provResp.StatusCode, body)
	}
	provResp.Body.Close()

	for _, up := range []store.MCPUpstream{
		{
			ID: "alpha", Name: "alpha", URL: firstMCP.URL, Enabled: true,
			Metadata: store.MCPUpstreamMetadata{
				Description:   "alpha invoices payments",
				RiskLevel:     "low",
				AllowedModels: []string{"vibe/grounded"},
				DefaultTool:   "search",
			},
		},
		{
			ID: "beta", Name: "beta", URL: secondMCP.URL, Enabled: true,
			Metadata: store.MCPUpstreamMetadata{
				Description:   "beta calendar rooms",
				RiskLevel:     "low",
				AllowedModels: []string{"vibe/grounded"},
				DefaultTool:   "search",
			},
		},
	} {
		if err := db.UpsertMCPUpstream(t.Context(), up); err != nil {
			t.Fatal(err)
		}
	}

	resp := postJSON(t, proxy.URL+"/v1/chat/completions", "", map[string]any{
		"model": "vibe/grounded",
		"messages": []map[string]string{{
			"role": "user", "content": "zzzz unmatched query tokens",
		}},
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("agentic grounded status=%d body=%s", resp.StatusCode, body)
	}
	if resp.Header.Get("X-MCP-Agentic") != "true" || resp.Header.Get("X-MCP-Backing-Model") != "qwen-plus" {
		t.Fatalf("expected configured agentic model, got agentic=%s backing=%s", resp.Header.Get("X-MCP-Agentic"), resp.Header.Get("X-MCP-Backing-Model"))
	}
	if resp.Header.Get("X-MCP-Candidates") != "2" {
		t.Fatalf("low selector MCPs should remain candidates for the LLM, got %s", resp.Header.Get("X-MCP-Candidates"))
	}
	if got := resp.Header.Get("X-MCP-Score-Filtered"); got != "" {
		t.Fatalf("agentic selector should rank, not filter; got X-MCP-Score-Filtered=%s", got)
	}
	if firstCalls.Load() != 0 || secondCalls.Load() != 0 {
		t.Fatalf("backing LLM did not request tools, so MCP calls should be 0; got first=%d second=%d", firstCalls.Load(), secondCalls.Load())
	}
}

func fakeDiscoveryMCP(t *testing.T, text string, calls *atomic.Int64) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		if len(req.ID) == 0 {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Mcp-Session-Id", "sess-discovery")
		resp := map[string]any{"jsonrpc": "2.0", "id": req.ID}
		switch req.Method {
		case "initialize":
			resp["result"] = map[string]any{
				"protocolVersion": "2025-06-18",
				"capabilities":    map[string]any{"tools": map[string]any{}},
				"serverInfo":      map[string]any{"name": "fake", "version": "1"},
			}
		case "tools/list":
			resp["result"] = map[string]any{"tools": []map[string]any{{
				"name": "search", "description": "search indexed domain evidence", "inputSchema": map[string]any{"type": "object"},
			}}}
		case "tools/call":
			calls.Add(1)
			var p struct {
				Arguments map[string]any `json:"arguments"`
			}
			_ = json.Unmarshal(req.Params, &p)
			query, _ := p.Arguments["query"].(string)
			resp["result"] = map[string]any{
				"content": []map[string]any{{
					"type":  "text",
					"title": "result",
					"uri":   "mcp://fixture",
					"text":  text + " for " + query,
				}},
				"isError": false,
			}
		default:
			resp["error"] = map[string]any{"code": -32601, "message": "method not found"}
		}
		var buf bytes.Buffer
		_ = json.NewEncoder(&buf).Encode(resp)
		_, _ = w.Write(buf.Bytes())
	}))
}
