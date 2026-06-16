package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

// requestFactDDL is the per-request fact table (detailed behavioral DW). ReplacingMergeTree
// keyed on request_id makes re-sends idempotent (last ingested_at wins on merge).
const requestFactDDL = `CREATE TABLE IF NOT EXISTS %s (
	event_date Date,
	event_time DateTime64(3),
	request_id String,
	trace_id String,
	session_id String,
	api_key_id String,
	team LowCardinality(String),
	endpoint LowCardinality(String),
	provider LowCardinality(String),
	model LowCardinality(String),
	requested_model LowCardinality(String),
	stream UInt8,
	status_code UInt16,
	error_category LowCardinality(String),
	latency_ms Int64,
	first_chunk_ms Int64,
	prompt_tokens UInt32,
	completion_tokens UInt32,
	cached_tokens UInt32,
	reasoning_tokens UInt32,
	total_tokens UInt32,
	cost_krw Float64,
	currency LowCardinality(String),
	repo String,
	branch String,
	project LowCardinality(String),
	service LowCardinality(String),
	cost_center LowCardinality(String),
	task_type LowCardinality(String),
	prompt_name LowCardinality(String),
	prompt_version LowCardinality(String),
	prompt_fingerprint String,
	tool_count UInt16,
	failover UInt8,
	fallback_from LowCardinality(String),
	fallback_reason String,
	route_reason LowCardinality(String),
	route_detail String,
	complexity_score UInt8,
	language_top LowCardinality(String),
	client_ip_hash String,
	request_hash String,
	ingested_at DateTime64(3)
) ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_date, team, provider, model, request_id)`

// insertJSONEachRow ships rows to a ClickHouse table via the HTTP interface as JSONEachRow.
// best_effort lets RFC3339 timestamps parse into DateTime columns; skip_unknown_fields keeps
// older table schemas accepting payloads after new columns are added. Returns the raw body
// that was sent (for retry persistence) and the row count.
func insertJSONEachRow(ctx context.Context, client *http.Client, cfg config.ClickHouseConfig, table string, rows []map[string]any) (string, int, error) {
	if cfg.URL == "" || table == "" || len(rows) == 0 {
		return "", 0, nil
	}
	ref := table
	if cfg.Database != "" && !strings.Contains(table, ".") {
		ref = cfg.Database + "." + table
	}
	var body bytes.Buffer
	for _, row := range rows {
		line, err := json.Marshal(row)
		if err != nil {
			return "", 0, err
		}
		body.Write(line)
		body.WriteByte('\n')
	}
	payload := body.String()
	q := "INSERT INTO " + ref + " FORMAT JSONEachRow"
	endpoint := cfg.URL + "/?query=" + url.QueryEscape(q) + "&date_time_input_format=best_effort&input_format_skip_unknown_fields=1"
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(payload))
	if err != nil {
		return payload, 0, err
	}
	req.Header.Set("Content-Type", "application/x-ndjson")
	if cfg.User != "" {
		req.Header.Set("X-ClickHouse-User", cfg.User)
		req.Header.Set("X-ClickHouse-Key", cfg.Password)
	}
	resp, err := client.Do(req)
	if err != nil {
		return payload, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return payload, 0, fmt.Errorf("clickhouse insert failed: status %d", resp.StatusCode)
	}
	return payload, len(rows), nil
}

// requestFactRow flattens a completed request into one ai_request_fact row. Privacy: the
// client IP is hashed and no raw prompt/response text is included — only hashes/features.
func requestFactRow(rec store.LogRecord) map[string]any {
	r := rec.Request
	ts := r.CreatedAt.UTC()
	if ts.IsZero() {
		ts = time.Now().UTC()
	}
	var promptTokens, completionTokens, cachedTokens, reasoningTokens, totalTokens int
	var cost float64
	currency := "KRW"
	if rec.Usage != nil {
		promptTokens, completionTokens = rec.Usage.PromptTokens, rec.Usage.CompletionTokens
		cachedTokens, reasoningTokens, totalTokens = rec.Usage.CachedTokens, rec.Usage.ReasoningTokens, rec.Usage.TotalTokens
		cost = rec.Usage.EstimatedCost
		if rec.Usage.Currency != "" {
			currency = rec.Usage.Currency
		}
	}
	langTop := ""
	if len(rec.Languages) > 0 {
		langTop = rec.Languages[0].Language
	}
	ipHash := ""
	if r.ClientIP != "" {
		ipHash = audit.HashText(r.ClientIP)[:16]
	}
	b2i := func(b bool) int {
		if b {
			return 1
		}
		return 0
	}
	return map[string]any{
		"event_date":        ts.Format("2006-01-02"),
		"event_time":        ts.Format(time.RFC3339Nano),
		"request_id":        r.ID,
		"trace_id":          r.TraceID,
		"session_id":        r.SessionID,
		"api_key_id":        r.APIKeyID,
		"team":              "", // resolved at query time via api_key; kept blank to avoid a join here
		"endpoint":          r.Endpoint,
		"provider":          r.Provider,
		"model":             r.Model,
		"requested_model":   r.RequestedModel,
		"stream":            b2i(r.Stream),
		"status_code":       r.StatusCode,
		"error_category":    errorCategory(r.StatusCode, r.Error),
		"latency_ms":        r.LatencyMS,
		"first_chunk_ms":    r.FirstChunkMS,
		"prompt_tokens":     promptTokens,
		"completion_tokens": completionTokens,
		"cached_tokens":     cachedTokens,
		"reasoning_tokens":  reasoningTokens,
		"total_tokens":      totalTokens,
		"cost_krw":          cost,
		"currency":          currency,
		"repo":              r.Repo,
		"branch":            r.Branch,
		"project":           r.Project,
		"service":           r.Service,
		"cost_center":       r.CostCenter,
		"task_type":         r.TaskType,
		"prompt_name":       r.PromptName,
		"prompt_version":    r.PromptVersion,
		"prompt_fingerprint": r.PromptFingerprint,
		"tool_count":        r.ToolCount,
		"failover":          b2i(r.Failover),
		"fallback_from":     r.FallbackFrom,
		"fallback_reason":   r.FallbackReason,
		"route_reason":      r.RouteReason,
		"route_detail":      r.RouteDetail,
		"complexity_score":  r.Complexity,
		"language_top":      langTop,
		"client_ip_hash":    ipHash,
		"request_hash":      r.RequestHash,
		"ingested_at":       time.Now().UTC().Format(time.RFC3339Nano),
	}
}

