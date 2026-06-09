package proxy

import (
	"encoding/json"
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

var validMCPModes = map[string]bool{"allow": true, "block": true, "warn": true}

// handleMCPPolicies lists/creates MCP server policies and toggles allowlist mode.
func (s *Server) handleMCPPolicies(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		policies, err := s.db.ListMCPPolicies(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "mcp_policies_failed")
			return
		}
		allowlist := false
		if flag, found, err := s.db.GetFlag(r.Context(), "mcp_allowlist_enabled"); err == nil && found {
			allowlist = strings.EqualFold(strings.TrimSpace(flag.Value), "true") || flag.Value == "1"
		}
		writeJSON(w, http.StatusOK, map[string]any{"policies": policies, "allowlist_enabled": allowlist})
	case http.MethodPost:
		var payload struct {
			ServerLabel      string `json:"server_label"`
			Mode             string `json:"mode"`
			Note             string `json:"note"`
			AllowlistEnabled *bool  `json:"allowlist_enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		// allowlist toggle only
		if payload.AllowlistEnabled != nil && strings.TrimSpace(payload.ServerLabel) == "" {
			flag := store.RuntimeFlag{Key: "mcp_allowlist_enabled", Value: boolStr(*payload.AllowlistEnabled), UpdatedBy: adminID(r)}
			if err := s.db.SetFlag(r.Context(), flag); err != nil {
				writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "mcp_allowlist_failed")
				return
			}
			s.invalidateMCPPolicyCache()
			s.auditAdmin(r, "mcp.allowlist", "", auditJSON(map[string]any{"enabled": *payload.AllowlistEnabled}))
			writeJSON(w, http.StatusOK, map[string]any{"allowlist_enabled": *payload.AllowlistEnabled})
			return
		}
		payload.ServerLabel = strings.TrimSpace(payload.ServerLabel)
		payload.Mode = strings.TrimSpace(payload.Mode)
		if payload.ServerLabel == "" {
			writeOpenAIError(w, http.StatusBadRequest, "server_label is required", "invalid_request_error", "missing_server")
			return
		}
		if !validMCPModes[payload.Mode] {
			writeOpenAIError(w, http.StatusBadRequest, "mode must be allow/block/warn", "invalid_request_error", "invalid_mode")
			return
		}
		policy := store.MCPPolicy{ServerLabel: payload.ServerLabel, Mode: payload.Mode, Note: strings.TrimSpace(payload.Note)}
		if err := s.db.UpsertMCPPolicy(r.Context(), policy); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "mcp_policy_save_failed")
			return
		}
		s.invalidateMCPPolicyCache()
		s.auditAdmin(r, "mcp.policy.upsert", "", auditJSON(policy))
		writeJSON(w, http.StatusCreated, map[string]any{"policy": policy})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) handleMCPPolicyByServer(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	server := strings.TrimPrefix(r.URL.Path, "/admin/mcp/policies/")
	if server == "" || strings.Contains(server, "/") {
		writeOpenAIError(w, http.StatusBadRequest, "invalid server label", "invalid_request_error", "invalid_server")
		return
	}
	if r.Method != http.MethodDelete {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if err := s.db.DeleteMCPPolicy(r.Context(), server); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "mcp_policy_delete_failed")
		return
	}
	s.invalidateMCPPolicyCache()
	s.auditAdmin(r, "mcp.policy.delete", auditJSON(map[string]string{"server_label": server}), "")
	writeJSON(w, http.StatusOK, map[string]string{"server_label": server, "status": "deleted"})
}

// handleMCPCatalog lists the observed per-server tool catalog, flagging tools that
// appeared recently (drift / supply-chain change) or went stale.
func (s *Server) handleMCPCatalog(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	server := strings.TrimSpace(r.URL.Query().Get("server"))
	newWindow := 24 * time.Hour
	if v := strings.TrimSpace(r.URL.Query().Get("new_window")); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			newWindow = d
		}
	}
	staleWindow := 30 * 24 * time.Hour
	entries, err := s.db.MCPCatalog(r.Context(), server, newWindow, staleWindow)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "mcp_catalog_failed")
		return
	}
	newCount := 0
	for _, e := range entries {
		if e.IsNew {
			newCount++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"catalog": entries, "new_count": newCount})
}

// handleMCPLoops surfaces sessions where one tool was called many times (agent loop).
func (s *Server) handleMCPLoops(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	threshold := 10
	if v := strings.TrimSpace(r.URL.Query().Get("threshold")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			threshold = n
		}
	}
	since := parseWindow(r.URL.Query().Get("window"), 24*time.Hour, "day")
	loops, err := s.db.SessionToolLoops(r.Context(), since, threshold, recentLimit(r))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "mcp_loops_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"loops": loops, "threshold": threshold})
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
