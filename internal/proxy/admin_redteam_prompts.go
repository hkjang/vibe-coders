package proxy

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

// Manual Red Team prompt management (요건 §29 사용자 정의 프로브).
//
// Admins manage the probe prompts (cases) that a run sends: browse the seeded OWASP set, add/edit
// their own via the UI, and round-trip the whole catalogue as CSV (Excel-friendly) for bulk edits.
// Prompts are still stored as cases under a probe pack; import/export uses one row per case.

// redTeamProbeCSVHeader is the column order for probe-case CSV export/import. target_types and
// risk_tags are pipe(|)-separated inside their cell so the file stays valid CSV and easy to edit.
var redTeamProbeCSVHeader = []string{
	"pack_id", "pack_name", "category", "pack_severity", "requires_approval",
	"case_id", "case_key", "expected_policy", "evaluator_type", "severity",
	"target_types", "risk_tags", "input_template",
}

// handleRedTeamProbePacksSub serves the /admin/redteam/probe-packs/ subtree: CSV export and import.
func (s *Server) handleRedTeamProbePacksSub(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	action := strings.Trim(strings.TrimPrefix(r.URL.Path, "/admin/redteam/probe-packs/"), "/")
	switch {
	case action == "export" && r.Method == http.MethodGet:
		s.redTeamExportProbeCSV(w, r)
	case action == "import" && r.Method == http.MethodPost:
		s.redTeamImportProbeCSV(w, r)
	default:
		writeOpenAIError(w, http.StatusNotFound, "unknown probe-pack action", "invalid_request_error", "not_found")
	}
}

