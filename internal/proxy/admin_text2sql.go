package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"vibe-coders/internal/store"
	"vibe-coders/internal/text2sql"
)

var sqlTokenRe = regexp.MustCompile(`[a-zA-Z_][a-zA-Z0-9_]*`)

// goldenSQLMatch is a lenient comparison: the generated SQL passes if it references
// the same set of identifier tokens as the expected SQL (order/whitespace/alias
// differences are tolerated, since LLM SQL is rarely byte-identical).
func goldenSQLMatch(expected, generated string) bool {
	want := sqlTokenRe.FindAllString(strings.ToLower(expected), -1)
	if len(want) == 0 {
		return false
	}
	got := map[string]bool{}
	for _, t := range sqlTokenRe.FindAllString(strings.ToLower(generated), -1) {
		got[t] = true
	}
	// Every expected identifier/keyword (except the optional "as" alias keyword) must
	// appear in the generated SQL. Extra tokens (aliases, formatting) are tolerated;
	// a missing table/column/keyword means the query diverged.
	for _, t := range want {
		if t == "as" {
			continue
		}
		if !got[t] {
			return false
		}
	}
	return true
}

// handleText2SQLAdmin serves the Text2SQL admin tab data: recent query logs +
// aggregate stats over a window.
// GET /admin/text2sql?window=7d
func (s *Server) handleText2SQLAdmin(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	logs, err := s.db.ListText2SQLLogs(r.Context(), recentLimit(r))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "text2sql_logs_failed")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 7*24*time.Hour, "day")
	stats, err := s.db.Text2SQLStatsSince(r.Context(), since)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "text2sql_stats_failed")
		return
	}
	schemas, _ := s.db.ListText2SQLSchemas(r.Context())
	modelMetrics, _ := s.db.Text2SQLModelMetricsSince(r.Context(), since)
	goldens, _ := s.db.ListText2SQLGoldenQueries(r.Context(), false)
	dbProfiles, _ := s.db.ListText2SQLProfiles(r.Context())
	permissions, _ := s.db.ListText2SQLPermissions(r.Context())
	failures, _ := s.db.Text2SQLFailureBreakdownSince(r.Context(), since)
	writeJSON(w, http.StatusOK, map[string]any{
		"schemas":       schemas,
		"model_metrics": modelMetrics,
		"golden":        goldens,
		"db_profiles":   dbProfiles,
		"permissions":   permissions,
		"failures":      failures,
		"enabled":       s.cfg.Text2SQL.Enabled,
		"profiles": []map[string]string{
			{"model": "vibe/text2sql-preview", "mode": "preview", "upstream": s.cfg.Text2SQL.PreviewModel},
			{"model": "vibe/text2sql-execute", "mode": "execute", "upstream": s.cfg.Text2SQL.ExecuteModel},
			{"model": "vibe/text2sql-accurate", "mode": "preview", "upstream": s.cfg.Text2SQL.AccurateModel},
			{"model": "vibe/text2sql-local", "mode": "preview", "upstream": s.cfg.Text2SQL.LocalModel},
			{"model": "vibe/text2sql-auto", "mode": "auto", "upstream": "(complexity 기반)"},
		},
		"stats": stats,
		"logs":  logs,
	})
}

