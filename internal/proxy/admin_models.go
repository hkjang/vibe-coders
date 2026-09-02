package proxy

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"vibe-coders/internal/store"
)

const (
	adminModelsProviderTimeoutCap = 10 * time.Second

	// The admin inventory is deliberately larger than a typical provider catalogue, but it is
	// still bounded because this handler shares the gateway process with data-plane traffic.
	maxAdminModelsProviders            = 64
	maxAdminModelsResponseRows         = 20_000
	maxAdminModelsResponseBytes        = 16 << 20
	maxAdminModelsResponseModelBytes   = maxAdminModelsResponseBytes - (512 << 10)
	maxAdminModelsRetainedCatalogBytes = 16 << 20
)

type adminModelSource string

const (
	adminModelSourceLive       adminModelSource = "live"
	adminModelSourceCache      adminModelSource = "cache"
	adminModelSourceAgentRoute adminModelSource = "agent_route"
)

type adminModelDeprecation struct {
	ID            string `json:"id"`
	ModelGlob     string `json:"model_glob"`
	Replacement   string `json:"replacement"`
	SunsetDate    string `json:"sunset_date"`
	Message       string `json:"message"`
	SunsetReached bool   `json:"sunset_reached"`
	Retired       bool   `json:"retired"`
	Action        string `json:"action"`
}

type adminModel struct {
	ID          string                 `json:"id"`
	Provider    string                 `json:"provider"`
	Object      string                 `json:"object"`
	OwnedBy     string                 `json:"owned_by"`
	Created     *int64                 `json:"created"`
	Source      adminModelSource       `json:"source"`
	Virtual     bool                   `json:"virtual"`
	Shadowed    bool                   `json:"shadowed"`
	ShadowedBy  string                 `json:"shadowed_by"`
	Stale       bool                   `json:"stale"`
	FetchedAt   string                 `json:"fetched_at"`
	Deprecation *adminModelDeprecation `json:"deprecation"`
}

type adminModelProvider struct {
	Provider   string           `json:"provider"`
	Status     string           `json:"status"`
	Source     adminModelSource `json:"source"`
	ModelCount int              `json:"model_count"`
	FetchedAt  *string          `json:"fetched_at,omitempty"`
	Stale      bool             `json:"stale"`
}

type adminModelPartialFailure struct {
	Provider string `json:"provider"`
	Code     string `json:"code"`
	Message  string `json:"message"`
}

type adminModelsResponse struct {
	RequestID       string                     `json:"request_id"`
	GeneratedAt     string                     `json:"generated_at"`
	Models          []adminModel               `json:"models"`
	Providers       []adminModelProvider       `json:"providers"`
	PartialFailures []adminModelPartialFailure `json:"partial_failures"`
}

type adminModelsResponseLimiter struct {
	modelBytes int
	limited    bool
}

func (limiter *adminModelsResponseLimiter) append(response *adminModelsResponse, model adminModel) bool {
	if len(response.Models) >= maxAdminModelsResponseRows {
		limiter.limited = true
		return false
	}
	encoded, err := json.Marshal(model)
	if err != nil {
		limiter.limited = true
		return false
	}
	modelBytes := len(encoded) + 1
	if modelBytes > maxAdminModelsResponseModelBytes-limiter.modelBytes {
		limiter.limited = true
		return false
	}
	response.Models = append(response.Models, model)
	limiter.modelBytes += modelBytes
	return true
}

func appendAdminModelsPartialFailureOnce(response *adminModelsResponse, failure adminModelPartialFailure) {
	for _, existing := range response.PartialFailures {
		if existing.Provider == failure.Provider && existing.Code == failure.Code {
			return
		}
	}
	response.PartialFailures = append(response.PartialFailures, failure)
}

type adminProviderModelsResult struct {
	config      store.ProviderConfig
	models      []adminModelCatalogRow
	status      string
	source      adminModelSource
	fetchedAt   string
	stale       bool
	failureCode string
}

