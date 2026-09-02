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

// Materialized views roll ai_request_fact up into dashboard-ready aggregates on insert, so
// cost/latency/error queries scan small SummingMergeTree tables instead of the raw fact.
// %s placeholders are filled with table references in order noted per function.

// requestFactDailyTableDDL — target table for the daily MV (%s = daily table ref).
func requestFactDailyTableDDL(ref string) string {
	return "CREATE TABLE IF NOT EXISTS " + ref + " (" +
		"event_date Date, team LowCardinality(String), provider LowCardinality(String), model LowCardinality(String), " +
		"requests UInt64, total_tokens UInt64, cost_krw Float64, errors UInt64" +
		") ENGINE = SummingMergeTree ORDER BY (event_date, team, provider, model)"
}

// requestFactDailyMVDDL — the daily MV (mvRef, targetRef, sourceRef).
func requestFactDailyMVDDL(mvRef, targetRef, sourceRef string) string {
	return "CREATE MATERIALIZED VIEW IF NOT EXISTS " + mvRef + " TO " + targetRef + " AS " +
		"SELECT event_date, team, provider, model, count() AS requests, sum(total_tokens) AS total_tokens, " +
		"sum(cost_krw) AS cost_krw, countIf(error_category != 'ok') AS errors " +
		"FROM " + sourceRef + " GROUP BY event_date, team, provider, model"
}

// requestFactHourlyTableDDL — target table for the hourly MV (%s = hourly table ref).
func requestFactHourlyTableDDL(ref string) string {
	return "CREATE TABLE IF NOT EXISTS " + ref + " (" +
		"event_hour DateTime, team LowCardinality(String), provider LowCardinality(String), model LowCardinality(String), " +
		"requests UInt64, total_tokens UInt64, cost_krw Float64, errors UInt64" +
		") ENGINE = SummingMergeTree ORDER BY (event_hour, team, provider, model)"
}

// requestFactHourlyMVDDL — the hourly MV (mvRef, targetRef, sourceRef).
func requestFactHourlyMVDDL(mvRef, targetRef, sourceRef string) string {
	return "CREATE MATERIALIZED VIEW IF NOT EXISTS " + mvRef + " TO " + targetRef + " AS " +
		"SELECT toStartOfHour(event_time) AS event_hour, team, provider, model, count() AS requests, " +
		"sum(total_tokens) AS total_tokens, sum(cost_krw) AS cost_krw, countIf(error_category != 'ok') AS errors " +
		"FROM " + sourceRef + " GROUP BY event_hour, team, provider, model"
}

// toolFactDDL — one row per tool/MCP invocation (append; multiple per request).
const toolFactDDL = `CREATE TABLE IF NOT EXISTS %s (
	event_date Date,
	event_time DateTime64(3),
	request_id String,
	trace_id String,
	api_key_id String,
	server_label LowCardinality(String),
	tool_name LowCardinality(String),
	source LowCardinality(String),
	is_mcp UInt8,
	is_error UInt8,
	arg_sensitive UInt8,
	arg_hash String,
	ingested_at DateTime64(3)
) ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_date, server_label, tool_name, request_id)`

// routingFactDDL — one row per routing decision (1 per request; dedupe on request_id).
const routingFactDDL = `CREATE TABLE IF NOT EXISTS %s (
	event_date Date,
	event_time DateTime64(3),
	request_id String,
	trace_id String,
	requested_model LowCardinality(String),
	selected_model LowCardinality(String),
	selected_provider LowCardinality(String),
	complexity_score UInt8,
	complexity_tier LowCardinality(String),
	risk_score UInt8,
	risk_tier LowCardinality(String),
	health_score Int16,
	fallback_path String,
	decision_reason String,
	ingested_at DateTime64(3)
) ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_date, selected_provider, selected_model, request_id)`