// handleText2SQLTables manages the table registry for a schema.
// GET /admin/text2sql/tables?schema=NAME · POST {schema_name,table_name,description,enabled} · DELETE ?schema=&table=
func (s *Server) handleText2SQLTables(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		schema := strings.TrimSpace(r.URL.Query().Get("schema"))
		tables, err := s.db.ListText2SQLTables(r.Context(), schema)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "tables_failed")
			return
		}
		cols, _ := s.db.ListText2SQLColumns(r.Context(), schema)
		writeJSON(w, http.StatusOK, map[string]any{"tables": tables, "columns": cols})
	case http.MethodPost:
		var p struct {
			SchemaName  string `json:"schema_name"`
			TableName   string `json:"table_name"`
			Description string `json:"description"`
			Enabled     *bool  `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		if strings.TrimSpace(p.SchemaName) == "" || strings.TrimSpace(p.TableName) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "schema_name and table_name are required", "invalid_request_error", "missing_fields")
			return
		}
		t := store.Text2SQLTable{SchemaName: strings.TrimSpace(p.SchemaName), TableName: strings.TrimSpace(p.TableName), Description: strings.TrimSpace(p.Description), Enabled: true}
		if p.Enabled != nil {
			t.Enabled = *p.Enabled
		}
		if err := s.db.UpsertText2SQLTable(r.Context(), t); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "table_save_failed")
			return
		}
		s.auditAdmin(r, "text2sql.table.upsert", "", auditJSON(t))
		writeJSON(w, http.StatusCreated, map[string]any{"table": t})
	case http.MethodDelete:
		schema, table := strings.TrimSpace(r.URL.Query().Get("schema")), strings.TrimSpace(r.URL.Query().Get("table"))
		if schema == "" || table == "" {
			writeOpenAIError(w, http.StatusBadRequest, "schema and table query params required", "invalid_request_error", "missing_params")
			return
		}
		if err := s.db.DeleteText2SQLTable(r.Context(), schema, table); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "table_delete_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"schema": schema, "table": table, "status": "deleted"})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// validText2SQLSensitivity reports whether a sensitivity value is one the registry
// understands. Keep in sync with the column-policy handling in BuildSchemaCatalog and
// the admin UI dropdown.
func validText2SQLSensitivity(sens string) bool {
	switch sens {
	case store.SensitivityNormal, store.SensitivityMask, store.SensitivityAggregateOnly,
		store.SensitivityApprovalRequired, store.SensitivityExclude:
		return true
	}
	return false
}

// handleText2SQLColumns manages the column registry (descriptions + sensitivity).
// POST {schema_name,table_name,column_name,data_type,description,sensitivity} · DELETE ?schema=&table=&column=
func (s *Server) handleText2SQLColumns(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodPost:
		var p struct {
			SchemaName, TableName, ColumnName, DataType, Description, Sensitivity string
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		if strings.TrimSpace(p.SchemaName) == "" || strings.TrimSpace(p.TableName) == "" || strings.TrimSpace(p.ColumnName) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "schema_name, table_name, column_name are required", "invalid_request_error", "missing_fields")
			return
		}
		sens := strings.ToLower(strings.TrimSpace(p.Sensitivity))
		if sens != "" && !validText2SQLSensitivity(sens) {
			writeOpenAIError(w, http.StatusBadRequest, "sensitivity must be one of normal/mask/aggregate_only/approval_required/exclude", "invalid_request_error", "invalid_sensitivity")
			return
		}
		c := store.Text2SQLColumn{
			SchemaName: strings.TrimSpace(p.SchemaName), TableName: strings.TrimSpace(p.TableName), ColumnName: strings.TrimSpace(p.ColumnName),
			DataType: strings.TrimSpace(p.DataType), Description: strings.TrimSpace(p.Description), Sensitivity: sens,
		}
		if err := s.db.UpsertText2SQLColumn(r.Context(), c); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "column_save_failed")
			return
		}
		s.auditAdmin(r, "text2sql.column.upsert", "", auditJSON(c))
		writeJSON(w, http.StatusCreated, map[string]any{"column": c})
	case http.MethodDelete:
		schema, table, col := strings.TrimSpace(r.URL.Query().Get("schema")), strings.TrimSpace(r.URL.Query().Get("table")), strings.TrimSpace(r.URL.Query().Get("column"))
		if schema == "" || table == "" || col == "" {
			writeOpenAIError(w, http.StatusBadRequest, "schema, table, column query params required", "invalid_request_error", "missing_params")
			return
		}
		if err := s.db.DeleteText2SQLColumn(r.Context(), schema, table, col); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "column_delete_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleText2SQLRiskQueue returns Text2SQL requests needing operator attention:
// rejected, high EXPLAIN risk, or classified failures.
// GET /admin/text2sql/risk-queue?window=7d&min_risk=50
func (s *Server) handleText2SQLRiskQueue(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 7*24*time.Hour, "day")
	minRisk := 50
	if v := strings.TrimSpace(r.URL.Query().Get("min_risk")); v != "" {
		if n := atoiDefault(v, 50); n >= 0 {
			minRisk = n
		}
	}
	logs, err := s.db.RiskyText2SQLLogs(r.Context(), since, minRisk, recentLimit(r))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "risk_queue_failed")
		return
	}
	// Attach actionable fix suggestions per entry so operators get next steps, not just
	// a block reason.
	queue := make([]map[string]any, 0, len(logs))
	for _, l := range logs {
		queue = append(queue, map[string]any{"log": l, "suggestions": suggestText2SQLFixes(l)})
	}
	writeJSON(w, http.StatusOK, map[string]any{"queue": queue, "count": len(queue)})
}

// suggestText2SQLFixes derives operator-facing remediation hints from a risky/failed
// Text2SQL log: what to change in the question (date filter, aggregation, dropping a
// sensitive column, tightening LIMIT) to get a safe, valid query.
func suggestText2SQLFixes(l store.Text2SQLQueryLog) []string {
	out := []string{}
	reason := strings.ToLower(l.RejectReason + " " + l.Error)
	switch l.FailureCategory {
	case "permission_denied":
		out = append(out, "민감 컬럼/비허용 테이블을 질문에서 제외하거나 권한 부여를 요청하세요.")
	case "cost_exceeded":
		out = append(out, "조회 범위를 좁히는 기간/필터 조건을 추가하세요.", "원시 행 대신 집계(GROUP BY)로 변경을 고려하세요.")
	case "timeout":
		out = append(out, "기간 조건을 추가하고 LIMIT을 축소하세요.")
	case "unknown_column":
		out = append(out, "스키마 카탈로그의 실제 컬럼명을 확인해 질문을 수정하세요.")
	case "empty_result":
		out = append(out, "조건이 과도하게 제한적입니다 — 필터를 완화하세요.")
	case "clarification":
		out = append(out, "기간·대상 등 누락된 조건을 명시해 다시 질문하세요.")
	}
	if strings.Contains(reason, "aggregate-only") {
		out = append(out, "해당 컬럼은 원시 조회가 불가합니다 — 집계 함수(sum/avg/count 등) 안에서 사용하세요.")
	}
	if strings.Contains(reason, "sensitive column") {
		out = append(out, "민감 컬럼을 SELECT 목록에서 제거하세요.")
	}
	if strings.Contains(reason, "exceeds max") || strings.Contains(reason, "limit") {
		out = append(out, "명시 LIMIT을 허용 상한 이하로 축소하세요.")
	}
	if l.ExplainRisk >= 70 {
		out = append(out, "EXPLAIN 위험이 높습니다 — 인덱스 가능한 조건 추가 또는 결과 범위 축소를 검토하세요.")
	}
	if len(out) == 0 && !l.Valid {
		out = append(out, "질문을 더 구체적으로 작성하거나 대상 테이블/기간을 명시하세요.")
	}
	return out
}

// handleText2SQLMiners surfaces insight mined from the question logs: recurring
// questions worth promoting to a saved report, and frequent undefined question tokens
// worth adding to the business glossary. Read-only.
// GET /admin/text2sql/miners?window=30d&min_count=3
func (s *Server) handleText2SQLMiners(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")
	minCount := 3
	if v := strings.TrimSpace(r.URL.Query().Get("min_count")); v != "" {
		if n := atoiDefault(v, 3); n >= 2 {
			minCount = n
		}
	}
	reports, err := s.db.Text2SQLReportCandidates(r.Context(), since, minCount, 100)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "report_miner_failed")
		return
	}
	terms, err := s.db.Text2SQLGlossaryCandidates(r.Context(), since, minCount, 100)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "glossary_miner_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"report_candidates": reports, "glossary_candidates": terms})
}

// Text2SQL runtime feature toggles (admin-managed, default off).
const (
	t2sFeatureSelfChallenge = "self_challenge"
	t2sFeatureGatewayMemory = "gateway_memory"
	t2sFeatureRiskEnforce   = "cumulative_risk_enforce"
)

// t2sKnownFeatures is the catalog of toggleable features shown in the admin panel.
var t2sKnownFeatures = []struct{ Name, Description string }{
	{t2sFeatureSelfChallenge, "생성된 SQL을 보조 모델이 한 번 더 검토 (정확도↑, 요청당 추가 호출 비용 발생)"},
	{t2sFeatureGatewayMemory, "사용자가 최근 자주 사용한 스키마/테이블을 프롬프트 힌트로 보강"},
	{t2sFeatureRiskEnforce, "API Key의 당일 누적 위험 요청이 한도(TEXT2SQL_DAILY_RISK_LIMIT)를 넘으면 차단 (탐지→차단 강제)"},
}

// reloadText2SQLFeatures refreshes the in-memory feature-flag cache from the DB.
func (s *Server) reloadText2SQLFeatures(ctx context.Context) {
	m, err := s.db.Text2SQLFeatureFlagMap(ctx)
	if err != nil || m == nil {
		m = map[string]bool{}
	}
	s.t2sFeatures.Store(&m)
}

// t2sFeatureOn reports whether a runtime Text2SQL feature toggle is enabled.
func (s *Server) t2sFeatureOn(name string) bool {
	if m := s.t2sFeatures.Load(); m != nil {
		return (*m)[name]
	}
	return false
}

// handleText2SQLFeatures lists and toggles runtime Text2SQL features from the admin UI.
// GET /admin/text2sql/features · POST {name, enabled}
func (s *Server) handleText2SQLFeatures(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		features := make([]map[string]any, 0, len(t2sKnownFeatures))
		for _, f := range t2sKnownFeatures {
			features = append(features, map[string]any{"name": f.Name, "description": f.Description, "enabled": s.t2sFeatureOn(f.Name)})
		}
		writeJSON(w, http.StatusOK, map[string]any{"features": features})
	case http.MethodPost:
		var p struct {
			Name    string `json:"name"`
			Enabled bool   `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		known := false
		for _, f := range t2sKnownFeatures {
			if f.Name == p.Name {
				known = true
				break
			}
		}
		if !known {
			writeOpenAIError(w, http.StatusBadRequest, "unknown feature: "+p.Name, "invalid_request_error", "unknown_feature")
			return
		}
		if err := s.db.SetText2SQLFeatureFlag(r.Context(), p.Name, p.Enabled); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "feature_save_failed")
			return
		}
		s.reloadText2SQLFeatures(r.Context())
		s.auditAdmin(r, "text2sql.feature.toggle", "", auditJSON(map[string]any{"name": p.Name, "enabled": p.Enabled}))
		writeJSON(w, http.StatusOK, map[string]any{"name": p.Name, "enabled": p.Enabled})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleText2SQLPromote promotes a recurring question (typically surfaced by Prompt DNA
// or the report miner) into a reusable asset: a saved report/dashboard card, a golden
// query, or a business-glossary term. One endpoint, target-selected.
// POST /admin/text2sql/promote {target: report|golden|glossary, ...}
func (s *Server) handleText2SQLPromote(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var p struct {
		Target     string `json:"target"`
		Name       string `json:"name"`
		Question   string `json:"question"`
		SQL        string `json:"sql"`
		SchemaName string `json:"schema_name"`
		Kind       string `json:"kind"`
		Term       string `json:"term"`
		Mapping    string `json:"mapping"`
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	switch strings.ToLower(strings.TrimSpace(p.Target)) {
	case "report":
		if strings.TrimSpace(p.Name) == "" || strings.TrimSpace(p.Question) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "name and question are required for a report", "invalid_request_error", "missing_fields")
			return
		}
		rep := store.Text2SQLSavedReport{
			ID: newID("t2srpt"), Name: strings.TrimSpace(p.Name), Question: strings.TrimSpace(p.Question),
			SQL: strings.TrimSpace(p.SQL), SchemaName: strings.TrimSpace(p.SchemaName), Kind: strings.TrimSpace(p.Kind),
		}
		if err := s.db.UpsertText2SQLSavedReport(r.Context(), rep); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "promote_failed")
			return
		}
		s.auditAdmin(r, "text2sql.promote.report", "", auditJSON(rep))
		writeJSON(w, http.StatusCreated, map[string]any{"target": "report", "report": rep})
	case "golden":
		if strings.TrimSpace(p.Question) == "" || strings.TrimSpace(p.SQL) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "question and sql are required for a golden query", "invalid_request_error", "missing_fields")
			return
		}
		name := firstNonEmpty(strings.TrimSpace(p.Name), truncateForName(p.Question))
		g := store.Text2SQLGoldenQuery{
			ID: newID("t2sg"), Name: name, Question: strings.TrimSpace(p.Question), ExpectedSQL: strings.TrimSpace(p.SQL),
			SchemaName: strings.TrimSpace(p.SchemaName), Enabled: true, Source: "manual",
		}
		if err := s.db.UpsertText2SQLGoldenQuery(r.Context(), g); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "promote_failed")
			return
		}
		s.auditAdmin(r, "text2sql.promote.golden", "", auditJSON(map[string]any{"id": g.ID, "name": g.Name}))
		writeJSON(w, http.StatusCreated, map[string]any{"target": "golden", "golden": g})
	case "glossary":
		if strings.TrimSpace(p.Term) == "" || strings.TrimSpace(p.Mapping) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "term and mapping are required for a glossary entry", "invalid_request_error", "missing_fields")
			return
		}
		t := store.Text2SQLBusinessTerm{
			ID: newID("t2sbt"), SchemaName: strings.TrimSpace(p.SchemaName), Term: strings.TrimSpace(p.Term),
			Mapping: strings.TrimSpace(p.Mapping),
		}
		if err := s.db.UpsertText2SQLBusinessTerm(r.Context(), t); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "promote_failed")
			return
		}
		s.auditAdmin(r, "text2sql.promote.glossary", "", auditJSON(t))
		writeJSON(w, http.StatusCreated, map[string]any{"target": "glossary", "term": t})
	default:
		writeOpenAIError(w, http.StatusBadRequest, "target must be report, golden, or glossary", "invalid_request_error", "invalid_target")
	}
}

