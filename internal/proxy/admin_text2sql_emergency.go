package proxy

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// This is deliberately a process-local, non-durable admission control. It does
// not cancel SQL already executing or change any other gateway process.
type text2SQLEmergencyState struct {
	Disabled      bool   `json:"disabled"`
	ConfigEnabled bool   `json:"config_enabled"`
	Scope         string `json:"scope"`
	InstanceRef   string `json:"instance_ref"`
	ReviewToken   string `json:"review_token"`
	ObservedAt    string `json:"observed_at"`
	Reason        string `json:"reason,omitempty"`
}

func newText2SQLEmergencyReview() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw[:]), nil
}

// Caller holds t2sKillMu. Tokens change after every accepted write (including
// no-op and remediation writes), preventing both stale and A-B-A reviews.
func (s *Server) text2SQLEmergencySnapshot() text2SQLEmergencyState {
	return text2SQLEmergencyState{
		Disabled: s.t2sKilled.Load(), ConfigEnabled: s.t2sConf().Enabled,
		Scope: "responding_process", InstanceRef: "process_" + hashProxyKey(s.instanceID)[:16],
		ReviewToken: s.t2sKillReview, ObservedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
}

// Existing remediation keeps its own audit/receipt workflow, but must invalidate
// the same review token. No caller may write t2sKilled outside this mutex.
func (s *Server) setText2SQLKilled(disabled bool) {
	s.t2sKillMu.Lock()
	defer s.t2sKillMu.Unlock()
	s.t2sKilled.Store(disabled)
	s.t2sKillReview = ""
}

func (s *Server) handleText2SQLKillSwitch(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var p struct {
		Disabled            *bool   `json:"disabled"`
		Reason              string  `json:"reason"`
		ExpectedReviewToken *string `json:"expected_review_token"`
	}
	if r.Method == http.MethodPost {
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		p.Reason = strings.TrimSpace(p.Reason)
		if p.ExpectedReviewToken != nil && (p.Disabled == nil || p.Reason == "" || len(*p.ExpectedReviewToken) != 32) {
			writeOpenAIError(w, http.StatusBadRequest, "reviewed changes require a state, reason and review token", "invalid_request_error", "text2sql_review_required")
			return
		}
	}
	s.t2sKillMu.Lock()
	if s.t2sKillReview == "" {
		token, err := newText2SQLEmergencyReview()
		if err != nil {
			s.t2sKillMu.Unlock()
			writeOpenAIError(w, http.StatusServiceUnavailable, "emergency review unavailable", "server_error", "text2sql_review_unavailable")
			return
		}
		s.t2sKillReview = token
	}
	before := s.text2SQLEmergencySnapshot()
	if r.Method == http.MethodGet {
		s.t2sKillMu.Unlock()
		writeJSON(w, http.StatusOK, before)
		return
	}
	if p.ExpectedReviewToken != nil && *p.ExpectedReviewToken != before.ReviewToken {
		s.t2sKillMu.Unlock()
		writeOpenAIError(w, http.StatusConflict, "the reviewed process or emergency state changed; read and review again", "invalid_request_error", "text2sql_review_conflict")
		return
	}
	nextToken, err := newText2SQLEmergencyReview()
	if err != nil {
		s.t2sKillMu.Unlock()
		writeOpenAIError(w, http.StatusServiceUnavailable, "emergency review unavailable", "server_error", "text2sql_review_unavailable")
		return
	}
	disabled := p.Disabled != nil && *p.Disabled // Preserve legacy omitted/null => false.
	beforeAudit := auditJSON(map[string]any{"disabled": before.Disabled, "scope": before.Scope, "instance_ref": before.InstanceRef})
	afterAudit := auditJSON(map[string]any{"disabled": disabled, "reason": p.Reason, "scope": before.Scope, "instance_ref": before.InstanceRef})
	// Persist the audit before the non-failing in-memory store. A failed/uncertain
	// audit acknowledgment never applies the control and never returns success.
	// This is not a durable state transaction: restarting still clears the flag.
	if err := s.db.InsertAdminAudit(r.Context(), store.AdminAuditLog{
		ID: newID("audit"), AdminID: adminID(r), Action: "text2sql.kill_switch",
		BeforeValue: beforeAudit, AfterValue: afterAudit, CreatedAt: time.Now().UTC(),
	}); err != nil {
		s.t2sKillMu.Unlock()
		writeOpenAIError(w, http.StatusInternalServerError, "emergency change audit could not be confirmed", "server_error", "text2sql_kill_audit_failed")
		return
	}
	s.t2sKilled.Store(disabled)
	s.t2sKillReview = nextToken
	after := s.text2SQLEmergencySnapshot()
	after.Reason = p.Reason
	s.t2sKillMu.Unlock()
	s.runAdminPostChange(r, "text2sql.kill_switch", beforeAudit, afterAudit, "")
	writeJSON(w, http.StatusOK, after)
}
