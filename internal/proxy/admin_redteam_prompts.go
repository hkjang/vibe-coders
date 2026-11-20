package proxy

import (
	"encoding/csv"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
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
// risk_tags normally use pipe-separated cells; the marked format preserves literal
// separators and text escapes. See docs/REDTEAM_PROBE_CSV.md.
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
	case action == "import-review" && r.Method == http.MethodPost:
		s.handleRedTeamProbeCSVReviewed(w, r, false)
	case action == "import" && r.Method == http.MethodPut:
		s.handleRedTeamProbeCSVReviewed(w, r, true)
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
	_ = cw.Write(append(append([]string{}, redTeamProbeCSVHeader...), redTeamProbeCSVFormatColumn))
	for _, p := range packs {
		for _, c := range p.Cases {
			cells := []string{
				p.ID, p.Name, p.Category, p.Severity, boolStr(p.RequiresApproval),
				c.ID, c.CaseKey, c.ExpectedPolicy, c.EvaluatorType, c.Severity,
				redTeamProbeCSVList(c.TargetTypes), redTeamProbeCSVList(c.RiskTags), c.InputTemplate,
			}
			for i, cell := range cells {
				cells[i] = redTeamProbeCSVText(cell)
			}
			_ = cw.Write(append(cells, redTeamProbeCSVFormat))
		}
	}
	cw.Flush()
}

const redTeamProbeCSVMaxBytes int64 = 8 << 20
const redTeamProbeMultipartOverhead int64 = 1 << 20

// Bound the complete input before parsing rows or writing any pack/case. Multipart
// framing has its own small allowance; the uploaded file retains the raw CSV limit.
func readRedTeamProbeCSV(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Type"))), "multipart/form-data") {
		r.Body = http.MaxBytesReader(w, r.Body, redTeamProbeCSVMaxBytes)
		return io.ReadAll(r.Body)
	}
	r.Body = http.MaxBytesReader(w, r.Body, redTeamProbeCSVMaxBytes+redTeamProbeMultipartOverhead)
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()
	// Parse before reading r.Body. Large file parts spill to temporary storage and
	// are removed on success as well as all validation/error paths.
	if err := r.ParseMultipartForm(redTeamProbeMultipartOverhead); err != nil {
		return nil, err
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if header.Size > redTeamProbeCSVMaxBytes {
		return nil, &http.MaxBytesError{Limit: redTeamProbeCSVMaxBytes}
	}
	body, err := io.ReadAll(io.LimitReader(file, redTeamProbeCSVMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > redTeamProbeCSVMaxBytes {
		return nil, &http.MaxBytesError{Limit: redTeamProbeCSVMaxBytes}
	}
	return body, nil
}

// redTeamImportProbeCSV upserts probe packs and cases from an uploaded CSV (same schema as export).
// It is idempotent: rows with a known case_id update in place; blank ids are derived deterministically
// so re-imports don't duplicate. Existing cases not present in the file are left untouched.
func (s *Server) redTeamImportProbeCSV(w http.ResponseWriter, r *http.Request) {
	raw, err := readRedTeamProbeCSV(w, r)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) || errors.Is(err, multipart.ErrMessageTooLarge) {
			writeOpenAIError(w, http.StatusRequestEntityTooLarge, "CSV exceeds the 8 MiB file or bounded multipart request limit", "invalid_request_error", "csv_too_large")
		} else {
			writeOpenAIError(w, http.StatusBadRequest, "cannot read CSV upload", "invalid_request_error", "bad_body")
		}
		return
	}
	plan, err := prepareRedTeamProbeCSV(raw, adminID(r))
	if err != nil {
		var invalid *redTeamProbeCSVPlanError
		if errors.As(err, &invalid) {
			writeOpenAIError(w, http.StatusBadRequest, invalid.message, "invalid_request_error", invalid.code)
		} else {
			writeOpenAIError(w, http.StatusBadRequest, "invalid probe CSV", "invalid_request_error", "invalid_csv_format")
		}
		return
	}
	summary := auditJSON(map[string]any{"packs": len(plan.Content.Packs), "cases": len(plan.Content.Cases), "skipped": len(plan.Skipped)})
	audit := store.AdminAuditLog{ID: newID("audit"), AdminID: adminID(r), Action: "redteam.probe.import", AfterValue: summary}
	if err := s.db.ImportRedTeamProbeContent(r.Context(), plan.Content, audit); err != nil {

		code := "redteam_import_save_failed"
		switch {
		case errors.Is(err, store.ErrRedTeamProbeImportPack):
			code = "redteam_pack_save_failed"
		case errors.Is(err, store.ErrRedTeamProbeImportCase):
			code = "redteam_case_save_failed"
		}
		writeOpenAIError(w, http.StatusInternalServerError, "CSV import could not be confirmed; check the current catalogue before retrying", "server_error", code)
		return
	}
	s.runAdminPostChange(r, audit.Action, "", summary, "")
	writeJSON(w, http.StatusOK, map[string]any{"imported_cases": len(plan.Content.Cases), "packs_touched": len(plan.Content.Packs), "skipped": plan.Skipped})
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
			// needed. Updating content preserves existing controls and leaves other cases intact.
			packName := redTeamDefault(body.PackName, "사용자 정의 프롬프트")
			packID = redTeamCustomPackID(packName)
			sev := normalizeRedTeamSeverity(body.Severity)
			if err := s.db.UpsertRedTeamProbePackContentPreservingApproval(r.Context(), store.RedTeamProbePack{
				ID: packID, Name: packName, Category: "custom", Severity: sev,
				Version: "v1", Enabled: true, RequiresApproval: redTeamSeverityRank(sev) >= redTeamSeverityRank("high"),
				CreatedBy: adminID(r),
			}); err != nil {
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
		if err := s.db.UpsertRedTeamProbeCaseContent(r.Context(), c); err != nil {
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
