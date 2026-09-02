package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// sloMetric is one evaluated SLO dimension: its target, the current actual value,
// and whether the objective is currently breached.
type sloMetric struct {
	Target   float64 `json:"target"`
	Actual   float64 `json:"actual"`
	Breached bool    `json:"breached"`
	Enforced bool    `json:"enforced"`
}

type providerSLOEvaluation struct {
	Provider    string               `json:"provider"`
	ProviderRef string               `json:"provider_ref,omitempty"`
	Requests    int64                `json:"requests"`
	Enabled     bool                 `json:"enabled"`
	Breached    bool                 `json:"breached"`
	Metrics     map[string]sloMetric `json:"metrics"`
}

// handleProviderSLOs manages provider SLO targets and evaluates current health
// against them. GET /admin/providers/slo → {slos, evaluations}; POST upserts;
// DELETE ?provider=name removes one.
func (s *Server) handleProviderSLOs(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		appProjection := r.Header.Get("X-Vibe-UI") == "app"
		var providerRef providerReferenceFunc
		if appProjection {
			providerRef = s.providerRefSnapshot()
		}
		slos, err := s.db.ListProviderSLOs(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "provider_slo_failed")
			return
		}
		since := parseWindow(r.URL.Query().Get("window"), time.Hour, "hour")
		scores, _ := s.db.ProviderHealthScores(r.Context(), since)
		evaluations := evaluateProviderSLOs(slos, scores)
		if appProjection {
			for index := range slos {
				rawProvider := slos[index].Provider
				slos[index].ProviderRef = providerRef(rawProvider)
				slos[index].Provider = boundedModelsProviderLabel(rawProvider)
			}
			for index := range evaluations {
				rawProvider := evaluations[index].Provider
				evaluations[index].ProviderRef = providerRef(rawProvider)
				evaluations[index].Provider = boundedModelsProviderLabel(rawProvider)
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"slos":        slos,
			"evaluations": evaluations,
			"since":       since.UTC().Format(time.RFC3339),
		})
	case http.MethodPost:
		appProjection := r.Header.Get("X-Vibe-UI") == "app"
		var providerRef providerReferenceFunc
		if appProjection {
			providerRef = s.providerRefSnapshot()
		}
		var p struct {
			Provider           string  `json:"provider"`
			AvailabilityTarget float64 `json:"availability_target"`
			P95LatencyTargetMS int64   `json:"p95_latency_target_ms"`
			ErrorRateTarget    float64 `json:"error_rate_target"`
			FallbackRateTarget float64 `json:"fallback_rate_target"`
			Enabled            *bool   `json:"enabled"`
			Note               string  `json:"note"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		p.Provider = strings.TrimSpace(p.Provider)
		if p.Provider == "" {
			writeOpenAIError(w, http.StatusBadRequest, "provider is required", "invalid_request_error", "missing_provider")
			return
		}
		_, existingLegacySLO, sloLookupErr := s.db.GetProviderSLO(r.Context(), p.Provider)
		if sloLookupErr != nil {
			writeOpenAIError(w, http.StatusServiceUnavailable, "provider SLO validation is temporarily unavailable", "server_error", "provider_slo_lookup_failed")
			return
		}
		if modelsProviderNameReserved(p.Provider) && !existingLegacySLO {
			writeOpenAIError(w, http.StatusBadRequest, "provider name is reserved", "invalid_request_error", "provider_slo_provider_reserved")
			return
		}
		if !modelsProviderLabelSafe(p.Provider) && !existingLegacySLO {
			writeOpenAIError(w, http.StatusBadRequest, "provider name contains unsafe metadata", "invalid_request_error", "provider_slo_provider_invalid")
			return
		}
		_, providerFound, lookupErr := s.db.GetProvider(r.Context(), p.Provider)
		if lookupErr != nil {
			writeOpenAIError(w, http.StatusServiceUnavailable, "provider validation is temporarily unavailable", "server_error", "provider_slo_provider_lookup_failed")
			return
		}
		if !providerFound {
			writeOpenAIError(w, http.StatusBadRequest, "provider is not configured", "invalid_request_error", "provider_slo_provider_not_found")
			return
		}
		enabled := true
		if p.Enabled != nil {
			enabled = *p.Enabled
		}
		slo := store.ProviderSLO{
			Provider: p.Provider, AvailabilityTarget: p.AvailabilityTarget, P95LatencyTargetMS: p.P95LatencyTargetMS,
			ErrorRateTarget: p.ErrorRateTarget, FallbackRateTarget: p.FallbackRateTarget, Enabled: enabled, Note: strings.TrimSpace(p.Note),
		}
		if err := s.db.UpsertProviderSLO(r.Context(), &slo); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "provider_slo_save_failed")
			return
		}
		s.auditAdminWithProviderTarget(r, "provider_slo.upsert", "", providerSLOAuditJSON(slo), slo.Provider)
		responseSLO := slo
		if appProjection {
			responseSLO.ProviderRef = providerRef(slo.Provider)
			responseSLO.Provider = boundedModelsProviderLabel(slo.Provider)
		}
		writeJSON(w, http.StatusCreated, map[string]any{"slo": responseSLO})
	case http.MethodDelete:
		appProjection := r.Header.Get("X-Vibe-UI") == "app"
		var providerRef providerReferenceFunc
		if appProjection {
			providerRef = s.providerRefSnapshot()
		}
		provider := strings.TrimSpace(r.URL.Query().Get("provider"))
		if provider == "" {
			writeOpenAIError(w, http.StatusBadRequest, "provider query param is required", "invalid_request_error", "missing_provider")
			return
		}
		if err := s.db.DeleteProviderSLO(r.Context(), provider); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "provider_slo_delete_failed")
			return
		}
		s.auditAdminWithProviderTarget(r, "provider_slo.delete", auditJSON(map[string]string{"provider": boundedModelsProviderLabel(provider)}), "", provider)
		response := map[string]string{"provider": provider, "status": "deleted"}
		if appProjection {
			response["provider"] = boundedModelsProviderLabel(provider)
			response["provider_ref"] = providerRef(provider)
		}
		writeJSON(w, http.StatusOK, response)
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func providerSLOAuditJSON(slo store.ProviderSLO) string {
	slo.Provider = boundedModelsProviderLabel(slo.Provider)
	slo.ProviderRef = ""
	return auditJSON(slo)
}

// evaluateProviderSLOs compares each SLO's targets against the current health
// snapshot. Availability/error-rate/fallback-rate are derived from request counts.
func evaluateProviderSLOs(slos []store.ProviderSLO, scores []store.ProviderHealthScore) []providerSLOEvaluation {
	byProvider := map[string]store.ProviderHealthScore{}
	for _, s := range scores {
		byProvider[s.Provider] = s
	}
	out := []providerSLOEvaluation{}
	for _, slo := range slos {
		h := byProvider[slo.Provider]
		var availability, errorRate float64 = 1, 0
		if h.Requests > 0 {
			availability = float64(h.Requests-h.Rate5xx-h.Timeouts) / float64(h.Requests)
			errorRate = float64(h.Rate429+h.Rate5xx) / float64(h.Requests)
		}

		metrics := map[string]sloMetric{}
		anyBreach := false
		// minMetric: actual must be >= target (availability).
		minMetric := func(target, actual float64) sloMetric {
			m := sloMetric{Target: target, Actual: actual, Enforced: target > 0}
			if m.Enforced && h.Requests > 0 && actual < target {
				m.Breached = true
				anyBreach = true
			}
			return m
		}
		// maxMetric: actual must be <= target (latency/error/fallback).
		maxMetric := func(target, actual float64) sloMetric {
			m := sloMetric{Target: target, Actual: actual, Enforced: target > 0}
			if m.Enforced && h.Requests > 0 && actual > target {
				m.Breached = true
				anyBreach = true
			}
			return m
		}
		metrics["availability"] = minMetric(slo.AvailabilityTarget, availability)
		metrics["p95_latency_ms"] = maxMetric(float64(slo.P95LatencyTargetMS), float64(h.P95LatencyMS))
		metrics["error_rate"] = maxMetric(slo.ErrorRateTarget, errorRate)
		metrics["fallback_rate"] = maxMetric(slo.FallbackRateTarget, h.FallbackRate)

		out = append(out, providerSLOEvaluation{
			Provider: slo.Provider, Requests: h.Requests, Enabled: slo.Enabled,
			Breached: slo.Enabled && anyBreach, Metrics: metrics,
		})
	}
	return out
}
