package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

// clickhouseSink pushes daily rollup rows to ClickHouse via its HTTP interface as
// JSONEachRow. ClickHouse de-duplicates by (day, dimension, dim_value) when the
// target table uses a ReplacingMergeTree, so re-sending a backfilled window is safe.
// Returns the number of rows sent.
func clickhouseSink(ctx context.Context, client *http.Client, cfg config.ClickHouseConfig, rows []store.AnalyticsRollupRow) (int, error) {
	if cfg.URL == "" {
		return 0, fmt.Errorf("clickhouse URL not configured")
	}
	if len(rows) == 0 {
		return 0, nil
	}
	var body bytes.Buffer
	for _, row := range rows {
		line, err := json.Marshal(map[string]any{
			"day":       row.Day,
			"dimension": row.Dimension,
			"dim_value": row.DimValue,
			"requests":  row.Requests,
			"tokens":    row.Tokens,
			"cost_krw":  row.CostKRW,
			"errors":    row.Errors,
		})
		if err != nil {
			return 0, err
		}
		body.Write(line)
		body.WriteByte('\n')
	}

	table := cfg.Table
	if cfg.Database != "" {
		table = cfg.Database + "." + cfg.Table
	}
	q := "INSERT INTO " + table + " FORMAT JSONEachRow"
	endpoint := cfg.URL + "/?query=" + url.QueryEscape(q)

	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, &body)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/x-ndjson")
	if cfg.User != "" {
		req.Header.Set("X-ClickHouse-User", cfg.User)
		req.Header.Set("X-ClickHouse-Key", cfg.Password)
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return 0, fmt.Errorf("clickhouse insert failed: status %d", resp.StatusCode)
	}
	return len(rows), nil
}

// clickhouseText2SQLFactSink ships per-query Text2SQL facts (masked — no raw question
// or SQL text, only a length and the governance/outcome columns) to a detailed fact
// table for long-term, row-level analysis. Returns rows sent.
func clickhouseText2SQLFactSink(ctx context.Context, client *http.Client, cfg config.ClickHouseConfig, logs []store.Text2SQLQueryLog) (int, error) {
	if cfg.URL == "" || cfg.Text2SQLFactTable == "" || len(logs) == 0 {
		return 0, nil
	}
	var body bytes.Buffer
	for _, l := range logs {
		line, err := json.Marshal(map[string]any{
			"ts":               l.CreatedAt.UTC().Format(time.RFC3339),
			"request_id":       l.RequestID,
			"team":             l.Team,
			"virtual_model":    l.VirtualModel,
			"upstream_model":   l.UpstreamModel,
			"mode":             l.Mode,
			"schema_name":      l.SchemaName,
			"schema_version":   l.SchemaVersion,
			"valid":            boolToInt(l.Valid),
			"executed":         boolToInt(l.Executed),
			"row_count":        l.RowCount,
			"explain_risk":     l.ExplainRisk,
			"cost_krw":         l.CostKRW,
			"generation_cost":  l.GenerationCost,
			"summary_cost":     l.SummaryCost,
			"latency_ms":       l.LatencyMS,
			"failure_category": l.FailureCategory,
			"question_chars":   len([]rune(l.Question)),
			"reject_reason":    l.RejectReason,
			"sql_hash":         text2sqlSQLHash(l.GeneratedSQL),
		})
		if err != nil {
			return 0, err
		}
		body.Write(line)
		body.WriteByte('\n')
	}
	table := cfg.Text2SQLFactTable
	if cfg.Database != "" && !strings.Contains(table, ".") {
		table = cfg.Database + "." + table
	}
	q := "INSERT INTO " + table + " FORMAT JSONEachRow"
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	// best_effort lets ClickHouse parse the RFC3339 ts (e.g. 2026-06-16T03:15:56Z) into a
	// DateTime/DateTime64 column without a separate transform.
	endpoint := cfg.URL + "/?query=" + url.QueryEscape(q) + "&date_time_input_format=best_effort"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, &body)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/x-ndjson")
	if cfg.User != "" {
		req.Header.Set("X-ClickHouse-User", cfg.User)
		req.Header.Set("X-ClickHouse-Key", cfg.Password)
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return 0, fmt.Errorf("clickhouse fact insert failed: status %d", resp.StatusCode)
	}
	return len(logs), nil
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// syncText2SQLFacts ships Text2SQL facts created since the stored watermark; first run
// backfills the last 7 days. Advances the "text2sql_fact" watermark on success.
func (s *Server) syncText2SQLFacts(ctx context.Context) (int, error) {
	cfg := s.chConf()
	if cfg.URL == "" || cfg.Text2SQLFactTable == "" {
		return 0, nil
	}
	since := time.Now().UTC().AddDate(0, 0, -7)
	if states, err := s.db.ListClickHouseSinkState(ctx); err == nil {
		for _, st := range states {
			if st.Dimension == "text2sql_fact" && st.LastSyncedDay != "" {
				if t, perr := time.Parse(time.RFC3339Nano, st.LastSyncedDay); perr == nil {
					since = t
				}
			}
		}
	}
	logs, err := s.db.ListText2SQLLogsSince(ctx, since, 5000)
	if err != nil {
		_ = s.db.RecordClickHouseSinkFailure(ctx, "text2sql_fact", since.Format("2006-01-02"), "log read: "+err.Error())
		return 0, err
	}
	if len(logs) == 0 {
		return 0, nil
	}
	n, err := clickhouseText2SQLFactSink(ctx, s.client, cfg, logs)
	if err != nil {
		_ = s.db.RecordClickHouseSinkFailure(ctx, "text2sql_fact", since.Format("2006-01-02"), err.Error())
		return 0, err
	}
	maxTS := logs[len(logs)-1].CreatedAt.UTC().Format(time.RFC3339Nano)
	_ = s.db.RecordClickHouseSinkSuccess(ctx, "text2sql_fact", maxTS, int64(n))
	return n, nil
}

