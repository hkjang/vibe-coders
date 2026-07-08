package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// Red Team remediation lifecycle & apply (요건 §17 조치/Owner action).
//
// A finding's remediation was previously write-only (created "open" and shown on a board). This
// adds the missing loop: an operator can move a remediation through open → in_progress → resolved
// / dismissed, and — for action types with a concrete, safe target — actually APPLY the fix from
// here. Today "mcp_trust_update" is applied for real (it escalates the offending MCP tool's trust
// profile to require approval/block); other types produce a ready-to-use draft plus a pointer to
// the menu where the operator finalizes it, and record the outcome on the remediation.

var redTeamRemediationStatuses = map[string]bool{"open": true, "in_progress": true, "resolved": true, "dismissed": true}

// handleRedTeamRemediationByID handles /admin/redteam/remediations/{id} and /{id}/apply.
//
//	GET  {id}          → the remediation
//	POST {id}          → update status/owner/due_date/note (lifecycle)
//	POST {id}/apply    → perform the remediation action where supported
func (s *Server) handleRedTeamRemediationByID(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/admin/redteam/remediations/"), "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		writeOpenAIError(w, http.StatusBadRequest, "remediation id required", "invalid_request_error", "missing_remediation")
		return
	}
	id := parts[0]
	action := ""
	if len(parts) > 1 {
		action = parts[1]
	}
	rem, found, err := s.db.GetRedTeamRemediation(r.Context(), id)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "redteam_remediation_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "remediation not found", "invalid_request_error", "not_found")
		return
	}

	switch {
	case action == "" && r.Method == http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{"remediation": rem})
	case action == "" && r.Method == http.MethodPost:
		var body struct {
			Status  string `json:"status"`
			Owner   string `json:"owner"`
			DueDate string `json:"due_date"`
			Note    string `json:"note"`
		}
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&body)
		if st := strings.TrimSpace(strings.ToLower(body.Status)); st != "" {
			if !redTeamRemediationStatuses[st] {
				writeOpenAIError(w, http.StatusBadRequest, "status must be one of open|in_progress|resolved|dismissed", "invalid_request_error", "invalid_status")
				return
			}
			rem.Status = st
		}
		if strings.TrimSpace(body.Owner) != "" {
			rem.Owner = strings.TrimSpace(body.Owner)
		}
		if strings.TrimSpace(body.DueDate) != "" {
			rem.DueDate = strings.TrimSpace(body.DueDate)
		}
		if strings.TrimSpace(body.Note) != "" {
			if rem.ActionPayload == nil {
				rem.ActionPayload = map[string]any{}
			}
			rem.ActionPayload["note"] = strings.TrimSpace(body.Note)
		}
		if err := s.db.UpdateRedTeamRemediation(r.Context(), rem); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "redteam_remediation_update_failed")
			return
		}
		s.auditAdmin(r, "redteam.remediation.update", "", auditJSON(map[string]any{"id": rem.ID, "status": rem.Status, "owner": rem.Owner}))
		writeJSON(w, http.StatusOK, map[string]any{"remediation": rem})
	case action == "apply" && r.Method == http.MethodPost:
		outcome, applied, err := s.applyRedTeamRemediation(r.Context(), &rem)
		if err != nil {
			writeOpenAIError(w, http.StatusBadRequest, err.Error(), "invalid_request_error", "redteam_apply_failed")
			return
		}
		if err := s.db.UpdateRedTeamRemediation(r.Context(), rem); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "redteam_remediation_update_failed")
			return
		}
		s.auditAdmin(r, "redteam.remediation.apply", "", auditJSON(map[string]any{"id": rem.ID, "action_type": rem.ActionType, "applied": applied, "status": rem.Status}))
		writeJSON(w, http.StatusOK, map[string]any{"remediation": rem, "applied": applied, "outcome": outcome})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// applyRedTeamRemediation performs the concrete action for a remediation where a safe target
