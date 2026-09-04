package proxy

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// handleRoutingLearning returns the learned model recommendations per
// (task_type, complexity bucket) from historical outcomes.
// GET /admin/routing/learning?window=7d&min_samples=20
func (s *Server) handleRoutingLearning(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	window := parseLearningWindow(r.URL.Query().Get("window"))
	minSamples := 20
	if v := r.URL.Query().Get("min_samples"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			minSamples = n
		}
	}
	report, err := s.db.RoutingLearning(r.Context(), time.Now().Add(-window), minSamples)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "routing_learning_failed")
		return
	}
	writeJSON(w, http.StatusOK, report)
}

// parseLearningWindow accepts 24h/7d/30d style windows, defaulting to 7 days.
func parseLearningWindow(s string) time.Duration {
	switch s {
	case "24h":
		return 24 * time.Hour
	case "30d":
		return 30 * 24 * time.Hour
	case "90d":
		return 90 * 24 * time.Hour
	case "7d", "":
		return 7 * 24 * time.Hour
	}
	if d, err := time.ParseDuration(s); err == nil && d > 0 {
		return d
	}
	return 7 * 24 * time.Hour
}

// handleDomainRoutingDecisions surfaces the domain router's signal/evidence log.
// GET /admin/routing/domain-decisions?route=&window=&limit=
func (s *Server) handleDomainRoutingDecisions(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if !s.canViewRawPrompts(r) {
		writeOpenAIError(w, http.StatusForbidden, "원문 라우팅 학습 데이터 조회 권한이 필요합니다.", "permission_error", "raw_prompt_access_required")
		return
	}
	filter := domainRoutingFilterFromRequest(r)
	decisions, err := s.db.ListDomainRoutingDecisions(r.Context(), filter)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "domain_decisions_failed")
		return
	}
	signals := map[string][]store.DomainRoutingSignal{}
	for _, d := range decisions {
		sigs, _ := s.db.DomainRoutingSignals(r.Context(), d.ID)
		signals[d.ID] = sigs
	}
	writeJSON(w, http.StatusOK, map[string]any{"decisions": decisions, "signals": signals})
}

// handleDomainExamples returns auto-promoted/approved examples used to reduce
// manual keyword maintenance.
func (s *Server) handleDomainExamples(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if !s.canViewRawPrompts(r) {
		writeOpenAIError(w, http.StatusForbidden, "원문 라우팅 예시 조회 권한이 필요합니다.", "permission_error", "raw_prompt_access_required")
		return
	}
	examples, err := s.db.ListDomainExamples(r.Context(), strings.TrimSpace(r.URL.Query().Get("route")), recentLimit(r))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "domain_examples_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"examples": examples})
}

func (s *Server) handleDomainReviewQueue(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if !s.canViewRawPrompts(r) {
		writeOpenAIError(w, http.StatusForbidden, "원문 라우팅 검토 데이터 조회 권한이 필요합니다.", "permission_error", "raw_prompt_access_required")
		return
	}
	filter := domainRoutingFilterFromRequest(r)
	filter.Status = firstNonEmpty(strings.TrimSpace(r.URL.Query().Get("status")), "pending")
	items, err := s.db.ListDomainReviewQueue(r.Context(), filter)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "domain_review_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// POST /admin/routing/domain-review/{id}/approve|reject
func (s *Server) handleDomainReviewAction(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/admin/routing/domain-review/")
	id, action, ok := strings.Cut(path, "/")
	if !ok || strings.TrimSpace(id) == "" {
		writeOpenAIError(w, http.StatusBadRequest, "invalid review path", "invalid_request_error", "invalid_review_path")
		return
	}
	status := ""
	switch action {
	case "approve":
		status = "approved"
	case "reject":
		status = "rejected"
	default:
		writeOpenAIError(w, http.StatusBadRequest, "action must be approve or reject", "invalid_request_error", "invalid_review_action")
		return
	}
	if err := s.db.SetDomainReviewStatus(r.Context(), id, status); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "domain_review_update_failed")
		return
	}
	s.auditAdmin(r, "domain_review."+status, "", auditJSON(map[string]any{"id": id}))
	writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": status})
}

func domainRoutingFilterFromRequest(r *http.Request) store.DomainRoutingFilter {
	filter := store.DomainRoutingFilter{
		Limit:     recentLimit(r),
		Route:     strings.TrimSpace(r.URL.Query().Get("route")),
		RequestID: strings.TrimSpace(r.URL.Query().Get("request_id")),
	}
	if window := strings.TrimSpace(r.URL.Query().Get("window")); window != "" {
		filter.Since = time.Now().Add(-parseLearningWindow(window))
	}
	return filter
}
