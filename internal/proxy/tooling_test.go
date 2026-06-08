package proxy

import (
	"testing"
)

func TestClassifyToolName(t *testing.T) {
	cases := []struct {
		name       string
		wantServer string
		wantTool   string
		wantMCP    bool
	}{
		{"mcp__github__create_issue", "github", "create_issue", true},
		{"mcp__korean-law__search_law", "korean-law", "search_law", true},
		{"mcp__server__a__b", "server", "a__b", true},
		{"github.create_issue", "github", "create_issue", false},
		{"fs/read_file", "fs", "read_file", false},
		{"get_weather", "", "get_weather", false},
		{"", "", "", false},
	}
	for _, tc := range cases {
		server, tool, isMCP := classifyToolName(tc.name)
		if server != tc.wantServer || tool != tc.wantTool || isMCP != tc.wantMCP {
			t.Errorf("classifyToolName(%q) = (%q,%q,%v), want (%q,%q,%v)",
				tc.name, server, tool, isMCP, tc.wantServer, tc.wantTool, tc.wantMCP)
		}
	}
}

func TestExtractRequestToolsCatalogAndResults(t *testing.T) {
	body := []byte(`{
		"model": "gpt-4.1",
		"tools": [
			{"type":"function","function":{"name":"mcp__github__create_issue"}},
			{"type":"mcp","server_label":"filesystem","name":"read_file"},
			{"type":"web_search"}
		],
		"messages": [
			{"role":"user","content":"hi"},
			{"role":"assistant","tool_calls":[{"function":{"name":"mcp__github__create_issue","arguments":"{\"title\":\"x\"}"}}]},
			{"role":"tool","name":"mcp__github__create_issue","content":"{\"isError\":true,\"message\":\"403\"}"}
		]
	}`)
	tools := extractRequestTools(body)

	var defs, calls, results, errs, mcp int
	for _, tl := range tools {
		switch tl.Source {
		case "definition":
			defs++
		case "call":
			calls++
		case "result":
			results++
		}
		if tl.IsError {
			errs++
		}
		if tl.IsMCP {
			mcp++
		}
	}
	if defs != 3 {
		t.Fatalf("expected 3 definitions, got %d (%#v)", defs, tools)
	}
	if calls != 1 {
		t.Fatalf("expected 1 call, got %d", calls)
	}
	if results != 1 {
		t.Fatalf("expected 1 result, got %d", results)
	}
	if errs != 1 {
		t.Fatalf("expected 1 error result, got %d", errs)
	}
	if mcp < 3 {
		t.Fatalf("expected at least 3 MCP-classified tools, got %d", mcp)
	}
}

func TestResponseAnalyzerCapturesToolCalls(t *testing.T) {
	// non-streaming message.tool_calls
	a := NewResponseAnalyzer(false, true, 65536)
	a.Write([]byte(`{"choices":[{"message":{"content":"","tool_calls":[{"type":"function","function":{"name":"mcp__db__query","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`))
	res := a.Finalize()
	if len(res.ToolCalls) != 1 {
		t.Fatalf("expected 1 tool call captured, got %d", len(res.ToolCalls))
	}
	if res.ToolCalls[0].Server != "db" || res.ToolCalls[0].Tool != "query" || !res.ToolCalls[0].IsMCP {
		t.Fatalf("unexpected parsed tool call: %#v", res.ToolCalls[0])
	}

	// streaming delta.tool_calls fragments
	s := NewResponseAnalyzer(true, false, 65536)
	s.Write([]byte("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"get_weather\"}}]}}]}\n\n"))
	s.Write([]byte("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"city\\\":\"}}]}}]}\n\n"))
	s.Write([]byte("data: [DONE]\n\n"))
	sres := s.Finalize()
	if len(sres.ToolCalls) != 1 || sres.ToolCalls[0].Tool != "get_weather" {
		t.Fatalf("expected streamed tool call get_weather, got %#v", sres.ToolCalls)
	}
}

func TestLooksLikeToolError(t *testing.T) {
	if !looksLikeToolError(`{"isError": true}`) {
		t.Error("expected isError:true to be flagged")
	}
	if !looksLikeToolError("Error: file not found") {
		t.Error("expected textual error to be flagged")
	}
	if looksLikeToolError(`{"result":"ok"}`) {
		t.Error("expected normal result to not be flagged")
	}
}
