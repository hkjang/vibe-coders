// Command vibe is a small CLI for the vibe-coders AI Gateway. It talks to the gateway over HTTP:
// chat/app runs via the OpenAI-compatible /v1 API, and read-only lookups (models, quota, route
// preview, usage) via the Gateway MCP server at /mcp/gateway. Config comes from flags or env
// (VIBE_BASE_URL, VIBE_API_KEY). Output is JSON by default; --table renders a human view.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

type cliConfig struct {
	BaseURL string
	APIKey  string
	Table   bool
}

// resolveConfig reads --base/--key/--table flags (falling back to env) and returns the remaining
// positional args. Pure for testability.
func resolveConfig(args []string, env func(string) string) (cliConfig, []string) {
	cfg := cliConfig{BaseURL: env("VIBE_BASE_URL"), APIKey: env("VIBE_API_KEY")}
	if cfg.BaseURL == "" {
		cfg.BaseURL = "http://localhost:8080"
	}
	rest := []string{}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--base":
			if i+1 < len(args) {
				cfg.BaseURL = args[i+1]
				i++
			}
		case "--key":
			if i+1 < len(args) {
				cfg.APIKey = args[i+1]
				i++
			}
		case "--table":
			cfg.Table = true
		default:
			rest = append(rest, args[i])
		}
	}
	cfg.BaseURL = strings.TrimRight(cfg.BaseURL, "/")
	return cfg, rest
}

// mcpConfigJSON builds the MCP client config block for connecting to this gateway. Pure.
func mcpConfigJSON(baseURL string) string {
	cfg := map[string]any{"mcpServers": map[string]any{"vibe-gateway": map[string]any{
		"url": strings.TrimRight(baseURL, "/") + "/mcp/gateway", "headers": map[string]any{"Authorization": "Bearer ${VIBE_API_KEY}"},
	}}}
	b, _ := json.MarshalIndent(cfg, "", "  ")
	return string(b)
}

func main() {
	cfg, rest := resolveConfig(os.Args[1:], os.Getenv)
	if len(rest) == 0 {
		usage()
		os.Exit(2)
	}
	if err := run(cfg, rest); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `vibe — AI Gateway CLI

Usage: vibe [--base URL] [--key KEY] [--table] <command> [args]

Commands:
  models                  list available models
  chat -m MODEL PROMPT    run a chat completion
  quota                   show your quota status
  route MODEL PROMPT      preview vibe/auto routing
  usage [WINDOW]          show your usage summary (e.g. 30d)
  app run APP_ID          run an AI work app
  doctor [--client C]     diagnose your client connection setup
  mcp config              print MCP client config for this gateway

Env: VIBE_BASE_URL, VIBE_API_KEY`)
}

func run(cfg cliConfig, args []string) error {
	cmd := args[0]
	rest := args[1:]
	switch cmd {
	case "mcp":
		if len(rest) >= 1 && rest[0] == "config" {
			fmt.Println(mcpConfigJSON(cfg.BaseURL))
			return nil
		}
		return fmt.Errorf("usage: vibe mcp config")
	case "models":
		return cmdModels(cfg)
	case "quota":
		return cmdMCPTool(cfg, "gateway_check_quota", map[string]any{})
	case "usage":
		win := "30d"
		if len(rest) > 0 {
			win = rest[0]
		}
		return cmdMCPTool(cfg, "gateway_get_usage_summary", map[string]any{"window": win})
	case "route":
		if len(rest) < 2 {
			return fmt.Errorf("usage: vibe route MODEL PROMPT")
		}
		return cmdMCPTool(cfg, "gateway_route_preview", map[string]any{"model": rest[0], "prompt": strings.Join(rest[1:], " ")})
	case "chat":
		return cmdChat(cfg, rest)
	case "app":
		if len(rest) >= 2 && rest[0] == "run" {
			return cmdAppRun(cfg, rest[1])
		}
		return fmt.Errorf("usage: vibe app run APP_ID")
	case "doctor":
		client := "openai-sdk"
		for i := 0; i < len(rest); i++ {
			if rest[i] == "--client" && i+1 < len(rest) {
				client = rest[i+1]
				i++
			}
		}
		return cmdDoctor(cfg, client)
	default:
		usage()
		return fmt.Errorf("unknown command: %s", cmd)
	}
}