// evalFactDDL — one row per LLM evaluation (dedupe on request_id+name).
const evalFactDDL = `CREATE TABLE IF NOT EXISTS %s (
	event_date Date,
	event_time DateTime64(3),
	request_id String,
	trace_id String,
	name LowCardinality(String),
	category LowCardinality(String),
	evaluator LowCardinality(String),
	score Float64,
	label LowCardinality(String),
	passed UInt8,
	reason String,
	ingested_at DateTime64(3)
) ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_date, request_id, name)`

// policyFactDDL — one row per governance policy decision (append).
const policyFactDDL = `CREATE TABLE IF NOT EXISTS %s (
	event_date Date,
	event_time DateTime64(3),
	request_id String,
	api_key_id String,
	team_id LowCardinality(String),
	endpoint LowCardinality(String),
	phase LowCardinality(String),
	policy_id String,
	rule_id String,
	rule_name LowCardinality(String),
	decision LowCardinality(String),
	reason String,
	model LowCardinality(String),
	provider LowCardinality(String),
	risk_score UInt8,
	complexity_score UInt8,
	cost_krw Float64,
	ingested_at DateTime64(3)
) ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_date, decision, team_id, request_id)`

// emitPolicyFacts ships governance policy-decision events to ai_policy_fact (best-effort,
// off the request path). No-op when the sink is unconfigured.
func (s *Server) emitPolicyFacts(events []store.PolicyDecisionEvent) {
	ch := s.chConf()
	table := strings.TrimSpace(ch.PolicyFactTable)
	if ch.URL == "" || table == "" || len(events) == 0 {
		return
	}
	rows := make([]map[string]any, 0, len(events))
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, e := range events {
		if strings.TrimSpace(e.Decision) == "" {
			continue
		}
		// event_date stays UTC while the gateway's own charts bucket by Seoul day, and that
		// is deliberate. It is a partition key here (PARTITION BY toYYYYMM(event_date)) on an
		// append-only export, so switching conventions would leave old rows dated one way and
		// new rows the other inside a single table, with no way to rewrite the history - the
		// same discontinuity that made the analytics_daily rollup worth fixing, except this
		// one could not be repaired afterwards. event_time carries the full instant, so a
		// warehouse query that needs Seoul days can derive them from it.
		ts := e.CreatedAt.UTC()
		if ts.IsZero() {
			ts = time.Now().UTC()
		}
		rawProvider := e.Provider
		rows = append(rows, map[string]any{
			"event_date":       ts.Format("2006-01-02"),
			"event_time":       ts.Format(time.RFC3339Nano),
			"request_id":       e.RequestID,
			"api_key_id":       e.APIKeyID,
			"team_id":          e.TeamID,
			"endpoint":         e.Endpoint,
			"phase":            e.Phase,
			"policy_id":        e.PolicyID,
			"rule_id":          e.RuleID,
			"rule_name":        e.RuleName,
			"decision":         e.Decision,
			"reason":           boundedExternalProviderText(e.Reason, rawProvider),
			"model":            e.Model,
			"provider":         boundedModelsProviderLabelOrEmpty(rawProvider),
			"risk_score":       e.RiskScore,
			"complexity_score": e.ComplexityScore,
			"cost_krw":         e.CostKRW,
			"ingested_at":      now,
		})
	}
	if len(rows) == 0 {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		payload, _, err := insertJSONEachRow(ctx, s.client, ch, table, rows)
		if err != nil {
			_ = s.db.RecordClickHouseFactRetry(context.Background(), table, payload, len(rows), err.Error())
		}
	}()
}

// feedbackFactDDL — one row per human feedback event (append; low volume).
const feedbackFactDDL = `CREATE TABLE IF NOT EXISTS %s (
	event_date Date,
	event_time DateTime64(3),
	request_id String,
	trace_id String,
	rating Int8,
	label LowCardinality(String),
	source LowCardinality(String),
	created_by String,
	ingested_at DateTime64(3)
) ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_date, request_id)`

