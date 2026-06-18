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

// embeddingCacheKey returns a deterministic key for an /v1/embeddings request body.
// It hashes (model || input-as-string) so that the same input on the same model maps
// to the same key, while different encodings, dimensions, or models do not collide.
func embeddingCacheKey(body []byte) (string, string, bool) {
	var root struct {
		Model          string          `json:"model"`
		Input          json.RawMessage `json:"input"`
		Dimensions     int             `json:"dimensions"`
		EncodingFormat string          `json:"encoding_format"`
	}
	if err := json.Unmarshal(body, &root); err != nil {
		return "", "", false
	}
	model := strings.TrimSpace(root.Model)
	if model == "" || len(root.Input) == 0 {
		return "", "", false
	}
	h := sha256.New()
	h.Write([]byte(model))
	h.Write([]byte{0})
	if root.Dimensions > 0 {
		h.Write([]byte(strings.TrimSpace(json.Number(intToString(root.Dimensions)).String())))
		h.Write([]byte{0})
	}
	if root.EncodingFormat != "" {
		h.Write([]byte(root.EncodingFormat))
		h.Write([]byte{0})
	}
	h.Write(root.Input)
	return hex.EncodeToString(h.Sum(nil)), model, true
}

func intToString(v int) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	buf := [20]byte{}
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// serveEmbeddingFromCache returns true if the request was served from the cache.
// When it serves a cached response it also enqueues an audit record with provider="cache"
// so the call still shows up in usage dashboards.
func (s *Server) serveEmbeddingFromCache(ctx context.Context, w http.ResponseWriter, r *http.Request, body []byte, meta store.LogRecord, traceID string) bool {
	key, model, ok := embeddingCacheKey(body)
	if !ok {
		return false
	}
	hit, found, err := s.db.GetEmbeddingCache(ctx, key)
	if err != nil {
		slog.Warn("embedding cache lookup failed", "error", err)
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
	w.Header().Set("X-Cache-Key", hit.CacheKey[:16])
	w.Header().Set("X-Request-ID", traceID)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(hit.Body)

	s.metrics.IncCacheHit()
	s.metrics.IncRequest(false)

	// emit an audit row so cached responses still count toward usage stats
	meta.Request.Provider = "cache"
	meta.Request.StatusCode = http.StatusOK
	meta.Request.LatencyMS = 0
	meta.Request.Stream = false
	meta.Response = &store.ResponseLog{
		ID:           newID("resp"),
		RequestID:    meta.Request.ID,
		StatusCode:   http.StatusOK,
		FinishReason: "cache",
		ResponseHash: audit.HashText(string(hit.Body)),
		CreatedAt:    time.Now().UTC(),
	}
	// usage figures: prompt tokens estimated from input, no completion tokens, KRW=0
	if promptEstimate := promptTokenEstimate(meta.Prompts); promptEstimate > 0 {
		meta.Usage = &store.TokenUsage{
			ID:               newID("usage"),
			RequestID:        meta.Request.ID,
			PromptTokens:     promptEstimate,
			CompletionTokens: 0,
			TotalTokens:      promptEstimate,
			EstimatedCost:    0,
			Currency:         "KRW",
			Source:           "cache",
			CreatedAt:        time.Now().UTC(),
		}
	}
	meta.Evaluations = buildLLMEvaluations(meta, ResponseAnalysis{
		Hash:         audit.HashText(string(hit.Body)),
		Text:         string(hit.Body),
		FinishReason: "cache",
		HasUsage:     meta.Usage != nil,
	})
	s.metrics.ObserveLLMEvaluations(meta.Evaluations)
	_ = model
	s.enqueue(meta)
	return true
}

func (s *Server) maybeStoreEmbeddingCache(ctx context.Context, requestBody []byte, statusCode int, contentType string, responseBody []byte) {
	if !s.cacheConf().EmbeddingEnabled {
		return
	}
	if statusCode != http.StatusOK {
		return
	}
	if len(responseBody) == 0 || len(responseBody) > s.cacheConf().EmbeddingMaxBytes {
		return
	}
	key, model, ok := embeddingCacheKey(requestBody)
	if !ok {
		return
	}
	if err := s.db.PutEmbeddingCache(ctx, key, model, contentType, responseBody, s.cacheConf().EmbeddingTTL); err != nil {
		slog.Warn("embedding cache store failed", "error", err)
	}
}
