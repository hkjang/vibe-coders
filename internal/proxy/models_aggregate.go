package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"vibe-coders/internal/store"
)

const (
	// Provider catalogues are normally measured in hundreds of rows. The byte and row limits
	// intentionally leave an order of magnitude of headroom while preventing compact JSON from
	// expanding into an unbounded []map in the shared gateway process.
	maxModelsResponseBytes       = 8 << 20
	maxModelsPerProvider         = 10_000
	maxModelsProvidersPerRequest = 64

	// An unpinned public catalogue has its own aggregate row and encoded-response bounds. The
	// small reserve covers {"object":"list","data":...} around the individually measured rows.
	maxAggregatedModelsResponseBytes = 16 << 20
	maxAggregatedModelsPayloadBytes  = maxAggregatedModelsResponseBytes - 64
	maxAggregatedModels              = 20_000
	modelsCatalogMaxConcurrency      = 4
	modelsCatalogOverallTimeout      = 10 * time.Second
)

type providerModelsLimitError struct {
	kind  string
	limit int
}

func (err *providerModelsLimitError) Error() string {
	return fmt.Sprintf("provider model catalogue exceeds the supported %s limit (%d)", err.kind, err.limit)
}

func isProviderModelsLimitError(err error) bool {
	var limitErr *providerModelsLimitError
	return errors.As(err, &limitErr)
}

func providerModelsFailureCode(err error) string {
	if isProviderModelsLimitError(err) {
		return "provider_models_limit_exceeded"
	}
	return "provider_models_unavailable"
}

func (s *Server) modelsCatalogTimeout() time.Duration {
	if s.adminModels == nil {
		return modelsCatalogOverallTimeout
	}
	return boundedAdminModelsCatalogRefreshTimeout(s.adminModels.refreshTimeout)
}

type aggregatedModelsResult struct {
	data         []map[string]any
	providersOK  []string
	providersErr []string
	skipped      int
	truncated    bool
	payloadBytes int
}

// clientPinnedProvider reports whether the caller explicitly targeted one provider (via the
// X-Proxy-Provider header or ?provider= query). A pinned GET /v1/models keeps the classic
// single-provider passthrough; an unpinned one is aggregated across every enabled provider.
func clientPinnedProvider(r *http.Request) bool {
	if strings.TrimSpace(r.Header.Get("X-Proxy-Provider")) != "" {
		return true
	}
	return strings.TrimSpace(r.URL.Query().Get("provider")) != ""
}

// aggregatedModels fans out GET /v1/models to every enabled upstream provider concurrently and
// merges their catalogues into one OpenAI-compatible model list. Each returned model object is
// tagged with its source provider ("owned_by" is filled in when the upstream omits it, and a
// non-breaking "provider" field is added) so an operator/user can see, at a glance, every model
// the gateway can actually reach and which upstream serves it. Deduped by model id (first
// provider wins), so overlapping catalogues surface each usable model exactly once.
func (s *Server) aggregatedModels(ctx context.Context, r *http.Request) aggregatedModelsResult {
	result := aggregatedModelsResult{data: []map[string]any{}}
	configs, err := s.db.ListProviderConfigs(ctx)
	if err != nil {
		slog.Warn("aggregated models: list providers failed", "code", "provider_config_unavailable")
		return result
	}

	type provJob struct {
		name    string
		baseURL string
		apiKey  string
		timeout time.Duration
	}
	dec := s.secrets.Load()
	jobCapacity := len(configs)
	if jobCapacity > maxModelsProvidersPerRequest {
		jobCapacity = maxModelsProvidersPerRequest
	}
	jobs := make([]provJob, 0, jobCapacity)
	for _, p := range configs {
		if !p.Enabled {
			continue
		}
		if len(jobs) >= maxModelsProvidersPerRequest {
			result.skipped++
			result.truncated = true
			continue
		}
		key, kerr := dec.Decrypt(p.EncryptedAPIKey)
		if kerr != nil || key == "" {
			continue
		}
		timeout := time.Duration(p.TimeoutMS) * time.Millisecond
		if timeout <= 0 {
			timeout = s.cfg.Upstream.Timeout
		}
		jobs = append(jobs, provJob{name: p.Name, baseURL: p.BaseURL, apiKey: key, timeout: timeout})
	}
	if len(jobs) == 0 {
		return result
	}

	// Dedup by model id across providers so the caller sees each usable model once (first
	// provider wins). Overlap is common — e.g. an explicit "openai" provider and the seeded
	// default upstream can both advertise the same ids; showing both would just be noise.
	seen := map[string]bool{}
	type providerResult struct {
		models []map[string]any
		err    error
	}
	for batchStart := 0; batchStart < len(jobs); batchStart += modelsCatalogMaxConcurrency {
		if ctx.Err() != nil || len(result.data) >= maxAggregatedModels || result.payloadBytes >= maxAggregatedModelsPayloadBytes {
			result.skipped += len(jobs) - batchStart
			result.truncated = true
			break
		}
		batchEnd := batchStart + modelsCatalogMaxConcurrency
		if batchEnd > len(jobs) {
			batchEnd = len(jobs)
		}
		batch := make([]providerResult, batchEnd-batchStart)
		var wg sync.WaitGroup
		wg.Add(len(batch))
		for offset := range batch {
			job := jobs[batchStart+offset]
			go func(index int, job provJob) {
				defer wg.Done()
				batch[index].models, batch[index].err = s.fetchProviderModelsWithSlot(
					ctx, job.name, job.baseURL, job.apiKey, job.timeout, r.URL.RawQuery,
				)
			}(offset, job)
		}
		wg.Wait()

		for offset, providerResult := range batch {
			job := jobs[batchStart+offset]
			if providerResult.err != nil {
				result.providersErr = append(result.providersErr, job.name)
				slog.Warn("aggregated models: provider fetch failed", "provider", job.name, "code", providerModelsFailureCode(providerResult.err))
				continue
			}
			result.providersOK = append(result.providersOK, job.name)
			for _, model := range providerResult.models {
				if model == nil {
					continue
				}
				id, _ := model["id"].(string)
				if id != "" && seen[id] {
					continue
				}
				if owned, ok := model["owned_by"].(string); !ok || owned == "" {
					model["owned_by"] = job.name
				}
				model["provider"] = job.name
				if !appendBoundedAggregatedModel(&result, model) {
					result.truncated = true
					if len(result.data) >= maxAggregatedModels || result.payloadBytes >= maxAggregatedModelsPayloadBytes {
						break
					}
					continue
				}
				if id != "" {
					seen[id] = true
				}
			}
		}
	}
	return result
}

