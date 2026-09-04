package proxy

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"vibe-coders/internal/store"
)

// handleRequestLinks returns an operator-oriented link map for one request. It avoids
// raw prompt/response payloads and focuses on correlated artifacts across routing, MCP,
// Text2SQL, governance, and session views.
func (s *Server) handleRequestLinks(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	id, valid := adminTracePathID(r.URL.Path, "/admin/requests/", "/links")
	if !valid {
		writeOpenAIError(w, http.StatusBadRequest, "invalid request id", "invalid_request_error", "invalid_request_id")
		return
	}

	detail, err := s.db.RequestDetail(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "request not found", "invalid_request_error", "request_not_found")
			return
		}
		writeRequestLinksFailure(w, id, "request detail", err)
		return
	}
	if !s.canViewRequestDetail(r, detail.Request) {
		writeOpenAIError(w, http.StatusForbidden, "request is outside your team scope", "permission_error", "cross_team_access_denied")
		return
	}
	showRaw := s.canViewRawPrompts(r)
	rawProvider := detail.Request.Provider
	rawFallback := detail.Request.FallbackFrom
	s.maskRequestDetail(r, &detail)
	routing, routingFound, err := s.requestRoutingDecision(r.Context(), id)
	if err != nil {
		writeRequestLinksFailure(w, id, "routing decision", err)
		return
	}
	if routingFound && !showRaw {
		routing = projectRoutingDecisionProviderForExternal(routing, s.externalCredentialProjectionArgs()...)
	}
	mcpDecisions, err := s.db.MCPRouteDecisionsForRequest(r.Context(), id)
	if err != nil {
		writeRequestLinksFailure(w, id, "mcp route decisions", err)
		return
	}
	if !showRaw {
		projectMCPRouteDecisionsProviderForExternal(mcpDecisions, s.externalCredentialProjectionArgs(rawProvider, rawFallback)...)
	}

	mcpTools := 0
	toolErrors := 0
	for _, t := range detail.Tools {
		if t.IsMCP {
			mcpTools++
		}
		if t.IsError {
			toolErrors++
		}
	}
	governance := detail.Governance
	blocked := false
	for _, p := range governance.PolicyDecisions {
		if p.Decision == "block" || strings.HasPrefix(p.Decision, "deny_") {
			blocked = true
			break
		}
	}
	if !blocked {
		for _, a := range governance.Approvals {
			if a.Status == "pending" || a.Status == "rejected" || a.Status == "expired" {
				blocked = true
				break
			}
		}
	}
	if !blocked {
		for _, se := range governance.SecretEvents {
			if strings.EqualFold(se.Action, "block") {
				blocked = true
				break
			}
		}
	}

	escapedID := url.PathEscape(id)
	artifacts := map[string]any{
		"request_detail": "/admin/requests/" + escapedID,
		"explain":        "/admin/requests/" + escapedID + "/explain",
		"links":          "/admin/requests/" + escapedID + "/links",
		"ui_request":     "#/requests/" + escapedID,
	}
	if detail.Request.SessionID != "" {
		artifacts["waterfall"] = "/admin/waterfall?session_id=" + url.QueryEscape(detail.Request.SessionID)
		artifacts["ui_waterfall"] = "#/waterfall/" + url.PathEscape(detail.Request.SessionID)
	}
	if mcpTools > 0 || len(mcpDecisions) > 0 {
		artifacts["mcp_waterfall"] = "/admin/mcp/requests/" + escapedID + "/waterfall"
	}
	if len(detail.Text2SQLSpans) > 0 {
		artifacts["text2sql_spans"] = "/admin/text2sql/spans?request_id=" + url.QueryEscape(id)
	}
	if routingFound {
		artifacts["routing_decision"] = "/admin/routing/decisions/" + url.PathEscape(routing.ID)
	}
	effectivePolicyDecisions := effectivePolicyDecisionCount(governance.PolicyDecisions)

	writeJSON(w, http.StatusOK, map[string]any{
		"request_id": detail.Request.ID,
		"trace_id":   detail.Request.TraceID,
		"session_id": detail.Request.SessionID,
		"api_key_id": detail.Request.APIKeyID,
		"model":      detail.Request.Model,
		"provider":   detail.Request.Provider,
		"status":     detail.Request.StatusCode,
		"counts": map[string]any{
			"prompts":               len(detail.Prompts),
			"tools":                 len(detail.Tools),
			"mcp_tools":             mcpTools,
			"tool_errors":           toolErrors,
			"text2sql_spans":        len(detail.Text2SQLSpans),
			"evaluations":           len(detail.Evaluations),
			"feedback":              len(detail.Feedback),
			"secret_events":         len(governance.SecretEvents),
			"approvals":             len(governance.Approvals),
			"anomaly_events":        len(governance.AnomalyEvents),
			"policy_decisions":      effectivePolicyDecisions,
			"policy_decision_total": len(governance.PolicyDecisions),
			"mcp_route_decisions":   len(mcpDecisions),
		},
		"artifacts": artifacts,
		"routing": map[string]any{
			"found": routingFound,
			"decision": func() any {
				if routingFound {
					return routing
				}
				return nil
			}(),
		},
		"mcp": map[string]any{
			"tool_count":       mcpTools,
			"route_decisions":  mcpDecisions,
			"route_count":      len(mcpDecisions),
			"has_mcp_activity": mcpTools > 0 || len(mcpDecisions) > 0,
		},
		"text2sql":   explainText2SQL(detail.Text2SQLSpans),
		"governance": map[string]any{"blocked": blocked, "events": governance},
	})
}

func writeRequestLinksFailure(w http.ResponseWriter, requestID, operation string, err error) {
	slog.Error("request links query failed", "request_id", requestID, "operation", operation, "error", err)
	writeOpenAIError(w, http.StatusInternalServerError, "request links could not be loaded", "server_error", "request_links_failed")
}

func (s *Server) requestRoutingDecision(ctx context.Context, requestID string) (store.RoutingDecisionLog, bool, error) {
	decision, err := s.db.RoutingDecisionByRequestID(ctx, requestID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return store.RoutingDecisionLog{}, false, nil
		}
		return store.RoutingDecisionLog{}, false, err
	}
	return decision, true, nil
}
