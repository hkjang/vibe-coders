package proxy

import (
	"strings"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

const providerMetadataOmitted = "[provider-metadata-omitted]"
const externalCredentialPrefixMarker = "\x00credential-prefix:"

// boundedExternalProviderText is the final boundary for descriptive provider
// metadata. Internal request/routing rows retain their raw provider identity so
// aggregation and failover joins remain exact; browser, MCP and warehouse
// projections must never repeat a credential-shaped legacy name or URL.
func boundedExternalProviderText(value string, rawProviders ...string) string {
	projected := value
	credentialPrefixes := make([]string, 0, 2)
	for _, rawProvider := range rawProviders {
		if strings.HasPrefix(rawProvider, externalCredentialPrefixMarker) {
			credentialPrefixes = append(credentialPrefixes, strings.TrimPrefix(rawProvider, externalCredentialPrefixMarker))
			continue
		}
		projected = boundedProviderMetadataText(projected, rawProvider)
	}
	if providerURLComponentHasCredential(projected) {
		return providerMetadataOmitted
	}
	for _, prefix := range credentialPrefixes {
		if providerTextContainsConfiguredCredentialPrefix(projected, prefix) {
			return providerMetadataOmitted
		}
	}
	return audit.Redact(projected)
}

func (s *Server) externalCredentialProjectionArgs(rawProviders ...string) []string {
	args := append([]string(nil), rawProviders...)
	seen := map[string]struct{}{}
	for _, prefix := range uiCredentialPrefixes(s.cfg.Auth) {
		if prefix == "" {
			continue
		}
		marked := externalCredentialPrefixMarker + prefix
		if _, exists := seen[marked]; exists {
			continue
		}
		seen[marked] = struct{}{}
		args = append(args, marked)
	}
	return args
}

func (s *Server) modelsProviderLabelSafeForConfig(name string) bool {
	if !modelsProviderLabelSafe(name) {
		return false
	}
	for _, prefix := range uiCredentialPrefixes(s.cfg.Auth) {
		if providerTextContainsConfiguredCredentialPrefix(name, prefix) {
			return false
		}
	}
	return true
}

func (s *Server) boundedModelsProviderLabelForConfig(name string) string {
	if !s.modelsProviderLabelSafeForConfig(name) {
		return providerNameOmitted
	}
	return name
}

func (s *Server) boundedModelsProviderLabelOrEmptyForConfig(name string) string {
	if strings.TrimSpace(name) == "" {
		return ""
	}
	return s.boundedModelsProviderLabelForConfig(name)
}

func (s *Server) projectAdminAuditsForExternal(logs []store.AdminAuditPublic) {
	projectionArgs := s.externalCredentialProjectionArgs()
	for index := range logs {
		logs[index].AdminID = audit.Redact(boundedExternalProviderText(logs[index].AdminID, projectionArgs...))
		logs[index].Action = audit.Redact(boundedExternalProviderText(logs[index].Action, projectionArgs...))
		logs[index].BeforeValue = audit.Redact(boundedExternalProviderText(logs[index].BeforeValue, projectionArgs...))
		logs[index].AfterValue = audit.Redact(boundedExternalProviderText(logs[index].AfterValue, projectionArgs...))
	}
}

func boundedExternalProviderLabelOrEmpty(name string, projectionArgs ...string) string {
	if strings.TrimSpace(name) == "" {
		return ""
	}
	projected := boundedExternalProviderText(name, projectionArgs...)
	if projected == providerMetadataOmitted || !modelsProviderLabelSafe(projected) {
		return providerNameOmitted
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

func projectRecentRequestProviderForExternal(req store.RecentRequest, projectionArgs ...string) store.RecentRequest {
	rawProvider := req.Provider
	rawFallback := req.FallbackFrom
	providers := append([]string{rawProvider, rawFallback}, projectionArgs...)
	req.Provider = boundedExternalProviderLabelOrEmpty(rawProvider, projectionArgs...)
	req.FallbackFrom = boundedExternalProviderLabelOrEmpty(rawFallback, projectionArgs...)
	req.Model = boundedExternalProviderText(req.Model, providers...)
	req.RequestedModel = boundedExternalProviderText(req.RequestedModel, providers...)
	req.ResolvedModel = boundedExternalProviderText(req.ResolvedModel, providers...)
	req.UpstreamModel = boundedExternalProviderText(req.UpstreamModel, providers...)
	req.RouteReason = boundedExternalProviderText(req.RouteReason, providers...)
	req.RouteDetail = boundedExternalProviderText(req.RouteDetail, providers...)
	req.FallbackReason = boundedExternalProviderText(req.FallbackReason, providers...)
	req.Error = boundedExternalProviderText(req.Error, providers...)
	req.Endpoint = boundedExternalProviderText(req.Endpoint, providers...)
	req.ResponseFormatType = boundedExternalProviderText(req.ResponseFormatType, providers...)
	req.PromptName = boundedExternalProviderText(req.PromptName, providers...)
	req.PromptVersion = boundedExternalProviderText(req.PromptVersion, providers...)
	req.TokenSource = boundedExternalProviderText(req.TokenSource, providers...)
	req.FinishReason = boundedExternalProviderText(req.FinishReason, providers...)
	for index := range req.Languages {
		req.Languages[index].Language = boundedExternalProviderText(req.Languages[index].Language, providers...)
		req.Languages[index].Evidence = boundedExternalProviderText(req.Languages[index].Evidence, providers...)
	}
	for index := range req.Prompts {
		req.Prompts[index].Role = boundedExternalProviderText(req.Prompts[index].Role, providers...)
		req.Prompts[index].RedactedText = boundedExternalProviderText(req.Prompts[index].RedactedText, providers...)
		req.Prompts[index].LanguageHint = boundedExternalProviderText(req.Prompts[index].LanguageHint, providers...)
	}
	for index := range req.Tags {
		req.Tags[index] = boundedExternalProviderText(req.Tags[index], providers...)
	}
	req.Note = boundedExternalProviderText(req.Note, providers...)
	return req
}

// projectRequestReadabilityProviderForExternal removes credential-shaped legacy
// provider identities from the derived request-detail maps. Older rows may have
// persisted the raw provider in routing summaries before the provider boundary
// was introduced, so projecting only Request.Provider is not sufficient.
func projectRequestReadabilityProviderForExternal(readability *store.RequestReadability, rawProviders ...string) {
	if readability == nil {
		return
	}
	projectProviderMetadataMapForExternal(readability.Basic, rawProviders...)
	projectProviderMetadataMapForExternal(readability.Model, rawProviders...)
	projectProviderMetadataMapForExternal(readability.Parameters, rawProviders...)
	projectProviderMetadataMapForExternal(readability.Headers, rawProviders...)
	projectProviderMetadataMapForExternal(readability.Body, rawProviders...)
	projectProviderMetadataMapForExternal(readability.Routing, rawProviders...)
	projectProviderMetadataMapForExternal(readability.Policy, rawProviders...)
	for index := range readability.Badges {
		readability.Badges[index].Reason = boundedExternalProviderText(readability.Badges[index].Reason, rawProviders...)
	}
	for index := range readability.Timeline {
		readability.Timeline[index].Reason = boundedExternalProviderText(readability.Timeline[index].Reason, rawProviders...)
		projectProviderMetadataMapForExternal(readability.Timeline[index].Detail, rawProviders...)
	}
}

func projectRequestGovernanceProviderForExternal(governance *store.GovernanceEvents, rawProviders ...string) {
	if governance == nil {
		return
	}
	project := func(value string) string {
		return audit.Redact(boundedExternalProviderText(value, rawProviders...))
	}
	for index := range governance.SecretEvents {
		event := &governance.SecretEvents[index]
		event.ID = project(event.ID)
		event.RequestID = project(event.RequestID)
		event.APIKeyID = project(event.APIKeyID)
		event.UserID = project(event.UserID)
		event.TeamID = project(event.TeamID)
		event.SecretType = project(event.SecretType)
		event.Action = project(event.Action)
		event.Location = project(event.Location)
		event.MatchedHash = project(event.MatchedHash)
	}
	for index := range governance.Approvals {
		approval := &governance.Approvals[index]
		approval.ID = project(approval.ID)
		approval.RequestID = project(approval.RequestID)
		approval.APIKeyID = project(approval.APIKeyID)
		approval.UserID = project(approval.UserID)
		approval.TeamID = project(approval.TeamID)
		approval.SubjectType = project(approval.SubjectType)
		approval.SubjectID = project(approval.SubjectID)
		approval.Status = project(approval.Status)
		approval.Reason = project(approval.Reason)
		approval.Payload = project(approval.Payload)
		approval.DecidedBy = project(approval.DecidedBy)
	}
	for index := range governance.AnomalyEvents {
		event := &governance.AnomalyEvents[index]
		event.ID = project(event.ID)
		event.Scope = project(event.Scope)
		event.ScopeValue = project(event.ScopeValue)
		event.Metric = project(event.Metric)
		event.Severity = project(event.Severity)
		event.Channel = project(event.Channel)
		event.Status = project(event.Status)
	}
	for index := range governance.PolicyDecisions {
		decision := &governance.PolicyDecisions[index]
		decisionProvider := decision.Provider
		providers := append([]string{decisionProvider}, rawProviders...)
		projectDecision := func(value string) string {
			return audit.Redact(boundedExternalProviderText(value, providers...))
		}
		decision.ID = projectDecision(decision.ID)
		decision.RequestID = projectDecision(decision.RequestID)
		decision.APIKeyID = projectDecision(decision.APIKeyID)
		decision.UserID = projectDecision(decision.UserID)
		decision.TeamID = projectDecision(decision.TeamID)
		decision.Provider = audit.Redact(boundedExternalProviderLabelOrEmpty(decisionProvider, providers...))
		decision.Endpoint = projectDecision(decision.Endpoint)
		decision.Phase = projectDecision(decision.Phase)
		decision.PolicyID = projectDecision(decision.PolicyID)
		decision.RuleID = projectDecision(decision.RuleID)
		decision.RuleName = projectDecision(decision.RuleName)
		decision.Decision = projectDecision(decision.Decision)
		decision.Model = projectDecision(decision.Model)
		decision.Reason = projectDecision(decision.Reason)
	}
}

func projectProviderMetadataMapForExternal(values map[string]any, rawProviders ...string) {
	projectedKeys := make(map[string]any, len(values))
	uniqueKeys := newUniqueJSONDisplayKeys(len(values))
	for _, key := range sortedMapKeys(values) {
		value := values[key]
		projectedKey := uniqueKeys.claim(boundedExternalProviderText(key, rawProviders...))
		projectedKeys[projectedKey] = projectProviderMetadataValueForExternal(value, rawProviders...)
	}
	for key := range values {
		delete(values, key)
	}
	for key, value := range projectedKeys {
		values[key] = value
	}
}

func projectProviderMetadataValueForExternal(value any, rawProviders ...string) any {
	switch typed := value.(type) {
	case string:
		return boundedExternalProviderText(typed, rawProviders...)
	case []string:
		return boundedExternalFallbackPath(typed, rawProviders...)
	case []any:
		for index := range typed {
			typed[index] = projectProviderMetadataValueForExternal(typed[index], rawProviders...)
		}
	case map[string]any:
		projectProviderMetadataMapForExternal(typed, rawProviders...)
	}
	return value
}

func projectRoutingDecisionProviderForExternal(decision store.RoutingDecisionLog, projectionArgs ...string) store.RoutingDecisionLog {
	rawProvider := decision.SelectedProvider
	providers := append([]string{rawProvider}, projectionArgs...)
	decision.TraceID = audit.Redact(boundedExternalProviderText(decision.TraceID, providers...))
	decision.SelectedProvider = boundedExternalProviderLabelOrEmpty(rawProvider, projectionArgs...)
	decision.RequestedModel = boundedExternalProviderText(decision.RequestedModel, providers...)
	decision.SelectedModel = boundedExternalProviderText(decision.SelectedModel, providers...)
	decision.FallbackPath = boundedExternalFallbackPath(decision.FallbackPath, providers...)
	for index := range decision.FallbackPath {
		decision.FallbackPath[index] = audit.Redact(decision.FallbackPath[index])
	}
	decision.DecisionReason = audit.Redact(boundedExternalProviderText(decision.DecisionReason, providers...))
	return decision
}

func projectExplainDataProviderForExternal(data store.ExplainData, projectionArgs ...string) store.ExplainData {
	rawProvider := data.Provider
	rawFallback := data.FallbackFrom
	providers := append([]string{rawProvider, rawFallback}, projectionArgs...)
	data.TraceID = audit.Redact(boundedExternalProviderText(data.TraceID, providers...))
	data.Provider = boundedExternalProviderLabelOrEmpty(rawProvider, projectionArgs...)
	data.FallbackFrom = boundedExternalProviderLabelOrEmpty(rawFallback, projectionArgs...)
	data.SessionID = audit.Redact(boundedExternalProviderText(data.SessionID, providers...))
	data.Model = boundedExternalProviderText(data.Model, providers...)
	data.RequestedModel = boundedExternalProviderText(data.RequestedModel, providers...)
	data.RouteReason = audit.Redact(boundedExternalProviderText(data.RouteReason, providers...))
	data.RouteDetail = audit.Redact(boundedExternalProviderText(data.RouteDetail, providers...))
	data.Endpoint = audit.Redact(boundedExternalProviderText(data.Endpoint, providers...))
	data.TokenSource = boundedExternalProviderText(data.TokenSource, providers...)
	data.RoutingReason = audit.Redact(boundedExternalProviderText(data.RoutingReason, providers...))
	data.RoutingFallbackPath = boundedExternalFallbackPath(data.RoutingFallbackPath, providers...)
	for index := range data.RoutingFallbackPath {
		data.RoutingFallbackPath[index] = audit.Redact(data.RoutingFallbackPath[index])
	}
	data.FallbackReason = audit.Redact(boundedExternalProviderText(data.FallbackReason, providers...))
	data.Error = audit.Redact(boundedExternalProviderText(data.Error, providers...))
	return data
}

func projectMCPRouteDecisionsProviderForExternal(decisions []store.MCPRouteDecision, rawProviders ...string) {
	for index := range decisions {
		decision := &decisions[index]
		rawUpstream := decision.UpstreamName
		providers := append([]string{rawUpstream}, rawProviders...)
		decision.ID = audit.Redact(boundedExternalProviderText(decision.ID, providers...))
		decision.RequestID = audit.Redact(boundedExternalProviderText(decision.RequestID, providers...))
		decision.TraceID = audit.Redact(boundedExternalProviderText(decision.TraceID, providers...))
		decision.APIKeyID = audit.Redact(boundedExternalProviderText(decision.APIKeyID, providers...))
		decision.Method = audit.Redact(boundedExternalProviderText(decision.Method, providers...))
		decision.UpstreamName = boundedExternalProviderLabelOrEmpty(rawUpstream, rawProviders...)
		decision.ExposedName = audit.Redact(boundedExternalProviderText(decision.ExposedName, providers...))
		decision.UpstreamID = audit.Redact(boundedExternalProviderText(decision.UpstreamID, providers...))
		decision.TargetName = audit.Redact(boundedExternalProviderText(decision.TargetName, providers...))
		decision.ServerPolicy = audit.Redact(boundedExternalProviderText(decision.ServerPolicy, providers...))
		decision.ToolRiskLevel = audit.Redact(boundedExternalProviderText(decision.ToolRiskLevel, providers...))
		decision.ToolRiskAction = audit.Redact(boundedExternalProviderText(decision.ToolRiskAction, providers...))
		decision.FinalDecision = audit.Redact(boundedExternalProviderText(decision.FinalDecision, providers...))
		decision.Reason = audit.Redact(boundedExternalProviderText(decision.Reason, providers...))
	}
}
