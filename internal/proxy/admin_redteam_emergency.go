package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"vibe-coders/internal/store"
)

// The existing runner flag is process-global. Its review identity and lock must
// have exactly the same lifetime, including when a process has multiple Servers.
var redteamEmergency struct {
	sync.Mutex
	instance string
	token    string
}

type redTeamEmergencyState struct {
	Enabled     bool   `json:"enabled"`
	Scope       string `json:"scope"`
	InstanceRef string `json:"instance_ref"`
	ReviewToken string `json:"review_token"`
	ObservedAt  string `json:"observed_at"`
	Reason      string `json:"reason,omitempty"`
}

// Caller holds redteamEmergency. A new token follows every accepted write,
// including legacy/no-op writes, so an A-B-A transition cannot revive a review.
func redTeamEmergencySnapshot() redTeamEmergencyState {
	return redTeamEmergencyState{
		Enabled: redteamKillSwitch.Load(), Scope: "responding_process",
		InstanceRef: redteamEmergency.instance, ReviewToken: redteamEmergency.token,
		ObservedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
}

func (s *Server) handleRedTeamKillSwitch(w http.ResponseWriter, r *http.Request) {
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
	var body struct {
		Enabled             *bool   `json:"enabled"`
		Reason              string  `json:"reason"`
		ExpectedReviewToken *string `json:"expected_review_token"`
	}
	if r.Method == http.MethodPost {
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
		if err := decoder.Decode(&body); err != nil || decoder.Decode(new(any)) != io.EOF {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		body.Reason = strings.TrimSpace(body.Reason)
		if utf8.RuneCountInString(body.Reason) > 1000 || (body.ExpectedReviewToken != nil &&
			(body.Enabled == nil || body.Reason == "" || len(*body.ExpectedReviewToken) != 32)) {
			writeOpenAIError(w, http.StatusBadRequest, "reviewed changes require a state, bounded reason and review token", "invalid_request_error", "redteam_review_required")
			return
		}
	}
	redteamEmergency.Lock()
	if redteamEmergency.token == "" || redteamEmergency.instance == "" {
		token, err := newText2SQLEmergencyReview()
		if err != nil {
			redteamEmergency.Unlock()
			writeOpenAIError(w, http.StatusServiceUnavailable, "emergency review unavailable", "server_error", "redteam_review_unavailable")
			return
		}
		redteamEmergency.token = token
		if redteamEmergency.instance == "" {
			redteamEmergency.instance = "process_" + hashProxyKey(token)[:16]
		}
	}
	before := redTeamEmergencySnapshot()
	if r.Method == http.MethodGet {
		redteamEmergency.Unlock()
		writeJSON(w, http.StatusOK, before)
		return
	}
	if body.ExpectedReviewToken != nil && *body.ExpectedReviewToken != before.ReviewToken {
		redteamEmergency.Unlock()
		writeOpenAIError(w, http.StatusConflict, "reviewed process or state changed; read and review again", "invalid_request_error", "redteam_review_conflict")
		return
	}
	nextToken, err := newText2SQLEmergencyReview()
	if err != nil {
		redteamEmergency.Unlock()
		writeOpenAIError(w, http.StatusServiceUnavailable, "emergency review unavailable", "server_error", "redteam_review_unavailable")
		return
	}
	enabled := body.Enabled != nil && *body.Enabled // Existing omitted/null => false.
	beforeAudit := auditJSON(map[string]any{"enabled": before.Enabled, "scope": before.Scope, "instance_ref": before.InstanceRef})
	afterAudit := auditJSON(map[string]any{"enabled": enabled, "reason": body.Reason, "scope": before.Scope, "instance_ref": before.InstanceRef})
	// Audit acknowledgment precedes a non-failing memory store. This is not a
	// durable flag/audit transaction: a crash can happen in between, and an
	// uncertain database acknowledgment can leave an audit without applying.
	if err := s.db.InsertAdminAudit(r.Context(), store.AdminAuditLog{
		ID: newID("audit"), AdminID: adminID(r), Action: "redteam.kill_switch",
		BeforeValue: beforeAudit, AfterValue: afterAudit, CreatedAt: time.Now().UTC(),
	}); err != nil {
		redteamEmergency.Unlock()
		writeOpenAIError(w, http.StatusInternalServerError, "emergency change audit could not be confirmed", "server_error", "redteam_kill_audit_failed")
		return
	}
	redteamKillSwitch.Store(enabled)
	redteamEmergency.token = nextToken
	after := redTeamEmergencySnapshot()
	after.Reason = body.Reason
	redteamEmergency.Unlock()
	s.runAdminPostChange(r, "redteam.kill_switch", beforeAudit, afterAudit, "")
	writeJSON(w, http.StatusOK, after)
}
