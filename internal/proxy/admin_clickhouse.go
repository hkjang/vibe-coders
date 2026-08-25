package proxy

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"vibe-coders/internal/config"
)

// chTableRef returns the (optionally database-qualified) table reference for a name.
func chTableRef(database, name string) string {
	if database != "" && !strings.Contains(name, ".") {
		return database + "." + name
	}
	return name
}

// chIdentRe matches a safe ClickHouse identifier: a database/table name made of
// letters, digits and underscores, optionally one dot-qualified segment (db.table).
// Identifiers are interpolated bare into DDL (CREATE TABLE/DATABASE) where they cannot be
// escaped as string literals, so they must be validated rather than escaped.
var chIdentRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$`)

// validCHIdentifier reports whether name is a safe ClickHouse identifier (empty is allowed
// so optional fact-table settings can be cleared). Guards against SQL injection through
// admin-set table/database names.
func validCHIdentifier(name string) bool {
	name = strings.TrimSpace(name)
	if name == "" {
		return true
	}
	return chIdentRe.MatchString(name)
}

// clickhouseExec sends a statement (DDL/INSERT) to ClickHouse via its HTTP interface as the
// POST body and returns an error (including the response body) on a non-2xx status.
func clickhouseExec(ctx context.Context, client *http.Client, cfg config.ClickHouseConfig, stmt string) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.URL+"/", bytes.NewReader([]byte(stmt)))
	if err != nil {
		return err
	}
	if cfg.User != "" {
		req.Header.Set("X-ClickHouse-User", cfg.User)
		req.Header.Set("X-ClickHouse-Key", cfg.Password)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return fmt.Errorf("status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}

// clickhouseQuery runs a read query (GET) and returns the trimmed response body.
func (s *Server) clickhouseQuery(ctx context.Context, cfg config.ClickHouseConfig, query string) (string, int, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cfg.URL+"/?query="+url.QueryEscape(query), nil)
	if err != nil {
		return "", 0, err
	}
	if cfg.User != "" {
		req.Header.Set("X-ClickHouse-User", cfg.User)
		req.Header.Set("X-ClickHouse-Key", cfg.Password)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return "", 0, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return strings.TrimSpace(string(body)), resp.StatusCode, nil
}

// rollupTableDDL builds the CREATE TABLE for the daily rollup sink target. The engine and
// sort key match what the sink relies on for safe re-sends (ReplacingMergeTree dedupe by
// day/dimension/dim_value).
func rollupTableDDL(ref string) string {
	return "CREATE TABLE IF NOT EXISTS " + ref + " (" +
		"day Date, " +
		"dimension LowCardinality(String), " +
		"dim_value String, " +
		"requests UInt64, " +
		"tokens UInt64, " +
		"cost_krw Float64, " +
		"errors UInt64" +
		") ENGINE = ReplacingMergeTree ORDER BY (day, dimension, dim_value)"
}

// factTableDDL builds the CREATE TABLE for the per-query Text2SQL fact sink target.
func factTableDDL(ref string) string {
	return "CREATE TABLE IF NOT EXISTS " + ref + " (" +
		"ts DateTime64(3), " +
		"request_id String, " +
		"team LowCardinality(String), " +
		"virtual_model LowCardinality(String), " +
		"upstream_model LowCardinality(String), " +
		"mode LowCardinality(String), " +
		"schema_name String, " +
		"schema_version String, " +
		"valid UInt8, " +
		"executed UInt8, " +
		"row_count Int64, " +
		"explain_risk Float64, " +
		"cost_krw Float64, " +
		"generation_cost Float64, " +
		"summary_cost Float64, " +
		"latency_ms Int64, " +
		"failure_category LowCardinality(String), " +
		"question_chars UInt32, " +
		"reject_reason LowCardinality(String), " +
		"sql_hash String" +
		") ENGINE = MergeTree ORDER BY (ts, request_id)"
}

// handleClickHouseBootstrap creates the database (when named) and the rollup table — plus
// the Text2SQL fact table when configured — using IF NOT EXISTS, so it is idempotent.
// POST /admin/dw/clickhouse/bootstrap
func (s *Server) handleClickHouseBootstrap(w http.ResponseWriter, r *http.Request) {
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
		writeOpenAIError(w, http.StatusBadRequest, "ClickHouse is not configured (clickhouse.url)", "invalid_request_error", "no_clickhouse")
		return
	}
	if strings.TrimSpace(cfg.Table) == "" {
		writeOpenAIError(w, http.StatusBadRequest, "clickhouse.table is not set", "invalid_request_error", "no_table")
		return
	}
	// Defense in depth: identifiers are interpolated bare into DDL, so reject any unsafe
	// database/table name before issuing CREATE statements (settings validation also blocks
	// these, but env-supplied values bypass that path).
	for label, name := range map[string]string{
		"clickhouse.database": cfg.Database, "clickhouse.table": cfg.Table,
		"clickhouse.text2sql_fact_table": cfg.Text2SQLFactTable, "clickhouse.request_fact_table": cfg.RequestFactTable,
		"clickhouse.tool_fact_table": cfg.ToolFactTable, "clickhouse.routing_fact_table": cfg.RoutingFactTable,
		"clickhouse.eval_fact_table": cfg.EvalFactTable, "clickhouse.feedback_fact_table": cfg.FeedbackFactTable,
		"clickhouse.policy_fact_table": cfg.PolicyFactTable, "clickhouse.skill_fact_table": cfg.SkillFactTable,
	} {
		if !validCHIdentifier(name) {
			writeOpenAIError(w, http.StatusBadRequest, "invalid ClickHouse identifier for "+label+": "+name, "invalid_request_error", "invalid_identifier")
			return
		}
	}
	type step struct {
		Object string `json:"object"`
		OK     bool   `json:"ok"`
		Error  string `json:"error,omitempty"`
	}
	steps := []step{}
	run := func(object, stmt string) bool {
		if err := clickhouseExec(r.Context(), s.client, cfg, stmt); err != nil {
			steps = append(steps, step{Object: object, OK: false, Error: err.Error()})
			return false
		}
		steps = append(steps, step{Object: object, OK: true})
		return true
	}

	allOK := true
	if cfg.Database != "" {
		allOK = run("database "+cfg.Database, "CREATE DATABASE IF NOT EXISTS "+cfg.Database) && allOK
	}
	rollupRef := chTableRef(cfg.Database, cfg.Table)
	allOK = run("table "+rollupRef, rollupTableDDL(rollupRef)) && allOK
	if strings.TrimSpace(cfg.Text2SQLFactTable) != "" {
		factRef := chTableRef(cfg.Database, cfg.Text2SQLFactTable)
		allOK = run("table "+factRef, factTableDDL(factRef)) && allOK
	}
	if strings.TrimSpace(cfg.RequestFactTable) != "" {
		reqRef := chTableRef(cfg.Database, cfg.RequestFactTable)
		allOK = run("table "+reqRef, fmt.Sprintf(requestFactDDL, reqRef)) && allOK
		// Dashboard-ready rollups of the request fact (daily + hourly) via materialized views.
		dailyRef := chTableRef(cfg.Database, cfg.RequestFactTable+"_daily")
		hourlyRef := chTableRef(cfg.Database, cfg.RequestFactTable+"_hourly")
		allOK = run("table "+dailyRef, requestFactDailyTableDDL(dailyRef)) && allOK
		allOK = run("view "+dailyRef+"_mv", requestFactDailyMVDDL(dailyRef+"_mv", dailyRef, reqRef)) && allOK
		allOK = run("table "+hourlyRef, requestFactHourlyTableDDL(hourlyRef)) && allOK
		allOK = run("view "+hourlyRef+"_mv", requestFactHourlyMVDDL(hourlyRef+"_mv", hourlyRef, reqRef)) && allOK
	}
	if strings.TrimSpace(cfg.ToolFactTable) != "" {
		ref := chTableRef(cfg.Database, cfg.ToolFactTable)
		allOK = run("table "+ref, fmt.Sprintf(toolFactDDL, ref)) && allOK
	}
	if strings.TrimSpace(cfg.RoutingFactTable) != "" {
		ref := chTableRef(cfg.Database, cfg.RoutingFactTable)
		allOK = run("table "+ref, fmt.Sprintf(routingFactDDL, ref)) && allOK
	}
	if strings.TrimSpace(cfg.EvalFactTable) != "" {
		ref := chTableRef(cfg.Database, cfg.EvalFactTable)
		allOK = run("table "+ref, fmt.Sprintf(evalFactDDL, ref)) && allOK
	}
	if strings.TrimSpace(cfg.FeedbackFactTable) != "" {
		ref := chTableRef(cfg.Database, cfg.FeedbackFactTable)
		allOK = run("table "+ref, fmt.Sprintf(feedbackFactDDL, ref)) && allOK
	}
	if strings.TrimSpace(cfg.PolicyFactTable) != "" {
		ref := chTableRef(cfg.Database, cfg.PolicyFactTable)
		allOK = run("table "+ref, fmt.Sprintf(policyFactDDL, ref)) && allOK
	}
	if strings.TrimSpace(cfg.SkillFactTable) != "" {
		ref := chTableRef(cfg.Database, cfg.SkillFactTable)
		allOK = run("table "+ref, fmt.Sprintf(skillFactDDL, ref)) && allOK
	}
	if strings.TrimSpace(cfg.MultiModelFactTable) != "" {
		ref := chTableRef(cfg.Database, cfg.MultiModelFactTable)
		allOK = run("table "+ref, fmt.Sprintf(multiModelFactDDL, ref)) && allOK
	}

	s.auditAdmin(r, "dw.clickhouse.bootstrap", "", auditJSON(map[string]any{"steps": steps, "ok": allOK}))
	status := http.StatusOK
	if !allOK {
		status = http.StatusBadGateway
	}
	writeJSON(w, status, map[string]any{"ok": allOK, "steps": steps})
}

// handleClickHouseOverview returns a single-call health view for the ClickHouse DW: ping,
// rollup/fact table presence + engine, auto-sink configuration, per-dimension watermarks,
// and the pending retry queue. Powers the admin "ClickHouse" monitoring panel.
// GET /admin/dw/clickhouse/overview
func (s *Server) handleClickHouseOverview(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	cfg := s.chConf()
	out := map[string]any{
		"configured": cfg.URL != "",
		"database":   cfg.Database,
		"table":      cfg.Table,
		"sink": map[string]any{
			"interval":     cfg.SinkInterval.String(),
			"days":         cfg.SinkDays,
			"auto_enabled": cfg.URL != "" && cfg.SinkInterval > 0,
		},
		"fact_table": map[string]any{"configured": strings.TrimSpace(cfg.Text2SQLFactTable) != "", "name": cfg.Text2SQLFactTable},
	}
	// Async per-request fact queue status (independent of ping).
	reqFact := map[string]any{
		"configured":  strings.TrimSpace(cfg.RequestFactTable) != "",
		"table":       cfg.RequestFactTable,
		"queue_depth": len(s.chFactQueue),
		"queue_cap":   cap(s.chFactQueue),
		"dropped":     s.chFactDropped.Load(),
		"batch_size":  cfg.BatchSize,
		"flush":       cfg.FlushInterval.String(),
	}
	if n, err := s.db.CountClickHouseFactRetries(r.Context()); err == nil {
		reqFact["retry_batches"] = n
	}
	out["request_fact"] = reqFact
	if cfg.URL == "" {
		writeJSON(w, http.StatusOK, out)
		return
	}

	// Ping.
	start := time.Now()
	ping := map[string]any{"ok": false}
	if body, code, err := s.clickhouseQuery(r.Context(), cfg, "SELECT 1"); err != nil {
		ping["message"] = "ping failed: " + err.Error()
	} else if code != http.StatusOK {
		ping["message"] = fmt.Sprintf("ping returned HTTP %d (check auth/url)", code)
	} else {
		ping["ok"] = true
		ping["latency_ms"] = time.Since(start).Milliseconds()
		_ = body
	}
	out["ping"] = ping

	// Rollup table engine + sort key (only worth querying if ping ok).
	if ping["ok"] == true {
		db := cfg.Database
		if db == "" {
			db = "default"
		}
		q := fmt.Sprintf("SELECT engine, sorting_key FROM system.tables WHERE database='%s' AND name='%s' FORMAT TabSeparated", chEscape(db), chEscape(cfg.Table))
		rollup := map[string]any{"exists": false}
		if line, code, err := s.clickhouseQuery(r.Context(), cfg, q); err == nil && code == http.StatusOK && line != "" {
			fields := strings.Split(line, "\t")
			engine, sortingKey := "", ""
			if len(fields) > 0 {
				engine = fields[0]
			}
			if len(fields) > 1 {
				sortingKey = fields[1]
			}
			replacing := strings.Contains(engine, "ReplacingMergeTree")
			dedupeOK := strings.Contains(sortingKey, "day") && strings.Contains(sortingKey, "dimension") && strings.Contains(sortingKey, "dim_value")
			rollup = map[string]any{
				"exists": true, "engine": engine, "sorting_key": sortingKey,
				"replacing_merge_tree": replacing, "dedupe_ok": dedupeOK,
			}
		}
		out["rollup_table"] = rollup

		if ft := strings.TrimSpace(cfg.Text2SQLFactTable); ft != "" {
			exists := false
			ref := chTableRef(cfg.Database, ft)
			if _, code, err := s.clickhouseQuery(r.Context(), cfg, "EXISTS TABLE "+ref); err == nil && code == http.StatusOK {
				// EXISTS returns 1/0 in the body; treat HTTP 200 as reachable and parse.
				if line, _, _ := s.clickhouseQuery(r.Context(), cfg, "EXISTS TABLE "+ref); strings.TrimSpace(line) == "1" {
					exists = true
				}
			}
			out["fact_table"] = map[string]any{"configured": true, "name": ft, "exists": exists}
		}
	}

	// Watermarks + retry queue from the local ledger (independent of ping).
	if state, err := s.db.ListClickHouseSinkState(r.Context()); err == nil {
		out["watermarks"] = state
	}
	if retries, err := s.db.ListClickHouseSinkRetries(r.Context()); err == nil {
		out["retries"] = retries
		out["retry_count"] = len(retries)
	}

	writeJSON(w, http.StatusOK, out)
}