// handleText2SQLReports lists/deletes saved reports promoted from questions.
// GET /admin/text2sql/reports · DELETE ?id=
func (s *Server) handleText2SQLReports(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		reports, err := s.db.ListText2SQLSavedReports(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "reports_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"reports": reports})
	case http.MethodPost:
		// Configure a report's schedule. interval is a Go duration ("24h", "1h"); empty
		// or enabled=false leaves it manual-only.
		var p struct {
			ID                string `json:"id"`
			Interval          string `json:"interval"`
			Enabled           bool   `json:"enabled"`
			DeliverMattermost bool   `json:"deliver_mattermost"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil || strings.TrimSpace(p.ID) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "id is required", "invalid_request_error", "missing_id")
			return
		}
		if iv := strings.TrimSpace(p.Interval); iv != "" {
			if d, err := time.ParseDuration(iv); err != nil || d <= 0 {
				writeOpenAIError(w, http.StatusBadRequest, "interval must be a positive duration like 24h", "invalid_request_error", "invalid_interval")
				return
			}
		}
		if err := s.db.SetText2SQLReportSchedule(r.Context(), strings.TrimSpace(p.ID), strings.TrimSpace(p.Interval), p.Enabled, p.DeliverMattermost); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "schedule_failed")
			return
		}
		s.auditAdmin(r, "text2sql.report.schedule", "", auditJSON(p))
		writeJSON(w, http.StatusOK, map[string]any{"id": p.ID, "interval": p.Interval, "enabled": p.Enabled, "deliver_mattermost": p.DeliverMattermost})
	case http.MethodDelete:
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		if id == "" {
			writeOpenAIError(w, http.StatusBadRequest, "id query param is required", "invalid_request_error", "missing_id")
			return
		}
		if err := s.db.DeleteText2SQLSavedReport(r.Context(), id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "report_delete_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "deleted"})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// truncateForName derives a short name from a question for a promoted golden query.
func truncateForName(q string) string {
	q = strings.Join(strings.Fields(q), " ")
	if len(q) > 60 {
		return q[:60]
	}
	return q
}

// handleText2SQLPromptDNA profiles recurring questions over a window — frequency,
// distinct users, average cost, and reject/exec rates — labeling repeated, high-cost,
// and risky patterns. Read-only.
// GET /admin/text2sql/prompt-dna?window=30d&min_count=3
func (s *Server) handleText2SQLPromptDNA(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")
	minCount := 3
	if v := strings.TrimSpace(r.URL.Query().Get("min_count")); v != "" {
		if n := atoiDefault(v, 3); n >= 2 {
			minCount = n
		}
	}
	dna, err := s.db.Text2SQLPromptDNAReport(r.Context(), since, minCount, 100)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "prompt_dna_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"prompt_dna": dna})
}

// handleText2SQLAnomalies returns detection-only behavioral signals over the question
// logs: usage smells (repetition / permission probing / broad-scope requests),
// per-team cumulative risk exposure, and intent-drift flags. Nothing here blocks a
// request — it is purely for operator visibility.
// GET /admin/text2sql/anomalies?window=7d
func (s *Server) handleText2SQLAnomalies(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 7*24*time.Hour, "day")
	smells, err := s.db.Text2SQLUsageSmells(r.Context(), since, 0, 0)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "smell_detect_failed")
		return
	}
	exposure, err := s.db.Text2SQLRiskExposureByTeam(r.Context(), since)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "risk_exposure_failed")
		return
	}
	drifts, err := s.db.Text2SQLIntentDrifts(r.Context(), since)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "intent_drift_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"detection_only": true,
		"usage_smells":   smells,
		"risk_exposure":  exposure,
		"intent_drifts":  drifts,
	})
}

// handleText2SQLKillSwitch reads or toggles the runtime Text2SQL kill switch. When
// engaged, vibe/text2sql-* requests return a safe "temporarily disabled" message
// without generating or executing any SQL — for incident/cost/security response.
// GET /admin/text2sql/kill-switch · POST {disabled: bool}
func (s *Server) handleText2SQLKillSwitch(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{"disabled": s.t2sKilled.Load(), "config_enabled": s.cfg.Text2SQL.Enabled})
	case http.MethodPost:
		var p struct {
			Disabled bool `json:"disabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		s.t2sKilled.Store(p.Disabled)
		s.auditAdmin(r, "text2sql.kill_switch", "", auditJSON(map[string]any{"disabled": p.Disabled}))
		writeJSON(w, http.StatusOK, map[string]any{"disabled": p.Disabled})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleText2SQLSchemaImpact reports what depends on a schema (golden queries, cache,
// glossary, permissions) — the blast radius of a schema version change.
// GET /admin/text2sql/schema-impact?schema=NAME
func (s *Server) handleText2SQLSchemaImpact(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	schema := strings.TrimSpace(r.URL.Query().Get("schema"))
	if schema == "" {
		writeOpenAIError(w, http.StatusBadRequest, "schema query param is required", "invalid_request_error", "missing_schema")
		return
	}
	rep, err := s.db.Text2SQLSchemaImpact(r.Context(), schema)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "schema_impact_failed")
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

// handleText2SQLReplay returns the stored replay bundle (full generation context) for a
// query, by query log ID or request ID. Available only when replay bundles are enabled.
// GET /admin/text2sql/replay?id=... (or ?request_id=...)
func (s *Server) handleText2SQLReplay(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	key := strings.TrimSpace(r.URL.Query().Get("id"))
	if key == "" {
		key = strings.TrimSpace(r.URL.Query().Get("request_id"))
	}
	if key == "" {
		writeOpenAIError(w, http.StatusBadRequest, "id or request_id is required", "invalid_request_error", "missing_id")
		return
	}
	bundle, found, err := s.db.GetText2SQLReplayBundle(r.Context(), key)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "replay_failed")
		return
	}
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]any{"found": false, "enabled": s.cfg.Text2SQL.ReplayBundles, "detail": "no replay bundle for this id (enable TEXT2SQL_REPLAY_BUNDLES to capture)"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"found": true, "bundle": bundle})
}

