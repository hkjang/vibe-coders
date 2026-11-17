package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"vibe-coders/internal/store"
)

type redTeamRunReviewRequest struct {
	Kind   string           `json:"kind"`
	Reason string           `json:"reason"`
	Models []string         `json:"models"`
	Limits redTeamRunLimits `json:"limits"`
}

type redTeamReviewedTarget struct {
	ID             string   `json:"id"`
	Ref            string   `json:"target_ref"`
	Provider       string   `json:"provider"`
	Models         []string `json:"models"`
	LiveCalls      int      `json:"live_calls"`
	CaseExecutions int      `json:"case_executions"`
}

type redTeamRunReviewResponse struct {
	ReviewToken           string                  `json:"review_token"`
	ReviewID              string                  `json:"review_id"`
	ExpiresAt             string                  `json:"expires_at"`
	Scope                 string                  `json:"scope"`
	CampaignID            string                  `json:"campaign_id"`
	CampaignName          string                  `json:"campaign_name"`
	Kind                  string                  `json:"kind"`
	Reason                string                  `json:"reason"`
	Targets               []redTeamReviewedTarget `json:"targets"`
	PackIDs               []string                `json:"probe_pack_ids"`
	Limits                redTeamRunLimits        `json:"limits"`
	LiveCalls             int                     `json:"planned_live_calls"`
	CaseExecutions        int                     `json:"case_executions"`
	EstimatedCost         float64                 `json:"estimated_cost_krw"`
	RequestedOutputTokens int                     `json:"requested_output_tokens"`
	InputBytes            int                     `json:"registered_input_bytes"`
	TimeoutMS             int                     `json:"timeout_ms"`
	RetainRawEvidence     bool                    `json:"retain_raw_evidence"`
}

func readRedTeamReviewJSON(w http.ResponseWriter, r *http.Request, body any) bool {
	w.Header().Set("Cache-Control", "no-store")
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(body); err != nil || decoder.Decode(new(any)) != io.EOF {
		writeOpenAIError(w, http.StatusBadRequest, "invalid review request", "invalid_request_error", "redteam_run_review_invalid")
		return false
	}
	return true
}

func redTeamReviewedTimeout(c store.RedTeamCampaign) time.Duration {
	if c.TimeoutMS > 0 && c.TimeoutMS < 120000 {
		return time.Duration(c.TimeoutMS) * time.Millisecond
	}
	return 120 * time.Second
}

func (s *Server) handleRedTeamRunReview(w http.ResponseWriter, r *http.Request, campaign store.RedTeamCampaign) {
	var body redTeamRunReviewRequest
	if !readRedTeamReviewJSON(w, r, &body) {
		return
	}
	body.Reason = strings.TrimSpace(body.Reason)
	if body.Reason == "" || utf8.RuneCountInString(body.Reason) > 1000 || !body.Limits.valid() {
		writeOpenAIError(w, http.StatusBadRequest, "bounded limits and reason required", "invalid_request_error", "redteam_run_review_invalid")
		return
	}
	if redteamKillSwitch.Load() {
		writeOpenAIError(w, http.StatusConflict, "redteam is stopped on this process", "invalid_request_error", "redteam_run_stopped")
		return
	}
	plan, err := s.prepareRedTeamRunPlan(r, campaign, body.Kind, body.Limits, body.Models)
	if err != nil {
		if errors.Is(err, errRedTeamRunSelection) {
			writeOpenAIError(w, http.StatusBadRequest, "check registered targets, concrete models, approval, external-provider permission and limits", "invalid_request_error", "redteam_run_selection")
		} else {
			writeOpenAIError(w, http.StatusServiceUnavailable, "execution definitions unavailable", "server_error", "redteam_run_review_unavailable")
		}
		return
	}
	review := redTeamExecutionReview{Actor: s.adminKeyActor(r), CampaignID: campaign.ID, Revision: plan.revision(), Kind: body.Kind, Reason: body.Reason, Limits: body.Limits, Models: body.Models, ExpiresAt: time.Now().Add(redTeamReviewTTL), ID: newID("rtreview")}
	if review.Revision == "" {
		writeOpenAIError(w, http.StatusServiceUnavailable, "execution revision unavailable", "server_error", "redteam_run_review_unavailable")
		return
	}
	token, ok := s.redTeamReviews.issue(review)
	if !ok {
		writeOpenAIError(w, http.StatusServiceUnavailable, "review capacity unavailable", "server_error", "redteam_run_review_unavailable")
		return
	}
	writeJSON(w, http.StatusOK, redTeamPlanReviewResponse(plan, review, token))
}

