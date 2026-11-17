package proxy

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"vibe-coders/internal/store"
)

type redTeamReplaySource struct {
	Result       store.RedTeamCaseResult
	Run          store.RedTeamRun
	Campaign     store.RedTeamCampaign // preserve the original configuration, before explicit replay overrides
	EvidenceID   string
	EvidenceHash string
}

type redTeamReplayReviewRequest struct {
	Reason            string           `json:"reason"`
	Model             string           `json:"model"`
	Limits            redTeamRunLimits `json:"limits"`
	RetainRawEvidence bool             `json:"retain_raw_evidence"`
}

type redTeamReplayReviewResponse struct {
	redTeamRunReviewResponse
	SourceResult store.RedTeamCaseResult `json:"source_result"`
	CaseKey      string                  `json:"case_key"`
	PackName     string                  `json:"pack_name"`
}

var errRedTeamReplayMissing = errors.New("replay source unavailable")

// Only the selected current case is replayed. Historical result/evidence stays
// immutable; raw retention is a new explicit choice under existing admin:write.
func (s *Server) prepareRedTeamReplayPlan(r *http.Request, id string, body redTeamReplayReviewRequest) (*redTeamRunPlan, error) {
	if body.Limits.MaxCalls != 1 || !body.Limits.valid() || !redTeamConcreteModels([]string{body.Model}) {
		return nil, errRedTeamRunSelection
	}
	result, found, err := s.db.GetRedTeamCaseResult(r.Context(), id)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, errRedTeamReplayMissing
	}
	run, found, err := s.db.GetRedTeamRun(r.Context(), result.RunID)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, errRedTeamReplayMissing
	}
	if run.Status == "running" {
		return nil, errRedTeamRunSelection
	}
	campaign, found, err := s.db.GetRedTeamCampaign(r.Context(), run.CampaignID)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, errRedTeamReplayMissing
	}
	cs, found, err := s.db.GetRedTeamProbeCase(r.Context(), result.CaseID)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, errRedTeamRunSelection
	}
	target, found, err := s.db.GetRedTeamTarget(r.Context(), run.TargetID)
	if err != nil {
		return nil, err
	}
	if !found || !redTeamTargetMatchesCampaign(target, campaign) {
		return nil, errRedTeamRunSelection
	}
	if len(campaign.ProbePackIDs) > 0 && !redTeamContains(campaign.ProbePackIDs, cs.PackID) {
		return nil, errRedTeamRunSelection
	}
	packs, err := s.db.ListRedTeamProbePacks(r.Context(), false)
	if err != nil {
		return nil, err
	}
	var pack *store.RedTeamProbePack
	for i := range packs {
		if packs[i].ID == cs.PackID && packs[i].Enabled {
			pack = &packs[i]
			break
		}
	}
	if pack == nil {
		return nil, errRedTeamRunSelection
	}
	source := &redTeamReplaySource{Result: result, Run: run, Campaign: campaign}
	evidence, found, err := s.db.RedTeamEvidenceByResult(r.Context(), id)
	if err != nil {
		return nil, err
	}
	if found {
		source.EvidenceID, source.EvidenceHash = evidence.ID, evidence.ExportHash
	}
	campaign.ExecutionMode, campaign.RetainRawEvidence = "active-controlled", body.RetainRawEvidence
	plan, err := s.prepareRedTeamSelectionPlan(r, campaign, "live", body.Limits, []string{body.Model}, []store.RedTeamTarget{target}, []store.RedTeamProbePack{*pack}, []store.RedTeamProbeCase{cs})
	if err != nil {
		return nil, err
	}
	if plan.LiveCalls != 1 || plan.CaseExecutions != 1 {
		return nil, errRedTeamRunSelection
	}
	plan.ReplaySource = source
	return plan, nil
}

func (s *Server) handleRedTeamReplayReview(w http.ResponseWriter, r *http.Request, resultID string) {
	var body redTeamReplayReviewRequest
	if !readRedTeamReviewJSON(w, r, &body) {
		return
	}
	body.Reason = strings.TrimSpace(body.Reason)
	if body.Reason == "" || utf8.RuneCountInString(body.Reason) > 1000 {
		writeOpenAIError(w, http.StatusBadRequest, "재실행 사유를 입력하세요.", "invalid_request_error", "redteam_run_review_invalid")
		return
	}
	if redteamKillSwitch.Load() {
		writeOpenAIError(w, http.StatusConflict, "레드팀 실행이 중지되어 있습니다.", "invalid_request_error", "redteam_run_stopped")
		return
	}
	plan, err := s.prepareRedTeamReplayPlan(r, resultID, body)
	if err != nil {
		status, code, message := http.StatusServiceUnavailable, "redteam_run_review_unavailable", "재실행 정의를 확인하지 못했습니다."
		if errors.Is(err, errRedTeamReplayMissing) {
			status, code, message = http.StatusNotFound, "redteam_replay_source_missing", "원본 결과 또는 실행을 찾을 수 없습니다."
		}
		if errors.Is(err, errRedTeamRunSelection) {
			status, code, message = http.StatusBadRequest, "redteam_run_selection", "현재 대상·검사·승인 상태와 정확한 모델, 실행 상한을 확인하세요. 이 재실행은 단일 LLM 호출만 지원합니다."
		}
		errorType := "invalid_request_error"
		if status >= 500 {
			errorType = "server_error"
		}
		writeOpenAIError(w, status, message, errorType, code)
		return
	}
	review := redTeamExecutionReview{Actor: s.adminKeyActor(r), CampaignID: plan.Campaign.ID, SourceResultID: resultID, RetainRawEvidence: body.RetainRawEvidence, Revision: plan.revision(), Kind: "live", Reason: body.Reason, Models: []string{body.Model}, Limits: body.Limits, ExpiresAt: time.Now().Add(redTeamReviewTTL), ID: newID("rtreview")}
	if review.Revision == "" {
		writeOpenAIError(w, http.StatusServiceUnavailable, "재실행 버전을 확인하지 못했습니다.", "server_error", "redteam_run_review_unavailable")
		return
	}
	token, ok := s.redTeamReviews.issue(review)
	if !ok {
		writeOpenAIError(w, http.StatusServiceUnavailable, "검토 요청을 보관하지 못했습니다.", "server_error", "redteam_run_review_unavailable")
		return
	}
	writeJSON(w, http.StatusOK, redTeamReplayReviewResponse{redTeamRunReviewResponse: redTeamPlanReviewResponse(plan, review, token), SourceResult: plan.ReplaySource.Result, CaseKey: plan.Cases[0].CaseKey, PackName: plan.Packs[0].Name})
}

