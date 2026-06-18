package proxy

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

func (s *Server) handleLLMTraces(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	traces, err := s.db.RecentRequests(r.Context(), store.RequestFilter{
		Limit:          llmLimit(r, 100, 500),
		Model:          strings.TrimSpace(r.URL.Query().Get("model")),
		APIKeyID:       strings.TrimSpace(r.URL.Query().Get("api_key_id")),
		Team:           strings.TrimSpace(r.URL.Query().Get("team")),
		SessionID:      strings.TrimSpace(r.URL.Query().Get("session_id")),
		PromptName:     strings.TrimSpace(r.URL.Query().Get("prompt_name")),
		PromptVersion:  strings.TrimSpace(r.URL.Query().Get("prompt_version")),
		EvaluationName: strings.TrimSpace(r.URL.Query().Get("evaluation_name")),
	})
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "llm_traces_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"traces": traces})
}

func (s *Server) handleLLMTraceDetail(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/admin/llm/traces/")
	if id == "" || strings.Contains(id, "/") {
		writeOpenAIError(w, http.StatusBadRequest, "invalid trace id", "invalid_request_error", "invalid_trace_id")
		return
	}
	detail, err := s.db.RequestDetail(r.Context(), id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "trace not found", "invalid_request_error", "trace_not_found")
			return
		}
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "llm_trace_detail_failed")
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

func (s *Server) handleLLMSessions(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	whereClause, whereArgs := llmScopeWhere(r)
	sessions, err := s.db.LLMSessions(r.Context(), llmLimit(r, 100, 500))
	if whereClause != "1=1" {
		sessions, err = s.db.LLMSessionsFilter(r.Context(), whereClause, llmLimit(r, 100, 500), whereArgs...)
	}
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "llm_sessions_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": sessions})
}

func (s *Server) handleLLMSessionTimeline(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	sessionID := strings.TrimSpace(r.URL.Query().Get("session_id"))
	if sessionID == "" {
		writeOpenAIError(w, http.StatusBadRequest, "session_id is required", "invalid_request_error", "missing_session_id")
		return
	}
	timeline, err := s.db.SessionTimeline(r.Context(), sessionID, llmLimit(r, 1000, 2000))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "session_timeline_failed")
		return
	}
	writeJSON(w, http.StatusOK, timeline)
}

func (s *Server) handleLLMPrompts(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if strings.HasSuffix(r.URL.Path, "/compare") {
		s.handleLLMPromptCompare(w, r)
		return
	}
	whereClause, whereArgs := llmScopeWhere(r)
	prompts, err := s.db.LLMPrompts(r.Context(), llmLimit(r, 100, 500))
	if whereClause != "1=1" {
		prompts, err = s.db.LLMPromptsFilter(r.Context(), whereClause, llmLimit(r, 100, 500), whereArgs...)
	}
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "llm_prompts_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"prompts": prompts})
}

func (s *Server) handleLLMPromptCompare(w http.ResponseWriter, r *http.Request) {
	promptName := strings.TrimSpace(r.URL.Query().Get("prompt_name"))
	if promptName == "" {
		writeOpenAIError(w, http.StatusBadRequest, "prompt_name is required", "invalid_request_error", "missing_prompt_name")
		return
	}
	whereClause, whereArgs := llmScopeWhere(r)
	candidateLimit := llmPromptCandidateLimit(r)
	comparison, err := s.db.LLMPromptComparisonLimit(
		r.Context(),
		promptName,
		strings.TrimSpace(r.URL.Query().Get("candidate")),
		strings.TrimSpace(r.URL.Query().Get("baseline")),
		candidateLimit,
	)
	if whereClause != "1=1" {
		comparison, err = s.db.LLMPromptComparisonFilterLimit(
			r.Context(),
			promptName,
			strings.TrimSpace(r.URL.Query().Get("candidate")),
			strings.TrimSpace(r.URL.Query().Get("baseline")),
			candidateLimit,
			whereClause,
			whereArgs...,
		)
	}
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeOpenAIError(w, http.StatusNotFound, "prompt comparison not found", "invalid_request_error", "prompt_compare_not_found")
			return
		}
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "llm_prompt_compare_failed")
		return
	}
	writeJSON(w, http.StatusOK, comparison)
}

func (s *Server) handleLLMPatterns(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	whereClause, whereArgs := llmScopeWhere(r)
	patterns, err := s.db.LLMPatterns(r.Context(), llmLimit(r, 50, 200))
	if whereClause != "1=1" {
		patterns, err = s.db.LLMPatternsFilter(r.Context(), whereClause, llmLimit(r, 50, 200), whereArgs...)
	}
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "llm_patterns_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"patterns": patterns})
}