func redTeamPlanReviewResponse(plan *redTeamRunPlan, review redTeamExecutionReview, token string) redTeamRunReviewResponse {
	campaign := plan.Campaign
	response := redTeamRunReviewResponse{ReviewToken: token, ReviewID: review.ID, ExpiresAt: review.ExpiresAt.UTC().Format(time.RFC3339Nano), Scope: "responding_server", CampaignID: campaign.ID, CampaignName: campaign.Name, Kind: review.Kind, Reason: review.Reason, Limits: review.Limits, Targets: []redTeamReviewedTarget{}, PackIDs: []string{}, LiveCalls: plan.LiveCalls, CaseExecutions: plan.CaseExecutions, EstimatedCost: plan.EstimatedCost, RequestedOutputTokens: plan.LiveCalls * review.Limits.MaxOutputTokens, InputBytes: plan.InputBytes, TimeoutMS: int(redTeamReviewedTimeout(campaign).Milliseconds()), RetainRawEvidence: campaign.RetainRawEvidence}
	for _, pack := range plan.Packs {
		response.PackIDs = append(response.PackIDs, pack.ID)
	}
	for _, target := range plan.Targets {
		models := plan.Models[target.ID]
		if models == nil {
			models = []string{}
		}
		row := redTeamReviewedTarget{ID: target.ID, Ref: target.TargetRef, Provider: target.Provider, Models: models}
		for _, cs := range plan.Cases {
			if redTeamCaseApplies(target, cs) {
				if len(models) > 0 {
					row.LiveCalls += len(models)
					row.CaseExecutions += len(models)
				} else {
					row.CaseExecutions++
				}
			}
		}
		response.Targets = append(response.Targets, row)
	}
	return response
}

func (s *Server) handleRedTeamReviewedExecution(w http.ResponseWriter, r *http.Request, campaign store.RedTeamCampaign) {
	var body struct {
		ReviewToken string `json:"review_token"`
		ProxyKey    string `json:"proxy_key"`
	}
	if !readRedTeamReviewJSON(w, r, &body) {
		return
	}
	review, ok := s.redTeamReviews.consume(body.ReviewToken, s.adminKeyActor(r), campaign.ID)
	if !ok {
		writeOpenAIError(w, http.StatusConflict, "review expired, consumed, busy or belongs to another server/actor", "invalid_request_error", "redteam_run_review_conflict")
		return
	}
	defer s.redTeamReviews.finish(campaign.ID)
	body.ProxyKey = strings.TrimSpace(body.ProxyKey)
	if (len(body.ProxyKey) > 8192) || (review.Kind == "live" && body.ProxyKey == "") || (review.Kind == "simulation" && body.ProxyKey != "") {
		writeOpenAIError(w, http.StatusBadRequest, "credential does not match reviewed execution kind", "invalid_request_error", "redteam_run_review_invalid")
		return
	}
	plan, err := s.prepareRedTeamRunPlan(r, campaign, review.Kind, review.Limits, review.Models)
	if err != nil || plan.revision() != review.Revision || redteamKillSwitch.Load() {
		writeOpenAIError(w, http.StatusConflict, "reviewed definitions or emergency state changed; review again", "invalid_request_error", "redteam_run_review_changed")
		return
	}
	// This acknowledges intent before any live call. A database uncertainty or
	// lost response consumes the review; it must never authorize an automatic retry.
	if err := s.db.InsertAdminAudit(r.Context(), store.AdminAuditLog{ID: newID("audit"), AdminID: review.Actor, Action: "redteam.campaign.run.reviewed", AfterValue: auditJSON(map[string]any{"campaign_id": campaign.ID, "review_id": review.ID, "reason": review.Reason, "kind": review.Kind, "revision": review.Revision, "limits": review.Limits, "planned_live_calls": plan.LiveCalls}), CreatedAt: time.Now().UTC()}); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "reviewed admission audit not confirmed", "server_error", "redteam_run_review_audit_failed")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), redTeamReviewedTimeout(campaign))
	defer cancel()
	execution := campaign
	execution.BudgetLimitKRW = review.Limits.BudgetLimitKRW
	if review.Kind == "simulation" {
		execution.ExecutionMode = "dry-run"
	}
	// Persist the admitted review on every run before calling the provider, so
	// pending and uncertain responses can be inspected without executing again.
	plan.ReviewID = review.ID
	result, err := s.runRedTeamSelectionReviewed(r.WithContext(ctx), execution, body.ProxyKey, plan.Targets, plan.Packs, plan.Cases, plan)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "reviewed execution outcome unavailable", "server_error", "redteam_run_review_outcome_unknown")
		return
	}
	result["review_id"], result["execution_kind"], result["limits"] = review.ID, review.Kind, review.Limits
	result["planned_live_calls"], result["planned_case_executions"] = plan.LiveCalls, plan.CaseExecutions
	summary := result["summary"].(map[string]any)
	result["complete"] = result["recording"].(redTeamRecording).Confirmed && result["status"] == "completed" && summary["live_calls"] == plan.LiveCalls && summary["results"] == plan.CaseExecutions && ctx.Err() == nil
	writeJSON(w, http.StatusOK, result)
}