// emitFeedbackFact ships one human-feedback row to ai_feedback_fact (best-effort, off the
// response path). Feedback is sparse, so it inserts directly rather than via the batch queue;
// a failed insert is persisted to the retry queue. No-op when the sink is unconfigured.
func (s *Server) emitFeedbackFact(fb store.LLMFeedback) {
	ch := s.chConf()
	table := strings.TrimSpace(ch.FeedbackFactTable)
	if ch.URL == "" || table == "" {
		return
	}
	ts := fb.CreatedAt.UTC()
	if ts.IsZero() {
		ts = time.Now().UTC()
	}
	row := map[string]any{
		"event_date":  ts.Format("2006-01-02"),
		"event_time":  ts.Format(time.RFC3339Nano),
		"request_id":  fb.RequestID,
		"trace_id":    fb.TraceID,
		"rating":      fb.Rating,
		"label":       fb.Label,
		"source":      fb.Source,
		"created_by":  fb.CreatedBy,
		"ingested_at": time.Now().UTC().Format(time.RFC3339Nano),
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		payload, _, err := insertJSONEachRow(ctx, s.client, ch, table, []map[string]any{row})
		if err != nil {
			_ = s.db.RecordClickHouseFactRetry(context.Background(), table, payload, 1, err.Error())
		}
	}()
}

// skillFactDDL — one row per skill run (append; low volume). No prompt text — only the
// skill identity, actor, model, status, cost, latency, and tools used.
const skillFactDDL = `CREATE TABLE IF NOT EXISTS %s (
	event_date Date,
	event_time DateTime64(3),
	skill_name LowCardinality(String),
	skill_version String,
	actor String,
	model LowCardinality(String),
	status LowCardinality(String),
	tools_used String,
	cost_krw Float64,
	latency_ms Int64,
	ingested_at DateTime64(3)
) ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_date, skill_name, status)`