// handleText2SQLGlossary manages the business-term glossary.
// GET /admin/text2sql/glossary[?schema=] · POST {schema_name,term,mapping,description} · DELETE ?id=
func (s *Server) handleText2SQLGlossary(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		schema := strings.TrimSpace(r.URL.Query().Get("schema"))
		terms, err := s.db.ListText2SQLBusinessTerms(r.Context(), schema)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "glossary_failed")
			return
		}
		conflicts, _ := s.db.DetectGlossaryConflicts(r.Context(), schema)
		writeJSON(w, http.StatusOK, map[string]any{"terms": terms, "conflicts": conflicts})
	case http.MethodPost:
		var p struct{ SchemaName, Term, Mapping, Description string }
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		if strings.TrimSpace(p.Term) == "" || strings.TrimSpace(p.Mapping) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "term and mapping are required", "invalid_request_error", "missing_fields")
			return
		}
		t := store.Text2SQLBusinessTerm{
			ID: newID("t2sbt"), SchemaName: strings.TrimSpace(p.SchemaName), Term: strings.TrimSpace(p.Term),
			Mapping: strings.TrimSpace(p.Mapping), Description: strings.TrimSpace(p.Description),
		}
		if err := s.db.UpsertText2SQLBusinessTerm(r.Context(), t); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "glossary_save_failed")
			return
		}
		s.auditAdmin(r, "text2sql.glossary.upsert", "", auditJSON(t))
		writeJSON(w, http.StatusCreated, map[string]any{"term": t})
	case http.MethodDelete:
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		if id == "" {
			writeOpenAIError(w, http.StatusBadRequest, "id query param is required", "invalid_request_error", "missing_id")
			return
		}
		if err := s.db.DeleteText2SQLBusinessTerm(r.Context(), id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "glossary_delete_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "deleted"})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleText2SQLPermissions manages the access matrix (subject × schema/table/column × allow/deny).
// GET /admin/text2sql/permissions · POST {subject_type,subject_id,schema_name,table_name,column_name,action} · DELETE ?id=
func (s *Server) handleText2SQLPermissions(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		list, err := s.db.ListText2SQLPermissions(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "permissions_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"permissions": list})
	case http.MethodPost:
		var p struct {
			SubjectType, SubjectID, SchemaName, TableName, ColumnName, Action string
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		st := strings.ToLower(strings.TrimSpace(p.SubjectType))
		if st != "team" && st != "api_key" && st != "user" && st != "*" {
			writeOpenAIError(w, http.StatusBadRequest, "subject_type must be team/api_key/user/*", "invalid_request_error", "invalid_subject")
			return
		}
		act := strings.ToLower(strings.TrimSpace(p.Action))
		if act != "allow" && act != "deny" {
			writeOpenAIError(w, http.StatusBadRequest, "action must be allow or deny", "invalid_request_error", "invalid_action")
			return
		}
		if st != "*" && strings.TrimSpace(p.SubjectID) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "subject_id is required unless subject_type=*", "invalid_request_error", "missing_subject_id")
			return
		}
		perm := store.Text2SQLPermission{
			ID: newID("t2sp"), SubjectType: st, SubjectID: firstNonEmpty(strings.TrimSpace(p.SubjectID), "*"),
			SchemaName: strings.TrimSpace(p.SchemaName), TableName: strings.TrimSpace(p.TableName), ColumnName: strings.TrimSpace(p.ColumnName), Action: act,
		}
		if err := s.db.UpsertText2SQLPermission(r.Context(), perm); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "permission_save_failed")
			return
		}
		s.auditAdmin(r, "text2sql.permission.upsert", "", auditJSON(perm))
		writeJSON(w, http.StatusCreated, map[string]any{"permission": perm})
	case http.MethodDelete:
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		if id == "" {
			writeOpenAIError(w, http.StatusBadRequest, "id query param is required", "invalid_request_error", "missing_id")
			return
		}
		if err := s.db.DeleteText2SQLPermission(r.Context(), id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "permission_delete_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "deleted"})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleText2SQLCollect auto-collects the table/column layout from the execute DB
// (information_schema / sqlite_master) into the registry under a schema name.
// POST /admin/text2sql/collect {schema_name, db_schema}
func (s *Server) handleText2SQLCollect(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if s.cfg.Text2SQL.ExecDSN == "" {
		writeOpenAIError(w, http.StatusBadRequest, "execute DB is not configured (TEXT2SQL_EXEC_DSN)", "invalid_request_error", "no_exec_db")
		return
	}
	var p struct {
		SchemaName string `json:"schema_name"`
		DBSchema   string `json:"db_schema"`
	}
	_ = json.NewDecoder(r.Body).Decode(&p)
	if strings.TrimSpace(p.SchemaName) == "" {
		writeOpenAIError(w, http.StatusBadRequest, "schema_name is required", "invalid_request_error", "missing_schema")
		return
	}
	db, err := s.text2sqlExecDB()
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, "exec DB open failed: "+err.Error(), "server_error", "exec_db_failed")
		return
	}
	tables, cols, err := s.db.CollectInformationSchema(r.Context(), db, s.cfg.Text2SQL.ExecDriver, strings.TrimSpace(p.DBSchema), strings.TrimSpace(p.SchemaName))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "collect_failed")
		return
	}
	s.auditAdmin(r, "text2sql.schema.collect", "", auditJSON(map[string]any{"schema": p.SchemaName, "added_tables": tables, "added_columns": cols}))
	writeJSON(w, http.StatusOK, map[string]any{"schema_name": p.SchemaName, "added_tables": tables, "added_columns": cols})
}