// handleAdminModels returns the authenticated, normalized model inventory used by the
// Next Admin console. Unlike the OpenAI-compatible /v1/models route, this response keeps
// duplicate model IDs when separate providers serve them and makes partial provider failures
// explicit. It never returns provider credentials or upstream error text.
// GET /admin/models[?provider=<exact>&model=<exact>]
func (s *Server) handleAdminModels(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}

	configs, err := s.db.ListProviderConfigs(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "provider configuration is unavailable", "server_error", "models_provider_config_failed")
		return
	}

	providerFilter := strings.TrimSpace(r.URL.Query().Get("provider"))
	modelFilter := strings.TrimSpace(r.URL.Query().Get("model"))
	response := adminModelsResponse{
		RequestID:       traceIDFromRequest(r),
		Models:          []adminModel{},
		Providers:       []adminModelProvider{},
		PartialFailures: []adminModelPartialFailure{},
	}
	includeAgentRoutes := providerFilter == "" || providerFilter == "vibe"
	needsAgentRoutes := includeAgentRoutes
	if !needsAgentRoutes {
		for _, provider := range configs {
			if provider.Enabled && provider.Name == providerFilter {
				needsAgentRoutes = true
				break
			}
		}
	}
	var agentRoutes []store.AgentRoute
	var agentRoutesErr error
	var agentRoutesFetchedAt string
	if needsAgentRoutes {
		agentRoutes, agentRoutesErr = s.db.ListAgentRoutes(r.Context())
		if agentRoutesErr != nil {
			response.PartialFailures = append(response.PartialFailures, adminModelPartialFailure{
				Provider: "vibe", Code: "agent_routes_unavailable", Message: "Virtual model catalog is unavailable.",
			})
		} else {
			agentRoutesFetchedAt = time.Now().UTC().Format(time.RFC3339Nano)
		}
	}
	agentRouteShadows := enabledAdminAgentRouteShadows(agentRoutes)

	results := s.fetchAdminProviderModels(r.Context(), configs, providerFilter, modelFilter, &response)
	now := time.Now().UTC()
	response.GeneratedAt = now.Format(time.RFC3339Nano)
	seenModels := make(map[string]struct{})
	limiter := adminModelsResponseLimiter{}
	for _, result := range results {
		provider := adminModelProvider{
			Provider: result.config.Name,
			Status:   result.status,
			Source:   result.source,
			Stale:    result.stale,
		}
		if result.fetchedAt != "" {
			fetchedAt := result.fetchedAt
			provider.FetchedAt = &fetchedAt
		}
		if result.status == "ok" {
			for _, catalogModel := range result.models {
				model := s.adminModelFromCatalog(r.Context(), catalogModel, result, now)
				if routeID, shadowed := agentRouteShadows[model.ID]; shadowed {
					model.Shadowed = true
					model.ShadowedBy = routeID
				}
				if modelFilter != "" && model.ID != modelFilter {
					continue
				}
				key := adminModelKey(model)
				if _, exists := seenModels[key]; exists {
					continue
				}
				if !limiter.append(&response, model) {
					continue
				}
				seenModels[key] = struct{}{}
				provider.ModelCount++
			}
		}
		response.Providers = append(response.Providers, provider)
	}

	if includeAgentRoutes {
		if agentRoutesErr != nil {
			response.Providers = append(response.Providers, adminModelProvider{
				Provider: "vibe", Status: "failed", Source: adminModelSourceAgentRoute, Stale: false,
			})
		} else {
			s.appendAdminAgentRouteModels(r.Context(), agentRoutes, agentRoutesFetchedAt, modelFilter, now, seenModels, &response, &limiter)
		}
	}
	if limiter.limited {
		appendAdminModelsPartialFailureOnce(&response, adminModelPartialFailure{
			Provider: "*", Code: "models_response_limit_exceeded", Message: "Model catalog response was truncated at the supported limit.",
		})
	}

	sort.Slice(response.Models, func(i, j int) bool {
		if response.Models[i].Provider != response.Models[j].Provider {
			return response.Models[i].Provider < response.Models[j].Provider
		}
		if response.Models[i].ID != response.Models[j].ID {
			return response.Models[i].ID < response.Models[j].ID
		}
		return response.Models[i].Source < response.Models[j].Source
	})
	sort.Slice(response.Providers, func(i, j int) bool {
		if response.Providers[i].Provider != response.Providers[j].Provider {
			return response.Providers[i].Provider < response.Providers[j].Provider
		}
		return response.Providers[i].Source < response.Providers[j].Source
	})
	sort.Slice(response.PartialFailures, func(i, j int) bool {
		if response.PartialFailures[i].Provider != response.PartialFailures[j].Provider {
			return response.PartialFailures[i].Provider < response.PartialFailures[j].Provider
		}
		return response.PartialFailures[i].Code < response.PartialFailures[j].Code
	})
	writeAdminModelsResponse(w, response)
}