func appendBoundedAggregatedModel(result *aggregatedModelsResult, model map[string]any) bool {
	if len(result.data) >= maxAggregatedModels {
		return false
	}
	encoded, err := json.Marshal(model)
	if err != nil {
		return false
	}
	// One byte accounts for the comma separating neighbouring array entries. The fixed list
	// envelope is deliberately outside this budget and is only a few dozen bytes.
	modelBytes := len(encoded) + 1
	if modelBytes > maxAggregatedModelsPayloadBytes-result.payloadBytes {
		return false
	}
	result.data = append(result.data, model)
	result.payloadBytes += modelBytes
	return true
}

func (s *Server) fetchProviderModelsWithSlot(ctx context.Context, name, baseURL, apiKey string, timeout time.Duration, rawQuery string) ([]map[string]any, error) {
	if s.adminModels == nil || s.adminModels.semaphore == nil {
		return s.fetchProviderModels(ctx, name, baseURL, apiKey, timeout, rawQuery)
	}
	select {
	case s.adminModels.semaphore <- struct{}{}:
		defer func() { <-s.adminModels.semaphore }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return s.fetchProviderModels(ctx, name, baseURL, apiKey, timeout, rawQuery)
}

func decodeProviderModels(raw []byte) ([]map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	first, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	if first == nil {
		if err := requireJSONEOF(decoder); err != nil {
			return nil, err
		}
		return []map[string]any{}, nil
	}
	if delimiter, ok := first.(json.Delim); !ok || delimiter != '{' {
		return nil, errors.New("provider model catalogue must be a JSON object")
	}
	models := make([]map[string]any, 0, 256)
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, errors.New("provider model catalogue contains a non-string object key")
		}
		if key != "data" {
			var ignored json.RawMessage
			if err := decoder.Decode(&ignored); err != nil {
				return nil, err
			}
			continue
		}
		value, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		if value == nil {
			models = models[:0]
			continue
		}
		delimiter, ok := value.(json.Delim)
		if !ok || delimiter != '[' {
			return nil, errors.New("provider model catalogue data must be an array")
		}
		models = models[:0]
		for decoder.More() {
			if len(models) >= maxModelsPerProvider {
				return nil, &providerModelsLimitError{kind: "model count", limit: maxModelsPerProvider}
			}
			var model map[string]any
			if err := decoder.Decode(&model); err != nil {
				return nil, err
			}
			models = append(models, model)
		}
		if _, err := decoder.Token(); err != nil {
			return nil, err
		}
	}
	if _, err := decoder.Token(); err != nil {
		return nil, err
	}
	if err := requireJSONEOF(decoder); err != nil {
		return nil, err
	}
	return models, nil
}

