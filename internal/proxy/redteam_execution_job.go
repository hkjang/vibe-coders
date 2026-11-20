package proxy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"
	"vibe-coders/internal/store"
)

// A private context value retains audit attribution without retaining the
// submitting browser's bearer token or request body in a background worker.
type redTeamJobActorKey struct{}

func redTeamJobID(token string) string {
	sum := sha256.Sum256([]byte(token))
	return "rtj_" + hex.EncodeToString(sum[:])
}
func validRedTeamJobID(id string) bool {
	if len(id) != 68 || !strings.HasPrefix(id, "rtj_") {
		return false
	}
	_, err := hex.DecodeString(id[4:])
	return err == nil && strings.ToLower(id) == id
}
func publicRedTeamJob(job store.RedTeamJob) store.RedTeamJob {
	if job.Status == "running" {
		until, err := time.Parse(dwRetryTimeLayout, job.LeaseUntil)
		if err != nil || !time.Now().Before(until) {
			job.Status = "interrupted"
		}
	}
	return job
}
func redTeamJobError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Cache-Control", "no-store")
	writeOpenAIError(w, status, message, "redteam_job_error", code)
}
func (s *Server) writeOwnedRedTeamJob(w http.ResponseWriter, r *http.Request, campaign, id string) bool {
	job, found, err := s.db.RedTeamJob(r.Context(), id)
	if err != nil {
		redTeamJobError(w, 503, "redteam_job_unavailable", "작업 상태를 조회하지 못했습니다.")
		return true
	}
	if !found {
		return false
	}
	if job.Actor != s.adminKeyActor(r) || job.CampaignID != campaign {
		redTeamJobError(w, 403, "redteam_job_denied", "이 실행 작업을 조회할 권한이 없습니다.")
		return true
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, publicRedTeamJob(job))
	return true
}
func (s *Server) handleRedTeamJobRead(w http.ResponseWriter, r *http.Request, campaign string) {
	query, err := url.ParseQuery(r.URL.RawQuery)
	id := query.Get("job_id")
	if err != nil || len(query) != 1 || len(query["job_id"]) != 1 || !validRedTeamJobID(id) {
		redTeamJobError(w, 400, "redteam_job_invalid", "실행 작업 주소를 확인하세요.")
		return
	}
	if !s.writeOwnedRedTeamJob(w, r, campaign, id) {
		redTeamJobError(w, 404, "redteam_job_not_found", "접수된 실행 작업을 찾지 못했습니다.")
	}
}

