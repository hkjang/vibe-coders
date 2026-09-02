package proxy

import (
	"context"
	"encoding/json"
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

const maxModelsResponseBytes = 8 << 20

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
func (s *Server) aggregatedModels(ctx context.Context, r *http.Request) (data []map[string]any, providersOK, providersErr []string) {
	configs, err := s.db.ListProviderConfigs(ctx)
	if err != nil {
		slog.Warn("aggregated models: list providers failed", "error", err)
		return nil, nil, nil
	}

	type provJob struct {
		name    string
		baseURL string
		apiKey  string
		timeout time.Duration
	}
	dec := s.secrets.Load()
	jobs := make([]provJob, 0, len(configs))
	for _, p := range configs {
		if !p.Enabled {
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
		return nil, nil, nil
	}

	results := make([][]map[string]any, len(jobs))
	failed := make([]bool, len(jobs))
	var wg sync.WaitGroup
	for i := range jobs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			models, ferr := s.fetchProviderModels(ctx, jobs[i].name, jobs[i].baseURL, jobs[i].apiKey, jobs[i].timeout, r.URL.RawQuery)
			if ferr != nil {
				failed[i] = true
				slog.Warn("aggregated models: provider fetch failed", "provider", jobs[i].name, "error", ferr)
				return
			}
			results[i] = models
		}(i)
	}
	wg.Wait()

	// Dedup by model id across providers so the caller sees each usable model once (first
	// provider wins). Overlap is common — e.g. an explicit "openai" provider and the seeded
	// default upstream can both advertise the same ids; showing both would just be noise.
	seen := map[string]bool{}
	for i, models := range results {
		if failed[i] {
			providersErr = append(providersErr, jobs[i].name)
			continue
		}
		providersOK = append(providersOK, jobs[i].name)
		for _, m := range models {
			if m == nil {
				continue
			}
			id, _ := m["id"].(string)
			if id != "" {
				if seen[id] {
					continue
				}
				seen[id] = true
			}
			if owned, ok := m["owned_by"].(string); !ok || owned == "" {
				m["owned_by"] = jobs[i].name
			}
			m["provider"] = jobs[i].name
			data = append(data, m)
		}
	}
	return data, providersOK, providersErr
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
		return nil, fmt.Errorf("provider %q model catalogue exceeds %d bytes", name, maxModelsResponseBytes)
	}
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("provider %q returned status %d", name, resp.StatusCode)
	}
	var parsed struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, err
	}
	return parsed.Data, nil
}

// serveAggregatedModels writes the merged multi-provider model list for an unpinned GET
// /v1/models and enqueues a lightweight audit record. It returns false (without writing) when
// no provider could be aggregated, so the caller can fall back to classic single-provider proxying.
func (rc *requestPipeline) serveAggregatedModels() bool {
	s, r, w := rc.s, rc.r, rc.w
	start := time.Now()

	data, providersOK, providersErr := s.aggregatedModels(r.Context(), r)
	if len(providersOK) == 0 {
		return false
	}
	if data == nil {
		data = []map[string]any{}
	}
	// Advertise operator-defined agent routes as callable virtual models so clients discover them
	// alongside real models.
	if routes, err := s.db.ListAgentRoutes(r.Context()); err == nil {
		for _, ar := range routes {
			if !ar.Enabled {
				continue
			}
			data = append(data, map[string]any{
				"id": ar.VirtualModel, "object": "model", "owned_by": "agent-route",
				"provider": "vibe", "agent_route": true,
			})
		}
	}
	buf, err := json.Marshal(map[string]any{"object": "list", "data": data})
	if err != nil {
		slog.Warn("aggregated models: marshal failed", "error", err)
		return false
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Request-ID", rc.traceID)
	w.Header().Set("X-Models-Providers", strings.Join(providersOK, ","))
	if len(providersErr) > 0 {
		w.Header().Set("X-Models-Providers-Failed", strings.Join(providersErr, ","))
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf)

	s.metrics.IncRequest(false)

	meta := rc.meta
	meta.Request.Provider = "aggregate"
	meta.Request.RouteReason = "models_aggregate"
	meta.Request.RouteDetail = strings.Join(providersOK, ",")
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