// dwDimensions is the set of rollup dimensions shipped to ClickHouse.
var dwDimensions = []string{"all", "model", "provider", "project", "cost_center"}

// syncClickHouseDimension ships one dimension's daily rollups since sinceDay and
// records the outcome: a watermark on success, or a persisted retry entry on failure.
func (s *Server) syncClickHouseDimension(ctx context.Context, dim, sinceDay string) (int, error) {
	rows, err := s.db.ListDailyRollups(ctx, dim, sinceDay, 5000)
	if err != nil {
		_ = s.db.RecordClickHouseSinkFailure(ctx, dim, sinceDay, "rollup read: "+err.Error())
		return 0, err
	}
	n, err := clickhouseSink(ctx, s.client, s.chConf(), rows)
	if err != nil {
		_ = s.db.RecordClickHouseSinkFailure(ctx, dim, sinceDay, err.Error())
		return 0, err
	}
	_ = s.db.RecordClickHouseSinkSuccess(ctx, dim, sinceDay, int64(n))
	return n, nil
}

// handleClickHouseSink rolls up the last N days and ships every dimension's daily
// aggregates to ClickHouse for long-term analysis.
// POST /admin/dw/clickhouse?days=30
func (s *Server) handleClickHouseSink(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if s.chConf().URL == "" {
		writeOpenAIError(w, http.StatusBadRequest, "ClickHouse is not configured (CLICKHOUSE_URL)", "invalid_request_error", "no_clickhouse")
		return
	}
	days := 30
	if v := strings.TrimSpace(r.URL.Query().Get("days")); v != "" {
		if n := atoiDefault(v, 30); n > 0 && n <= 365 {
			days = n
		}
	}
	now := time.Now().UTC()
	since := now.AddDate(0, 0, -days)
	sinceDay := since.Format("2006-01-02")
	// Recompute the local daily rollups for the window first, so a manual sink ships current
	// data even when the periodic rollup worker hasn't run yet (otherwise it would read an
	// empty/stale daily_rollups table and report 0 rows despite live traffic).
	if _, err := s.db.RollupRange(r.Context(), since, now); err != nil {
		slog.Warn("clickhouse manual sink rollup failed", "error", err)
	}
	total := 0
	failed := map[string]string{}
	for _, dim := range dwDimensions {
		n, err := s.syncClickHouseDimension(r.Context(), dim, sinceDay)
		if err != nil {
			failed[dim] = err.Error()
			continue
		}
		total += n
	}
	s.auditAdmin(r, "dw.clickhouse.sink", "", auditJSON(map[string]any{"days": days, "rows": total, "failed": failed}))
	if len(failed) > 0 {
		// Partial success: report what landed and what was queued for retry.
		writeJSON(w, http.StatusBadGateway, map[string]any{"sent_rows": total, "since": sinceDay, "failed": failed, "queued_for_retry": true})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sent_rows": total, "since": sinceDay})
}

// handleClickHouseSinkStatus reports per-dimension watermarks and the pending retry
// queue, so operators can see how far each dimension has shipped.
// GET /admin/dw/sink-status
func (s *Server) handleClickHouseSinkStatus(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	state, err := s.db.ListClickHouseSinkState(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "sink_state_failed")
		return
	}
	retries, err := s.db.ListClickHouseSinkRetries(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "sink_retry_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"state": state, "retries": retries, "configured": s.chConf().URL != ""})
}

// handleClickHouseSinkRetry reprocesses the pending retry queue (or all dimensions
// when ?all=1), clearing entries that now succeed.
// POST /admin/dw/sink-retry[?all=1]
func (s *Server) handleClickHouseSinkRetry(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if s.chConf().URL == "" {
		writeOpenAIError(w, http.StatusBadRequest, "ClickHouse is not configured (CLICKHOUSE_URL)", "invalid_request_error", "no_clickhouse")
		return
	}
	type job struct{ dim, since string }
	var jobs []job
	if r.URL.Query().Get("all") == "1" {
		days := s.chConf().SinkDays
		if days <= 0 {
			days = 3
		}
		sinceDay := time.Now().UTC().AddDate(0, 0, -days).Format("2006-01-02")
		for _, dim := range dwDimensions {
			jobs = append(jobs, job{dim, sinceDay})
		}
	} else {
		retries, err := s.db.ListClickHouseSinkRetries(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "sink_retry_failed")
			return
		}
		for _, rt := range retries {
			jobs = append(jobs, job{rt.Dimension, rt.SinceDay})
		}
	}
	total, recovered := 0, 0
	failed := map[string]string{}
	for _, j := range jobs {
		n, err := s.syncClickHouseDimension(r.Context(), j.dim, j.since)
		if err != nil {
			failed[j.dim] = err.Error()
			continue
		}
		total += n
		recovered++
	}
	s.auditAdmin(r, "dw.clickhouse.retry", "", auditJSON(map[string]any{"recovered": recovered, "rows": total, "failed": failed}))
	writeJSON(w, http.StatusOK, map[string]any{"recovered_dimensions": recovered, "sent_rows": total, "failed": failed})
}