func (s *Server) handleRedTeamJobSubmission(w http.ResponseWriter, r *http.Request, campaign store.RedTeamCampaign, body redTeamExecutionRequest) {
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || len(query) != 1 || len(query["job"]) != 1 || query.Get("job") != "1" || len(body.ReviewToken) != 43 {
		redTeamJobError(w, 400, "redteam_job_invalid", "실행 작업 접수 조건을 확인하세요.")
		return
	}
	id := redTeamJobID(body.ReviewToken)
	// Returning a previously admitted operation is a read, never another call.
	// It works after a process restart even though the capability was consumed.
	if s.writeOwnedRedTeamJob(w, r, campaign.ID, id) {
		return
	}
	review, plan, ok := s.consumeRedTeamExecution(w, r, campaign, &body)
	if !ok {
		return
	}
	started := false
	defer func() {
		if !started {
			s.redTeamReviews.finish(campaign.ID)
		}
	}()
	now := time.Now().UTC()
	job := store.RedTeamJob{ID: id, CampaignID: campaign.ID, Actor: review.Actor, WorkerToken: newID("rt_worker"), Status: "running", CreatedAt: now.Format(dwRetryTimeLayout), UpdatedAt: now.Format(dwRetryTimeLayout), LeaseUntil: now.Add(90 * time.Second).Format(dwRetryTimeLayout), RedTeamJobDefinition: store.RedTeamJobDefinition{ReviewID: review.ID, Kind: review.Kind, Reason: review.Reason, PlannedLiveCalls: plan.LiveCalls, PlannedCases: plan.CaseExecutions}, Progress: store.RedTeamJobProgress{RunIDs: []string{}}}
	audit := store.AdminAuditLog{ID: id + "_requested", AdminID: job.Actor, Action: "redteam.job.requested", BeforeValue: id, AfterValue: auditJSON(map[string]any{"job_id": id, "campaign_id": campaign.ID, "review": job.RedTeamJobDefinition, "revision": review.Revision, "limits": review.Limits})}
	admitted, err := s.db.AdmitRedTeamJob(r.Context(), job, audit)
	if errors.Is(err, store.ErrRedTeamJobBusy) {
		redTeamJobError(w, 409, "redteam_job_busy", "이 캠페인의 다른 검토 작업이 진행 중입니다.")
		return
	}
	if err != nil {
		redTeamJobError(w, 503, "redteam_job_admission_failed", "작업과 감사 기록의 접수를 확인하지 못했습니다. 작업 상태를 조회하세요.")
		return
	}
	if !admitted {
		if !s.writeOwnedRedTeamJob(w, r, campaign.ID, id) {
			redTeamJobError(w, 503, "redteam_job_unavailable", "접수 상태를 다시 조회하세요.")
		}
		return
	}
	// Keep only necessary transport metadata. The sole execution credential
	// lives in this bounded worker's memory, never in a job, URL, cache or audit.
	request := &http.Request{Method: http.MethodPost, URL: &url.URL{Path: r.URL.Path}, Header: make(http.Header), RemoteAddr: r.RemoteAddr, Host: r.Host}
	started = true
	go s.runRedTeamJob(request, job, campaign, body.ProxyKey, review, plan)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusAccepted, job)
}

func (s *Server) runRedTeamJob(request *http.Request, job store.RedTeamJob, campaign store.RedTeamCampaign, key string, review redTeamExecutionReview, plan *redTeamRunPlan) {
	ctx, cancel := context.WithTimeout(context.WithValue(s.db.LifecycleContext(), redTeamJobActorKey{}, job.Actor), redTeamReviewedTimeout(campaign))
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				update, stop := context.WithTimeout(ctx, 5*time.Second)
				err := s.db.UpdateRedTeamJob(update, job.ID, job.WorkerToken, nil, time.Now())
				stop()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()
	defer func() {
		if recover() != nil {
			job.Status = "unknown"
			job.Outcome = nil
		}
		cancel()
		<-heartbeatDone
		job.FinishedAt = time.Now().UTC().Format(dwRetryTimeLayout)
		finish, stop := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer stop()
		// Failed completion/audit leaves the last confirmed progress and expires
		// into interrupted. It never publishes an invented successful outcome.
		_ = s.db.FinishRedTeamJob(finish, job, store.AdminAuditLog{ID: job.ID + "_completed", AdminID: job.Actor, Action: "redteam.job.completed", BeforeValue: job.ID, AfterValue: auditJSON(map[string]any{"job_id": job.ID, "campaign_id": job.CampaignID, "review_id": job.ReviewID, "status": job.Status, "progress": job.Progress})})
		s.redTeamReviews.finish(job.CampaignID)
	}()
	update := func(progress *store.RedTeamJobProgress) error {
		write, stop := context.WithTimeout(ctx, 5*time.Second)
		defer stop()
		err := s.db.UpdateRedTeamJob(write, job.ID, job.WorkerToken, progress, time.Now())
		if err != nil {
			cancel()
		}
		return err
	}
	plan.JobBeforeCall = func() error { return update(nil) }
	plan.JobProgress = func(progress store.RedTeamJobProgress) error { job.Progress = progress; return update(&progress) }
	job.Status = "unknown"
	result, err := s.executeRedTeamReviewed(request.WithContext(ctx), campaign, key, review, plan)
	if err != nil {
		return
	}
	outcome, err := json.Marshal(result)
	if err != nil || len(outcome) > 4<<20 {
		return
	}
	job.Outcome = outcome
	job.Status = "stopped"
	if result["complete"] == true {
		job.Status = "completed"
	} else if !result["recording"].(redTeamRecording).Confirmed {
		job.Status = "unknown"
	}
}