// emitSkillFact ships one skill-run row to ai_skill_fact (best-effort, off the request path).
// Skill runs are sparse, so it inserts directly rather than via the batch queue; a failed
// insert is persisted to the retry queue. No-op when the sink/table is unconfigured.
func (s *Server) emitSkillFact(run store.SkillRun) {
	ch := s.chConf()
	table := strings.TrimSpace(ch.SkillFactTable)
	if ch.URL == "" || table == "" {
		return
	}
	ts := time.Now().UTC()
	if strings.TrimSpace(run.CreatedAt) != "" {
		if parsed, err := time.Parse(time.RFC3339Nano, run.CreatedAt); err == nil {
			ts = parsed.UTC()
		}
	}
	row := map[string]any{
		"event_date":    ts.Format("2006-01-02"),
		"event_time":    ts.Format(time.RFC3339Nano),
		"skill_name":    run.SkillName,
		"skill_version": run.SkillVersion,
		"actor":         run.Actor,
		"model":         run.Model,
		"status":        run.Status,
		"tools_used":    run.ToolsUsed,
		"cost_krw":      run.CostKRW,
		"latency_ms":    run.LatencyMS,
		"ingested_at":   time.Now().UTC().Format(time.RFC3339Nano),
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		payload, _, err := insertJSONEachRow(ctx, s.client, ch, table, []map[string]any{row})
		if err != nil {
			_ = s.db.RecordClickHouseFactRetry(context.Background(), table, payload, 1, err.Error())
		}
	}()
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func factEventTime(reqTime, rowTime time.Time) time.Time {
	t := rowTime
	if t.IsZero() {
		t = reqTime
	}
	if t.IsZero() {
		t = time.Now().UTC()
	}
	return t.UTC()
}

// toolFactRows flattens a request's tool invocations into ai_tool_fact rows.
func toolFactRows(rec store.LogRecord) []map[string]any {
	out := make([]map[string]any, 0, len(rec.Tools))
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, t := range rec.Tools {
		ts := factEventTime(rec.Request.CreatedAt, t.CreatedAt)
		out = append(out, map[string]any{
			"event_date":    ts.Format("2006-01-02"),
			"event_time":    ts.Format(time.RFC3339Nano),
			"request_id":    t.RequestID,
			"trace_id":      t.TraceID,
			"api_key_id":    t.APIKeyID,
			"server_label":  t.ServerLabel,
			"tool_name":     t.ToolName,
			"source":        t.Source,
			"is_mcp":        b2i(t.IsMCP),
			"is_error":      b2i(t.IsError),
			"arg_sensitive": b2i(t.ArgSensitive),
			"arg_hash":      t.ArgHash,
			"ingested_at":   now,
		})
	}
	return out
}

// routingFactRow builds the ai_routing_fact row from the routing decision (when present).
func routingFactRow(rec store.LogRecord) (map[string]any, bool) {
	if rec.Routing == nil {
		return nil, false
	}
	r := rec.Routing
	ts := factEventTime(rec.Request.CreatedAt, r.CreatedAt)
	rawProvider := r.SelectedProvider
	fallback := ""
	if path := boundedExternalFallbackPath(r.FallbackPath, rawProvider); len(path) > 0 {
		fallback = strings.Join(path, ">")
	}
	return map[string]any{
		"event_date":        ts.Format("2006-01-02"),
		"event_time":        ts.Format(time.RFC3339Nano),
		"request_id":        r.RequestID,
		"trace_id":          r.TraceID,
		"requested_model":   r.RequestedModel,
		"selected_model":    r.SelectedModel,
		"selected_provider": boundedModelsProviderLabelOrEmpty(rawProvider),
		"complexity_score":  r.Complexity.Score,
		"complexity_tier":   r.Complexity.Tier,
		"risk_score":        r.Risk.Score,
		"risk_tier":         r.Risk.Tier,
		"health_score":      r.HealthScore,
		"fallback_path":     fallback,
		"decision_reason":   boundedExternalProviderText(r.DecisionReason, rawProvider),
		"ingested_at":       time.Now().UTC().Format(time.RFC3339Nano),
	}, true
}

// evalFactRows flattens a request's LLM evaluations into ai_eval_fact rows.
func evalFactRows(rec store.LogRecord) []map[string]any {
	out := make([]map[string]any, 0, len(rec.Evaluations))
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, e := range rec.Evaluations {
		ts := factEventTime(rec.Request.CreatedAt, e.CreatedAt)
		out = append(out, map[string]any{
			"event_date":  ts.Format("2006-01-02"),
			"event_time":  ts.Format(time.RFC3339Nano),
			"request_id":  e.RequestID,
			"trace_id":    e.TraceID,
			"name":        e.Name,
			"category":    e.Category,
			"evaluator":   e.Evaluator,
			"score":       e.Score,
			"label":       e.Label,
			"passed":      b2i(e.Passed),
			"reason":      e.Reason,
			"ingested_at": now,
		})
	}
	return out
}

// anyFactTableConfigured reports whether at least one fact sink is enabled.
func anyFactTableConfigured(ch config.ClickHouseConfig) bool {
	return strings.TrimSpace(ch.RequestFactTable) != "" ||
		strings.TrimSpace(ch.ToolFactTable) != "" ||
		strings.TrimSpace(ch.RoutingFactTable) != "" ||
		strings.TrimSpace(ch.EvalFactTable) != ""
}

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
	rawProvider := r.Provider
	rawFallback := r.FallbackFrom
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
	return map[string]any{
		"event_date":         ts.Format("2006-01-02"),
		"event_time":         ts.Format(time.RFC3339Nano),
		"request_id":         r.ID,
		"trace_id":           r.TraceID,
		"session_id":         r.SessionID,
		"api_key_id":         r.APIKeyID,
		"team":               "", // resolved at query time via api_key; kept blank to avoid a join here
		"endpoint":           r.Endpoint,
		"provider":           boundedModelsProviderLabelOrEmpty(rawProvider),
		"model":              r.Model,
		"requested_model":    r.RequestedModel,
		"stream":             b2i(r.Stream),
		"status_code":        r.StatusCode,
		"error_category":     errorCategory(r.StatusCode, r.Error),
		"latency_ms":         r.LatencyMS,
		"first_chunk_ms":     r.FirstChunkMS,
		"prompt_tokens":      promptTokens,
		"completion_tokens":  completionTokens,
		"cached_tokens":      cachedTokens,
		"reasoning_tokens":   reasoningTokens,
		"total_tokens":       totalTokens,
		"cost_krw":           cost,
		"currency":           currency,
		"repo":               r.Repo,
		"branch":             r.Branch,
		"project":            r.Project,
		"service":            r.Service,
		"cost_center":        r.CostCenter,
		"task_type":          r.TaskType,
		"prompt_name":        r.PromptName,
		"prompt_version":     r.PromptVersion,
		"prompt_fingerprint": r.PromptFingerprint,
		"tool_count":         r.ToolCount,
		"failover":           b2i(r.Failover),
		"fallback_from":      boundedModelsProviderLabelOrEmpty(rawFallback),
		"fallback_reason":    boundedExternalProviderText(r.FallbackReason, rawProvider, rawFallback),
		"route_reason":       r.RouteReason,
		"route_detail":       boundedExternalProviderText(r.RouteDetail, rawProvider, rawFallback),
		"complexity_score":   r.Complexity,
		"language_top":       langTop,
		"client_ip_hash":     ipHash,
		"request_hash":       r.RequestHash,
		"ingested_at":        time.Now().UTC().Format(time.RFC3339Nano),
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

// text2sqlSQLHash returns a stable hash of generated SQL (the raw SQL is never shipped to
// the DW). Empty SQL → empty hash.
func text2sqlSQLHash(sql string) string {
	if strings.TrimSpace(sql) == "" {
		return ""
	}
	return audit.HashText(sql)[:16]
}

// configuredFactTables lists the (key,table) pairs that are currently enabled, including
// the daily rollup, so status/lag views can iterate them uniformly.
func configuredFactTables(ch config.ClickHouseConfig) []struct{ Key, Table string } {
	all := []struct{ Key, Table string }{
		{"rollup", ch.Table},
		{"request_fact", ch.RequestFactTable},
		{"tool_fact", ch.ToolFactTable},
		{"routing_fact", ch.RoutingFactTable},
		{"eval_fact", ch.EvalFactTable},
		{"feedback_fact", ch.FeedbackFactTable},
		{"policy_fact", ch.PolicyFactTable},
		{"skill_fact", ch.SkillFactTable},
		{"text2sql_fact", ch.Text2SQLFactTable},
	}
	out := all[:0]
	for _, t := range all {
		if strings.TrimSpace(t.Table) != "" {
			out = append(out, t)
		}
	}
	return out
}

// handleClickHouseLag reports adoption/lag for the DW: per-table ClickHouse row counts, the
// local request-log count, the derived request-fact lag, and the live queue/retry backlog.
// GET /admin/dw/clickhouse/lag
func (s *Server) handleClickHouseLag(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	cfg := s.chConf()
	if cfg.URL == "" {
		writeOpenAIError(w, http.StatusBadRequest, "ClickHouse is not configured", "invalid_request_error", "no_clickhouse")
		return
	}
	tables := []map[string]any{}
	reqFactCount := int64(-1)
	for _, t := range configuredFactTables(cfg) {
		ref := t.Table
		if cfg.Database != "" && !strings.Contains(ref, ".") {
			ref = cfg.Database + "." + ref
		}
		entry := map[string]any{"key": t.Key, "table": t.Table}
		if body, code, err := s.clickhouseQuery(r.Context(), cfg, "SELECT count() FROM "+ref+" FORMAT TabSeparated"); err == nil && code == http.StatusOK {
			c := parseInt64(strings.TrimSpace(body))
			entry["rows"] = c
			entry["exists"] = true
			if t.Key == "request_fact" {
				reqFactCount = c
			}
		} else {
			entry["exists"] = false
		}
		tables = append(tables, entry)
	}
	localRequests := int64(0)
	if reqs, _, _, err := s.db.Counts(r.Context()); err == nil {
		localRequests = reqs
	}
	out := map[string]any{
		"tables":         tables,
		"local_requests": localRequests,
		"queue_depth":    len(s.chFactQueue),
		"queue_cap":      cap(s.chFactQueue),
		"dropped":        s.chFactDropped.Load(),
	}
	if reqFactCount >= 0 {
		out["request_fact_rows"] = reqFactCount
		out["request_fact_lag"] = localRequests - reqFactCount // local minus shipped (approx)
	}
	if n, err := s.db.CountClickHouseFactRetries(r.Context()); err == nil {
		out["retry_batches"] = n
	}
	writeJSON(w, http.StatusOK, out)
}

// handleClickHouseEvents returns recent rows from a configured fact table (read-only
// passthrough) for spot-checking what landed. table must be one of the configured sinks.
// GET /admin/dw/clickhouse/events?table=ai_request_fact&limit=20
func (s *Server) handleClickHouseEvents(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	cfg := s.chConf()
	if cfg.URL == "" {
		writeOpenAIError(w, http.StatusBadRequest, "ClickHouse is not configured", "invalid_request_error", "no_clickhouse")
		return
	}
	table := strings.TrimSpace(r.URL.Query().Get("table"))
	allowed := false
	for _, t := range configuredFactTables(cfg) {
		if t.Table == table {
			allowed = true
			break
		}
	}
	if !allowed {
		writeOpenAIError(w, http.StatusBadRequest, "table must be one of the configured fact/rollup tables", "invalid_request_error", "bad_table")
		return
	}
	limit := intQuery(r, "limit", 20)
	if limit <= 0 || limit > 200 {
		limit = 20
	}
	ref := table
	if cfg.Database != "" && !strings.Contains(ref, ".") {
		ref = cfg.Database + "." + ref
	}
	q := fmt.Sprintf("SELECT * FROM %s LIMIT %d FORMAT JSON", ref, limit)
	body, code, err := s.clickhouseQuery(r.Context(), cfg, q)
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, "clickhouse query failed: "+err.Error(), "server_error", "clickhouse_failed")
		return
	}
	if code != http.StatusOK {
		writeOpenAIError(w, http.StatusBadGateway, fmt.Sprintf("clickhouse status %d", code), "server_error", "clickhouse_failed")
		return
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"table": table, "raw": body})
		return
	}
	parsed["table"] = table
	writeJSON(w, http.StatusOK, parsed)
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
	if ch.URL == "" || !anyFactTableConfigured(ch) {
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
		if ch.URL == "" {
			buf = buf[:0]
			return
		}
		// One INSERT per configured fact table. A failed table is persisted to the retry
		// queue independently, so a single bad table doesn't lose the others.
		sink := func(table string, rows []map[string]any) {
			if strings.TrimSpace(table) == "" || len(rows) == 0 {
				return
			}
			ctx, cancel := context.WithTimeout(parent, 45*time.Second)
			payload, _, err := insertJSONEachRow(ctx, s.client, ch, table, rows)
			cancel()
			if err != nil {
				slog.Warn("clickhouse fact flush failed", "table", table, "rows", len(rows), "error", err)
				_ = s.db.RecordClickHouseFactRetry(parent, table, payload, len(rows), err.Error())
			}
		}
		var reqRows, toolRows, routeRows, evalRows []map[string]any
		for _, rec := range buf {
			if strings.TrimSpace(ch.RequestFactTable) != "" {
				reqRows = append(reqRows, requestFactRow(rec))
			}
			if strings.TrimSpace(ch.ToolFactTable) != "" {
				toolRows = append(toolRows, toolFactRows(rec)...)
			}
			if strings.TrimSpace(ch.RoutingFactTable) != "" {
				if rr, ok := routingFactRow(rec); ok {
					routeRows = append(routeRows, rr)
				}
			}
			if strings.TrimSpace(ch.EvalFactTable) != "" {
				evalRows = append(evalRows, evalFactRows(rec)...)
			}
		}
		sink(ch.RequestFactTable, reqRows)
		sink(ch.ToolFactTable, toolRows)
		sink(ch.RoutingFactTable, routeRows)
		sink(ch.EvalFactTable, evalRows)
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
