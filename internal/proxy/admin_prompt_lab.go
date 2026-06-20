package proxy

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

// ── output contract validation ───────────────────────────────────────────────

// validateOutputContract checks a model response against a contract and returns whether it
// passes plus any human-readable errors. Supported types: json / json_schema (lite: required
// keys + scalar types), markdown_table, sql (SELECT-only), regex.
func validateOutputContract(c store.PromptContract, output string) (bool, []string) {
	out := strings.TrimSpace(output)
	switch strings.ToLower(c.Type) {
	case "json", "json_schema":
		return validateJSONContract(c, out)
	case "markdown_table", "table":
		if hasMarkdownTable(out) {
			return true, nil
		}
		return false, []string{"마크다운 표를 찾을 수 없습니다"}
	case "sql":
		return validateSQLContract(out)
	case "regex":
		re, err := regexp.Compile(c.SchemaJSON)
		if err != nil {
			return false, []string{"잘못된 정규식 계약: " + err.Error()}
		}
		if re.MatchString(out) {
			return true, nil
		}
		return false, []string{"정규식과 일치하지 않습니다"}
	default:
		return false, []string{"알 수 없는 계약 유형: " + c.Type}
	}
}

func stripCodeFence(s string) string {
	if m := jsonFenceRe.FindStringSubmatch(s); len(m) == 2 {
		return strings.TrimSpace(m[1])
	}
	return s
}

type jsonSchemaLite struct {
	Required   []string          `json:"required"`
	Properties map[string]string `json:"properties"` // field -> expected type (string/number/boolean/array/object)
}

func validateJSONContract(c store.PromptContract, output string) (bool, []string) {
	raw := stripCodeFence(output)
	var obj map[string]any
	if err := json.Unmarshal([]byte(raw), &obj); err != nil {
		return false, []string{"유효한 JSON 객체가 아닙니다: " + err.Error()}
	}
	if strings.TrimSpace(c.SchemaJSON) == "" {
		return true, nil // valid-JSON-only contract
	}
	var sch jsonSchemaLite
	if err := json.Unmarshal([]byte(c.SchemaJSON), &sch); err != nil {
		return false, []string{"잘못된 schema_json: " + err.Error()}
	}
	errs := []string{}
	for _, req := range sch.Required {
		if _, ok := obj[req]; !ok {
			errs = append(errs, "필수 필드 누락: "+req)
		}
	}
	for field, want := range sch.Properties {
		v, ok := obj[field]
		if !ok {
			continue // presence covered by required
		}
		if got := jsonTypeOf(v); want != "" && got != want {
			errs = append(errs, "필드 "+field+" 타입 불일치(기대 "+want+", 실제 "+got+")")
		}
	}
	return len(errs) == 0, errs
}

func jsonTypeOf(v any) string {
	switch v.(type) {
	case string:
		return "string"
	case bool:
		return "boolean"
	case float64:
		return "number"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	case nil:
		return "null"
	}
	return "unknown"
}

var sqlForbidden = regexp.MustCompile(`(?i)\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|MERGE)\b`)

func validateSQLContract(output string) (bool, []string) {
	sql := stripCodeFence(output)
	upper := strings.ToUpper(strings.TrimSpace(sql))
	if !strings.HasPrefix(upper, "SELECT") && !strings.HasPrefix(upper, "WITH") {
		return false, []string{"SELECT/WITH로 시작하는 읽기 전용 쿼리가 아닙니다"}
	}
	if sqlForbidden.MatchString(sql) {
		return false, []string{"쓰기/DDL 구문이 포함되어 있습니다"}
	}
	return true, nil
}

// ── experiments / rubrics / contracts CRUD ──────────────────────────────────