func (s *Server) redTeamExportProbeCSV(w http.ResponseWriter, r *http.Request) {
	if err := s.ensureDefaultRedTeamProbePacks(r.Context(), adminID(r)); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "redteam_seed_failed")
		return
	}
	packs, err := s.db.ListRedTeamProbePacks(r.Context(), true)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "redteam_packs_failed")
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="redteam-probe-prompts.csv"`)
	_, _ = w.Write([]byte{0xEF, 0xBB, 0xBF}) // UTF-8 BOM so Excel renders Korean correctly
	cw := csv.NewWriter(w)
	_ = cw.Write(redTeamProbeCSVHeader)
	for _, p := range packs {
		for _, c := range p.Cases {
			_ = cw.Write([]string{
				p.ID, p.Name, p.Category, p.Severity, boolStr(p.RequiresApproval),
				c.ID, c.CaseKey, c.ExpectedPolicy, c.EvaluatorType, c.Severity,
				strings.Join(c.TargetTypes, "|"), strings.Join(c.RiskTags, "|"), c.InputTemplate,
			})
		}
	}
	cw.Flush()
}

// redTeamImportProbeCSV upserts probe packs and cases from an uploaded CSV (same schema as export).
// It is idempotent: rows with a known case_id update in place; blank ids are derived deterministically
// so re-imports don't duplicate. Existing cases not present in the file are left untouched.
func (s *Server) redTeamImportProbeCSV(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "cannot read body", "invalid_request_error", "bad_body")
		return
	}
	// Accept a multipart "file" upload or a raw CSV body.
	body := string(raw)
	if ct := r.Header.Get("Content-Type"); strings.HasPrefix(ct, "multipart/form-data") {
		if err := r.ParseMultipartForm(8 << 20); err == nil {
			if f, _, ferr := r.FormFile("file"); ferr == nil {
				defer f.Close()
				if b, rerr := io.ReadAll(io.LimitReader(f, 8<<20)); rerr == nil {
					body = string(b)
				}
			}
		}
	}
	body = strings.TrimPrefix(body, "\uFEFF") // strip UTF-8 BOM if present
	cr := csv.NewReader(strings.NewReader(body))
	cr.FieldsPerRecord = -1
	records, err := cr.ReadAll()
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid CSV: "+err.Error(), "invalid_request_error", "invalid_csv")
		return
	}
	if len(records) < 2 {
		writeOpenAIError(w, http.StatusBadRequest, "CSV has no data rows (need a header + at least one row)", "invalid_request_error", "empty_csv")
		return
	}
	col := map[string]int{}
	for i, name := range records[0] {
		col[strings.TrimSpace(strings.ToLower(name))] = i
	}
	get := func(row []string, name string) string {
		if i, ok := col[name]; ok && i < len(row) {
			return strings.TrimSpace(row[i])
		}
		return ""
	}

	packsSeen := map[string]bool{}
	packCount, caseCount := 0, 0
	var skipped []string
	for n, row := range records[1:] {
		caseKey := get(row, "case_key")
		tmpl := get(row, "input_template")
		if caseKey == "" || tmpl == "" {
			skipped = append(skipped, fmt.Sprintf("row %d: case_key/input_template 필수", n+2))
			continue
		}
		packName := redTeamDefault(get(row, "pack_name"), "사용자 정의 프롬프트")
		packID := get(row, "pack_id")
		if packID == "" {
			packID = redTeamCustomPackID(packName)
		}
		if !packsSeen[packID] {
			sev := normalizeRedTeamSeverity(get(row, "pack_severity"))
			approval := redTeamTruthy(get(row, "requires_approval")) || severityRank(sev) >= severityRank("high")
			pack := store.RedTeamProbePack{
				ID: packID, Name: packName, Category: redTeamDefault(get(row, "category"), "custom"),
				Severity: sev, Version: "v1", Enabled: true, RequiresApproval: approval, CreatedBy: adminID(r),
			}
			if err := s.db.UpsertRedTeamProbePackWithCases(r.Context(), pack, nil); err != nil {
				writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "redteam_pack_save_failed")
				return
			}
			packsSeen[packID] = true
			packCount++
		}
		caseID := get(row, "case_id")
		if caseID == "" {
			caseID = redTeamCaseID(packID, caseKey)
		}
		c := store.RedTeamProbeCase{
			ID: caseID, PackID: packID, CaseKey: caseKey, InputTemplate: tmpl,
			ExpectedPolicy: redTeamDefault(get(row, "expected_policy"), "safe_completion"),
			EvaluatorType:  redTeamDefault(get(row, "evaluator_type"), "rule"),
			Severity:       normalizeRedTeamSeverity(get(row, "severity")),
			TargetTypes:    redTeamSplitPipe(get(row, "target_types")),
			RiskTags:       redTeamSplitPipe(get(row, "risk_tags")),
		}
		if err := s.db.UpsertRedTeamProbeCase(r.Context(), c); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "redteam_case_save_failed")
			return
		}
		caseCount++
	}
	s.auditAdmin(r, "redteam.probe.import", "", auditJSON(map[string]any{"packs": packCount, "cases": caseCount, "skipped": len(skipped)}))
	writeJSON(w, http.StatusOK, map[string]any{"imported_cases": caseCount, "packs_touched": packCount, "skipped": skipped})
}

// handleRedTeamProbeCases manages a single manually-authored probe case.
//
//	POST   /admin/redteam/probe-cases        → add or edit a case (JSON)
//	DELETE /admin/redteam/probe-cases/{id}   → remove a case
func (s *Server) handleRedTeamProbeCases(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/admin/redteam/probe-cases"), "/")
	switch {
	case r.Method == http.MethodDelete && id != "":
		if err := s.db.DeleteRedTeamProbeCase(r.Context(), id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "redteam_case_delete_failed")
			return
		}
		s.auditAdmin(r, "redteam.probe.case.delete", "", auditJSON(map[string]any{"id": id}))
		writeJSON(w, http.StatusOK, map[string]any{"id": id, "deleted": true})
	case r.Method == http.MethodPost && id == "":
		var body struct {
			CaseID         string   `json:"case_id"`
			PackID         string   `json:"pack_id"`
			PackName       string   `json:"pack_name"`
			CaseKey        string   `json:"case_key"`
			InputTemplate  string   `json:"input_template"`
			ExpectedPolicy string   `json:"expected_policy"`
			EvaluatorType  string   `json:"evaluator_type"`
			Severity       string   `json:"severity"`
			TargetTypes    []string `json:"target_types"`
			RiskTags       []string `json:"risk_tags"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&body); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		if strings.TrimSpace(body.CaseKey) == "" || strings.TrimSpace(body.InputTemplate) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "case_key and input_template are required", "invalid_request_error", "missing_fields")
			return
		}
		packID := strings.TrimSpace(body.PackID)
		if packID == "" {
			// No target pack chosen: file the case under the admin's custom pack, creating it if
			// needed. Passing nil cases upserts only the pack shell, leaving existing cases intact.
			packName := redTeamDefault(body.PackName, "사용자 정의 프롬프트")
			packID = redTeamCustomPackID(packName)
			sev := normalizeRedTeamSeverity(body.Severity)
			if err := s.db.UpsertRedTeamProbePackWithCases(r.Context(), store.RedTeamProbePack{
				ID: packID, Name: packName, Category: "custom", Severity: sev,
				Version: "v1", Enabled: true, RequiresApproval: severityRank(sev) >= severityRank("high"),
				CreatedBy: adminID(r),
			}, nil); err != nil {
				writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "redteam_pack_save_failed")
				return
			}
		}
		caseID := strings.TrimSpace(body.CaseID)
		if caseID == "" {
			caseID = redTeamCaseID(packID, body.CaseKey)
		}
		c := store.RedTeamProbeCase{
			ID: caseID, PackID: packID, CaseKey: strings.TrimSpace(body.CaseKey), InputTemplate: body.InputTemplate,
			ExpectedPolicy: redTeamDefault(body.ExpectedPolicy, "safe_completion"),
			EvaluatorType:  redTeamDefault(body.EvaluatorType, "rule"),
			Severity:       normalizeRedTeamSeverity(body.Severity),
			TargetTypes:    body.TargetTypes, RiskTags: body.RiskTags,
		}
		if err := s.db.UpsertRedTeamProbeCase(r.Context(), c); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "redteam_case_save_failed")
			return
		}
		s.auditAdmin(r, "redteam.probe.case.upsert", "", auditJSON(map[string]any{"id": c.ID, "pack_id": packID, "case_key": c.CaseKey}))
		writeJSON(w, http.StatusCreated, map[string]any{"case": c, "pack_id": packID})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func redTeamCustomPackID(name string) string {
	return "rtp_custom_" + audit.HashText("custom|" + strings.ToLower(strings.TrimSpace(name)))[:12]
}

func redTeamCaseID(packID, caseKey string) string {
	return "rtc_" + audit.HashText(packID + "|" + caseKey)[:16]
}

func redTeamSplitPipe(raw string) []string {
	out := []string{}
	for _, p := range strings.Split(raw, "|") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func redTeamTruthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "y", "예", "승인필요":
		return true
	}
	return false
}