func requireJSONEOF(decoder *json.Decoder) error {
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return errors.New("provider model catalogue contains trailing JSON")
		}
		return err
	}
	return nil
}

// fetchProviderModels performs one upstream GET /v1/models against a single provider and returns
// its raw model objects (the JSON "data" array). The target path is deliberately constructed
// here instead of being copied from the caller: this helper is also used by /admin/models, whose
// control-plane path and filters must never be forwarded to a provider. Provider-specific base
// paths are preserved, while the provider's own key and timeout are applied. rawQuery exists
// only to preserve the public /v1/models passthrough contract; admin callers always pass "".
func (s *Server) fetchProviderModels(ctx context.Context, name, baseURL, apiKey string, timeout time.Duration, rawQuery string) ([]map[string]any, error) {
	target, err := s.upstreamURL(baseURL, &url.URL{Path: "/v1/models", RawQuery: rawQuery})
	if err != nil {
		return nil, err
	}
	callCtx := ctx
	if timeout > 0 {
		var cancel context.CancelFunc
		callCtx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	req, err := http.NewRequestWithContext(callCtx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Accept", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxModelsResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > maxModelsResponseBytes {
		return nil, &providerModelsLimitError{kind: "byte size", limit: maxModelsResponseBytes}
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("provider %q returned status %d", name, resp.StatusCode)
	}
	return decodeProviderModels(raw)
}

// serveAggregatedModels writes the merged multi-provider model list for an unpinned GET
// /v1/models and enqueues a lightweight audit record. It returns false (without writing) when
// no provider could be aggregated, so the caller can fall back to classic single-provider proxying.
func (rc *requestPipeline) serveAggregatedModels() bool {
	s, r, w := rc.s, rc.r, rc.w
	start := time.Now()

	result := s.aggregatedModels(r.Context(), r)
	if len(result.providersOK) == 0 {
		setAggregatedModelsHeaders(w, result)
		return false
	}
	// Advertise operator-defined agent routes as callable virtual models so clients discover them
	// alongside real models.
	if routes, err := s.db.ListAgentRoutes(r.Context()); err == nil {
		for _, ar := range routes {
			if !ar.Enabled {
				continue
			}
			if !appendBoundedAggregatedModel(&result, map[string]any{
				"id": ar.VirtualModel, "object": "model", "owned_by": "agent-route",
				"provider": "vibe", "agent_route": true,
			}) {
				result.truncated = true
				break
			}
		}
	}
	buf, err := json.Marshal(map[string]any{"object": "list", "data": result.data})
	if err != nil {
		slog.Warn("aggregated models: marshal failed", "code", "models_response_encode_failed")
		writeOpenAIError(w, http.StatusServiceUnavailable, "model catalog response is unavailable", "server_error", "models_response_encode_failed")
		return true
	}
	if len(buf) > maxAggregatedModelsResponseBytes {
		slog.Warn("aggregated models: response bound exceeded", "code", "models_response_limit_exceeded")
		writeOpenAIError(w, http.StatusServiceUnavailable, "model catalog response exceeds the supported limit", "server_error", "models_response_limit_exceeded")
		return true
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Request-ID", rc.traceID)
	setAggregatedModelsHeaders(w, result)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf)

	s.metrics.IncRequest(false)

	meta := rc.meta
	meta.Request.Provider = "aggregate"
	meta.Request.RouteReason = "models_aggregate"
	meta.Request.RouteDetail = strings.Join(result.providersOK, ",")
	meta.Request.StatusCode = http.StatusOK
	meta.Request.LatencyMS = time.Since(start).Milliseconds()
	meta.Response = &store.ResponseLog{
		ID:         newID("resp"),
		RequestID:  meta.Request.ID,
		StatusCode: http.StatusOK,
		CreatedAt:  time.Now().UTC(),
	}
	s.enqueue(meta)
	return true
}

func setAggregatedModelsHeaders(w http.ResponseWriter, result aggregatedModelsResult) {
	if len(result.providersOK) > 0 {
		w.Header().Set("X-Models-Providers", strings.Join(result.providersOK, ","))
	}
	if len(result.providersErr) > 0 {
		w.Header().Set("X-Models-Providers-Failed", strings.Join(result.providersErr, ","))
	}
	if result.skipped > 0 {
		w.Header().Set("X-Models-Providers-Skipped", fmt.Sprintf("%d", result.skipped))
	}
	if result.truncated {
		w.Header().Set("X-Models-Truncated", "true")
	}
}
