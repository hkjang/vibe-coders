package proxy

import (
	"context"
	"crypto/subtle"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

const providerImpactReadLimit = 1024

var providerImpactRefPattern = regexp.MustCompile(`^prv_[A-Za-z0-9_-]{43}$`)

type providerImpactItem struct {
	Reference   string `json:"reference"`
	Label       string `json:"label"`
	Enabled     bool   `json:"enabled"`
	Model       string `json:"model,omitempty"`
	ProviderRef string `json:"provider_ref,omitempty"`
	Relation    string `json:"relation,omitempty"`
}

type providerImpactSection struct {
	Status       string               `json:"status"`
	Scope        string               `json:"scope"`
	Reason       string               `json:"reason"`
	CountKind    string               `json:"count_kind"`
	ScannedCount *int                 `json:"scanned_count"`
	MatchedCount *int                 `json:"matched_count"`
	Truncated    bool                 `json:"truncated"`
	Items        []providerImpactItem `json:"items"`
}

type providerImpactResponse struct {
	ProviderRef        string                `json:"provider_ref"`
	ProviderDisplay    string                `json:"provider_display"`
	GeneratedAt        string                `json:"generated_at"`
	Consistency        string                `json:"consistency"`
	IsDefault          bool                  `json:"is_default"`
	BootstrapOnRestart bool                  `json:"bootstrap_on_restart"`
	ReadOnly           bool                  `json:"read_only"`
	UpstreamCalls      bool                  `json:"upstream_calls"`
	ConcurrentGuard    bool                  `json:"concurrent_change_guard"`
	NotAssessed        []string              `json:"not_assessed"`
	RoutingRules       providerImpactSection `json:"routing_rules"`
	AgentRoutes        providerImpactSection `json:"agent_routes"`
	FailoverPeers      providerImpactSection `json:"failover_peers"`
	APIKeys            providerImpactSection `json:"api_keys"`
	Teams              providerImpactSection `json:"teams"`
}

func unavailableProviderImpact(scope, status, reason string) providerImpactSection {
	return providerImpactSection{Status: status, Scope: scope, Reason: reason, CountKind: "unknown", Items: []providerImpactItem{}}
}

func measuredProviderImpact(scope string, scanned, matches int, partial bool, items []providerImpactItem) providerImpactSection {
	if items == nil {
		items = []providerImpactItem{}
	}
	section := providerImpactSection{Status: "complete", Scope: scope, CountKind: "exact", ScannedCount: &scanned, MatchedCount: &matches, Items: items}
	if partial {
		section.Status, section.Reason, section.CountKind = "partial", "bounded_or_unassessable_configuration", "lower_bound"
		section.Truncated = true
	}
	return section
}

// GET /admin/provider-impact aggregates existing configuration only. It never
// invokes a model, predicts a call result, mutates a binding, or guards a later
// DELETE against concurrent changes. Sections are independently scoped/bounded.
func (s *Server) handleProviderImpact(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeOpenAIError(w, http.StatusMethodNotAllowed, "GET 요청만 지원합니다.", "invalid_request_error", "method_not_allowed")
		return
	}
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "관리자 조회 권한이 필요합니다.", "permission_error", "invalid_api_key")
		return
	}
	allowRouting, teamScoped := true, false
	claims, claimsAvailable := s.currentAccessClaims(r)
	if claimsAvailable {
		teamScoped = claims.Role == "team_admin"
	}
	if s.cfg.Auth.Enabled {
		if !claimsAvailable {
			writeOpenAIError(w, http.StatusUnauthorized, "인증 상태를 확인할 수 없습니다.", "permission_error", "invalid_api_key")
			return
		}
		allowRouting = hasScope(claims.Scopes, "routing:read")
	}
	if len(r.URL.RawQuery) > 256 {
		writeOpenAIError(w, http.StatusBadRequest, "유효한 공급자 참조 하나가 필요합니다.", "invalid_request_error", "invalid_provider_ref")
		return
	}
	params, queryErr := url.ParseQuery(r.URL.RawQuery)
	values := params["provider_ref"]
	if queryErr != nil || len(params) != 1 || len(values) != 1 || !providerImpactRefPattern.MatchString(values[0]) {
		writeOpenAIError(w, http.StatusBadRequest, "유효한 공급자 참조 하나가 필요합니다.", "invalid_request_error", "invalid_provider_ref")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	refs := s.providerRefsSnapshot()
	providers, incomplete, err := s.db.AppRequestProviderCandidates(ctx)
	if err != nil || incomplete {
		writeOpenAIError(w, http.StatusServiceUnavailable, "공급자 참조를 완전하게 확인할 수 없습니다.", "server_error", "provider_impact_lookup_unavailable")
		return
	}
	name := ""
	for _, candidate := range providers {
		if ctx.Err() != nil {
			writeOpenAIError(w, http.StatusServiceUnavailable, "공급자 참조 조회 시간이 초과되었습니다.", "server_error", "provider_impact_lookup_unavailable")
			return
		}
		if subtle.ConstantTimeCompare([]byte(refs.physical(candidate)), []byte(values[0])) == 1 {
			name = candidate
			break
		}
	}
	if name == "" {
		writeOpenAIError(w, http.StatusNotFound, "공급자를 찾을 수 없습니다. 목록을 갱신하세요.", "invalid_request_error", "provider_not_found")
		return
	}
	cipher := s.secrets.Load()
	opaque := func(kind, id string) string { return "impact_" + cipher.OpaqueReference("provider-impact-"+kind, id) }
	project, err := providerImpactProjection(ctx, providers, s.externalCredentialProjectionArgs())
	if err != nil {
		writeOpenAIError(w, http.StatusServiceUnavailable, "공급자 참조 조회 시간이 초과되었습니다.", "server_error", "provider_impact_lookup_unavailable")
		return
	}
	result := providerImpactResponse{
		ProviderRef: refs.physical(name), ProviderDisplay: s.boundedModelsProviderLabelForConfig(name),
		GeneratedAt: time.Now().UTC().Format(time.RFC3339Nano), Consistency: "best_effort", ReadOnly: true,
		IsDefault:          name == s.cfg.Upstream.Provider,
		BootstrapOnRestart: name == s.cfg.Upstream.Provider && s.cfg.Upstream.APIKey != "",
		NotAssessed:        []string{"pattern_overlap", "full_model_catalog", "model_usage", "runtime_call_success", "ip_and_model_authorization", "concurrent_change_guard"},
	}
	const routingScope = "direct_provider_references"
	if !allowRouting {
		result.RoutingRules = unavailableProviderImpact(routingScope, "denied", "routing_read_required")
	} else {
		read, err := s.db.ProviderImpactRoutingReferences(ctx, providerImpactReadLimit)
		result.RoutingRules = providerImpactReferences(ctx, read, err, name, routingScope, "routing", opaque, project)
	}
	read, err := s.db.ProviderImpactAgentReferences(ctx, providerImpactReadLimit)
	result.AgentRoutes = providerImpactReferences(ctx, read, err, name, routingScope, "agent", opaque, project)
	result.FailoverPeers = s.providerImpactPeers(ctx, name, refs.physical)
	if teamScoped {
		// Existing key visibility is team-scoped. Until a bounded equivalent is
		// available, do not expose global candidate counts (including scanned rows).
		result.APIKeys = unavailableProviderImpact("eligible_provider_access_configuration", "denied", "team_scoped_assessment_not_available")
		result.Teams = unavailableProviderImpact("teams_of_eligible_key_configuration", "denied", "team_scoped_assessment_not_available")
	} else {
		result.APIKeys, result.Teams = s.providerImpactKeyCandidates(ctx, name)
	}
	writeJSON(w, http.StatusOK, result)
}