func (s *Server) fetchAdminProviderModels(ctx context.Context, configs []store.ProviderConfig, providerFilter, modelFilter string, response *adminModelsResponse) []adminProviderModelsResult {
	fallbackTimeout := s.upstreamConf().Timeout
	s.adminModels.prune(configs, fallbackTimeout)
	selectedCapacity := len(configs)
	if selectedCapacity > maxAdminModelsProviders {
		selectedCapacity = maxAdminModelsProviders
	}
	selected := make([]store.ProviderConfig, 0, selectedCapacity)
	skippedProviders := 0
	for _, provider := range configs {
		if !provider.Enabled || (providerFilter != "" && provider.Name != providerFilter) {
			continue
		}
		if len(selected) >= maxAdminModelsProviders {
			skippedProviders++
			continue
		}
		selected = append(selected, provider)
	}
	if skippedProviders > 0 {
		appendAdminModelsPartialFailureOnce(response, adminModelPartialFailure{
			Provider: "*", Code: "models_provider_limit_exceeded", Message: "Some providers were skipped at the supported provider limit.",
		})
	}

	results := make([]adminProviderModelsResult, len(selected))
	for i, provider := range selected {
		results[i] = adminProviderModelsResult{config: provider, status: "skipped", source: adminModelSourceLive}
	}
	if len(selected) == 0 {
		return results
	}
	refreshTimeout := boundedAdminModelsCatalogRefreshTimeout(s.adminModels.refreshTimeout)
	refreshCtx, cancelRefresh := context.WithTimeout(ctx, refreshTimeout)
	defer cancelRefresh()

	workerCount := s.adminModels.workerLimit
	if workerCount <= 0 || workerCount > adminModelsCatalogMaxConcurrency {
		workerCount = adminModelsCatalogMaxConcurrency
	}
	if workerCount > len(selected) {
		workerCount = len(selected)
	}
	dec := s.secrets.Load()
	retainedRows, retainedWeight := 0, 0
	seenCatalogRows := make(map[string]struct{})
	responseLimited := false
	for batchStart := 0; batchStart < len(selected); batchStart += workerCount {
		if refreshCtx.Err() != nil {
			for index := batchStart; index < len(selected); index++ {
				results[index].status = "failed"
				results[index].failureCode = "provider_models_unavailable"
			}
			break
		}
		if modelFilter == "" && retainedRows >= maxAdminModelsResponseRows {
			responseLimited = true
			break
		}
		batchEnd := batchStart + workerCount
		if batchEnd > len(selected) {
			batchEnd = len(selected)
		}
		var wg sync.WaitGroup
		wg.Add(batchEnd - batchStart)
		for index := batchStart; index < batchEnd; index++ {
			go func(index int) {
				defer wg.Done()
				provider := selected[index]
				apiKey, err := dec.Decrypt(provider.EncryptedAPIKey)
				if err != nil || strings.TrimSpace(apiKey) == "" {
					if cached, ok := s.adminModels.cached(provider, fallbackTimeout, true); ok {
						cached.stale = true
						cached.failureCode = "provider_credentials_unavailable"
						results[index] = cached
					} else {
						results[index].failureCode = "provider_credentials_unavailable"
					}
					return
				}
				results[index] = s.adminModels.load(refreshCtx, provider, fallbackTimeout, func(fetchCtx context.Context) ([]adminModelCatalogRow, error) {
					models, fetchErr := s.fetchProviderModels(fetchCtx, provider.Name, provider.BaseURL, apiKey, adminModelsProviderTimeout(provider, fallbackTimeout), "")
					if fetchErr != nil {
						return nil, fetchErr
					}
					catalog := make([]adminModelCatalogRow, 0, len(models))
					for _, raw := range models {
						if model, ok := normalizeAdminModelCatalogRow(raw, provider.Name); ok {
							catalog = append(catalog, model)
						}
					}
					return catalog, nil
				})
			}(index)
		}
		wg.Wait()

		for index := batchStart; index < batchEnd; index++ {
			result := results[index]
			if result.status != "ok" {
				continue
			}
			retained := make([]adminModelCatalogRow, 0, len(result.models))
			for _, model := range result.models {
				if modelFilter != "" && model.ID != modelFilter {
					continue
				}
				key := result.config.Name + "\x00" + model.ID
				if _, exists := seenCatalogRows[key]; exists {
					continue
				}
				weight := adminModelCatalogRowWeight(model)
				if retainedRows >= maxAdminModelsResponseRows || weight > maxAdminModelsRetainedCatalogBytes-retainedWeight {
					responseLimited = true
					continue
				}
				seenCatalogRows[key] = struct{}{}
				retained = append(retained, model)
				retainedRows++
				retainedWeight += weight
			}
			result.models = retained
			results[index] = result
		}
	}

	for _, result := range results {
		if result.failureCode == "" {
			continue
		}
		message := "Provider model catalog is unavailable."
		switch result.failureCode {
		case "provider_credentials_unavailable":
			message = "Provider credentials are unavailable."
		case "provider_models_limit_exceeded":
			message = "Provider model catalog exceeds the supported limit."
		}
		if result.failureCode == "provider_models_unavailable" || result.failureCode == "provider_models_limit_exceeded" {
			slog.Warn("admin model catalogue fetch failed", "provider", result.config.Name, "code", result.failureCode, "stale", result.stale)
		}
		response.PartialFailures = append(response.PartialFailures, adminModelPartialFailure{
			Provider: result.config.Name,
			Code:     result.failureCode,
			Message:  message,
		})
	}
	if responseLimited {
		appendAdminModelsPartialFailureOnce(response, adminModelPartialFailure{
			Provider: "*", Code: "models_response_limit_exceeded", Message: "Model catalog response was truncated at the supported limit.",
		})
	}
	return results
}

