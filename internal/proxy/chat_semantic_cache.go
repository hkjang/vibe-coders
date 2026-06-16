package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

// chatPromptText extracts a flat text representation of a chat request's messages, used
// as the embedding input for semantic-cache matching.
func chatPromptText(body []byte) string {
	var root struct {
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &root); err != nil {
		return ""
	}
	var b strings.Builder
	for _, m := range root.Messages {
		// content may be a string or an array of parts; handle the common string case
		// and fall back to the raw JSON for structured content.
		var str string
		if json.Unmarshal(m.Content, &str) == nil {
			b.WriteString(m.Role + ": " + str + "\n")
		} else {
			b.WriteString(m.Role + ": " + string(m.Content) + "\n")
		}
	}
	return strings.TrimSpace(b.String())
}

// embedText calls the configured embedding model (via the normal provider selection)
// to vectorize text. Best-effort with a short timeout; returns an error the caller
// treats as "no semantic cache for this request".
func (s *Server) embedText(ctx context.Context, r *http.Request, model, text string) ([]float64, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cfg := s.cacheConf()
	var baseURL, apiKey string
	if strings.TrimSpace(cfg.EmbeddingBaseURL) != "" {
		// Dedicated embedding endpoint (e.g. a local embedding server). Use its own key
		// when provided, else fall back to the default upstream provider's key.
		baseURL = cfg.EmbeddingBaseURL
		apiKey = cfg.EmbeddingAPIKey
		if strings.TrimSpace(apiKey) == "" {
			if provider, perr := s.selectProvider(ctx, r, model); perr == nil {
				apiKey = provider.APIKey
			}
		}
	} else {
		// Optional provider override; empty → normal selection (model glob → default upstream).
		provider, err := s.selectProviderForced(ctx, r, model, strings.TrimSpace(cfg.EmbeddingProvider))
		if err != nil {
			return nil, err
		}
		baseURL, apiKey = provider.BaseURL, provider.APIKey
	}
	upstreamURL, err := s.upstreamURL(baseURL, &url.URL{Path: "/v1/embeddings"})
	if err != nil {
		return nil, err
	}
	reqBody, _ := json.Marshal(map[string]any{"model": model, "input": text})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, upstreamURL, bytes.NewReader(reqBody))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if strings.TrimSpace(apiKey) != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &cacheEmbedError{status: resp.StatusCode}
	}
	var parsed struct {
		Data []struct {
			Embedding []float64 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, err
	}
	if len(parsed.Data) == 0 || len(parsed.Data[0].Embedding) == 0 {
		return nil, &cacheEmbedError{status: resp.StatusCode}
	}
	return parsed.Data[0].Embedding, nil
}

type cacheEmbedError struct{ status int }

func (e *cacheEmbedError) Error() string { return "embedding upstream failed" }

// serveChatSemantic, on an exact-cache miss, embeds the prompt and looks for a
// semantically-near cached response. On a hit it writes the response and returns
// served=true. It always returns the computed query vector (when available) so the
// caller can store the eventual response under it. Any failure → (nil, false): the
// request proceeds normally.
func (s *Server) serveChatSemantic(ctx context.Context, w http.ResponseWriter, r *http.Request, body []byte, meta store.LogRecord, traceID string) ([]float64, bool) {
	cfg := s.cacheConf()
	if !cfg.ChatSemanticEnabled || strings.TrimSpace(cfg.ChatSemanticModel) == "" {
		return nil, false
	}
	text := chatPromptText(body)
	if text == "" {
		return nil, false
	}
	vec, err := s.embedText(ctx, r, cfg.ChatSemanticModel, text)
	if err != nil {
		slog.Warn("semantic cache embed failed", "error", err)
		return nil, false
	}
	_, model, _ := chatCacheKey(body)
	hit, found, err := s.db.SearchChatSemantic(ctx, model, vec, cfg.ChatSemanticThreshold, cfg.ChatSemanticMaxCandidates)
	if err != nil || !found {
		return vec, false
	}
	contentType := hit.ContentType
	if contentType == "" {
		contentType = "application/json"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Cache", "HIT")
	w.Header().Set("X-Cache-Type", "chat-semantic")
	w.Header().Set("X-Request-ID", traceID)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(hit.Body)

	s.metrics.IncCacheHit()
	s.metrics.IncRequest(false)
	meta.Request.Provider = "cache"
	meta.Request.StatusCode = http.StatusOK
	meta.Request.LatencyMS = 0
	meta.Request.RouteReason = "cache-semantic"
	meta.Response = &store.ResponseLog{
		ID: newID("resp"), RequestID: meta.Request.ID, StatusCode: http.StatusOK,
		FinishReason: "cache", ResponseHash: audit.HashText(string(hit.Body)), CreatedAt: time.Now().UTC(),
	}
	meta.Evaluations = buildLLMEvaluations(meta, ResponseAnalysis{Hash: meta.Response.ResponseHash, FinishReason: "cache"})
	s.metrics.ObserveLLMEvaluations(meta.Evaluations)
	s.enqueue(meta)
	return vec, true
}

// maybeStoreChatSemantic stores a successful chat response under the query embedding for
// future semantic reuse.
func (s *Server) maybeStoreChatSemantic(ctx context.Context, body []byte, vec []float64, statusCode int, contentType string, responseBody []byte) {
	if !s.cacheConf().ChatSemanticEnabled || len(vec) == 0 || statusCode != http.StatusOK || len(responseBody) == 0 {
		return
	}
	if maxBytes := s.cacheConf().EmbeddingMaxBytes; maxBytes > 0 && len(responseBody) > maxBytes {
		return
	}
	_, model, _ := chatCacheKey(body)
	if model == "" {
		return
	}
	if err := s.db.PutChatSemanticEntry(ctx, newID("sem"), model, vec, contentType, responseBody, s.cacheConf().ChatTTL); err != nil {
		slog.Warn("semantic cache store failed", "error", err)
	}
}