// clickhouseAggregate queries ClickHouse for the summed metrics of a dimension since
// sinceDay, used for consistency verification against the local ledger.
func clickhouseAggregate(ctx context.Context, client *http.Client, cfg config.ClickHouseConfig, sinceDay string, dimension string) (requests, tokens int64, cost float64, err error) {
	if dimension == "" {
		dimension = "all"
	}
	table := cfg.Table
	if cfg.Database != "" {
		table = cfg.Database + "." + cfg.Table
	}
	q := fmt.Sprintf("SELECT sum(requests), sum(tokens), sum(cost_krw) FROM %s WHERE dimension='%s' AND day >= '%s' FORMAT TabSeparated", table, dimension, sinceDay)
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cfg.URL+"/?query="+url.QueryEscape(q), nil)
	if err != nil {
		return 0, 0, 0, err
	}
	if cfg.User != "" {
		req.Header.Set("X-ClickHouse-User", cfg.User)
		req.Header.Set("X-ClickHouse-Key", cfg.Password)
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, 0, 0, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return 0, 0, 0, fmt.Errorf("clickhouse query failed: status %d", resp.StatusCode)
	}
	fields := strings.Fields(strings.TrimSpace(string(body)))
	if len(fields) < 3 {
		return 0, 0, 0, fmt.Errorf("unexpected clickhouse response: %q", string(body))
	}
	requests = parseInt64(fields[0])
	tokens = parseInt64(fields[1])
	cost, _ = parseFloat(fields[2])
	return requests, tokens, cost, nil
}

