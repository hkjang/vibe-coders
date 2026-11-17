package proxy

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"vibe-coders/internal/store"
)

type traceRelatedRun struct {
	RowKey           string   `json:"row_key"`
	ID               *string  `json:"id"`
	ResourceID       *string  `json:"resource_id"`
	ResourceName     *string  `json:"resource_name"`
	Status           string   `json:"status"`
	CreatedAt        *string  `json:"created_at"`
	LatencyMS        *int64   `json:"latency_ms"`
	CostKRW          *float64 `json:"cost_krw"`
	ReceiptAvailable bool     `json:"receipt_available"`
}
type traceRelatedRunPage struct {
	Version int               `json:"related_runs_version"`
	Kind    string            `json:"kind"`
	Items   []traceRelatedRun `json:"items"`
	Total   int64             `json:"total"`
	Limit   int               `json:"limit"`
	Offset  int               `json:"offset"`
}

// A metadata projection of the existing trace read. It never executes a run or
// reads its prompt, input, output, error text, hash or step definitions.
func (s *Server) handleTraceRelatedRuns(w http.ResponseWriter, r *http.Request, traceID string) {
	w.Header().Set("Cache-Control", "no-store")
	q, parseErr := url.ParseQuery(r.URL.RawQuery)
	invalid := func() {
		writeOpenAIError(w, http.StatusBadRequest, "invalid related run query", "invalid_request_error", "invalid_trace_run_query")
	}
	if parseErr != nil {
		invalid()
		return
	}
	for key, values := range q {
		if len(values) != 1 || (key != "kind" && key != "limit" && key != "offset") {
			invalid()
			return
		}
	}
	kind := q.Get("kind")
	if (kind != "workflow" && kind != "app") || len(traceID) > 1024 || !s.safeResourceSearchText(traceID) {
		invalid()
		return
	}
	limit, offset := 25, 0
	if q.Has("limit") {
		switch q.Get("limit") {
		case "25":
			limit = 25
		case "50":
			limit = 50
		case "100":
			limit = 100
		default:
			invalid()
			return
		}
	}
	if q.Has("offset") {
		raw := q.Get("offset")
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 || n > 1_000_000 || strconv.Itoa(n) != raw {
			invalid()
			return
		}
		offset = n
	}
	teams, scoped, err := requestTeamScopeForCallerChecked(s, r)
	if err != nil {
		writeTraceQueryFailed(w)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	rows, total, err := s.db.TraceRunPage(ctx, store.TraceRunQuery{TraceID: traceID, Kind: kind, Limit: limit, Offset: offset, Teams: teams, TeamScoped: scoped})
	if err != nil || total > appRequestMaxSafeInteger {
		writeTraceQueryFailed(w)
		return
	}
	safe := func(value string) *string {
		if !s.safeResourceSearchText(value) {
			return nil
		}
		return &value
	}
	result := traceRelatedRunPage{Version: 1, Kind: kind, Items: []traceRelatedRun{}, Total: total, Limit: limit, Offset: offset}
	caller, authenticated := s.currentAccessClaims(r)
	cipher := s.secrets.Load()
	for index, row := range rows {
		item := traceRelatedRun{RowKey: "run_" + cipher.OpaqueReference("trace-related-run", fmt.Sprintf("%s\x00%s\x00%s\x00%d", kind, traceID, row.ID, offset+index)), ID: safe(row.ID), ResourceID: safe(row.ResourceID), ResourceName: safe(row.ResourceName), Status: "unknown"}
		switch row.Status {
		case "ok", "error", "planned", "pending_approval", "condition_failed", "passed", "stopped", "skipped":
			item.Status = row.Status
		}
		if at, err := time.Parse(time.RFC3339Nano, row.CreatedAt); err == nil {
			text := at.UTC().Format(appRequestTimestampLayout)
			item.CreatedAt = &text
		}
		if row.LatencyMS >= 0 && row.LatencyMS <= appRequestMaxSafeInteger {
			value := row.LatencyMS
			item.LatencyMS = &value
		}
		if !math.IsNaN(row.CostKRW) && !math.IsInf(row.CostKRW, 0) && row.CostKRW >= 0 && row.CostKRW <= appRequestMaxCost {
			value := row.CostKRW
			item.CostKRW = &value
		}
		item.ReceiptAvailable = item.ID != nil && authenticated && strings.TrimSpace(caller.Subject) != "" && caller.Subject == row.OwnerID
		result.Items = append(result.Items, item)
	}
	writeJSON(w, http.StatusOK, result)
}