// Classify configured identities once, not once per projected field. This keeps
// expensive credential/PII checks O(providers + matching fields), with only
// bounded string replacement for unsafe identities. Context checks cooperate
// with the shared three-second read/projection budget; it is not a hard HTTP
// response deadline (encoding and transport can still take additional time).
func providerImpactProjection(ctx context.Context, providers, credentialArgs []string) (func(string) (string, error), error) {
	unsafe := make([]string, 0)
	for _, provider := range providers {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if provider != "" && !modelsProviderLabelSafe(provider) {
			unsafe = append(unsafe, provider)
		}
	}
	return func(value string) (string, error) {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		for _, provider := range unsafe {
			if err := ctx.Err(); err != nil {
				return "", err
			}
			value = strings.ReplaceAll(value, provider, providerNameOmitted)
			if len(value) > 1024 {
				return providerMetadataOmitted, nil
			}
		}
		value = boundedExternalProviderText(value, credentialArgs...)
		if len(value) > 1024 {
			value = providerMetadataOmitted
		}
		return value, ctx.Err()
	}, nil
}

func providerImpactReferences(ctx context.Context, read store.ProviderImpactRead[store.ProviderImpactReference], err error, name, scope, kind string, opaque func(string, string) string, project func(string) (string, error)) providerImpactSection {
	if err != nil {
		return unavailableProviderImpact(scope, "unavailable", "configuration_read_failed")
	}
	items := []providerImpactItem{}
	for _, row := range read.Rows {
		if ctx.Err() != nil {
			return unavailableProviderImpact(scope, "unavailable", "configuration_read_failed")
		}
		if strings.TrimSpace(row.Provider) != name {
			continue
		}
		label, labelErr := project(row.Label)
		model, modelErr := project(row.Model)
		if labelErr != nil || modelErr != nil {
			return unavailableProviderImpact(scope, "unavailable", "configuration_read_failed")
		}
		items = append(items, providerImpactItem{Reference: opaque(kind, row.ID), Label: label, Enabled: row.Enabled, Model: model, Relation: "direct_binding"})
	}
	return measuredProviderImpact(scope, read.Scanned, len(items), read.Truncated, items)
}