// handleText2SQLProfiles manages runtime virtual-model profiles (DB overrides of the
// env defaults; can also define new virtual models).
// GET /admin/text2sql/profiles · POST {virtual_model,mode,upstream_model,summary_model,schema_name,enabled} · DELETE ?virtual_model=
func (s *Server) handleText2SQLProfiles(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		list, err := s.db.ListText2SQLProfiles(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "profiles_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"profiles": list})
	case http.MethodPost:
		var p struct {
			VirtualModel  string `json:"virtual_model"`
			Mode          string `json:"mode"`
			UpstreamModel string `json:"upstream_model"`
			SummaryModel  string `json:"summary_model"`
			SchemaName    string `json:"schema_name"`
			Enabled       *bool  `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		vm := strings.ToLower(strings.TrimSpace(p.VirtualModel))
		if !text2sql.IsModel(vm) {
			writeOpenAIError(w, http.StatusBadRequest, "virtual_model must start with vibe/text2sql", "invalid_request_error", "invalid_virtual_model")
			return
		}
		mode := strings.ToLower(strings.TrimSpace(p.Mode))
		if mode != "" && mode != "preview" && mode != "execute" {
			writeOpenAIError(w, http.StatusBadRequest, "mode must be preview or execute", "invalid_request_error", "invalid_mode")
			return
		}
		prof := store.Text2SQLProfile{
			VirtualModel: vm, Mode: mode, UpstreamModel: strings.TrimSpace(p.UpstreamModel),
			SummaryModel: strings.TrimSpace(p.SummaryModel), SchemaName: strings.TrimSpace(p.SchemaName), Enabled: true,
		}
		if p.Enabled != nil {
			prof.Enabled = *p.Enabled
		}
		if err := s.db.UpsertText2SQLProfile(r.Context(), prof); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "profile_save_failed")
			return
		}
		s.auditAdmin(r, "text2sql.profile.upsert", "", auditJSON(prof))
		writeJSON(w, http.StatusCreated, map[string]any{"profile": prof})
	case http.MethodDelete:
		vm := strings.TrimSpace(r.URL.Query().Get("virtual_model"))
		if vm == "" {
			writeOpenAIError(w, http.StatusBadRequest, "virtual_model query param is required", "invalid_request_error", "missing_virtual_model")
			return
		}
		if err := s.db.DeleteText2SQLProfile(r.Context(), vm); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "profile_delete_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"virtual_model": vm, "status": "deleted"})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleText2SQLGolden manages verified Text2SQL golden queries (few-shot + regression).
// GET /admin/text2sql/golden · POST {name,question,expected_sql,schema_name,tags[],enabled} · DELETE ?id=
func (s *Server) handleText2SQLGolden(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	// /admin/text2sql/golden/run — regression replay.
	if strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/admin/text2sql/golden"), "/") == "/run" {
		s.handleText2SQLGoldenRun(w, r)
		return
	}
	switch r.Method {
	case http.MethodGet:
		list, err := s.db.ListText2SQLGoldenQueries(r.Context(), false)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "golden_list_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"golden": list})
	case http.MethodPost:
		var p struct {
			ID          string   `json:"id"`
			Name        string   `json:"name"`
			Question    string   `json:"question"`
			ExpectedSQL string   `json:"expected_sql"`
			SchemaName  string   `json:"schema_name"`
			Tags        []string `json:"tags"`
			Enabled     *bool    `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		if strings.TrimSpace(p.Name) == "" || strings.TrimSpace(p.Question) == "" || strings.TrimSpace(p.ExpectedSQL) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "name, question, expected_sql are required", "invalid_request_error", "missing_fields")
			return
		}
		g := store.Text2SQLGoldenQuery{
			ID: firstNonEmpty(strings.TrimSpace(p.ID), newID("t2sg")), Name: strings.TrimSpace(p.Name),
			Question: strings.TrimSpace(p.Question), ExpectedSQL: strings.TrimSpace(p.ExpectedSQL),
			SchemaName: strings.TrimSpace(p.SchemaName), Tags: p.Tags, Enabled: true,
		}
		if p.Enabled != nil {
			g.Enabled = *p.Enabled
		}
		if err := s.db.UpsertText2SQLGoldenQuery(r.Context(), g); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "golden_save_failed")
			return
		}
		s.auditAdmin(r, "text2sql.golden.upsert", "", auditJSON(map[string]string{"id": g.ID, "name": g.Name}))
		writeJSON(w, http.StatusCreated, map[string]any{"golden": g})
	case http.MethodDelete:
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		if id == "" {
			writeOpenAIError(w, http.StatusBadRequest, "id query param is required", "invalid_request_error", "missing_id")
			return
		}
		if err := s.db.DeleteText2SQLGoldenQuery(r.Context(), id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "golden_delete_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": "deleted"})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleText2SQLGoldenRun replays golden queries against a model: it regenerates SQL
