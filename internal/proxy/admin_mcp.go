package proxy

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

func (s *Server) handleMCPTools(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	tools, err := s.db.ListMCPTools(r.Context(), mcpFilterFromQuery(r))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "mcp_tools_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tools": tools})
}

func (s *Server) handleMCPServers(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	servers, err := s.db.ListMCPServers(r.Context(), mcpFilterFromQuery(r))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "mcp_servers_failed")
		return
	}
	summary, err := s.db.MCPSummary(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "mcp_summary_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"servers": servers, "summary": summary})
}

// handleMCPRequests drills down to the requests that touched a given tool/server.
func (s *Server) handleMCPRequests(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	server := strings.TrimSpace(r.URL.Query().Get("server"))
	tool := strings.TrimSpace(r.URL.Query().Get("tool"))
	errorsOnly := r.URL.Query().Get("errors") == "1"
	limit := recentLimit(r)
	requests, err := s.db.RequestsForTool(r.Context(), server, tool, errorsOnly, limit)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "mcp_requests_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"requests": requests})
}

func mcpFilterFromQuery(r *http.Request) store.ToolFilter {
	f := store.ToolFilter{
		APIKeyID:    strings.TrimSpace(r.URL.Query().Get("api_key_id")),
		ServerLabel: strings.TrimSpace(r.URL.Query().Get("server")),
		MCPOnly:     r.URL.Query().Get("mcp_only") == "1",
	}
	if v := strings.TrimSpace(r.URL.Query().Get("limit")); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			f.Limit = n
		}
	}
	if window := strings.TrimSpace(r.URL.Query().Get("window")); window != "" {
		f.Since = parseWindow(window, 0, "day")
	}
	_ = time.Now
	return f
}