func adminModelsProviderTimeout(provider store.ProviderConfig, fallback time.Duration) time.Duration {
	timeout := time.Duration(provider.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = fallback
	}
	if timeout <= 0 || timeout > adminModelsProviderTimeoutCap {
		return adminModelsProviderTimeoutCap
	}
	return timeout
}

func writeAdminModelsResponse(w http.ResponseWriter, response adminModelsResponse) {
	encoded, err := json.Marshal(response)
	if err != nil {
		writeOpenAIError(w, http.StatusServiceUnavailable, "model catalog response is unavailable", "server_error", "models_response_encode_failed")
		return
	}
	if len(encoded) > maxAdminModelsResponseBytes {
		writeOpenAIError(w, http.StatusServiceUnavailable, "model catalog response exceeds the supported limit", "server_error", "models_response_limit_exceeded")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(encoded)
}

func normalizeAdminModelCatalogRow(raw map[string]any, provider string) (adminModelCatalogRow, bool) {
	id, _ := raw["id"].(string)
	id = strings.TrimSpace(id)
	if id == "" {
		return adminModelCatalogRow{}, false
	}
	object, _ := raw["object"].(string)
	object = strings.TrimSpace(object)
	if object == "" {
		object = "model"
	}
	ownedBy, _ := raw["owned_by"].(string)
	ownedBy = strings.TrimSpace(ownedBy)
	if ownedBy == "" {
		ownedBy = provider
	}
	return adminModelCatalogRow{
		ID: id, Object: object, OwnedBy: ownedBy, Created: normalizedModelCreated(raw["created"]),
	}, true
}

func (s *Server) adminModelFromCatalog(ctx context.Context, catalog adminModelCatalogRow, result adminProviderModelsResult, now time.Time) adminModel {
	model := adminModel{
		ID: catalog.ID, Provider: result.config.Name, Object: catalog.Object, OwnedBy: catalog.OwnedBy,
		Created: catalog.Created, Source: result.source, Virtual: false, Stale: result.stale, FetchedAt: result.fetchedAt,
	}
	model.Deprecation = s.adminModelDeprecation(ctx, catalog.ID, now)
	return model
}

func normalizedModelCreated(value any) *int64 {
	number, ok := value.(float64)
	// float64(math.MaxInt64) rounds to 2^63. Treat that exclusive bound as invalid;
	// converting it directly would wrap to MinInt64.
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) || math.Trunc(number) != number || number < 0 || number >= math.MaxInt64 {
		return nil
	}
	created := int64(number)
	return &created
}

