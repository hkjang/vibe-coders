package proxy

import (
	"net/http"
	"sort"
	"time"

	"vibe-coders/internal/store"
)

// traceSpan is one normalized node of a request's end-to-end waterfall: the root request span plus
// child spans for each MCP/tool call and Text2SQL stage, sharing the request's trace_id. Offsets
// are relative to the request start; no raw prompt/SQL/args are included.
type traceSpan struct {
	SpanID        string  `json:"span_id"`
	ParentSpanID  string  `json:"parent_span_id"`
	Name          string  `json:"name"`
	Kind          string  `json:"kind"` // request | mcp_tool | tool | text2sql | cache
	Status        string  `json:"status"`
	StartOffsetMS int64   `json:"start_offset_ms"`
	DurationMS    int64   `json:"duration_ms"`
	Tokens        int64   `json:"tokens,omitempty"`
	CostKRW       float64 `json:"cost_krw,omitempty"`
	CacheHit      bool    `json:"cache_hit,omitempty"`
	Error         string  `json:"error,omitempty"`
}

type requestTrace struct {
	RequestID string      `json:"request_id"`
	TraceID   string      `json:"trace_id"`
	TotalMS   int64       `json:"total_ms"`
	Spans     []traceSpan `json:"spans"`
}

// handleRequestTrace returns the unified waterfall for one request, assembled from already-linked
// data (request_logs + tool_invocations + text2sql_spans) keyed by request_id/trace_id.
// GET /admin/requests/{id}/trace
func (s *Server) handleRequestTrace(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	id, valid := adminTracePathID(r.URL.Path, "/admin/requests/", "/trace")
	if !valid {
		writeOpenAIError(w, http.StatusBadRequest, "invalid request id", "invalid_request_error", "invalid_request_id")
		return
	}
	detail, err := s.db.RequestDetail(r.Context(), id)
	if err != nil {
		if err == store.ErrNotFound {
			writeOpenAIError(w, http.StatusNotFound, "request not found", "invalid_request_error", "not_found")
			return
		}
		writeOpenAIError(w, http.StatusInternalServerError, "request trace query failed", "server_error", "trace_failed")
		return
	}
	if !s.canViewRequestDetail(r, detail.Request) {
		writeOpenAIError(w, http.StatusForbidden, "request is outside your team scope", "permission_error", "cross_team_access_denied")
		return
	}
	s.maskRequestDetail(r, &detail)
	writeJSON(w, http.StatusOK, buildRequestTrace(detail))
}

// buildRequestTrace assembles the waterfall purely from RequestDetail (no DB) so it is unit-testable.
func buildRequestTrace(d store.RequestDetail) requestTrace {
	req := d.Request
	reqStart, _ := time.Parse(time.RFC3339Nano, req.CreatedAt)
	offset := func(t time.Time) int64 {
		if reqStart.IsZero() || t.IsZero() {
			return 0
		}
		ms := t.Sub(reqStart).Milliseconds()
		if ms < 0 {
			return 0
		}
		return ms
	}

	rootID := "span:req:" + req.ID
	rootStatus := "ok"
	if req.StatusCode >= 400 || req.Error != "" {
		rootStatus = "error"
	}
	spans := []traceSpan{{
		SpanID: rootID, Name: firstNonEmpty(req.Model, req.Endpoint, "request"), Kind: "request",
		Status: rootStatus, StartOffsetMS: 0, DurationMS: req.LatencyMS,
		Tokens: int64(req.TotalTokens), CostKRW: req.EstimatedCost,
		CacheHit: req.Provider == "cache" || req.CachedTokens > 0, Error: req.Error,
	}}

	// Text2SQL stages (have their own latency + cost).
	for _, sp := range d.Text2SQLSpans {
		st := sp.Status
		if st == "" {
			st = "ok"
		}
		spans = append(spans, traceSpan{
			SpanID: "span:t2s:" + sp.ID, ParentSpanID: rootID, Name: "text2sql:" + sp.Stage, Kind: "text2sql",
			Status: st, StartOffsetMS: offset(sp.CreatedAt), DurationMS: sp.LatencyMS, CostKRW: sp.CostKRW,
			Error: sp.RejectReason,
		})
	}

	// MCP/tool calls (only the actual calls, not definitions/results). No per-call latency is
	// recorded yet, so they render as point markers ordered by time.
	for _, t := range d.Tools {
		if t.Source != "call" {
			continue
		}
		name := t.ToolName
		if t.ServerLabel != "" {
			name = t.ServerLabel + "." + t.ToolName
		}
		kind := "tool"
		if t.IsMCP {
			kind = "mcp_tool"
		}
		status := "ok"
		if t.IsError {
			status = "error"
		}
		spans = append(spans, traceSpan{
			SpanID: "span:tool:" + t.ID, ParentSpanID: rootID, Name: name, Kind: kind,
			Status: status, StartOffsetMS: offset(t.CreatedAt), DurationMS: 0,
		})
	}

	// Children sorted by start; root stays first.
	children := spans[1:]
	sort.SliceStable(children, func(i, j int) bool { return children[i].StartOffsetMS < children[j].StartOffsetMS })

	total := req.LatencyMS
	for _, sp := range spans {
		if end := sp.StartOffsetMS + sp.DurationMS; end > total {
			total = end
		}
	}
	return requestTrace{RequestID: req.ID, TraceID: req.TraceID, TotalMS: total, Spans: spans}
}
