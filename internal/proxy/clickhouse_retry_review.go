package proxy

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

const dwRetryTimeLayout = "2006-01-02T15:04:05.000000000Z"
const dwRetryReviewTTL = 5 * time.Minute

type dwRetryReview struct {
	Revision           string                             `json:"revision"`
	RunID              string                             `json:"run_id"`
	ReviewedAt         string                             `json:"reviewed_at"`
	ExpiresAt          string                             `json:"expires_at"`
	All                bool                               `json:"all"`
	EligibleDimensions int                                `json:"eligible_dimensions"`
	EstimatedRows      int64                              `json:"estimated_rows"`
	Dimensions         []store.ClickHouseSinkRunDimension `json:"dimensions"`
}
type dwRetryPlan struct {
	Review  dwRetryReview
	Config  config.ClickHouseConfig
	Pending []store.ClickHouseSinkRetry
}

func (s *Server) buildDwRetryPlan(ctx context.Context, actor string, all bool, at time.Time) (dwRetryPlan, error) {
	p := dwRetryPlan{Config: s.chConf(), Review: dwRetryReview{All: all, ReviewedAt: at.UTC().Format(dwRetryTimeLayout), ExpiresAt: at.Add(dwRetryReviewTTL).UTC().Format(dwRetryTimeLayout), Dimensions: []store.ClickHouseSinkRunDimension{}}}
	var err error
	p.Pending, err = s.db.ListClickHouseSinkRetries(ctx)
	if err != nil {
		return p, err
	}
	if len(p.Pending) > 64 {
		return p, errors.New("retry queue is outside the supported bound")
	}
	sort.Slice(p.Pending, func(i, j int) bool { return p.Pending[i].Dimension < p.Pending[j].Dimension })
	jobs := map[string]string{}
	for _, entry := range p.Pending {
		jobs[entry.Dimension] = entry.SinceDay
	}
	if all {
		days := p.Config.SinkDays
		if days <= 0 {
			days = 3
		}
		if days > 365 {
			return p, errors.New("invalid sink days")
		}
		since := at.AddDate(0, 0, -days).Format("2006-01-02")
		// Match legacy all=1: rollup dimensions only. Pending facts are untouched.
		jobs = map[string]string{}
		for _, dim := range dwDimensions {
			jobs[dim] = since
			for _, entry := range p.Pending {
				if entry.Dimension == dim && entry.SinceDay < since {
					jobs[dim] = entry.SinceDay
				}
			}
		}
	}
	names := make([]string, 0, len(jobs))
	for name := range jobs {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		item := store.ClickHouseSinkRunDimension{Dimension: name, Since: jobs[name], Until: p.Review.ReviewedAt, Status: "queued"}
		interval, rangeErr := (store.ClickHouseSinkRange{Dimension: name, Since: item.Since, Until: item.Until}).Normalized()
		switch {
		case rangeErr != nil:
			item.Issue = "invalid_source_interval"
		case p.Config.URL == "":
			item.Issue = "not_configured"
		case name == "text2sql_fact" && p.Config.Text2SQLFactTable == "":
			item.Issue = "fact_not_configured"
		case name == "redteam_fact" && p.Config.RedTeamFactTable == "":
			item.Issue = "fact_not_configured"
		default:
			item.Since, item.Until = interval.Since, interval.Until
			summary, err := s.db.SummarizeClickHouseSink(ctx, interval)
			if err != nil {
				return p, err
			}
			item.EstimatedRows = summary.Rows
			p.Review.EstimatedRows += summary.Rows
			p.Review.EligibleDimensions++
		}
		if item.Issue != "" {
			item.Status = "blocked"
		}
		p.Review.Dimensions = append(p.Review.Dimensions, item)
	}
	raw, err := json.Marshal(struct {
		Version, Actor string
		All            bool
		At             string
		Config         config.ClickHouseConfig
		Pending        []store.ClickHouseSinkRetry
		Dimensions     []store.ClickHouseSinkRunDimension
	}{"dw-retry-v1", actor, all, p.Review.ReviewedAt, p.Config, p.Pending, p.Review.Dimensions})
	if err != nil {
		return p, err
	}
	key := s.cfg.Auth.JWTSecret
	if key == "" {
		key = s.cfg.Secret.GatewaySecret
	}
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte("dw-retry-review-v1\x00"))
	mac.Write(raw)
	p.Review.Revision = hex.EncodeToString(mac.Sum(nil))
	p.Review.RunID = "dwr_" + p.Review.Revision
	return p, nil
}
func dwRetryError(w http.ResponseWriter, status int, code, message string) {
	writeOpenAIError(w, status, message, "invalid_request_error", code)
}
func dwRetryValidRevision(value string) bool {
	if len(value) != 64 || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}