func (s *Server) handleLLMInsights(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	since, window := llmInsightWindow(r)
	whereClause, whereArgs := llmScopeWhere(r)
	insights, err := s.db.LLMInsights(r.Context(), since, llmLimit(r, 50, 200))
	if whereClause != "1=1" {
		insights, err = s.db.LLMInsightsFilter(r.Context(), since, whereClause, llmLimit(r, 50, 200), whereArgs...)
	}
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "llm_insights_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"window":   window,
		"since":    since.UTC().Format(time.RFC3339),
		"insights": insights,
	})
}

func (s *Server) handleLLMTimeseries(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	bucket := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("bucket")))
	if bucket != "day" {
		bucket = "hour"
	}
	since, window := llmInsightWindow(r)
	whereClause, whereArgs := llmScopeWhere(r)
	points, err := s.db.LLMTimeseries(r.Context(), bucket, since)
	if whereClause != "1=1" {
		points, err = s.db.LLMTimeseriesFilter(r.Context(), bucket, since, whereClause, whereArgs...)
	}
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "llm_timeseries_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"window": window,
		"bucket": bucket,
		"since":  since.UTC().Format(time.RFC3339),
		"points": points,
	})
}

func (s *Server) handleLLMFeedback(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		whereClause, whereArgs := llmScopeWhere(r)
		summary, err := s.db.LLMFeedbackSummary(r.Context())
		if whereClause != "1=1" {
			summary, err = s.db.LLMFeedbackSummaryFilter(r.Context(), whereClause, whereArgs...)
		}
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "llm_feedback_failed")
			return
		}
		feedback, err := s.db.RecentLLMFeedback(r.Context(), llmLimit(r, 100, 500))
		if whereClause != "1=1" {
			feedback, err = s.db.RecentLLMFeedbackFilter(r.Context(), whereClause, llmLimit(r, 100, 500), whereArgs...)
		}
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "llm_feedback_failed")
			return
		}
		labels, err := s.db.LLMFeedbackLabels(r.Context(), 20)
		if whereClause != "1=1" {
			labels, err = s.db.LLMFeedbackLabelsFilter(r.Context(), whereClause, 20, whereArgs...)
		}
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "llm_feedback_failed")
			return
		}
		prompts, err := s.db.LLMFeedbackPrompts(r.Context(), 20)
		if whereClause != "1=1" {
			prompts, err = s.db.LLMFeedbackPromptsFilter(r.Context(), whereClause, 20, whereArgs...)
		}
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "llm_feedback_failed")
			return
		}
		alignment, err := s.db.LLMAlignmentSummary(r.Context())
		if whereClause != "1=1" {
			alignment, err = s.db.LLMAlignmentSummaryFilter(r.Context(), whereClause, whereArgs...)
		}
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "llm_feedback_failed")
			return
		}
		alignmentPrompts, err := s.db.LLMAlignmentPrompts(r.Context(), 20)
		if whereClause != "1=1" {
			alignmentPrompts, err = s.db.LLMAlignmentPromptsFilter(r.Context(), whereClause, 20, whereArgs...)
		}
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "llm_feedback_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"summary":           summary,
			"feedback":          feedback,
			"labels":            labels,
			"prompts":           prompts,
			"alignment":         alignment,
			"alignment_prompts": alignmentPrompts,
		})
	case http.MethodPost:
		s.handleLLMFeedbackPost(w, r)
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) handleLLMEvaluations(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		s.handleLLMEvaluationsGet(w, r)
	case http.MethodPost:
		s.handleLLMEvaluationsPost(w, r)
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) handleLLMEvaluationsGet(w http.ResponseWriter, r *http.Request) {
	whereClause, whereArgs := llmScopeWhere(r)
	summary, err := s.db.EvaluationSummary(r.Context())
	if whereClause != "1=1" {
		summary, err = s.db.EvaluationSummaryFilter(r.Context(), whereClause, whereArgs...)
	}
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "llm_evaluations_failed")
		return
	}
	recent, err := s.db.RecentEvaluations(r.Context(), llmLimit(r, 100, 500))
	if whereClause != "1=1" {
		recent, err = s.db.RecentEvaluationsFilter(r.Context(), whereClause, llmLimit(r, 100, 500), whereArgs...)
	}
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "llm_evaluations_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"summary": summary, "evaluations": recent})
}