// and checks that it validates and contains the expected SQL's key tokens.
// POST /admin/text2sql/golden/run {model}
func (s *Server) handleText2SQLGoldenRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var p struct {
		Model string `json:"model"`
	}
	_ = json.NewDecoder(r.Body).Decode(&p)
	model := firstNonEmpty(strings.TrimSpace(p.Model), s.cfg.Text2SQL.PreviewModel)
	// Result-equivalence: execute both expected and generated SQL read-only and compare
	// the row sets, catching semantically-wrong SQL that token matching passes. When an
	// execute DB is configured this is the DEFAULT (the authoritative CI signal); pass
	// ?execute=0 to force token-only matching. With no execute DB it is unavailable.
	wantExec := s.cfg.Text2SQL.ExecDSN != "" && r.URL.Query().Get("execute") != "0"

	goldens, err := s.db.ListText2SQLGoldenQueries(r.Context(), true)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "golden_list_failed")
		return
	}
	results := []map[string]any{}
	passed, resultChecked, resultMatched := 0, 0, 0
	for _, g := range goldens {
		schema := s.cfg.Text2SQL.Schema
		if g.SchemaName != "" {
			if sc, found, _ := s.db.ResolveText2SQLSchema(r.Context(), g.SchemaName, ""); found {
				schema = sc.SchemaText
			}
		}
		msgs := text2sql.MessagesJSON(text2sql.BuildGenerationMessages(s.cfg.Text2SQL.Dialect, schema, g.Question, s.cfg.Text2SQL.DefaultLimit))
		gen := s.runGovernanceChat(r.Context(), r, model, msgs)
		genSQL := text2sql.ExtractSQL(gen.Response)
		validation := text2sql.ValidateSQL(genSQL, text2sql.ValidateOptions{DefaultLimit: s.cfg.Text2SQL.DefaultLimit, MaxLimit: s.cfg.Text2SQL.MaxLimit})
		tokenOK := validation.OK && goldenSQLMatch(g.ExpectedSQL, genSQL)
		row := map[string]any{
			"id": g.ID, "name": g.Name, "valid": validation.OK,
			"generated_sql": genSQL, "reject_reason": validation.Reason, "token_match": tokenOK,
		}
		ok := tokenOK
		if wantExec && validation.OK {
			match, detail := s.goldenResultEquivalent(r.Context(), validation.SQL, g.ExpectedSQL)
			resultChecked++
			row["result_match"] = match
			if detail != "" {
				row["result_detail"] = detail
			}
			if match {
				resultMatched++
			}
			// With execution enabled, result equivalence is the authority; token match
			// is reported but a true result match passes even if tokens drift.
			ok = match
		}
		row["passed"] = ok
		if ok {
			passed++
		}
		results = append(results, row)
	}
	rate := 1.0
	if len(goldens) > 0 {
		rate = float64(passed) / float64(len(goldens))
	}
	resp := map[string]any{
		"model": model, "total": len(goldens), "passed": passed, "pass_rate": rate, "results": results,
	}
	if wantExec {
		resp["result_checked"] = resultChecked
		resp["result_matched"] = resultMatched
	}
	s.auditAdmin(r, "text2sql.golden.run", "", auditJSON(map[string]any{"model": model, "total": len(goldens), "passed": passed, "execute": wantExec}))
	writeJSON(w, http.StatusOK, resp)
}