func (c cliConfig) do(method, path string, body any) ([]byte, int, error) {
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.BaseURL+path, rdr)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return raw, resp.StatusCode, nil
}

func cmdModels(cfg cliConfig) error {
	raw, status, err := cfg.do(http.MethodGet, "/v1/models", nil)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return fmt.Errorf("HTTP %d: %s", status, raw)
	}
	if !cfg.Table {
		fmt.Println(string(raw))
		return nil
	}
	var parsed struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	_ = json.Unmarshal(raw, &parsed)
	for _, m := range parsed.Data {
		fmt.Println(m.ID)
	}
	return nil
}

func cmdChat(cfg cliConfig, rest []string) error {
	model := "vibe/auto"
	prompt := []string{}
	for i := 0; i < len(rest); i++ {
		if rest[i] == "-m" && i+1 < len(rest) {
			model = rest[i+1]
			i++
			continue
		}
		prompt = append(prompt, rest[i])
	}
	if len(prompt) == 0 {
		return fmt.Errorf("usage: vibe chat -m MODEL PROMPT")
	}
	body := map[string]any{"model": model, "messages": []map[string]string{{"role": "user", "content": strings.Join(prompt, " ")}}}
	raw, status, err := cfg.do(http.MethodPost, "/v1/chat/completions", body)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return fmt.Errorf("HTTP %d: %s", status, raw)
	}
	if !cfg.Table {
		fmt.Println(string(raw))
		return nil
	}
	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	_ = json.Unmarshal(raw, &parsed)
	if len(parsed.Choices) > 0 {
		fmt.Println(parsed.Choices[0].Message.Content)
	}
	return nil
}

func cmdAppRun(cfg cliConfig, appID string) error {
	raw, status, err := cfg.do(http.MethodPost, "/v1/apps/"+appID+"/run", map[string]any{})
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return fmt.Errorf("HTTP %d: %s", status, raw)
	}
	fmt.Println(string(raw))
	return nil
}

// cmdDoctor runs the connection doctor for a client type and prints a per-check report.
func cmdDoctor(cfg cliConfig, client string) error {
	raw, status, err := cfg.do(http.MethodPost, "/me/connection-doctor", map[string]any{"client": client})
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return fmt.Errorf("HTTP %d: %s", status, raw)
	}
	if !cfg.Table {
		fmt.Println(string(raw))
		return nil
	}
	var parsed struct {
		Client  string `json:"client"`
		Overall string `json:"overall"`
		BaseURL string `json:"base_url"`
		MCPURL  string `json:"mcp_url"`
		Checks  []struct {
			Name   string `json:"name"`
			Status string `json:"status"`
			Detail string `json:"detail"`
			Fix    string `json:"fix"`
		} `json:"checks"`
	}
	_ = json.Unmarshal(raw, &parsed)
	fmt.Printf("client=%s  overall=%s\n", parsed.Client, parsed.Overall)
	fmt.Printf("base_url=%s  mcp_url=%s\n", parsed.BaseURL, parsed.MCPURL)
	for _, c := range parsed.Checks {
		fmt.Printf("[%-4s] %-16s %s\n", c.Status, c.Name, c.Detail)
		if c.Fix != "" && c.Status != "pass" {
			fmt.Printf("         fix: %s\n", c.Fix)
		}
	}
	return nil
}

// cmdMCPTool calls one read-only Gateway MCP tool via JSON-RPC and prints its text result.
func cmdMCPTool(cfg cliConfig, tool string, args map[string]any) error {
	body := map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": tool, "arguments": args}}
	raw, status, err := cfg.do(http.MethodPost, "/mcp/gateway", body)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return fmt.Errorf("HTTP %d: %s", status, raw)
	}
	if !cfg.Table {
		fmt.Println(extractMCPText(raw))
		return nil
	}
	fmt.Println(extractMCPText(raw))
	return nil
}

// extractMCPText pulls the text content out of an MCP tools/call JSON-RPC response.
func extractMCPText(raw []byte) string {
	var resp struct {
		Result struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return string(raw)
	}
	if resp.Error != nil {
		return "error: " + resp.Error.Message
	}
	if len(resp.Result.Content) > 0 {
		return resp.Result.Content[0].Text
	}
	return string(raw)
}