// handleClickHouseConsistency compares the local rollup ledger (dimension "all")
// against ClickHouse aggregates over a window and reports the differences.
// GET /admin/dw/consistency?days=30
func (s *Server) handleClickHouseConsistency(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if s.chConf().URL == "" {
		writeOpenAIError(w, http.StatusBadRequest, "ClickHouse is not configured", "invalid_request_error", "no_clickhouse")
		return
	}
	days := 30
	if v := strings.TrimSpace(r.URL.Query().Get("days")); v != "" {
		if n := atoiDefault(v, 30); n > 0 && n <= 365 {
			days = n
		}
	}
	sinceDay := time.Now().UTC().AddDate(0, 0, -days).Format("2006-01-02")
	// Compare the local ledger against ClickHouse per dimension, not just "all", so a
	// drift isolated to one dimension (e.g. project) is caught.
	dims := dwDimensions
	if d := strings.TrimSpace(r.URL.Query().Get("dimension")); d != "" {
		dims = []string{d}
	}
	perDim := make([]map[string]any, 0, len(dims))
	allConsistent := true
	for _, dim := range dims {
		local, err := s.db.ListDailyRollups(r.Context(), dim, sinceDay, 5000)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "rollups_failed")
			return
		}
		var lReq, lTok int64
		var lCost float64
		for _, row := range local {
			lReq += row.Requests
			lTok += row.Tokens
			lCost += row.CostKRW
		}
		chReq, chTok, chCost, err := clickhouseAggregate(r.Context(), s.client, s.chConf(), sinceDay, dim)
		if err != nil {
			writeOpenAIError(w, http.StatusBadGateway, "clickhouse query failed: "+err.Error(), "server_error", "clickhouse_failed")
			return
		}
		consistent := lReq == chReq && lTok == chTok
		if !consistent {
			allConsistent = false
		}
		perDim = append(perDim, map[string]any{
			"dimension":  dim,
			"consistent": consistent,
			"postgres":   map[string]any{"requests": lReq, "tokens": lTok, "cost_krw": lCost},
			"clickhouse": map[string]any{"requests": chReq, "tokens": chTok, "cost_krw": chCost},
			"diff":       map[string]any{"requests": lReq - chReq, "tokens": lTok - chTok, "cost_krw": lCost - chCost},
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"since":      sinceDay,
		"consistent": allConsistent,
		"dimensions": perDim,
	})
}

// handleClickHouseText2SQLFact manually ships pending Text2SQL facts to the configured
// fact table (incremental from the watermark).
// POST /admin/dw/text2sql-fact
func (s *Server) handleClickHouseText2SQLFact(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if s.chConf().URL == "" || s.chConf().Text2SQLFactTable == "" {
		writeOpenAIError(w, http.StatusBadRequest, "fact sink not configured (CLICKHOUSE_URL + CLICKHOUSE_TEXT2SQL_FACT_TABLE)", "invalid_request_error", "no_fact_table")
		return
	}
	n, err := s.syncText2SQLFacts(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, "text2sql fact sink failed: "+err.Error(), "server_error", "fact_sink_failed")
		return
	}
	s.auditAdmin(r, "dw.text2sql_fact.sink", "", auditJSON(map[string]any{"rows": n}))
	writeJSON(w, http.StatusOK, map[string]any{"sent_rows": n, "table": s.chConf().Text2SQLFactTable})
}