type llmEvaluationSubmitPayload struct {
	Evaluations []llmEvaluationSubmit `json:"evaluations"`
}

type llmEvaluationSubmit struct {
	RequestID string          `json:"request_id"`
	TraceID   string          `json:"trace_id"`
	Name      string          `json:"name"`
	Category  string          `json:"category"`
	Evaluator string          `json:"evaluator"`
	Score     float64         `json:"score"`
	Label     string          `json:"label"`
	Passed    *bool           `json:"passed"`
	Reason    string          `json:"reason"`
	Metadata  json.RawMessage `json:"metadata"`
}

type llmFeedbackSubmit struct {
	RequestID string `json:"request_id"`
	TraceID   string `json:"trace_id"`
	Rating    int    `json:"rating"`
	Label     string `json:"label"`
	Comment   string `json:"comment"`
	Source    string `json:"source"`
}

func (s *Server) handleLLMEvaluationsPost(w http.ResponseWriter, r *http.Request) {
	var payload llmEvaluationSubmitPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_json")
		return
	}
	if len(payload.Evaluations) == 0 {
		writeOpenAIError(w, http.StatusBadRequest, "evaluations is required", "invalid_request_error", "missing_evaluations")
		return
	}
	out := make([]store.LLMEvaluation, 0, len(payload.Evaluations))
	for _, input := range payload.Evaluations {
		evaluation, err := s.normalizeExternalEvaluation(r, input)
		if err != nil {
			writeOpenAIError(w, http.StatusBadRequest, err.Error(), "invalid_request_error", "invalid_evaluation")
			return
		}
		out = append(out, evaluation)
	}
	if err := s.db.InsertLLMEvaluations(r.Context(), out); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "llm_evaluation_insert_failed")
		return
	}
	s.metrics.ObserveLLMEvaluations(out)
	writeJSON(w, http.StatusCreated, map[string]any{"evaluations": out})
}

func (s *Server) handleLLMFeedbackPost(w http.ResponseWriter, r *http.Request) {
	var payload llmFeedbackSubmit
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_json")
		return
	}
	feedback, err := s.normalizeLLMFeedback(r, payload)
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, err.Error(), "invalid_request_error", "invalid_feedback")
		return
	}
	if err := s.db.InsertLLMFeedback(r.Context(), feedback); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "llm_feedback_insert_failed")
		return
	}
	s.emitFeedbackFact(feedback) // best-effort DW fact (no-op unless configured)
	s.auditAdmin(r, "llm_feedback.create", "", auditJSON(map[string]any{
		"id":         feedback.ID,
		"request_id": feedback.RequestID,
		"rating":     feedback.Rating,
		"label":      feedback.Label,
	}))
	writeJSON(w, http.StatusCreated, map[string]any{"feedback": feedback})
}

func (s *Server) normalizeExternalEvaluation(r *http.Request, input llmEvaluationSubmit) (store.LLMEvaluation, error) {
	input.RequestID = strings.TrimSpace(input.RequestID)
	input.TraceID = strings.TrimSpace(input.TraceID)
	input.Name = strings.TrimSpace(input.Name)
	input.Category = strings.TrimSpace(input.Category)
	input.Evaluator = strings.TrimSpace(input.Evaluator)
	input.Label = strings.TrimSpace(input.Label)
	if input.RequestID == "" {
		return store.LLMEvaluation{}, errors.New("request_id is required")
	}
	if input.Name == "" {
		return store.LLMEvaluation{}, errors.New("name is required")
	}
	if input.TraceID == "" {
		detail, err := s.db.RequestDetail(r.Context(), input.RequestID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return store.LLMEvaluation{}, errors.New("request_id not found")
			}
			return store.LLMEvaluation{}, err
		}
		input.TraceID = detail.Request.TraceID
	}
	if input.Category == "" {
		input.Category = "external"
	}
	if input.Evaluator == "" {
		input.Evaluator = "external"
	}
	passed := input.Score >= 0.5
	if input.Passed != nil {
		passed = *input.Passed
	}
	if input.Label == "" {
		if passed {
			input.Label = "pass"
		} else {
			input.Label = "fail"
		}
	}
	return store.LLMEvaluation{
		ID:        newID("eval"),
		RequestID: input.RequestID,
		TraceID:   input.TraceID,
		Name:      input.Name,
		Category:  input.Category,
		Evaluator: input.Evaluator,
		Score:     input.Score,
		Label:     input.Label,
		Passed:    passed,
		Reason:    strings.TrimSpace(input.Reason),
		Metadata:  strings.TrimSpace(string(input.Metadata)),
	}, nil
}

