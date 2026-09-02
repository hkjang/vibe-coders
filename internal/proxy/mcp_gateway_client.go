package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"

	"vibe-coders/internal/store"
)

const mcpProtocolVersion = "2025-06-18"

const mcpUpstreamRequestFailed = "MCP upstream request failed"

var errMCPUpstreamRequestFailed = errors.New(mcpUpstreamRequestFailed)

// JSON-RPC 2.0 message shapes (the subset the MCP gateway needs).
type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      any    `json:"id,omitempty"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type rpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// mcpToolDef is one tool as advertised by an upstream (and re-advertised by the gateway).
type mcpToolDef struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
	Annotations json.RawMessage `json:"annotations,omitempty"`
}

// mcpUpstreamConn caches the initialize handshake + session id for one upstream.
type mcpUpstreamConn struct {
	mu          sync.Mutex
	sessionID   string
	initialized bool
}

func (s *Server) mcpConn(id string) *mcpUpstreamConn {
	v, _ := s.mcpConns.LoadOrStore(id, &mcpUpstreamConn{})
	return v.(*mcpUpstreamConn)
}

// callUpstream performs a JSON-RPC request against an upstream, transparently
// initializing the session on first use and retrying once if the session was lost.
func (s *Server) callUpstream(ctx context.Context, up store.MCPUpstream, method string, params any) (json.RawMessage, error) {
	conn := s.mcpConn(up.ID)
	conn.mu.Lock()
	defer conn.mu.Unlock()
	if err := s.ensureUpstreamInit(ctx, up, conn); err != nil {
		return nil, err
	}
	res, err := s.rpcCall(ctx, up, conn, method, params)
	if err != nil {
		// session may have expired — re-initialize once and retry
		conn.initialized = false
		conn.sessionID = ""
		if ierr := s.ensureUpstreamInit(ctx, up, conn); ierr != nil {
			return nil, err
		}
		return s.rpcCall(ctx, up, conn, method, params)
	}
	return res, nil
}

func (s *Server) ensureUpstreamInit(ctx context.Context, up store.MCPUpstream, conn *mcpUpstreamConn) error {
	if conn.initialized {
		return nil
	}
	params := map[string]any{
		"protocolVersion": mcpProtocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "vibe-coders-mcp-gateway", "version": "1"},
	}
	if _, err := s.rpcCall(ctx, up, conn, "initialize", params); err != nil {
		return errMCPUpstreamRequestFailed
	}
	// notifications/initialized is a notification (no id, no response expected)
	_ = s.rpcNotify(ctx, up, conn, "notifications/initialized")
	conn.initialized = true
	return nil
}

func (s *Server) rpcCall(ctx context.Context, up store.MCPUpstream, conn *mcpUpstreamConn, method string, params any) (json.RawMessage, error) {
	resp, err := s.postRPC(ctx, up, conn, rpcRequest{JSONRPC: "2.0", ID: 1, Method: method, Params: params})
	if err != nil {
		return nil, err
	}
	if resp == nil {
		return nil, errMCPUpstreamRequestFailed
	}
	if resp.Error != nil {
		return nil, errMCPUpstreamRequestFailed
	}
	return resp.Result, nil
}

func (s *Server) rpcNotify(ctx context.Context, up store.MCPUpstream, conn *mcpUpstreamConn, method string) error {
	_, err := s.postRPC(ctx, up, conn, rpcRequest{JSONRPC: "2.0", Method: method})
	return err
}

// postRPC sends one JSON-RPC message and parses the response (application/json or
// text/event-stream). It captures/sends the Mcp-Session-Id header.
func (s *Server) postRPC(ctx context.Context, up store.MCPUpstream, conn *mcpUpstreamConn, msg rpcRequest) (*rpcResponse, error) {
	payload, err := json.Marshal(msg)
	if err != nil {
		return nil, errMCPUpstreamRequestFailed
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, up.URL, bytes.NewReader(payload))
	if err != nil {
		return nil, errMCPUpstreamRequestFailed
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", mcpProtocolVersion)
	if conn.sessionID != "" {
		req.Header.Set("Mcp-Session-Id", conn.sessionID)
	}
	if up.EncryptedAuth != "" {
		if token, derr := s.secrets.Load().Decrypt(up.EncryptedAuth); derr == nil && token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, errMCPUpstreamRequestFailed
	}
	defer resp.Body.Close()
	if sid := resp.Header.Get("Mcp-Session-Id"); sid != "" {
		conn.sessionID = sid
	}
	if resp.StatusCode >= 300 {
		// The body is untrusted and may echo credentials, request arguments, or the
		// upstream URL. Drain a bounded amount for connection reuse but never retain it.
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		return nil, errMCPUpstreamRequestFailed
	}
	// notification: server may answer 202 Accepted with no body
	if msg.ID == nil {
		return nil, nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, errMCPUpstreamRequestFailed
	}
	ct := resp.Header.Get("Content-Type")
	if strings.Contains(ct, "text/event-stream") {
		return parseSSEResponse(body)
	}
	var out rpcResponse
	if err := json.Unmarshal(bytes.TrimSpace(body), &out); err != nil {
		return nil, errMCPUpstreamRequestFailed
	}
	return &out, nil
}

// parseSSEResponse extracts the first JSON-RPC response from an SSE body. MCP
// Streamable HTTP may return the reply as one `data:` event.
func parseSSEResponse(body []byte) (*rpcResponse, error) {
	for _, block := range bytes.Split(body, []byte("\n\n")) {
		var data bytes.Buffer
		for _, line := range bytes.Split(block, []byte("\n")) {
			line = bytes.TrimRight(line, "\r")
			if bytes.HasPrefix(line, []byte("data:")) {
				data.Write(bytes.TrimSpace(line[len("data:"):]))
			}
		}
		if data.Len() == 0 {
			continue
		}
		var out rpcResponse
		if err := json.Unmarshal(data.Bytes(), &out); err == nil && (out.Result != nil || out.Error != nil) {
			return &out, nil
		}
	}
	return nil, errMCPUpstreamRequestFailed
}

// listUpstreamTools fetches and decodes an upstream's tools/list.
func (s *Server) listUpstreamTools(ctx context.Context, up store.MCPUpstream) ([]mcpToolDef, error) {
	res, err := s.callUpstream(ctx, up, "tools/list", map[string]any{})
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Tools []mcpToolDef `json:"tools"`
	}
	if err := json.Unmarshal(res, &parsed); err != nil {
		return nil, errMCPUpstreamRequestFailed
	}
	return parsed.Tools, nil
}

// mcpResource is one resource as advertised by an upstream.
type mcpResource struct {
	URI         string `json:"uri"`
	Name        string `json:"name,omitempty"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	MimeType    string `json:"mimeType,omitempty"`
}