// goldenResultEquivalent executes the generated and expected SQL read-only and reports
// whether they return the same rows (order-insensitive multiset). Returns (match, detail)
// where detail explains a mismatch or execution error.
func (s *Server) goldenResultEquivalent(ctx context.Context, generatedSQL, expectedSQL string) (bool, string) {
	db, driver, err := s.text2sqlValidationDB()
	if err != nil {
		return false, "validation db: " + err.Error()
	}
	rowCap := s.cfg.Text2SQL.MaxLimit
	if rowCap <= 0 {
		rowCap = 1000
	}
	expValid := text2sql.ValidateSQL(expectedSQL, text2sql.ValidateOptions{DefaultLimit: s.cfg.Text2SQL.DefaultLimit, MaxLimit: s.cfg.Text2SQL.MaxLimit})
	if !expValid.OK {
		return false, "expected SQL invalid: " + expValid.Reason
	}
	gCols, gRows, _, gErr := executeReadOnlyQuery(ctx, db, driver, generatedSQL, rowCap, s.cfg.Text2SQL.StatementTimeout, s.cfg.Text2SQL.WorkMem)
	if gErr != nil {
		return false, "generated exec: " + gErr.Error()
	}
	eCols, eRows, _, eErr := executeReadOnlyQuery(ctx, db, driver, expValid.SQL, rowCap, s.cfg.Text2SQL.StatementTimeout, s.cfg.Text2SQL.WorkMem)
	if eErr != nil {
		return false, "expected exec: " + eErr.Error()
	}
	if len(gCols) != len(eCols) {
		return false, fmt.Sprintf("column count differs (%d vs %d)", len(gCols), len(eCols))
	}
	if !resultSetsEqual(gRows, eRows) {
		return false, fmt.Sprintf("row sets differ (%d vs %d rows)", len(gRows), len(eRows))
	}
	return true, ""
}