func (s *Server) providerImpactPeers(ctx context.Context, name string, ref providerReferenceFunc) providerImpactSection {
	const scope = "configured_failover_group"
	target, err := s.db.ProviderImpactConfigs(ctx, name, 1)
	if err != nil {
		return unavailableProviderImpact(scope, "unavailable", "configuration_read_failed")
	}
	if target.Truncated || len(target.Rows) != 1 {
		return unavailableProviderImpact(scope, "unavailable", "target_configuration_unassessable")
	}
	group := strings.TrimSpace(target.Rows[0].FailoverGroup)
	if group == "" {
		return measuredProviderImpact(scope, 1, 0, false, nil)
	}
	peers, err := s.db.ProviderImpactConfigs(ctx, "", providerImpactReadLimit)
	if err != nil {
		return unavailableProviderImpact(scope, "unavailable", "configuration_read_failed")
	}
	items := []providerImpactItem{}
	for _, peer := range peers.Rows {
		if ctx.Err() != nil {
			return unavailableProviderImpact(scope, "unavailable", "configuration_read_failed")
		}
		if peer.Name == name || !peer.Enabled || strings.TrimSpace(peer.FailoverGroup) != group {
			continue
		}
		items = append(items, providerImpactItem{Reference: ref(peer.Name), ProviderRef: ref(peer.Name), Label: s.boundedModelsProviderLabelForConfig(peer.Name), Enabled: true, Relation: "configured_failover_group"})
	}
	return measuredProviderImpact(scope, peers.Scanned, len(items), peers.Truncated, items)
}

func (s *Server) providerImpactKeyCandidates(ctx context.Context, name string) (providerImpactSection, providerImpactSection) {
	const keyScope, teamScope = "eligible_provider_access_configuration", "teams_of_eligible_key_configuration"
	read, err := s.db.ProviderImpactKeys(ctx, providerImpactReadLimit)
	if err != nil {
		return unavailableProviderImpact(keyScope, "unavailable", "configuration_read_failed"), unavailableProviderImpact(teamScope, "unavailable", "key_configuration_unavailable")
	}
	count := 0
	teams := []string{}
	now := time.Now().UTC()
	for _, key := range read.Rows {
		if ctx.Err() != nil {
			return unavailableProviderImpact(keyScope, "unavailable", "configuration_read_failed"), unavailableProviderImpact(teamScope, "unavailable", "key_configuration_unavailable")
		}
		if key.Status != "active" || !key.RevokedAt.IsZero() || (!key.ExpiresAt.IsZero() && key.ExpiresAt.Before(now)) {
			continue
		}
		if !listAllows(name, key.AllowedProviders, key.DeniedProviders) {
			continue
		}
		count++
		teams = append(teams, key.Team)
	}
	keys := measuredProviderImpact(keyScope, read.Scanned, count, read.Truncated, nil)
	teamCount, partial, err := s.db.ProviderImpactTeams(ctx, teams, providerImpactReadLimit)
	if err != nil {
		return keys, unavailableProviderImpact(teamScope, "unavailable", "team_configuration_read_failed")
	}
	return keys, measuredProviderImpact(teamScope, len(teams), teamCount, partial || read.Truncated, nil)
}