// handleClickHouseFactRetry replays persisted failed fact batches by re-POSTing the stored
// JSONEachRow payload; rows that land are cleared from the retry queue.
// POST /admin/dw/clickhouse/fact-retry[?table=ai_request_fact]
func (s *Server) handleClickHouseFactRetry(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	cfg := s.chConf()
	if cfg.URL == "" {
		writeOpenAIError(w, http.StatusBadRequest, "ClickHouse is not configured", "invalid_request_error", "no_clickhouse")
		return
	}
	table := strings.TrimSpace(r.URL.Query().Get("table"))
	batches, err := s.db.ListClickHouseFactRetries(r.Context(), table, 500)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "fact_retry_failed")
		return
	}
	recovered, rows := 0, 0
	failed := 0
	for _, b := range batches {
		ref := b.TableName
		if cfg.Database != "" && !strings.Contains(ref, ".") {
			ref = cfg.Database + "." + ref
		}
		q := "INSERT INTO " + ref + " FORMAT JSONEachRow"
		endpoint := cfg.URL + "/?query=" + url.QueryEscape(q) + "&date_time_input_format=best_effort&input_format_skip_unknown_fields=1"
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(b.Payload))
		req.Header.Set("Content-Type", "application/x-ndjson")
		if cfg.User != "" {
			req.Header.Set("X-ClickHouse-User", cfg.User)
			req.Header.Set("X-ClickHouse-Key", cfg.Password)
		}
		resp, derr := s.client.Do(req)
		cancel()
		if derr != nil || resp.StatusCode >= 300 {
			failed++
			if resp != nil {
				resp.Body.Close()
			}
			continue
		}
		resp.Body.Close()
		_ = s.db.DeleteClickHouseFactRetry(r.Context(), b.ID)
		recovered++
		rows += b.Rows
	}
	s.auditAdmin(r, "dw.clickhouse.fact_retry", table, auditJSON(map[string]any{"recovered": recovered, "rows": rows, "failed": failed}))
	writeJSON(w, http.StatusOK, map[string]any{"recovered_batches": recovered, "rows": rows, "still_failing": failed})
}

// errorCategory buckets a request outcome for fast filtering.
func errorCategory(status int, errMsg string) string {
	switch {
	case status >= 500:
		return "5xx"
	case status == 429:
		return "rate_limited"
	case status >= 400:
		return "4xx"
	case errMsg != "":
		return "error"
	default:
		return "ok"
	}
}

// enqueueClickHouseFact offers a completed request to the async fact queue. Non-blocking:
// when the request-fact sink is disabled it is a no-op, and when the queue is full the row
// is dropped (counted) so request handling is never blocked by ClickHouse.
func (s *Server) enqueueClickHouseFact(rec store.LogRecord) {
	if s.chFactQueue == nil {
		return
	}
	ch := s.chConf()
	if ch.URL == "" || strings.TrimSpace(ch.RequestFactTable) == "" {
		return
	}
	if strings.TrimSpace(rec.Request.ID) == "" {
		return
	}
	select {
	case s.chFactQueue <- rec:
	default:
		s.chFactDropped.Add(1)
	}
}

// clickhouseFactLoop batches queued requests and flushes them to the request-fact table on
// a size or time trigger. A failed flush is persisted to clickhouse_fact_retry for replay.
func (s *Server) clickhouseFactLoop(parent context.Context) {
	buf := make([]store.LogRecord, 0, 256)
	flush := func() {
		if len(buf) == 0 {
			return
		}
		ch := s.chConf()
		table := strings.TrimSpace(ch.RequestFactTable)
		if ch.URL == "" || table == "" {
			buf = buf[:0]
			return
		}
		rows := make([]map[string]any, 0, len(buf))
		for _, rec := range buf {
			rows = append(rows, requestFactRow(rec))
		}
		ctx, cancel := context.WithTimeout(parent, 45*time.Second)
		payload, n, err := insertJSONEachRow(ctx, s.client, ch, table, rows)
		cancel()
		if err != nil {
			slog.Warn("clickhouse request-fact flush failed", "rows", len(rows), "error", err)
			_ = s.db.RecordClickHouseFactRetry(parent, table, payload, len(rows), err.Error())
		}
		_ = n
		buf = buf[:0]
	}

	interval := s.chConf().FlushInterval
	if interval <= 0 {
		interval = 5 * time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-parent.Done():
			flush()
			return
		case rec := <-s.chFactQueue:
			buf = append(buf, rec)
			batch := s.chConf().BatchSize
			if batch <= 0 {
				batch = 200
			}
			if len(buf) >= batch {
				flush()
			}
		case <-t.C:
			flush()
		}
	}
}
