package proxy

import (
	"strings"

	"vibe-coders/internal/store"
)

const providerMetadataOmitted = "[provider-metadata-omitted]"

// boundedExternalProviderText is the final boundary for descriptive provider
// metadata. Internal request/routing rows retain their raw provider identity so
// aggregation and failover joins remain exact; browser, MCP and warehouse
// projections must never repeat a credential-shaped legacy name or URL.
func boundedExternalProviderText(value string, rawProviders ...string) string {
	projected := value
	for _, rawProvider := range rawProviders {
		projected = boundedProviderMetadataText(projected, rawProvider)
	}
	if providerURLComponentHasCredential(projected) {
		return providerMetadataOmitted
	}
	return projected
}

func boundedExternalFallbackPath(path []string, rawProviders ...string) []string {
	if len(path) == 0 {
		return path
	}
	projected := make([]string, len(path))
	for index, hop := range path {
		projected[index] = boundedExternalProviderText(hop, rawProviders...)
		if strings.TrimSpace(projected[index]) != "" && !modelsProviderLabelSafe(projected[index]) {
			projected[index] = providerMetadataOmitted
		}
	}
	return projected
}

func projectRecentRequestProviderForExternal(req store.RecentRequest) store.RecentRequest {
	rawProvider := req.Provider
	rawFallback := req.FallbackFrom
	req.Provider = boundedModelsProviderLabelOrEmpty(rawProvider)
	req.FallbackFrom = boundedModelsProviderLabelOrEmpty(rawFallback)
	req.Model = boundedExternalProviderText(req.Model, rawProvider, rawFallback)
	req.RouteDetail = boundedExternalProviderText(req.RouteDetail, rawProvider, rawFallback)
	req.FallbackReason = boundedExternalProviderText(req.FallbackReason, rawProvider, rawFallback)
	req.Error = boundedExternalProviderText(req.Error, rawProvider, rawFallback)
	return req
}

func projectRoutingDecisionProviderForExternal(decision store.RoutingDecisionLog) store.RoutingDecisionLog {
	rawProvider := decision.SelectedProvider
	decision.SelectedProvider = boundedModelsProviderLabelOrEmpty(rawProvider)
	decision.FallbackPath = boundedExternalFallbackPath(decision.FallbackPath, rawProvider)
	decision.DecisionReason = boundedExternalProviderText(decision.DecisionReason, rawProvider)
	return decision
}