// subsystem exists, and records the outcome on rem.ActionPayload + rem.Status. Returns a short
// human-readable outcome, whether a real change was applied, and any error. Callers persist rem.
func (s *Server) applyRedTeamRemediation(ctx context.Context, rem *store.RedTeamRemediation) (string, bool, error) {
	if rem.ActionPayload == nil {
		rem.ActionPayload = map[string]any{}
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)

	switch rem.ActionType {
	case "mcp_trust_update":
		server, tool := redTeamParseMCPTarget(rem.ActionPayload)
		if tool == "" {
			return "", false, fmt.Errorf("cannot resolve MCP tool from remediation payload")
		}
		// Escalate the offending tool's trust: require approval by default; block when the finding
		// flagged a destructive/critical case. This is a real, reversible governance change.
		action := "require_approval"
		risk := "high"
		if redTeamPayloadIsDestructive(rem.ActionPayload) {
			action, risk = "block", "critical"
		}
		note := "Red Team 조치: " + redTeamPayloadString(rem.ActionPayload, "recommendation")
		if err := s.db.UpsertToolRiskProfile(ctx, store.ToolRiskProfile{
			ServerLabel: server, ToolName: tool, RiskLevel: risk, Action: action, Note: strings.TrimSpace(note),
		}); err != nil {
			return "", false, err
		}
		rem.ActionPayload["applied_action"] = "tool_risk_profile:" + action
		rem.ActionPayload["applied_target"] = server + "/" + tool
		rem.ActionPayload["applied_at"] = now
		rem.Status = "resolved"
		return "MCP 도구 '" + server + "/" + tool + "' 신뢰도를 '" + action + "'(위험도 " + risk + ")로 적용했습니다. MCP 신뢰도 관리에서 확인/되돌릴 수 있습니다.", true, nil
	case "text2sql_guardrail_rule":
		return s.draftRemediation(rem, now, "Text2SQL 가드레일(테이블 권한·민감 컬럼·SELECT-only) 초안을 생성했습니다. Text2SQL 관리 화면에서 규칙을 확정하세요."), false, nil
	case "route_policy_draft":
		return s.draftRemediation(rem, now, "라우팅/egress 제한 정책 초안을 생성했습니다. 라우팅 규칙/거버넌스 화면에서 활성화하세요."), false, nil
	default:
		return s.draftRemediation(rem, now, "정책 초안을 생성하고 담당자 조치 대기로 전환했습니다. 담당자가 확정 후 완료 처리하세요."), false, nil
	}
}

// draftRemediation records a draft outcome for action types without a safe auto-apply target and
// moves the remediation to in_progress (owner action pending). Returns the outcome message.
func (s *Server) draftRemediation(rem *store.RedTeamRemediation, now, message string) string {
	rem.ActionPayload["draft"] = redTeamPayloadString(rem.ActionPayload, "recommendation")
	rem.ActionPayload["drafted_at"] = now
	if rem.Status == "open" {
		rem.Status = "in_progress"
	}
	return message
}

// redTeamParseMCPTarget extracts (server, tool) from a remediation payload's target_ref
// (e.g. "mcp_tool:deploy/run") or explicit fields.
func redTeamParseMCPTarget(payload map[string]any) (server, tool string) {
	ref := redTeamPayloadString(payload, "target_ref")
	ref = strings.TrimPrefix(ref, "mcp_tool:")
	ref = strings.TrimPrefix(ref, "mcp_upstream:")
	if i := strings.Index(ref, "/"); i >= 0 {
		return ref[:i], ref[i+1:]
	}
	return ref, ""
}

// redTeamPayloadIsDestructive reports whether the finding involved a destructive/critical case,
// so applying its remediation should block rather than merely require approval.
func redTeamPayloadIsDestructive(payload map[string]any) bool {
	if findings, ok := payload["leak_findings"].([]any); ok && len(findings) > 0 {
		return true
	}
	rec := strings.ToLower(redTeamPayloadString(payload, "recommendation"))
	return strings.Contains(rec, "block") || strings.Contains(rec, "삭제") || strings.Contains(rec, "destructive")
}

func redTeamPayloadString(payload map[string]any, key string) string {
	if payload == nil {
		return ""
	}
	if v, ok := payload[key]; ok && v != nil {
		return strings.TrimSpace(fmt.Sprint(v))
	}
	return ""
}
