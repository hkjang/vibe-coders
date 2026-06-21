package proxy

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

	"vibe-coders/internal/store"
)

// metricSensitiveCols are column/keyword tokens that should not appear in a standard metric
// query — they expose raw content rather than aggregates.
var metricSensitiveCols = []string{
	"prompt_text", "response_text", "content_text", "redacted_text", "raw_body", "raw_prompt",
	"secret", "api_key", "password", "client_ip", "matched_hash", "arg_json",
}

var metricFromRe = regexp.MustCompile(`(?i)\b(?:from|join)\s+([a-zA-Z_][a-zA-Z0-9_.]*)`)

// validateMetricQuery runs static checks on a metric's query template: SELECT/WITH-only, no
// write/DDL, referenced tables resolve to known DW fact tables, and no sensitive columns.
func (s *Server) validateMetricQuery(query string) map[string]any {
	q := strings.TrimSpace(query)
	upper := strings.ToUpper(q)
	errs := []string{}
	warns := []string{}
	if !strings.HasPrefix(upper, "SELECT") && !strings.HasPrefix(upper, "WITH") {
		errs = append(errs, "쿼리는 SELECT/WITH로 시작해야 합니다(읽기 전용)")
	}
	if sqlForbidden.MatchString(q) {
		errs = append(errs, "쓰기/DDL 구문(INSERT/UPDATE/DELETE/DROP/…)이 포함되어 있습니다")
	}
	// Allowed tables = configured fact tables + common DW names.
	ch := s.chConf()
	allowed := map[string]bool{}
	for _, t := range []string{ch.RequestFactTable, ch.ToolFactTable, ch.RoutingFactTable, ch.EvalFactTable,
		ch.FeedbackFactTable, ch.PolicyFactTable, ch.SkillFactTable, ch.Text2SQLFactTable, ch.MultiModelFactTable} {
		if t = strings.TrimSpace(t); t != "" {
			allowed[strings.ToLower(t)] = true
		}
	}
	refs := []string{}
	unknown := []string{}
	for _, m := range metricFromRe.FindAllStringSubmatch(q, -1) {
		tbl := strings.ToLower(m[1])
		// Strip db prefix (db.table) and skip CTE/subquery aliases heuristically.
		if i := strings.LastIndex(tbl, "."); i >= 0 {
			tbl = tbl[i+1:]
		}
		refs = append(refs, tbl)
		if len(allowed) > 0 && !allowed[tbl] && !strings.HasPrefix(tbl, "ai_") {
			unknown = append(unknown, tbl)
		}
	}
	if len(unknown) > 0 {
		warns = append(warns, "표준 fact 테이블이 아닌 참조: "+strings.Join(unknown, ", "))
	}
	sensitive := []string{}
	lower := strings.ToLower(q)
	for _, c := range metricSensitiveCols {
		if strings.Contains(lower, c) {
			sensitive = append(sensitive, c)
		}
	}
	if len(sensitive) > 0 {
		errs = append(errs, "민감 컬럼/원문 참조: "+strings.Join(sensitive, ", "))
	}
	return map[string]any{
		"ok": len(errs) == 0, "errors": errs, "warnings": warns,
		"referenced_tables": refs, "sensitive_refs": sensitive,
		"note": "정적 검증입니다(ClickHouse 실행 비용은 별도). 표준 fact 테이블 + 집계 컬럼만 사용하세요.",
	}
}

// handleAdminMetrics lists or upserts DW metric-catalog entries. GET/POST /admin/dw/metrics
func (s *Server) handleAdminMetrics(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		ms, err := s.db.ListMetricCatalog(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "list_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"metrics": ms})
	case http.MethodPost:
		var p struct {
			MetricKey     string   `json:"metric_key"`
			NameKO        string   `json:"name_ko"`
			Description   string   `json:"description"`
			QueryTemplate string   `json:"query_template"`
			Dimensions    []string `json:"dimensions"`
			Owner         string   `json:"owner"`
			Sensitivity   string   `json:"sensitivity"`
			Enabled       bool     `json:"enabled"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil || strings.TrimSpace(p.MetricKey) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "metric_key is required", "invalid_request_error", "bad_request")
			return
		}
		// Block enabling a metric whose query fails static validation.
		v := s.validateMetricQuery(p.QueryTemplate)
		if p.Enabled && !v["ok"].(bool) {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
				"error":      map[string]any{"message": "검증 실패한 쿼리는 enabled로 저장할 수 없습니다", "type": "invalid_request_error", "code": "metric_invalid"},
				"validation": v,
			})
			return
		}
		m := store.MetricCatalogEntry{
			ID: newID("metric"), MetricKey: strings.TrimSpace(p.MetricKey), NameKO: p.NameKO, Description: p.Description,
			QueryTemplate: p.QueryTemplate, Dimensions: p.Dimensions, Owner: strings.TrimSpace(p.Owner),
			Sensitivity: strings.TrimSpace(p.Sensitivity), Enabled: p.Enabled, UpdatedBy: s.skillActor(r),
		}
		if err := s.db.UpsertMetricCatalog(r.Context(), m); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "save_failed")
			return
		}
		s.auditAdmin(r, "dw.metric_upsert", m.MetricKey, auditJSON(map[string]any{"enabled": m.Enabled}))
		writeJSON(w, http.StatusOK, map[string]any{"metric": m, "validation": v})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleAdminMetricByID serves DELETE /admin/dw/metrics/{id} and POST .../{id}/validate.
func (s *Server) handleAdminMetricByID(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/admin/dw/metrics/")
	id, action := rest, ""
	if idx := strings.Index(rest, "/"); idx >= 0 {
		id, action = rest[:idx], rest[idx+1:]
	}
	if id == "" {
		writeOpenAIError(w, http.StatusBadRequest, "metric id required", "invalid_request_error", "bad_request")
		return
	}
	if action == "validate" && r.Method == http.MethodPost {
		m, found, _ := s.db.GetMetricCatalog(r.Context(), id)
		if !found {
			writeOpenAIError(w, http.StatusNotFound, "metric not found", "invalid_request_error", "not_found")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"metric_key": m.MetricKey, "validation": s.validateMetricQuery(m.QueryTemplate)})
		return
	}
	if r.Method == http.MethodDelete {
		if err := s.db.DeleteMetricCatalog(r.Context(), id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "delete_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"status": "deleted"})
		return
	}
	writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
}