func (s *Server) normalizeLLMFeedback(r *http.Request, input llmFeedbackSubmit) (store.LLMFeedback, error) {
	input.RequestID = strings.TrimSpace(input.RequestID)
	input.TraceID = strings.TrimSpace(input.TraceID)
	input.Label = strings.TrimSpace(input.Label)
	input.Comment = strings.TrimSpace(input.Comment)
	input.Source = strings.TrimSpace(input.Source)
	if input.RequestID == "" {
		return store.LLMFeedback{}, errors.New("request_id is required")
	}
	if input.Rating < -1 || input.Rating > 1 {
		return store.LLMFeedback{}, errors.New("rating must be -1, 0, or 1")
	}
	detail, err := s.db.RequestDetail(r.Context(), input.RequestID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return store.LLMFeedback{}, errors.New("request_id not found")
		}
		return store.LLMFeedback{}, err
	}
	if input.TraceID == "" {
		input.TraceID = detail.Request.TraceID
	}
	if input.Label == "" {
		switch {
		case input.Rating > 0:
			input.Label = "positive"
		case input.Rating < 0:
			input.Label = "negative"
		default:
			input.Label = "neutral"
		}
	}
	if input.Source == "" {
		input.Source = "human"
	}
	return store.LLMFeedback{
		ID:        newID("fb"),
		RequestID: input.RequestID,
		TraceID:   input.TraceID,
		Rating:    input.Rating,
		Label:     input.Label,
		Comment:   input.Comment,
		Source:    input.Source,
		CreatedBy: adminID(r),
	}, nil
}

func llmLimit(r *http.Request, fallback int, max int) int {
	value := strings.TrimSpace(r.URL.Query().Get("limit"))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	if parsed > max {
		return max
	}
	return parsed
}

func llmPromptCandidateLimit(r *http.Request) int {
	value := strings.TrimSpace(r.URL.Query().Get("candidate_limit"))
	if value == "" {
		return 3
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return 3
	}
	if parsed > 10 {
		return 10
	}
	return parsed
}

func llmInsightWindow(r *http.Request) (time.Time, string) {
	window := strings.TrimSpace(r.URL.Query().Get("window"))
	now := time.Now().UTC()
	switch window {
	case "1h":
		return now.Add(-time.Hour), window
	case "24h", "":
		return now.Add(-24 * time.Hour), "24h"
	case "7d":
		return now.Add(-7 * 24 * time.Hour), window
	case "30d":
		return now.Add(-30 * 24 * time.Hour), window
	default:
		return now.Add(-24 * time.Hour), "24h"
	}
}

func llmScopeWhere(r *http.Request) (string, []any) {
	where := []string{"1=1"}
	args := []any{}
	if apiKeyID := strings.TrimSpace(r.URL.Query().Get("api_key_id")); apiKeyID != "" {
		where = append(where, "r.api_key_id = ?")
		args = append(args, apiKeyID)
	}
	if team := strings.TrimSpace(r.URL.Query().Get("team")); team != "" {
		where = append(where, "EXISTS (SELECT 1 FROM api_keys k WHERE k.id = r.api_key_id AND COALESCE(NULLIF(k.team, ''), 'unassigned') = ?)")
		args = append(args, team)
	}
	if model := strings.TrimSpace(r.URL.Query().Get("model")); model != "" {
		where = append(where, "r.model = ?")
		args = append(args, model)
	}
	if sessionID := strings.TrimSpace(r.URL.Query().Get("session_id")); sessionID != "" {
		where = append(where, "COALESCE(NULLIF(r.session_id, ''), 'no-session') = ?")
		args = append(args, sessionID)
	}
	if promptName := strings.TrimSpace(r.URL.Query().Get("prompt_name")); promptName != "" {
		where = append(where, "COALESCE(NULLIF(r.prompt_name, ''), 'ad-hoc') = ?")
		args = append(args, promptName)
	}
	if promptVersion := strings.TrimSpace(r.URL.Query().Get("prompt_version")); promptVersion != "" {
		where = append(where, "COALESCE(r.prompt_version, '') = ?")
		args = append(args, promptVersion)
	}
	if evaluationName := strings.TrimSpace(r.URL.Query().Get("evaluation_name")); evaluationName != "" {
		where = append(where, "EXISTS (SELECT 1 FROM llm_evaluations e WHERE e.request_id = r.id AND e.name = ?)")
		args = append(args, evaluationName)
	}
	return strings.Join(where, " AND "), args
}