// resultSetsEqual compares two result sets as multisets of rows (order-insensitive),
// so equivalent queries with different ORDER BY still match.
func resultSetsEqual(a, b [][]string) bool {
	if len(a) != len(b) {
		return false
	}
	counts := map[string]int{}
	for _, row := range a {
		counts[strings.Join(row, "\x1f")]++
	}
	for _, row := range b {
		k := strings.Join(row, "\x1f")
		counts[k]--
		if counts[k] < 0 {
			return false
		}
	}
	for _, v := range counts {
		if v != 0 {
			return false
		}
	}
	return true
}

// handleText2SQLSchemas manages the Text2SQL schema catalog (schema context + table
// allowlist + team scope).
// GET /admin/text2sql/schemas · POST {name,team,dialect,schema_text,allowed_tables[],is_default,enabled} · DELETE ?name=
func (s *Server) handleText2SQLSchemas(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		schemas, err := s.db.ListText2SQLSchemas(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "text2sql_schemas_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"schemas": schemas})
	case http.MethodPost:
		var p struct {
			Name          string   `json:"name"`
			Team          string   `json:"team"`
			Dialect       string   `json:"dialect"`
			SchemaText    string   `json:"schema_text"`
			AllowedTables []string `json:"allowed_tables"`
			IsDefault     *bool    `json:"is_default"`
			Enabled       *bool    `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		p.Name = strings.TrimSpace(p.Name)
		if p.Name == "" || strings.TrimSpace(p.SchemaText) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "name and schema_text are required", "invalid_request_error", "missing_fields")
			return
		}
		sc := store.Text2SQLSchema{
			Name: p.Name, Team: strings.TrimSpace(p.Team), Dialect: strings.TrimSpace(p.Dialect),
			SchemaText: p.SchemaText, AllowedTables: p.AllowedTables, Enabled: true,
		}
		if p.Enabled != nil {
			sc.Enabled = *p.Enabled
		}
		if p.IsDefault != nil {
			sc.IsDefault = *p.IsDefault
		}
		if err := s.db.UpsertText2SQLSchema(r.Context(), sc); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "text2sql_schema_save_failed")
			return
		}
		s.auditAdmin(r, "text2sql.schema.upsert", "", auditJSON(map[string]any{"name": sc.Name, "team": sc.Team, "tables": len(sc.AllowedTables)}))
		writeJSON(w, http.StatusCreated, map[string]any{"schema": sc})
	case http.MethodDelete:
		name := strings.TrimSpace(r.URL.Query().Get("name"))
		if name == "" {
			writeOpenAIError(w, http.StatusBadRequest, "name query param is required", "invalid_request_error", "missing_name")
			return
		}
		if err := s.db.DeleteText2SQLSchema(r.Context(), name); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "text2sql_schema_delete_failed")
			return
		}
		s.auditAdmin(r, "text2sql.schema.delete", auditJSON(map[string]string{"name": name}), "")
		writeJSON(w, http.StatusOK, map[string]string{"name": name, "status": "deleted"})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}
