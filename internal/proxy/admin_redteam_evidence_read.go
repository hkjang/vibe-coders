package proxy

import (
	"errors"
	"math"
	"net/http"
	"net/url"
	"strings"

	"vibe-coders/internal/store"
)

type redTeamEvidenceReadResponse struct {
	Evidence      store.RedTeamEvidence `json:"evidence"`
	Masked        bool                  `json:"masked"`
	RawAllowed    bool                  `json:"raw_allowed"`
	RawAvailable  bool                  `json:"raw_available"`
	ToolCallCount int                   `json:"tool_call_count"`
}

// Legacy full-admin reads retain their original shape. App reads explicitly opt
// into masked projection; requesting originals is a separate, audited read.
func redTeamEvidenceReadMode(r *http.Request, allowReveal bool) (app, reveal bool, err error) {
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return false, false, err
	}
	if !values.Has("view") && !values.Has("reveal") {
		return false, false, nil
	}
	invalid := errors.New("invalid evidence read options")
	if values.Get("view") != "app" || len(values["view"]) != 1 {
		return false, false, invalid
	}
	for key, items := range values {
		if len(items) != 1 || (key != "view" && key != "reveal") {
			return false, false, invalid
		}
	}
	if values.Has("reveal") {
		if !allowReveal || values.Get("reveal") != "raw" {
			return false, false, invalid
		}
		reveal = true
	}
	return true, reveal, nil
}

func (s *Server) projectRedTeamEvidence(ev store.RedTeamEvidence, reveal bool) store.RedTeamEvidence {
	provider, _ := ev.HeadersSummary["provider"].(string)
	project := s.requestIOMasker(provider)
	ev.MaskedPrompt, ev.MaskedResponse = project(ev.MaskedPrompt), project(ev.MaskedResponse)
	// A missing masked capture is not permission to fall back to the original.
	// Tool arguments and arbitrary metadata have no stored masked representation.
	if !reveal {
		ev.RawPrompt, ev.RawResponse = "", ""
		ev.ToolCalls = []map[string]any{}
	} else if ev.ToolCalls == nil {
		ev.ToolCalls = []map[string]any{}
	}
	headers := map[string]any{}
	for _, key := range []string{"target", "provider", "model", "pack", "mode", "expected", "session_id", "x-cost-center", "source_result_id", "source_run_id", "review_id"} {
		if value, ok := ev.HeadersSummary[key].(string); ok {
			headers[key] = project(value)
		}
	}
	for _, key := range []string{"x-redteam", "simulated"} {
		if value, ok := ev.HeadersSummary[key].(bool); ok {
			headers[key] = value
		}
	}
	for _, key := range []string{"http_status", "latency_ms", "cost_krw"} {
		if value, ok := ev.HeadersSummary[key].(float64); ok && !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 {
			headers[key] = value
		}
	}
	// Finding categories are generated labels, not excerpts from the response.
	if values, ok := ev.HeadersSummary["leak_findings"].([]any); ok {
		labels := []string{}
		for _, value := range values {
			if label, ok := value.(string); ok {
				labels = append(labels, project(label))
			}
		}
		headers["leak_findings"] = labels
	}
	ev.HeadersSummary = headers
	return ev
}

func (s *Server) writeRedTeamEvidenceRead(w http.ResponseWriter, r *http.Request, resultID string) {
	w.Header().Set("Cache-Control", "no-store")
	app, reveal, err := redTeamEvidenceReadMode(r, true)
	if err != nil {
		writeOpenAIError(w, 400, "증적 조회 조건을 확인하세요.", "invalid_request_error", "redteam_evidence_read_invalid")
		return
	}
	rawAllowed := s.canViewRawPrompts(r)
	if reveal && !rawAllowed {
		writeOpenAIError(w, 403, "원문 증적 조회 권한이 필요합니다.", "permission_error", "redteam_evidence_raw_denied")
		return
	}
	ev, found, err := s.db.RedTeamEvidenceByResult(r.Context(), resultID)
	if err != nil {
		if app {
			writeOpenAIError(w, 503, "증적을 확인하지 못했습니다.", "server_error", "redteam_evidence_read_unavailable")
		} else {
			writeOpenAIError(w, 500, "증적을 확인하지 못했습니다.", "server_error", "redteam_evidence_failed")
		}
		return
	}
	if !found {
		writeOpenAIError(w, 404, "증적을 찾을 수 없습니다.", "invalid_request_error", "not_found")
		return
	}
	if reveal {
		// Commit access evidence before returning any original. Never echo storage
		// errors, prompt/response bodies, credentials or arbitrary metadata to logs.
		if err := s.db.InsertAdminAudit(r.Context(), store.AdminAuditLog{
			ID: newID("audit"), AdminID: s.adminKeyActor(r), Action: "redteam.evidence.raw_view",
			AfterValue: auditJSON(map[string]any{"result_id": resultID, "evidence_id": ev.ID}),
		}); err != nil {
			writeOpenAIError(w, 503, "조회 감사 기록을 저장하지 못해 원문을 열지 않았습니다.", "server_error", "redteam_evidence_audit_unavailable")
			return
		}
	} else {
		s.auditAdmin(r, "redteam.evidence.view", "", auditJSON(map[string]any{"result_id": resultID, "evidence_id": ev.ID}))
	}
	if app {
		writeJSON(w, 200, redTeamEvidenceReadResponse{
			Evidence: s.projectRedTeamEvidence(ev, reveal), Masked: !reveal, RawAllowed: rawAllowed,
			RawAvailable: ev.RawPrompt != "" || ev.RawResponse != "" || len(ev.ToolCalls) > 0, ToolCallCount: len(ev.ToolCalls),
		})
		return
	}
	if !rawAllowed {
		ev = s.projectRedTeamEvidence(ev, false)
	}
	writeJSON(w, 200, map[string]any{"evidence": ev})
}

func (s *Server) redTeamResultPrompt(ev store.RedTeamEvidence, rawAllowed bool) string {
	prompt := strings.TrimSpace(ev.MaskedPrompt)
	if rawAllowed {
		if prompt == "" {
			prompt = strings.TrimSpace(ev.RawPrompt)
		}
		return prompt
	}
	provider, _ := ev.HeadersSummary["provider"].(string)
	return s.requestIOMasker(provider)(prompt)
}
