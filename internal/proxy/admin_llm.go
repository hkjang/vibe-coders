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
		Limit:      llmLimit(r, 100, 500),
		Model:      strings.TrimSpace(r.URL.Query().Get("model")),
		APIKeyID:   strings.TrimSpace(r.URL.Query().Get("api_key_id")),
		SessionID:  strings.TrimSpace(r.URL.Query().Get("session_id")),
		PromptName: strings.TrimSpace(r.URL.Query().Get("prompt_name")),
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
	sessions, err := s.db.LLMSessions(r.Context(), llmLimit(r, 100, 500))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "llm_sessions_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": sessions})
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
	prompts, err := s.db.LLMPrompts(r.Context(), llmLimit(r, 100, 500))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "llm_prompts_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"prompts": prompts})
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
	patterns, err := s.db.LLMPatterns(r.Context(), llmLimit(r, 50, 200))
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
	insights, err := s.db.LLMInsights(r.Context(), since, llmLimit(r, 50, 200))
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
	summary, err := s.db.EvaluationSummary(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "llm_evaluations_failed")
		return
	}
	recent, err := s.db.RecentEvaluations(r.Context(), llmLimit(r, 100, 500))
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
