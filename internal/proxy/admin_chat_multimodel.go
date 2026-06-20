package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"time"
)

// maxMultiRunModels caps how many models one multi-run may call, to bound real cost/latency.
const maxMultiRunModels = 5

type multiRunModelSpec struct {
	Model    string `json:"model"`
	Provider string `json:"provider"`
}

type multiRunRequest struct {
	Title    string              `json:"title"`
	Models   []multiRunModelSpec `json:"models"`
	Messages []map[string]any    `json:"messages"`
	Prompt   string              `json:"prompt"`
	Params   struct {
		Temperature *float64 `json:"temperature"`
		MaxTokens   int      `json:"max_tokens"`
		Stream      bool     `json:"stream"`
		TimeoutMS   int      `json:"timeout_ms"`
	} `json:"params"`
	SavePrompt bool `json:"save_prompt"`
}

type multiRunResult struct {
	Model        string  `json:"model"`
	Provider     string  `json:"provider"`
	Status       string  `json:"status"` // success | error | timeout
	StatusCode   int     `json:"status_code"`
	LatencyMS    int64   `json:"latency_ms"`
	InputTokens  int     `json:"input_tokens"`
	OutputTokens int     `json:"output_tokens"`
	TotalTokens  int     `json:"total_tokens"`
	CostKRWEst   float64 `json:"cost_krw_est"`
	Content      string  `json:"content"`
	FinishReason string  `json:"finish_reason"`
	Error        string  `json:"error"`
	SelectedProvider string `json:"selected_provider"`
}

// handleChatTestMultiRun calls the SAME prompt against several models in parallel through
// the real chat pipeline and returns per-model results for side-by-side comparison. One
// model failing never fails the run — each carries its own status. Capped at
// maxMultiRunModels to bound real cost. POST /admin/chat-test/multi-run
func (s *Server) handleChatTestMultiRun(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var req multiRunRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	// De-dup + validate models.
	seen := map[string]bool{}
	models := make([]multiRunModelSpec, 0, len(req.Models))
	for _, m := range req.Models {
		m.Model = strings.TrimSpace(m.Model)
		if m.Model == "" {
			continue
		}
		key := m.Model + "|" + strings.TrimSpace(m.Provider)
		if seen[key] {
			continue
		}
		seen[key] = true
		models = append(models, m)
	}
	if len(models) == 0 {
		writeOpenAIError(w, http.StatusBadRequest, "at least one model is required", "invalid_request_error", "missing_models")
		return
	}
	if len(models) > maxMultiRunModels {
		writeOpenAIError(w, http.StatusBadRequest, "at most "+strconv.Itoa(maxMultiRunModels)+" models per run", "invalid_request_error", "too_many_models")
		return
	}

	results := make([]multiRunResult, len(models))
	var wg sync.WaitGroup
	for i, m := range models {
		wg.Add(1)
		go func(idx int, spec multiRunModelSpec) {
			defer wg.Done()
			results[idx] = s.runSingleModel(r, req, spec)
		}(i, m)
	}
	wg.Wait()

	// Summary.
	success, failed := 0, 0
	bestLatencyModel, lowestCostModel := "", ""
	var bestLatency int64 = -1
	lowestCost := -1.0
	for _, res := range results {
		if res.Status == "success" {
			success++
			if bestLatency < 0 || res.LatencyMS < bestLatency {
				bestLatency = res.LatencyMS
				bestLatencyModel = res.Model
			}
			if lowestCost < 0 || res.CostKRWEst < lowestCost {
				lowestCost = res.CostKRWEst
				lowestCostModel = res.Model
			}
		} else {
			failed++
		}
	}
	s.auditAdmin(r, "chat_test.multi_run", "", auditJSON(map[string]any{"models": len(models), "success": success, "failed": failed}))
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "completed",
		"title":  strings.TrimSpace(req.Title),
		"summary": map[string]any{
			"total_models":              len(models),
			"success":                   success,
			"failed":                    failed,
			"best_latency_model":        bestLatencyModel,
			"lowest_cost_success_model": lowestCostModel,
		},
		"results": results,
	})
}

// runSingleModel runs one model through the chat pipeline and parses its result. It never
// panics out of its goroutine — failures become an error result.
func (s *Server) runSingleModel(r *http.Request, req multiRunRequest, spec multiRunModelSpec) multiRunResult {
	res := multiRunResult{Model: spec.Model, Provider: spec.Provider, Status: "error"}
	input := chatTestRunRequest{
		Model:       spec.Model,
		Provider:    spec.Provider,
		Messages:    req.Messages,
		Prompt:      req.Prompt,
		Temperature: req.Params.Temperature,
		MaxTokens:   req.Params.MaxTokens,
	}
	prepRec := httptest.NewRecorder()
	prep, ok := s.prepareChatTestRequest(prepRec, r, input, false)
	if !ok {
		res.Error = "request preparation failed (auth/policy)"
		return res
	}

	rec := httptest.NewRecorder()
	start := time.Now()
	s.handleOpenAI(rec, prep.req)
	res.LatencyMS = time.Since(start).Milliseconds()
	resp := rec.Result()
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	res.StatusCode = resp.StatusCode
	if res.StatusCode == 0 {
		res.StatusCode = http.StatusOK
	}
	content, _, finish := extractChatTestContent(body)
	res.Content = truncateRunes(content, 4000)
	res.FinishReason = finish
	res.SelectedProvider = resp.Header.Get("X-Proxy-Provider")
	if res.SelectedProvider == "" {
		res.SelectedProvider = resp.Header.Get("X-Selected-Provider")
	}

	// Actual token usage from the response body.
	var parsed struct {
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
			TotalTokens      int `json:"total_tokens"`
		} `json:"usage"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &parsed)
	res.InputTokens = parsed.Usage.PromptTokens
	res.OutputTokens = parsed.Usage.CompletionTokens
	res.TotalTokens = parsed.Usage.TotalTokens
	if v := strings.TrimSpace(resp.Header.Get("X-Estimated-Cost-KRW")); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			res.CostKRWEst = f
		}
	}

	if res.StatusCode >= 200 && res.StatusCode < 300 {
		res.Status = "success"
	} else {
		res.Status = "error"
		if parsed.Error != nil && parsed.Error.Message != "" {
			res.Error = parsed.Error.Message
		} else {
			res.Error = "HTTP " + strconv.Itoa(res.StatusCode)
		}
	}
	return res
}

// truncateRunes caps a string to n runes (preview safety).
func truncateRunes(s string, n int) string {
	rs := []rune(s)
	if len(rs) <= n {
		return s
	}
	return string(rs[:n]) + "…"
}