// handleClickHouseTableInfo inspects the target table's engine and sort key via
// system.tables, so an operator can confirm the dedupe assumption (ReplacingMergeTree
// keyed by day/dimension/dim_value) that makes re-sending a window safe.
// GET /admin/dw/table-info
func (s *Server) handleClickHouseTableInfo(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	cfg := s.chConf()
	if cfg.URL == "" {
		writeOpenAIError(w, http.StatusBadRequest, "ClickHouse is not configured", "invalid_request_error", "no_clickhouse")
		return
	}
	db := cfg.Database
	if db == "" {
		db = "default"
	}
	q := fmt.Sprintf("SELECT engine, sorting_key, primary_key FROM system.tables WHERE database='%s' AND name='%s' FORMAT TabSeparated", db, cfg.Table)
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cfg.URL+"/?query="+url.QueryEscape(q), nil)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "clickhouse_failed")
		return
	}
	if cfg.User != "" {
		req.Header.Set("X-ClickHouse-User", cfg.User)
		req.Header.Set("X-ClickHouse-Key", cfg.Password)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, "clickhouse query failed: "+err.Error(), "server_error", "clickhouse_failed")
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		writeOpenAIError(w, http.StatusBadGateway, fmt.Sprintf("clickhouse status %d: %s", resp.StatusCode, strings.TrimSpace(string(body))), "server_error", "clickhouse_failed")
		return
	}
	line := strings.TrimSpace(string(body))
	if line == "" {
		writeJSON(w, http.StatusOK, map[string]any{"exists": false, "database": db, "table": cfg.Table, "detail": "테이블이 존재하지 않습니다 — 적재 전 생성이 필요합니다."})
		return
	}
	fields := strings.Split(line, "\t")
	engine, sortingKey, primaryKey := "", "", ""
	if len(fields) > 0 {
		engine = fields[0]
	}
	if len(fields) > 1 {
		sortingKey = fields[1]
	}
	if len(fields) > 2 {
		primaryKey = fields[2]
	}
	replacing := strings.Contains(engine, "ReplacingMergeTree")
	// The sink de-dupes by (day, dimension, dim_value); confirm those are in the sort key.
	dedupeOK := strings.Contains(sortingKey, "day") && strings.Contains(sortingKey, "dimension") && strings.Contains(sortingKey, "dim_value")
	status, detail := "ok", "ReplacingMergeTree + (day,dimension,dim_value) 정렬키 — 재전송 시 안전하게 중복 제거됩니다."
	switch {
	case !replacing && !dedupeOK:
		status, detail = "warn", "엔진이 ReplacingMergeTree가 아니고 정렬키도 dedupe 키를 포함하지 않습니다 — 재전송 시 중복 적재 위험."
	case !replacing:
		status, detail = "warn", "엔진이 ReplacingMergeTree가 아닙니다 — 재전송 시 중복 행이 누적될 수 있습니다."
	case !dedupeOK:
		status, detail = "warn", "정렬키에 (day,dimension,dim_value)가 모두 포함되지 않아 dedupe가 의도대로 동작하지 않을 수 있습니다."
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"exists": true, "database": db, "table": cfg.Table,
		"engine": engine, "sorting_key": sortingKey, "primary_key": primaryKey,
		"replacing_merge_tree": replacing, "dedupe_key_ok": dedupeOK,
		"status": status, "detail": detail,
	})
}

// clickhouseSinkLoop periodically ships recent rollups to ClickHouse. Started only
// when a URL and a positive interval are configured.
// applyClickHouseSinkWorker (re)starts or stops the background sink worker according to
// the current effective ClickHouse config. Safe to call at startup and on settings change.
func (s *Server) applyClickHouseSinkWorker() {
	s.chSinkMu.Lock()
	defer s.chSinkMu.Unlock()
	s.chSinkStarted = true
	if s.chSinkStop != nil {
		s.chSinkStop()
		s.chSinkStop = nil
	}
	ch := s.chConf()
	if ch.URL == "" || ch.SinkInterval <= 0 {
		return // disabled
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.chSinkStop = cancel
	go s.clickhouseSinkLoop(ctx)
}

func (s *Server) clickhouseSinkLoop(parent context.Context) {
	interval := s.chConf().SinkInterval
	if interval <= 0 {
		return
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-parent.Done():
			return
		case <-t.C:
		}
		days := s.chConf().SinkDays
		if days <= 0 {
			days = 3
		}
		ctx, cancel := context.WithTimeout(parent, 2*time.Minute)
		now := time.Now().UTC()
		_, _ = s.db.RollupRange(ctx, now.AddDate(0, 0, -days), now)
		sinceDay := now.AddDate(0, 0, -days).Format("2006-01-02")
		for _, dim := range dwDimensions {
			// syncClickHouseDimension records a watermark on success and persists a
			// retry entry on failure, so a failed window survives to the next cycle
			// (and the manual /admin/dw/sink-retry endpoint) instead of being lost.
			if _, err := s.syncClickHouseDimension(ctx, dim, sinceDay); err != nil {
				slog.Warn("clickhouse auto-sink failed", "dimension", dim, "error", err)
			}
		}
		// Per-query Text2SQL facts (only when a fact table is configured).
		if _, err := s.syncText2SQLFacts(ctx); err != nil {
			slog.Warn("clickhouse text2sql fact sink failed", "error", err)
		}
		// Per-case Red Team facts (only when a fact table is configured).
		if _, err := s.syncRedTeamFacts(ctx); err != nil {
			slog.Warn("clickhouse redteam fact sink failed", "error", err)
		}
		cancel()
	}
}

func parseInt64(s string) int64 {
	var n int64
	for _, c := range strings.TrimSpace(s) {
		if c < '0' || c > '9' {
			break
		}
		n = n*10 + int64(c-'0')
	}
	return n
}

func atoiDefault(s string, def int) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return def
		}
		n = n*10 + int(c-'0')
	}
	return n
}
