package proxy

import (
	"bytes"
	"compress/gzip"
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
	"unicode"
	"unicode/utf8"

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

	// Provider names are operator-controlled metadata. Existing rows remain usable, but
	// public headers and audit details never copy an unbounded legacy value.
	maxModelsProviderNameBytes   = store.ProviderModelCatalogNameMaxBytes
	maxModelsMetadataHeaderBytes = 4 << 10
	maxModelsAuditDetailBytes    = 2 << 10
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
	data             []map[string]any
	providersOK      []string
	providersErr     []string
	providersOKSeen  int
	providersErrSeen int
	skipped          int
	metadataOmitted  int
	truncated        bool
	payloadBytes     int
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
	configs, configsTruncated, err := s.db.ListProviderModelCatalogConfigs(ctx, "", maxModelsProvidersPerRequest)
	if err != nil {
		slog.Warn("aggregated models: list providers failed", "code", "provider_config_unavailable")
		result.truncated = true
		return result
	}
	if configsTruncated {
		result.skipped = 1
		result.truncated = true
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
		key, kerr := dec.Decrypt(p.EncryptedAPIKey)
		if kerr != nil || key == "" {
			result.providersErr = append(result.providersErr, p.Name)
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
					ctx, job.name, job.baseURL, job.apiKey, job.timeout,
				)
			}(offset, job)
		}
		wg.Wait()

		for offset, providerResult := range batch {
			job := jobs[batchStart+offset]
			if providerResult.err != nil {
				result.providersErr = append(result.providersErr, job.name)
				if isProviderModelsLimitError(providerResult.err) {
					result.truncated = true
				}
				slog.Warn("aggregated models: provider fetch failed", "provider", boundedModelsProviderLabel(job.name), "code", providerModelsFailureCode(providerResult.err))
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
				providerLabel := boundedModelsProviderLabel(job.name)
				if owned, ok := model["owned_by"].(string); !ok || owned == "" {
					model["owned_by"] = providerLabel
				}
				model["provider"] = providerLabel
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

func (s *Server) modelsFallbackProvider(ctx context.Context) (resolvedProvider, error) {
	name := strings.TrimSpace(s.cfg.Upstream.Provider)
	if name == "" {
		return resolvedProvider{}, errors.New("default model catalogue provider is unavailable")
	}
	configs, truncated, err := s.db.ListProviderModelCatalogConfigs(ctx, name, 1)
	if err != nil {
		return resolvedProvider{}, err
	}
	if truncated || len(configs) != 1 {
		return resolvedProvider{}, errors.New("default model catalogue provider is unavailable")
	}
	provider := configs[0]
	apiKey, err := s.secrets.Load().Decrypt(provider.EncryptedAPIKey)
	if err != nil || apiKey == "" {
		return resolvedProvider{}, errors.New("default model catalogue provider credentials are unavailable")
	}
	timeout := time.Duration(provider.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = s.cfg.Upstream.Timeout
	}
	return resolvedProvider{
		Name: provider.Name, BaseURL: provider.BaseURL, APIKey: apiKey, Timeout: timeout,
		Reason: "default", Detail: "UPSTREAM_PROVIDER",
	}, nil
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

func (s *Server) fetchProviderModelsWithSlot(ctx context.Context, name, baseURL, apiKey string, timeout time.Duration) ([]map[string]any, error) {
	release, err := s.acquireModelsCatalogSlot(ctx)
	if err != nil {
		return nil, ctx.Err()
	}
	defer release()
	return s.fetchProviderModels(ctx, name, baseURL, apiKey, timeout)
}

func (s *Server) acquireModelsCatalogSlot(ctx context.Context) (func(), error) {
	if s.adminModels == nil || s.adminModels.semaphore == nil {
		return func() {}, nil
	}
	select {
	case s.adminModels.semaphore <- struct{}{}:
		return func() { <-s.adminModels.semaphore }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
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
		if !strings.EqualFold(key, "data") {
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

// readBoundedModelsFallbackBody validates a classic unpinned fallback response before
// any upstream headers or bytes are committed downstream. The cap applies after gzip
// decompression, preventing a small compressed catalogue from expanding without bound.
func readBoundedModelsFallbackBody(resp *http.Response) ([]byte, error) {
	var reader io.Reader = resp.Body
	encoding := strings.TrimSpace(strings.ToLower(resp.Header.Get("Content-Encoding")))
	if encoding != "" && encoding != "identity" {
		if encoding != "gzip" {
			return nil, errors.New("provider model catalogue uses an unsupported content encoding")
		}
		gzipReader, err := gzip.NewReader(resp.Body)
		if err != nil {
			return nil, errors.New("provider model catalogue gzip is invalid")
		}
		defer gzipReader.Close()
		reader = gzipReader
	}
	raw, err := io.ReadAll(io.LimitReader(reader, maxModelsResponseBytes+1))
	if err != nil {
		return nil, errors.New("provider model catalogue could not be read")
	}
	if len(raw) > maxModelsResponseBytes {
		return nil, &providerModelsLimitError{kind: "byte size", limit: maxModelsResponseBytes}
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return nil, errors.New("provider model catalogue returned an unsuccessful status")
	}
	if _, err := decodeProviderModels(raw); err != nil {
		return nil, err
	}
	return raw, nil
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
// paths are preserved, while the provider's own key and timeout are applied. Caller query
// parameters are deliberately absent: aggregate/admin discovery must never fan credentials
// or vendor-specific options out to multiple providers.
func (s *Server) fetchProviderModels(ctx context.Context, name, baseURL, apiKey string, timeout time.Duration) ([]map[string]any, error) {
	target, err := s.upstreamURL(baseURL, &url.URL{Path: "/v1/models"})
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
	hasProvider := len(result.providersOK) > 0
	if !hasProvider {
		boundAggregatedModelsMetadata(&result)
		rc.modelsAggregateFallback = true
		rc.modelsAggregateResult = result
		setAggregatedModelsHeaders(w, result)
		return false
	}
	// Advertise operator-defined agent routes as callable virtual models so clients discover them
	// alongside real models.
	routes, routesTruncated, routesOverflow, routesErr := s.db.ListEnabledAgentRouteModelsBounded(r.Context(), maxAggregatedModels)
	if routesErr != nil {
		result.providersErr = append(result.providersErr, "vibe")
		result.truncated = true
	} else {
		if routesTruncated {
			result.truncated = true
		}
		mergeAgentRouteModels(&result, routes, routesTruncated || routesOverflow)
	}
	boundAggregatedModelsMetadata(&result)
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
	meta.Request.RouteDetail = aggregatedModelsAuditDetail(result)
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

func mergeAgentRouteModels(result *aggregatedModelsResult, routes []store.AgentRouteModel, projectionOverflow bool) {
	if projectionOverflow {
		// Routes outside the bounded projection may shadow any physical ID.
		// Returning only the known virtual routes is conservative but never
		// advertises a physical model that runtime routing will replace.
		result.data = []map[string]any{}
		result.payloadBytes = 0
	}
	routeByModel := make(map[string]store.AgentRouteModel, len(routes))
	for _, route := range routes {
		if _, exists := routeByModel[route.VirtualModel]; !exists {
			routeByModel[route.VirtualModel] = route
		}
	}
	original := result.data
	result.data = make([]map[string]any, 0, len(original)+len(routeByModel))
	result.payloadBytes = 0
	emitted := make(map[string]bool, len(routeByModel))
	appendRoute := func(virtualModel string) {
		if emitted[virtualModel] {
			return
		}
		emitted[virtualModel] = true
		if !appendBoundedAggregatedModel(result, map[string]any{
			"id": virtualModel, "object": "model", "owned_by": "agent-route",
			"provider": "vibe", "agent_route": true,
		}) {
			// A virtual route shadows its physical id at runtime. If the replacement
			// does not fit, omit both instead of advertising the physical route that
			// will never execute.
			result.truncated = true
		}
	}
	for _, model := range original {
		id, _ := model["id"].(string)
		if _, shadows := routeByModel[id]; shadows {
			appendRoute(id)
			continue
		}
		if !appendBoundedAggregatedModel(result, model) {
			result.truncated = true
		}
	}
	for _, route := range routes {
		appendRoute(route.VirtualModel)
	}
}

func boundedModelsProviderLabel(name string) string {
	if !modelsProviderLabelSafe(name) {
		return "[provider-name-omitted]"
	}
	return name
}

func modelsProviderLabelSafe(name string) bool {
	if name == "" || len(name) > maxModelsProviderNameBytes || !utf8.ValidString(name) || strings.TrimSpace(name) != name || strings.ContainsRune(name, ',') {
		return false
	}
	if strings.IndexFunc(name, unicode.IsControl) >= 0 || providerURLComponentHasCredential(name) {
		return false
	}
	return true
}

func appendBoundedModelsProviderNames(dst []string, names []string, used *int) ([]string, int) {
	omitted := 0
	for _, name := range names {
		if !modelsProviderLabelSafe(name) {
			omitted++
			continue
		}
		required := len(name)
		if len(dst) > 0 {
			required++
		}
		if required > maxModelsMetadataHeaderBytes-*used {
			omitted++
			continue
		}
		dst = append(dst, name)
		*used += required
	}
	return dst, omitted
}

func boundAggregatedModelsMetadata(result *aggregatedModelsResult) {
	if result.providersOKSeen == 0 {
		result.providersOKSeen = len(result.providersOK)
	}
	if result.providersErrSeen == 0 {
		result.providersErrSeen = len(result.providersErr)
	}
	used := 0
	boundedOK, omittedOK := appendBoundedModelsProviderNames(nil, result.providersOK, &used)
	boundedErr, omittedErr := appendBoundedModelsProviderNames(nil, result.providersErr, &used)
	result.providersOK = boundedOK
	result.providersErr = boundedErr
	result.metadataOmitted += omittedOK + omittedErr
	if result.metadataOmitted > 0 {
		result.truncated = true
	}
}

func aggregatedModelsAuditDetail(result aggregatedModelsResult) string {
	suffix := fmt.Sprintf(";ok=%d;failed=%d;skipped=%d;metadata_omitted=%d;truncated=%t", result.providersOKSeen, result.providersErrSeen, result.skipped, result.metadataOmitted, result.truncated)
	budget := maxModelsAuditDetailBytes - len("providers=") - len(suffix)
	providerNames := make([]string, 0, len(result.providersOK))
	used := 0
	for _, name := range result.providersOK {
		required := len(name)
		if len(providerNames) > 0 {
			required++
		}
		if required > budget-used {
			break
		}
		providerNames = append(providerNames, name)
		used += required
	}
	return "providers=" + strings.Join(providerNames, ",") + suffix
}

func (rc *requestPipeline) writeModelsFallbackError(meta *store.LogRecord, status int, code string, startedAt time.Time) {
	s, r, w := rc.s, rc.r, rc.w
	s.metrics.IncUpstreamError()
	meta.Request.StatusCode = status
	meta.Request.LatencyMS = time.Since(startedAt).Milliseconds()
	meta.Request.Error = code
	meta.Request.FallbackReason = code
	meta.Request.RouteReason = "models_fallback"
	meta.Request.RouteDetail = aggregatedModelsAuditDetail(rc.modelsAggregateResult)
	meta.Response = &store.ResponseLog{
		ID: newID("resp"), RequestID: meta.Request.ID, StatusCode: status, CreatedAt: time.Now().UTC(),
	}
	setAggregatedModelsHeaders(w, rc.modelsAggregateResult)
	s.enqueue(*meta)
	slog.Warn("models fallback failed", "code", code)
	s.notifyMattermost(r.Context(), "provider", "Model catalogue fallback failed ("+code+")")
	writeOpenAIError(w, status, "model catalog fallback is unavailable", "server_error", code)
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
	if result.metadataOmitted > 0 {
		w.Header().Set("X-Models-Metadata-Omitted", fmt.Sprintf("%d", result.metadataOmitted))
	}
	if result.truncated {
		w.Header().Set("X-Models-Truncated", "true")
	}
}