func (s *Server) handleRedTeamReviewedReplay(w http.ResponseWriter, r *http.Request, resultID string) {
	var body struct {
		ReviewToken string `json:"review_token"`
		ProxyKey    string `json:"proxy_key"`
	}
	if !readRedTeamReviewJSON(w, r, &body) {
		return
	}
	// Look up only the campaign identity before consumption; operation/source/actor
	// checks happen atomically with the shared campaign concurrency gate.
	source, found, err := s.db.GetRedTeamCaseResult(r.Context(), resultID)
	if err != nil {
		writeOpenAIError(w, http.StatusServiceUnavailable, "원본 결과를 확인하지 못했습니다.", "server_error", "redteam_run_review_unavailable")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "원본 결과가 없습니다.", "invalid_request_error", "redteam_replay_source_missing")
		return
	}
	sourceRun, found, err := s.db.GetRedTeamRun(r.Context(), source.RunID)
	if err != nil || !found {
		writeOpenAIError(w, http.StatusConflict, "원본 실행을 다시 확인하세요.", "invalid_request_error", "redteam_run_review_changed")
		return
	}
	review, ok := s.redTeamReviews.consumeForSource(body.ReviewToken, s.adminKeyActor(r), sourceRun.CampaignID, resultID)
	if !ok {
		writeOpenAIError(w, http.StatusConflict, "검토가 만료·사용되었거나 현재 사용자·원본 결과·서버와 다릅니다.", "invalid_request_error", "redteam_run_review_conflict")
		return
	}
	defer s.redTeamReviews.finish(review.CampaignID)
	body.ProxyKey = strings.TrimSpace(body.ProxyKey)
	if body.ProxyKey == "" || len(body.ProxyKey) > 8192 || len(review.Models) != 1 {
		writeOpenAIError(w, http.StatusBadRequest, "전용 프록시 키를 확인하세요.", "invalid_request_error", "redteam_run_review_invalid")
		return
	}
	plan, err := s.prepareRedTeamReplayPlan(r, resultID, redTeamReplayReviewRequest{Reason: review.Reason, Model: review.Models[0], Limits: review.Limits, RetainRawEvidence: review.RetainRawEvidence})
	if err != nil || plan.revision() != review.Revision || redteamKillSwitch.Load() {
		writeOpenAIError(w, http.StatusConflict, "원본 결과나 실행 조건이 변경되었습니다. 다시 검토하세요.", "invalid_request_error", "redteam_run_review_changed")
		return
	}
	plan.ExecutionID, plan.ReviewID = newID("rtrun"), review.ID
	if err := s.db.InsertAdminAudit(r.Context(), store.AdminAuditLog{ID: newID("audit"), AdminID: review.Actor, Action: "redteam.result.replay.reviewed", AfterValue: auditJSON(map[string]any{"source_result_id": resultID, "source_run_id": sourceRun.ID, "run_id": plan.ExecutionID, "campaign_id": review.CampaignID, "review_id": review.ID, "reason": review.Reason, "revision": review.Revision, "limits": review.Limits, "retain_raw_evidence": review.RetainRawEvidence}), CreatedAt: time.Now().UTC()}); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "실행 전 감사 기록을 확인하지 못했습니다. 호출하지 않았습니다.", "server_error", "redteam_run_review_audit_failed")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), redTeamReviewedTimeout(plan.Campaign))
	defer cancel()
	campaign := plan.Campaign
	campaign.BudgetLimitKRW = review.Limits.BudgetLimitKRW
	result, err := s.runRedTeamSelectionReviewed(r.WithContext(ctx), campaign, body.ProxyKey, plan.Targets, plan.Packs, plan.Cases, plan)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "재실행 결과를 확인하지 못했습니다. 이력을 확인한 뒤 다시 검토하세요.", "server_error", "redteam_run_review_outcome_unknown")
		return
	}
	result["source_result_id"], result["source_run_id"] = resultID, sourceRun.ID
	result["review_id"], result["execution_kind"], result["limits"] = review.ID, review.Kind, review.Limits
	result["planned_live_calls"], result["planned_case_executions"] = 1, 1
	summary := result["summary"].(map[string]any)
	result["complete"] = result["recording"].(redTeamRecording).Confirmed && result["status"] == "completed" && summary["live_calls"] == 1 && summary["results"] == 1 && ctx.Err() == nil
	result["note"] = "검토한 한 건의 실행 응답입니다. 원본 결과와 증적, 캠페인 상태, 검사 묶음의 기준선은 변경하지 않습니다. 저장 확인 여부와 새 이력을 확인하세요."
	writeJSON(w, http.StatusOK, result)
}