func (s *Server) handlePromptLabExperiments(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		exps, err := s.db.ListPromptExperiments(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "list_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"experiments": exps})
	case http.MethodPost:
		var p struct {
			Title       string `json:"title"`
			Description string `json:"description"`
			Team        string `json:"team"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil || strings.TrimSpace(p.Title) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "title is required", "invalid_request_error", "bad_request")
			return
		}
		e := store.PromptExperiment{ID: newID("pexp"), Title: strings.TrimSpace(p.Title), Description: p.Description, Team: strings.TrimSpace(p.Team), Owner: s.skillActor(r), Status: "active"}
		if e.Team == "" {
			if claims, ok := s.currentAccessClaims(r); ok {
				e.Team = claims.TeamID
			}
		}
		if err := s.db.CreatePromptExperiment(r.Context(), e); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "create_failed")
			return
		}
		s.auditAdmin(r, "prompt_lab.experiment_create", e.ID, auditJSON(map[string]any{"title": e.Title}))
		writeJSON(w, http.StatusCreated, e)
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) handlePromptLabExperimentByID(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/admin/prompt-lab/experiments/")
	if id == "" {
		writeOpenAIError(w, http.StatusBadRequest, "experiment id required", "invalid_request_error", "bad_request")
		return
	}
	switch r.Method {
	case http.MethodGet:
		exp, found, err := s.db.GetPromptExperiment(r.Context(), id)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "get_failed")
			return
		}
		if !found {
			writeOpenAIError(w, http.StatusNotFound, "experiment not found", "invalid_request_error", "not_found")
			return
		}
		cases, _ := s.db.ListPromptTestCases(r.Context(), id)
		writeJSON(w, http.StatusOK, map[string]any{"experiment": exp, "test_cases": cases})
	case http.MethodPatch:
		var p struct {
			Status string `json:"status"`
		}
		_ = json.NewDecoder(r.Body).Decode(&p)
		if p.Status != "active" && p.Status != "archived" {
			writeOpenAIError(w, http.StatusBadRequest, "status must be active|archived", "invalid_request_error", "bad_status")
			return
		}
		if err := s.db.UpdatePromptExperimentStatus(r.Context(), id, p.Status); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "update_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"status": p.Status})
	case http.MethodDelete:
		if err := s.db.DeletePromptExperiment(r.Context(), id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "delete_failed")
			return
		}
		s.auditAdmin(r, "prompt_lab.experiment_delete", id, "")
		writeJSON(w, http.StatusOK, map[string]any{"status": "deleted"})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) handlePromptLabRubrics(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		rbs, err := s.db.ListPromptRubrics(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "list_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"rubrics": rbs})
	case http.MethodPost:
		var p struct {
			Name     string `json:"name"`
			Criteria any    `json:"criteria"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil || strings.TrimSpace(p.Name) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "name is required", "invalid_request_error", "bad_request")
			return
		}
		cj, _ := json.Marshal(p.Criteria)
		rb := store.PromptRubric{ID: newID("prub"), Name: strings.TrimSpace(p.Name), CriteriaJSON: string(cj), CreatedBy: s.skillActor(r)}
		if err := s.db.CreatePromptRubric(r.Context(), rb); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "create_failed")
			return
		}
		writeJSON(w, http.StatusCreated, rb)
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) handlePromptLabContracts(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		cs, err := s.db.ListPromptContracts(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "list_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"contracts": cs})
	case http.MethodPost:
		var p struct {
			Name   string `json:"name"`
			Type   string `json:"type"`
			Schema string `json:"schema_json"`
			Strict bool   `json:"strict"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil || strings.TrimSpace(p.Name) == "" || strings.TrimSpace(p.Type) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "name and type are required", "invalid_request_error", "bad_request")
			return
		}
		c := store.PromptContract{ID: newID("pctr"), Name: strings.TrimSpace(p.Name), Type: strings.TrimSpace(p.Type), SchemaJSON: p.Schema, Strict: p.Strict, CreatedBy: s.skillActor(r)}
		if err := s.db.CreatePromptContract(r.Context(), c); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "create_failed")
			return
		}
		writeJSON(w, http.StatusCreated, c)
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// ── test cases ───────────────────────────────────────────────────────────────

func (s *Server) handlePromptLabTestCases(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var p struct {
		ExperimentID string           `json:"experiment_id"`
		Name         string           `json:"name"`
		Messages     []map[string]any `json:"messages"`
		RubricID     string           `json:"rubric_id"`
		ContractID   string           `json:"contract_id"`
		Models       []string         `json:"models"`
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "bad_request")
		return
	}
	if strings.TrimSpace(p.ExperimentID) == "" || strings.TrimSpace(p.Name) == "" || len(p.Messages) == 0 {
		writeOpenAIError(w, http.StatusBadRequest, "experiment_id, name, messages are required", "invalid_request_error", "bad_request")
		return
	}
	msgJSON, _ := json.Marshal(p.Messages)
	modelsJSON, _ := json.Marshal(p.Models)
	tc := store.PromptTestCase{
		ID: newID("ptc"), ExperimentID: p.ExperimentID, Name: strings.TrimSpace(p.Name),
		MessagesJSON: string(msgJSON), MessagesHash: audit.HashText(string(msgJSON)),
		RubricID: p.RubricID, ContractID: p.ContractID, ModelsJSON: string(modelsJSON), CreatedBy: s.skillActor(r),
	}
	if err := s.db.CreatePromptTestCase(r.Context(), tc); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "create_failed")
		return
	}
	s.auditAdmin(r, "prompt_lab.test_case_create", tc.ID, auditJSON(map[string]any{"experiment": p.ExperimentID, "name": tc.Name}))
	writeJSON(w, http.StatusCreated, tc)
}

func (s *Server) handlePromptLabTestCaseByID(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/admin/prompt-lab/test-cases/")
	id := rest
	action := ""
	if idx := strings.Index(rest, "/"); idx >= 0 {
		id, action = rest[:idx], rest[idx+1:]
	}
	if id == "" {
		writeOpenAIError(w, http.StatusBadRequest, "test case id required", "invalid_request_error", "bad_request")
		return
	}
	if action == "run" && r.Method == http.MethodPost {
		s.handlePromptLabTestCaseRun(w, r, id)
		return
	}
	switch r.Method {
	case http.MethodGet:
		tc, found, err := s.db.GetPromptTestCase(r.Context(), id)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "get_failed")
			return
		}
		if !found {
			writeOpenAIError(w, http.StatusNotFound, "test case not found", "invalid_request_error", "not_found")
			return
		}
		history, _ := s.db.ListPromptTestCaseRuns(r.Context(), id, 30)
		writeJSON(w, http.StatusOK, map[string]any{"test_case": tc, "history": history})
	case http.MethodDelete:
		if err := s.db.DeletePromptTestCase(r.Context(), id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "delete_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"status": "deleted"})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}