func dwRetryPublicRun(run store.ClickHouseSinkRun) store.ClickHouseSinkRun {
	if run.Status == "running" {
		until, err := time.Parse(dwRetryTimeLayout, run.LeaseUntil)
		if err != nil || !time.Now().Before(until) {
			run.Status = "interrupted"
		}
	}
	return run
}
func (s *Server) handleDwRetryRead(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	query := r.URL.Query()
	if values, ok := query["job_id"]; ok {
		if len(query) != 1 || len(values) != 1 || !strings.HasPrefix(values[0], "dwr_") || !dwRetryValidRevision(strings.TrimPrefix(values[0], "dwr_")) {
			dwRetryError(w, 400, "invalid_sink_run", "작업 주소가 올바르지 않습니다.")
			return
		}
		run, found, err := s.db.ClickHouseSinkRun(r.Context(), values[0])
		if err != nil {
			dwRetryError(w, 503, "sink_run_unavailable", "작업 상태를 조회하지 못했습니다.")
			return
		}
		if !found {
			dwRetryError(w, 404, "sink_run_not_found", "등록된 재처리 작업이 없습니다.")
			return
		}
		if run.Actor != s.adminKeyActor(r) {
			dwRetryError(w, 403, "sink_run_denied", "이 재처리 작업을 조회할 권한이 없습니다.")
			return
		}
		writeJSON(w, 200, dwRetryPublicRun(run))
		return
	}
	all := false
	if len(query) > 0 {
		values, ok := query["all"]
		if !ok || len(query) != 1 || len(values) != 1 || (values[0] != "0" && values[0] != "1") {
			dwRetryError(w, 400, "invalid_sink_review", "재처리 검토 조건을 확인하세요.")
			return
		}
		all = values[0] == "1"
	}
	p, err := s.buildDwRetryPlan(r.Context(), s.adminKeyActor(r), all, time.Now().UTC())
	if err != nil {
		dwRetryError(w, 503, "sink_review_unavailable", "재처리 대상과 예상 건수를 확인하지 못했습니다.")
		return
	}
	writeJSON(w, 200, p.Review)
}
func (s *Server) handleDwRetryReviewed(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	query := r.URL.Query()
	if len(query) != 1 || len(query["reviewed"]) != 1 || query.Get("reviewed") != "1" {
		dwRetryError(w, 400, "invalid_sink_review", "재처리 실행 조건을 확인하세요.")
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8192))
	var input struct {
		Revision   string `json:"revision"`
		ReviewedAt string `json:"reviewed_at"`
		All        bool   `json:"all"`
		Reason     string `json:"reason"`
	}
	if err != nil || decodeRoutingOrderJSON(raw, &input, "revision", "reviewed_at", "all", "reason") != nil || !dwRetryValidRevision(input.Revision) {
		dwRetryError(w, 400, "invalid_sink_review", "검토 결과와 실행 사유를 확인하세요.")
		return
	}
	input.Reason = strings.TrimSpace(input.Reason)
	if input.Reason == "" || utf8.RuneCountInString(input.Reason) > 1024 {
		dwRetryError(w, 400, "invalid_sink_reason", "실행 사유를 1~1,024자로 입력하세요.")
		return
	}
	actor := s.adminKeyActor(r)
	runID := "dwr_" + input.Revision
	existing, found, err := s.db.ClickHouseSinkRun(r.Context(), runID)
	if err != nil {
		dwRetryError(w, 503, "sink_run_unavailable", "기존 작업 상태를 확인하지 못했습니다.")
		return
	}
	if found {
		if existing.Actor != actor {
			dwRetryError(w, 403, "sink_run_denied", "이 작업을 실행할 권한이 없습니다.")
			return
		}
		writeJSON(w, 200, dwRetryPublicRun(existing))
		return
	}
	at, err := time.Parse(dwRetryTimeLayout, input.ReviewedAt)
	age := time.Since(at)
	if err != nil || at.UTC().Format(dwRetryTimeLayout) != input.ReviewedAt || age < 0 || age > dwRetryReviewTTL {
		dwRetryError(w, 409, "sink_review_expired", "검토 시간이 만료되었습니다. 대기열을 다시 확인하세요.")
		return
	}
	plan, err := s.buildDwRetryPlan(r.Context(), actor, input.All, at)
	if err != nil {
		dwRetryError(w, 503, "sink_review_unavailable", "재처리 대상을 다시 확인하지 못했습니다.")
		return
	}
	if !hmac.Equal([]byte(plan.Review.Revision), []byte(input.Revision)) {
		dwRetryError(w, 409, "sink_review_conflict", "대기열·예상 건수 또는 연결 설정이 변경되었습니다. 다시 검토하세요.")
		return
	}
	if plan.Review.EligibleDimensions == 0 {
		dwRetryError(w, 409, "sink_review_empty", "실행 가능한 재처리 대상이 없습니다. 연결 설정과 대기열을 확인하세요.")
		return
	}
	now := time.Now().UTC()
	run := store.ClickHouseSinkRun{ID: runID, Actor: actor, WorkerToken: newID("dw_worker"), Status: "running", ReviewedAt: input.ReviewedAt, CreatedAt: now.Format(dwRetryTimeLayout), UpdatedAt: now.Format(dwRetryTimeLayout), LeaseUntil: now.Add(90 * time.Second).Format(dwRetryTimeLayout), Progress: store.ClickHouseSinkRunProgress{EstimatedRows: plan.Review.EstimatedRows, Dimensions: plan.Review.Dimensions}}
	audit := store.AdminAuditLog{ID: run.ID + "_requested", AdminID: actor, Action: "dw.clickhouse.retry.requested", BeforeValue: run.ID, AfterValue: auditJSON(map[string]any{"operation_id": run.ID, "reason": input.Reason, "reviewed_at": run.ReviewedAt, "dimensions": run.Progress.Dimensions, "estimated_rows": run.Progress.EstimatedRows})}
	admitted, err := s.db.AdmitClickHouseSinkRun(r.Context(), run, plan.Pending, audit)
	if errors.Is(err, store.ErrClickHouseSinkRunBusy) {
		dwRetryError(w, 409, "sink_run_active", "다른 재처리 작업이 진행 중입니다. 완료 후 다시 검토하세요.")
		return
	}
	if errors.Is(err, store.ErrClickHouseSinkReviewConflict) {
		dwRetryError(w, 409, "sink_review_conflict", "대기열이 변경되었습니다. 다시 검토하세요.")
		return
	}
	if err != nil {
		dwRetryError(w, 503, "sink_run_admission_failed", "작업과 감사 기록을 저장하지 못해 재처리를 시작하지 않았습니다.")
		return
	}
	if !admitted {
		existing, found, err = s.db.ClickHouseSinkRun(r.Context(), runID)
		if err != nil || !found {
			dwRetryError(w, 503, "sink_run_unavailable", "기존 작업 상태를 확인하세요.")
			return
		}
		if existing.Actor != actor {
			dwRetryError(w, 403, "sink_run_denied", "이 작업을 실행할 권한이 없습니다.")
			return
		}
		writeJSON(w, 200, dwRetryPublicRun(existing))
		return
	}
	// The response and background worker must not share the mutable progress
	// slice while JSON serialization is still reading the admission snapshot.
	workerRun := run
	workerRun.Progress.Dimensions = append([]store.ClickHouseSinkRunDimension(nil), run.Progress.Dimensions...)
	go s.runDwRetryJob(workerRun, plan.Config, plan.Pending, input.Reason)
	writeJSON(w, http.StatusAccepted, run)
}