// mcpPrompt is one prompt as advertised by an upstream.
type mcpPrompt struct {
	Name        string          `json:"name"`
	Title       string          `json:"title,omitempty"`
	Description string          `json:"description,omitempty"`
	Arguments   json.RawMessage `json:"arguments,omitempty"`
}

func (s *Server) listUpstreamResources(ctx context.Context, up store.MCPUpstream) ([]mcpResource, error) {
	res, err := s.callUpstream(ctx, up, "resources/list", map[string]any{})
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Resources []mcpResource `json:"resources"`
	}
	if err := json.Unmarshal(res, &parsed); err != nil {
		return nil, errMCPUpstreamRequestFailed
	}
	return parsed.Resources, nil
}

func (s *Server) listUpstreamResourceTemplates(ctx context.Context, up store.MCPUpstream) ([]json.RawMessage, error) {
	res, err := s.callUpstream(ctx, up, "resources/templates/list", map[string]any{})
	if err != nil {
		return nil, err
	}
	var parsed struct {
		ResourceTemplates []json.RawMessage `json:"resourceTemplates"`
	}
	if err := json.Unmarshal(res, &parsed); err != nil {
		return nil, errMCPUpstreamRequestFailed
	}
	return parsed.ResourceTemplates, nil
}

func (s *Server) listUpstreamPrompts(ctx context.Context, up store.MCPUpstream) ([]mcpPrompt, error) {
	res, err := s.callUpstream(ctx, up, "prompts/list", map[string]any{})
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Prompts []mcpPrompt `json:"prompts"`
	}
	if err := json.Unmarshal(res, &parsed); err != nil {
		return nil, errMCPUpstreamRequestFailed
	}
	return parsed.Prompts, nil
}
