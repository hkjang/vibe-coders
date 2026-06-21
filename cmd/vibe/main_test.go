package main

import (
	"strings"
	"testing"
)

func TestResolveConfig(t *testing.T) {
	env := func(k string) string {
		if k == "VIBE_BASE_URL" {
			return "http://env-host:9000/"
		}
		return ""
	}
	// Env provides base; flags override + are stripped from positional args.
	cfg, rest := resolveConfig([]string{"--key", "sk-1", "models", "--table"}, env)
	if cfg.APIKey != "sk-1" {
		t.Fatalf("key = %q", cfg.APIKey)
	}
	if cfg.BaseURL != "http://env-host:9000" { // trailing slash trimmed
		t.Fatalf("base = %q", cfg.BaseURL)
	}
	if !cfg.Table {
		t.Fatal("--table should set Table")
	}
	if len(rest) != 1 || rest[0] != "models" {
		t.Fatalf("rest = %v", rest)
	}

	// --base flag overrides env.
	cfg2, _ := resolveConfig([]string{"--base", "https://gw"}, env)
	if cfg2.BaseURL != "https://gw" {
		t.Fatalf("flag base = %q", cfg2.BaseURL)
	}

	// Default when no env/flag.
	cfg3, _ := resolveConfig([]string{"quota"}, func(string) string { return "" })
	if cfg3.BaseURL != "http://localhost:8080" {
		t.Fatalf("default base = %q", cfg3.BaseURL)
	}
}

func TestMCPConfigJSON(t *testing.T) {
	out := mcpConfigJSON("https://gw/")
	if !strings.Contains(out, "https://gw/mcp/gateway") {
		t.Fatalf("missing endpoint: %s", out)
	}
	if !strings.Contains(out, "vibe-gateway") || !strings.Contains(out, "Authorization") {
		t.Fatalf("missing keys: %s", out)
	}
}

func TestExtractMCPText(t *testing.T) {
	ok := extractMCPText([]byte(`{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"hello"}]}}`))
	if ok != "hello" {
		t.Fatalf("got %q", ok)
	}
	er := extractMCPText([]byte(`{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"bad"}}`))
	if er != "error: bad" {
		t.Fatalf("got %q", er)
	}
}
