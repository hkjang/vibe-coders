package proxy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

// chatCacheKey hashes the deterministic parts of a chat/completions request. Volatile
// fields (stream, user, n) are excluded. Returns (key, model, cacheable).
// cacheable is true only when the request is reproducible: temperature == 0 (explicit)
// or a seed is set. Callers may also force caching via the X-Proxy-Cache header.
func chatCacheKey(body []byte) (string, string, bool) {
	var root struct {
		Model          string          `json:"model"`
		Messages       json.RawMessage `json:"messages"`
		Tools          json.RawMessage `json:"tools"`
		Temperature    *float64        `json:"temperature"`
		TopP           *float64        `json:"top_p"`
		MaxTokens      *int            `json:"max_tokens"`
		ResponseFormat json.RawMessage `json:"response_format"`
		Seed           *int            `json:"seed"`
	}
	if err := json.Unmarshal(body, &root); err != nil {
		return "", "", false
	}
	model := strings.TrimSpace(root.Model)
	if model == "" || len(root.Messages) == 0 {
		return "", "", false
	}
	deterministic := (root.Temperature != nil && *root.Temperature == 0) || root.Seed != nil
	h := sha256.New()
	for _, part := range [][]byte{
		[]byte(model), {0}, root.Messages, {0}, root.Tools, {0}, root.ResponseFormat,
	} {
		h.Write(part)
	}
	if root.TopP != nil {
		h.Write([]byte("|top_p="))
		h.Write([]byte(jsonString(*root.TopP)))
	}
	if root.MaxTokens != nil {
		h.Write([]byte("|max="))
		h.Write([]byte(jsonString(*root.MaxTokens)))
	}
	if root.Seed != nil {
		h.Write([]byte("|seed="))
		h.Write([]byte(jsonString(*root.Seed)))
	}
	return "chat:" + hex.EncodeToString(h.Sum(nil)), model, deterministic
}

// chatCacheEligible reports whether this request may be served/stored from the chat
// cache: feature on, deterministic body (temp 0 / seed) OR explicit opt-in header.
func (s *Server) chatCacheEligible(r *http.Request, body []byte) (string, bool) {
	if !s.cfg.Cache.ChatEnabled || r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" {
		return "", false
	}
	key, _, deterministic := chatCacheKey(body)
	if key == "" {
		return "", false
	}
	optIn := strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Proxy-Cache")), "1")
	if !deterministic && !optIn {
		return "", false
	}
	return key, true
}

func (s *Server) serveChatFromCache(ctx context.Context, w http.ResponseWriter, key string, meta store.LogRecord, traceID string) bool {
	hit, found, err := s.db.GetEmbeddingCache(ctx, key)
	if err != nil {
		slog.Warn("chat cache lookup failed", "error", err)
		return false
	}
	if !found {
		return false
	}
	contentType := hit.ContentType
	if contentType == "" {
		contentType = "application/json"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Cache", "HIT")
	w.Header().Set("X-Cache-Type", "chat")
	w.Header().Set("X-Request-ID", traceID)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(hit.Body)

	s.metrics.IncCacheHit()
	s.metrics.IncRequest(false)

	meta.Request.Provider = "cache"
	meta.Request.StatusCode = http.StatusOK
	meta.Request.LatencyMS = 0
	meta.Request.RouteReason = "cache"
	if meta.Routing != nil {
		meta.Routing.SelectedProvider = "cache"
		meta.Routing.HealthScore = 100
		meta.Routing.DecisionReason = strings.TrimSpace(meta.Routing.DecisionReason + "; cache hit served without upstream call")
	}
	meta.Response = &store.ResponseLog{
		ID:           newID("resp"),
		RequestID:    meta.Request.ID,
		StatusCode:   http.StatusOK,
		FinishReason: "cache",
		ResponseHash: audit.HashText(string(hit.Body)),
		CreatedAt:    time.Now().UTC(),
	}
	if promptEstimate := promptTokenEstimate(meta.Prompts); promptEstimate > 0 {
		meta.Usage = &store.TokenUsage{
			ID:           newID("usage"),
			RequestID:    meta.Request.ID,
			PromptTokens: promptEstimate,
			TotalTokens:  promptEstimate,
			Currency:     "KRW",
			Source:       "cache",
			CreatedAt:    time.Now().UTC(),
		}
	}
	meta.Evaluations = buildLLMEvaluations(meta, ResponseAnalysis{Hash: meta.Response.ResponseHash, FinishReason: "cache"})
	s.metrics.ObserveLLMEvaluations(meta.Evaluations)
	s.enqueue(meta)
	return true
}

func (s *Server) maybeStoreChatCache(ctx context.Context, key string, statusCode int, contentType string, responseBody []byte) {
	if key == "" || statusCode != http.StatusOK {
		return
	}
	maxBytes := s.cfg.Cache.EmbeddingMaxBytes
	if len(responseBody) == 0 || (maxBytes > 0 && len(responseBody) > maxBytes) {
		return
	}
	if err := s.db.PutEmbeddingCache(ctx, key, "chat", contentType, responseBody, s.cfg.Cache.ChatTTL); err != nil {
		slog.Warn("chat cache store failed", "error", err)
	}
}