func (s *Server) adminModelDeprecation(ctx context.Context, model string, now time.Time) *adminModelDeprecation {
	deprecation, ok := s.matchModelDeprecation(ctx, model)
	if !ok {
		return nil
	}
	reached := sunsetReached(deprecation.SunsetDate, now)
	action := "warn"
	if reached {
		action = "block"
		if strings.TrimSpace(deprecation.Replacement) != "" {
			action = "rewrite"
		}
	}
	return &adminModelDeprecation{
		ID:            deprecation.ID,
		ModelGlob:     deprecation.ModelGlob,
		Replacement:   deprecation.Replacement,
		SunsetDate:    deprecation.SunsetDate,
		Message:       deprecation.Message,
		SunsetReached: reached,
		Retired:       reached,
		Action:        action,
	}
}

func enabledAdminAgentRouteShadows(routes []store.AgentRoute) map[string]string {
	shadows := make(map[string]string, len(routes))
	for _, route := range routes {
		// Runtime dispatch uses an exact lookup by the persisted virtual model. Do not
		// normalize here or the catalog could report a collision that runtime would not.
		if route.Enabled && route.VirtualModel != "" {
			shadows[route.VirtualModel] = route.ID
		}
	}
	return shadows
}

func (s *Server) appendAdminAgentRouteModels(ctx context.Context, routes []store.AgentRoute, fetchedAt, modelFilter string, now time.Time, seen map[string]struct{}, response *adminModelsResponse, limiter *adminModelsResponseLimiter) {
	provider := adminModelProvider{
		Provider: "vibe", Status: "ok", Source: adminModelSourceAgentRoute, FetchedAt: &fetchedAt, Stale: false,
	}
	hasEnabledRoute := false
	for _, route := range routes {
		if !route.Enabled {
			continue
		}
		hasEnabledRoute = true
		id := strings.TrimSpace(route.VirtualModel)
		if id == "" || (modelFilter != "" && id != modelFilter) {
			continue
		}
		model := adminModel{
			ID: id, Provider: "vibe", Object: "model", OwnedBy: "agent-route", Created: nil,
			Source: adminModelSourceAgentRoute, Virtual: true, Stale: false, FetchedAt: fetchedAt,
			Deprecation: s.adminModelDeprecation(ctx, id, now),
		}
		key := adminModelKey(model)
		if _, exists := seen[key]; exists {
			continue
		}
		if !limiter.append(response, model) {
			continue
		}
		seen[key] = struct{}{}
		provider.ModelCount++
	}
	if hasEnabledRoute {
		response.Providers = append(response.Providers, provider)
	}
}

func adminModelKey(model adminModel) string {
	return string(model.Source) + "\x00" + model.Provider + "\x00" + model.ID
}
