package proxy

import (
	"context"
	"log/slog"
	"math"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"vibe-coders/internal/store"
)

const adminModelsProviderTimeoutCap = 10 * time.Second

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

	results := s.fetchAdminProviderModels(r.Context(), configs, providerFilter, &response)
	now := time.Now().UTC()
	response.GeneratedAt = now.Format(time.RFC3339Nano)
	seenModels := make(map[string]struct{})
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
				if modelFilter != "" && model.ID != modelFilter {
					continue
				}
				key := adminModelKey(model)
				if _, exists := seenModels[key]; exists {
					continue
				}
				seenModels[key] = struct{}{}
				response.Models = append(response.Models, model)
				provider.ModelCount++
			}
		}
		response.Providers = append(response.Providers, provider)
	}

	if providerFilter == "" || providerFilter == "vibe" {
		s.appendAdminAgentRouteModels(r.Context(), modelFilter, now, seenModels, &response)
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
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) fetchAdminProviderModels(ctx context.Context, configs []store.ProviderConfig, providerFilter string, response *adminModelsResponse) []adminProviderModelsResult {
	fallbackTimeout := s.upstreamConf().Timeout
	s.adminModels.prune(configs, fallbackTimeout)
	selected := make([]store.ProviderConfig, 0, len(configs))
	for _, provider := range configs {
		if !provider.Enabled || (providerFilter != "" && provider.Name != providerFilter) {
			continue
		}
		selected = append(selected, provider)
	}

	results := make([]adminProviderModelsResult, len(selected))
	var wg sync.WaitGroup
	dec := s.secrets.Load()
	for i, provider := range selected {
		results[i] = adminProviderModelsResult{
			config: provider, status: "skipped", source: adminModelSourceLive,
		}
		apiKey, err := dec.Decrypt(provider.EncryptedAPIKey)
		if err != nil || strings.TrimSpace(apiKey) == "" {
			if cached, ok := s.adminModels.cached(provider, fallbackTimeout, true); ok {
				cached.stale = true
				cached.failureCode = "provider_credentials_unavailable"
				results[i] = cached
			} else {
				results[i].failureCode = "provider_credentials_unavailable"
			}
			continue
		}

		wg.Add(1)
		go func(index int, p store.ProviderConfig, key string) {
			defer wg.Done()
			results[index] = s.adminModels.load(ctx, p, fallbackTimeout, func(fetchCtx context.Context) ([]adminModelCatalogRow, error) {
				models, fetchErr := s.fetchProviderModels(fetchCtx, p.Name, p.BaseURL, key, adminModelsProviderTimeout(p, fallbackTimeout), "")
				if fetchErr != nil {
					return nil, fetchErr
				}
				catalog := make([]adminModelCatalogRow, 0, len(models))
				for _, raw := range models {
					if model, ok := normalizeAdminModelCatalogRow(raw, p.Name); ok {
						catalog = append(catalog, model)
					}
				}
				return catalog, nil
			})
			if results[index].failureCode == "provider_models_unavailable" {
				slog.Warn("admin model catalogue fetch failed", "provider", p.Name, "stale", results[index].stale)
			}
		}(i, provider, apiKey)
	}
	wg.Wait()

	for _, result := range results {
		if result.failureCode == "" {
			continue
		}
		message := "Provider model catalog is unavailable."
		if result.failureCode == "provider_credentials_unavailable" {
			message = "Provider credentials are unavailable."
		}
		response.PartialFailures = append(response.PartialFailures, adminModelPartialFailure{
			Provider: result.config.Name,
			Code:     result.failureCode,
			Message:  message,
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
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) || math.Trunc(number) != number || number < math.MinInt64 || number >= math.MaxInt64 {
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

func (s *Server) appendAdminAgentRouteModels(ctx context.Context, modelFilter string, now time.Time, seen map[string]struct{}, response *adminModelsResponse) {
	routes, err := s.db.ListAgentRoutes(ctx)
	if err != nil {
		response.Providers = append(response.Providers, adminModelProvider{
			Provider: "vibe", Status: "failed", Source: adminModelSourceAgentRoute, Stale: false,
		})
		response.PartialFailures = append(response.PartialFailures, adminModelPartialFailure{
			Provider: "vibe", Code: "agent_routes_unavailable", Message: "Virtual model catalog is unavailable.",
		})
		return
	}
	fetchedAt := time.Now().UTC().Format(time.RFC3339Nano)
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
		seen[key] = struct{}{}
		response.Models = append(response.Models, model)
		provider.ModelCount++
	}
	if hasEnabledRoute {
		response.Providers = append(response.Providers, provider)
	}
}

func adminModelKey(model adminModel) string {
	return string(model.Source) + "\x00" + model.Provider + "\x00" + model.ID
}
