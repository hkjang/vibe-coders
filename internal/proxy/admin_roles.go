package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

// rawPromptViewerRoles may view captured prompt/response ORIGINALS. Lower-privilege
// operators (viewer, readonly_admin, ops_admin, ai_admin, team_admin) still reach the
// request-detail surface (admin:read) but see only redacted text — data-scope masking.
var rawPromptViewerRoles = map[string]bool{"super_admin": true, "admin": true, "security_admin": true}

// canViewRawPrompts reports whether the caller may see un-redacted prompt/response text.
// Legacy admin-token mode (auth disabled) is treated as full admin.
func (s *Server) canViewRawPrompts(r *http.Request) bool {
	if !s.cfg.Auth.Enabled {
		if s.cfg.Auth.AdminToken == "" && s.cfg.Auth.AdminReadonlyToken == "" {
			return true
		}
		token := bearerToken(r.Header.Get("Authorization"))
		return s.cfg.Auth.AdminToken != "" && secureTokenEqual(token, s.cfg.Auth.AdminToken)
	}
	claims, ok := s.currentAccessClaims(r)
	if !ok {
		return false
	}
	return rawPromptViewerRoles[claims.Role]
}

// redactPromptDetails collapses each prompt's raw ContentText to its redacted form so no
// original leaks. Idempotent; safe when ContentText already equals RedactedText.
func redactPromptDetails(prompts []store.PromptDetail) {
	for i := range prompts {
		if prompts[i].ContentText != "" && prompts[i].ContentText != prompts[i].RedactedText {
			prompts[i].ContentText = prompts[i].RedactedText
		}
	}
}

// maskRequestDetail redacts prompt originals in a request detail unless the caller is
// authorized to view raw content.
func (s *Server) maskRequestDetail(r *http.Request, d *store.RequestDetail) {
	if d == nil || s.canViewRawPrompts(r) {
		return
	}
	rawProvider := d.Request.Provider
	rawFallback := d.Request.FallbackFrom
	projectionArgs := s.externalCredentialProjectionArgs(rawProvider, rawFallback)
	maskRecentRequestForExternal(&d.Request, projectionArgs...)
	projectRequestReadabilityProviderForExternal(d.Readability, projectionArgs...)
	projectRequestGovernanceProviderForExternal(&d.Governance, projectionArgs...)
	redactPromptDetails(d.Prompts)
	for index := range d.Prompts {
		d.Prompts[index].Role = audit.Redact(boundedExternalProviderText(d.Prompts[index].Role, projectionArgs...))
		d.Prompts[index].ContentText = audit.Redact(boundedExternalProviderText(d.Prompts[index].ContentText, projectionArgs...))
		d.Prompts[index].RedactedText = audit.Redact(boundedExternalProviderText(d.Prompts[index].RedactedText, projectionArgs...))
		d.Prompts[index].LanguageHint = audit.Redact(boundedExternalProviderText(d.Prompts[index].LanguageHint, projectionArgs...))
	}
	if d.Response != nil {
		d.Response.FinishReason = audit.Redact(boundedExternalProviderText(d.Response.FinishReason, projectionArgs...))
		d.Response.ResponseTextOptional = audit.Redact(boundedExternalProviderText(d.Response.ResponseTextOptional, projectionArgs...))
	}
	for index := range d.Languages {
		d.Languages[index].Language = audit.Redact(boundedExternalProviderText(d.Languages[index].Language, projectionArgs...))
		d.Languages[index].Evidence = audit.Redact(boundedExternalProviderText(d.Languages[index].Evidence, projectionArgs...))
	}
	for index := range d.Spans {
		d.Spans[index].TraceID = audit.Redact(boundedExternalProviderText(d.Spans[index].TraceID, projectionArgs...))
		d.Spans[index].Name = audit.Redact(boundedExternalProviderText(d.Spans[index].Name, projectionArgs...))
		d.Spans[index].Error = audit.Redact(boundedExternalProviderText(d.Spans[index].Error, projectionArgs...))
	}
	for index := range d.Text2SQLSpans {
		d.Text2SQLSpans[index].TraceID = audit.Redact(boundedExternalProviderText(d.Text2SQLSpans[index].TraceID, projectionArgs...))
		d.Text2SQLSpans[index].Model = boundedExternalProviderText(d.Text2SQLSpans[index].Model, projectionArgs...)
		d.Text2SQLSpans[index].RejectReason = audit.Redact(boundedExternalProviderText(d.Text2SQLSpans[index].RejectReason, projectionArgs...))
		d.Text2SQLSpans[index].Detail = audit.Redact(boundedExternalProviderText(d.Text2SQLSpans[index].Detail, projectionArgs...))
	}
	for index := range d.Evaluations {
		d.Evaluations[index].TraceID = audit.Redact(boundedExternalProviderText(d.Evaluations[index].TraceID, projectionArgs...))
		projectAndRedactEvaluationForExternal(&d.Evaluations[index], projectionArgs...)
	}
	for index := range d.Feedback {
		d.Feedback[index].TraceID = audit.Redact(boundedExternalProviderText(d.Feedback[index].TraceID, projectionArgs...))
		d.Feedback[index].Label = audit.Redact(boundedExternalProviderText(d.Feedback[index].Label, projectionArgs...))
		d.Feedback[index].Comment = audit.Redact(boundedExternalProviderText(d.Feedback[index].Comment, projectionArgs...))
		d.Feedback[index].Source = audit.Redact(boundedExternalProviderText(d.Feedback[index].Source, projectionArgs...))
		d.Feedback[index].CreatedBy = audit.Redact(boundedExternalProviderText(d.Feedback[index].CreatedBy, projectionArgs...))
	}
	for index := range d.Tools {
		d.Tools[index].TraceID = audit.Redact(boundedExternalProviderText(d.Tools[index].TraceID, projectionArgs...))
		d.Tools[index].APIKeyID = audit.Redact(boundedExternalProviderText(d.Tools[index].APIKeyID, projectionArgs...))
		d.Tools[index].ServerLabel = audit.Redact(boundedExternalProviderText(d.Tools[index].ServerLabel, projectionArgs...))
		d.Tools[index].ToolName = audit.Redact(boundedExternalProviderText(d.Tools[index].ToolName, projectionArgs...))
		d.Tools[index].Source = audit.Redact(boundedExternalProviderText(d.Tools[index].Source, projectionArgs...))
	}
	projectCodeVerifyForExternal(d.CodeVerify, projectionArgs...)
	redactRequestGovernance(&d.Governance)
	if d.Readability != nil {
		redactRequestReadabilityMap(d.Readability.Basic)
		redactRequestReadabilityMap(d.Readability.Model)
		redactRequestReadabilityMap(d.Readability.Parameters)
		redactRequestReadabilityMap(d.Readability.Headers)
		redactRequestReadabilityMap(d.Readability.Body)
		redactRequestReadabilityMap(d.Readability.Routing)
		redactRequestReadabilityMap(d.Readability.Policy)
		for index := range d.Readability.Timeline {
			d.Readability.Timeline[index].Stage = audit.Redact(d.Readability.Timeline[index].Stage)
			d.Readability.Timeline[index].Status = audit.Redact(d.Readability.Timeline[index].Status)
			d.Readability.Timeline[index].Reason = audit.Redact(d.Readability.Timeline[index].Reason)
			redactRequestReadabilityMap(d.Readability.Timeline[index].Detail)
		}
		for index := range d.Readability.Badges {
			d.Readability.Badges[index].Code = audit.Redact(d.Readability.Badges[index].Code)
			d.Readability.Badges[index].Label = audit.Redact(d.Readability.Badges[index].Label)
			d.Readability.Badges[index].Severity = audit.Redact(d.Readability.Badges[index].Severity)
			d.Readability.Badges[index].Reason = audit.Redact(d.Readability.Badges[index].Reason)
		}
	}
}

func projectCodeVerifyForExternal(detail *store.CodeVerifyDetail, projectionArgs ...string) {
	if detail == nil {
		return
	}
	project := func(value string) string {
		return audit.Redact(boundedExternalProviderText(value, projectionArgs...))
	}
	detail.Risk = project(detail.Risk)
	detail.Languages = project(detail.Languages)
	detail.CreatedAt = project(detail.CreatedAt)
	if len(detail.Findings) == 0 {
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(detail.Findings))
	decoder.UseNumber()
	var decoded any
	if err := decoder.Decode(&decoded); err != nil {
		detail.Findings = json.RawMessage("[]")
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		detail.Findings = json.RawMessage("[]")
		return
	}
	projected := projectProviderMetadataValueForExternal(decoded, projectionArgs...)
	encoded, err := json.Marshal(maskJSONForDisplay(projected))
	if err != nil {
		detail.Findings = json.RawMessage("[]")
		return
	}
	detail.Findings = encoded
}

func maskRecentRequestForExternal(request *store.RecentRequest, rawProviders ...string) {
	if request == nil {
		return
	}
	*request = projectRecentRequestProviderForExternal(*request, rawProviders...)
	request.Method = audit.Redact(boundedExternalProviderText(request.Method, rawProviders...))
	request.TraceID = audit.Redact(boundedExternalProviderText(request.TraceID, rawProviders...))
	request.APIKeyID = audit.Redact(boundedExternalProviderText(request.APIKeyID, rawProviders...))
	request.ClientIP = boundedExternalIPAddress(request.ClientIP)
	request.ForwardedFor = boundedExternalForwardedFor(request.ForwardedFor)
	request.SessionID = audit.Redact(boundedExternalProviderText(request.SessionID, rawProviders...))
	request.Model = audit.Redact(boundedExternalProviderText(request.Model, rawProviders...))
	request.RequestedModel = audit.Redact(boundedExternalProviderText(request.RequestedModel, rawProviders...))
	request.ResolvedModel = audit.Redact(boundedExternalProviderText(request.ResolvedModel, rawProviders...))
	request.UpstreamModel = audit.Redact(boundedExternalProviderText(request.UpstreamModel, rawProviders...))
	request.RouteReason = audit.Redact(boundedExternalProviderText(request.RouteReason, rawProviders...))
	request.RouteDetail = audit.Redact(boundedExternalProviderText(request.RouteDetail, rawProviders...))
	request.Endpoint = audit.Redact(boundedExternalProviderText(request.Endpoint, rawProviders...))
	request.ResponseFormatType = audit.Redact(boundedExternalProviderText(request.ResponseFormatType, rawProviders...))
	request.TokenSource = audit.Redact(boundedExternalProviderText(request.TokenSource, rawProviders...))
	request.Error = audit.Redact(boundedExternalProviderText(request.Error, rawProviders...))
	request.FallbackReason = audit.Redact(boundedExternalProviderText(request.FallbackReason, rawProviders...))
	request.UserAgent = audit.Redact(boundedExternalProviderText(request.UserAgent, rawProviders...))
	request.FinishReason = audit.Redact(boundedExternalProviderText(request.FinishReason, rawProviders...))
	request.PromptName = audit.Redact(boundedExternalProviderText(request.PromptName, rawProviders...))
	request.PromptVersion = audit.Redact(boundedExternalProviderText(request.PromptVersion, rawProviders...))
	request.Note = audit.Redact(boundedExternalProviderText(request.Note, rawProviders...))
	for index := range request.Tags {
		request.Tags[index] = audit.Redact(boundedExternalProviderText(request.Tags[index], rawProviders...))
	}
	for index := range request.Prompts {
		request.Prompts[index].Role = audit.Redact(boundedExternalProviderText(request.Prompts[index].Role, rawProviders...))
		request.Prompts[index].RedactedText = audit.Redact(boundedExternalProviderText(request.Prompts[index].RedactedText, rawProviders...))
		request.Prompts[index].LanguageHint = audit.Redact(boundedExternalProviderText(request.Prompts[index].LanguageHint, rawProviders...))
	}
	for index := range request.Languages {
		request.Languages[index].Language = audit.Redact(boundedExternalProviderText(request.Languages[index].Language, rawProviders...))
		request.Languages[index].Evidence = audit.Redact(boundedExternalProviderText(request.Languages[index].Evidence, rawProviders...))
	}
}

func projectAndRedactEvaluationForExternal(evaluation *store.LLMEvaluation, rawProviders ...string) {
	if evaluation == nil {
		return
	}
	evaluation.Name = audit.Redact(boundedExternalProviderText(evaluation.Name, rawProviders...))
	evaluation.Category = audit.Redact(boundedExternalProviderText(evaluation.Category, rawProviders...))
	evaluation.Evaluator = audit.Redact(boundedExternalProviderText(evaluation.Evaluator, rawProviders...))
	evaluation.Label = audit.Redact(boundedExternalProviderText(evaluation.Label, rawProviders...))
	evaluation.Reason = audit.Redact(boundedExternalProviderText(evaluation.Reason, rawProviders...))
	evaluation.Metadata = audit.Redact(boundedExternalProviderText(evaluation.Metadata, rawProviders...))
}

func redactRequestGovernance(governance *store.GovernanceEvents) {
	if governance == nil {
		return
	}
	for index := range governance.SecretEvents {
		governance.SecretEvents[index].Location = audit.Redact(governance.SecretEvents[index].Location)
	}
	for index := range governance.Approvals {
		governance.Approvals[index].SubjectID = audit.Redact(governance.Approvals[index].SubjectID)
		governance.Approvals[index].Reason = audit.Redact(governance.Approvals[index].Reason)
		governance.Approvals[index].Payload = audit.Redact(governance.Approvals[index].Payload)
		governance.Approvals[index].DecidedBy = audit.Redact(governance.Approvals[index].DecidedBy)
	}
	for index := range governance.AnomalyEvents {
		governance.AnomalyEvents[index].ScopeValue = audit.Redact(governance.AnomalyEvents[index].ScopeValue)
	}
	for index := range governance.PolicyDecisions {
		governance.PolicyDecisions[index].Reason = audit.Redact(governance.PolicyDecisions[index].Reason)
	}
}

// maskRecentRequests applies the same lower-privilege audit masking as request detail
// endpoints. The legacy trace list keeps its response shape, but must not become a
// bypass for prompt, upstream-error, fallback-reason, or user-agent redaction.
func (s *Server) maskRecentRequests(r *http.Request, requests []store.RecentRequest) {
	if s.canViewRawPrompts(r) {
		return
	}
	for index := range requests {
		rawProvider := requests[index].Provider
		rawFallback := requests[index].FallbackFrom
		maskRecentRequestForExternal(&requests[index], s.externalCredentialProjectionArgs(rawProvider, rawFallback)...)
	}
}

func (s *Server) maskUserDetail(r *http.Request, detail *store.UserDetail) {
	if detail == nil || s.canViewRawPrompts(r) {
		return
	}
	rawProviders := recentRequestProviderIdentities(detail.Recent)
	rawProviders = s.externalCredentialProjectionArgs(rawProviders...)
	s.maskRecentRequests(r, detail.Recent)
	maskGroupedTextStats(detail.ByModel, rawProviders...)
	maskGroupedIPStats(detail.ByIP)
	maskLanguageGroupedStats(detail.ByLanguage, rawProviders...)
	maskLLMSummaryStrings(&detail.LLM, rawProviders...)
}

func (s *Server) maskTeamDetail(r *http.Request, detail *store.TeamDetail) {
	if detail == nil || s.canViewRawPrompts(r) {
		return
	}
	rawProviders := recentRequestProviderIdentities(detail.Recent)
	rawProviders = s.externalCredentialProjectionArgs(rawProviders...)
	s.maskRecentRequests(r, detail.Recent)
	maskGroupedTextStats(detail.ByModel, rawProviders...)
	maskGroupedIPStats(detail.ByIP)
	maskGroupedTextStats(detail.ByKey, rawProviders...)
	maskLanguageGroupedStats(detail.ByLanguage, rawProviders...)
	maskLLMSummaryStrings(&detail.LLM, rawProviders...)
}

func (s *Server) maskIPDetail(r *http.Request, detail *store.IPDetail) {
	if detail == nil || s.canViewRawPrompts(r) {
		return
	}
	rawProviders := recentRequestProviderIdentities(detail.Recent)
	rawProviders = s.externalCredentialProjectionArgs(rawProviders...)
	s.maskRecentRequests(r, detail.Recent)
	detail.Stats.IP = boundedExternalIPAddress(detail.Stats.IP)
	maskGroupedTextStats(detail.ByModel, rawProviders...)
	maskGroupedTextStats(detail.ByKey, rawProviders...)
	maskLanguageGroupedStats(detail.ByLanguage, rawProviders...)
}

func maskGroupedIPStats(stats []store.GroupedStat) {
	for index := range stats {
		stats[index].Key = boundedExternalIPAddress(stats[index].Key)
	}
}

func recentRequestProviderIdentities(requests []store.RecentRequest) []string {
	providers := make([]string, 0, len(requests)*2)
	for _, request := range requests {
		providers = append(providers, request.Provider, request.FallbackFrom)
	}
	return providers
}

func maskGroupedTextStats(stats []store.GroupedStat, rawProviders ...string) {
	for index := range stats {
		stats[index].Key = audit.Redact(boundedExternalProviderText(stats[index].Key, rawProviders...))
	}
}

func maskLanguageGroupedStats(stats []store.LanguageGrouped, rawProviders ...string) {
	for index := range stats {
		stats[index].Language = audit.Redact(boundedExternalProviderText(stats[index].Language, rawProviders...))
	}
}

func maskLLMSummaryStrings(detail *store.UserLLMDetail, rawProviders ...string) {
	if detail == nil {
		return
	}
	for index := range detail.Prompts {
		detail.Prompts[index].PromptName = audit.Redact(boundedExternalProviderText(detail.Prompts[index].PromptName, rawProviders...))
		detail.Prompts[index].PromptVersion = audit.Redact(boundedExternalProviderText(detail.Prompts[index].PromptVersion, rawProviders...))
	}
	for index := range detail.FeedbackLabels {
		detail.FeedbackLabels[index].Label = audit.Redact(boundedExternalProviderText(detail.FeedbackLabels[index].Label, rawProviders...))
	}
}

func redactRequestReadabilityMap(values map[string]any) {
	redacted := make(map[string]any, len(values))
	uniqueKeys := newUniqueJSONDisplayKeys(len(values))
	for _, key := range sortedMapKeys(values) {
		redacted[uniqueKeys.claim(audit.Redact(key))] = redactRequestReadabilityAny(values[key])
	}
	for key := range values {
		delete(values, key)
	}
	for key, value := range redacted {
		values[key] = value
	}
}

func redactRequestReadabilityAny(value any) any {
	switch typed := value.(type) {
	case string:
		return audit.Redact(typed)
	case json.Number:
		return maskJSONNumberForDisplay(typed.String(), typed)
	case float64:
		return maskJSONNumberForDisplay(strconv.FormatFloat(typed, 'f', -1, 64), typed)
	case float32:
		return maskJSONNumberForDisplay(strconv.FormatFloat(float64(typed), 'f', -1, 32), typed)
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return maskJSONNumberForDisplay(fmt.Sprint(typed), typed)
	case []string:
		for index := range typed {
			typed[index] = audit.Redact(typed[index])
		}
	case []any:
		for index := range typed {
			typed[index] = redactRequestReadabilityAny(typed[index])
		}
	case map[string]any:
		redactRequestReadabilityMap(typed)
	}
	return value
}

// roleDescriptions documents each built-in role for the admin roles screen.
var roleDescriptions = map[string]string{
	"super_admin":     "최고 관리자 — 모든 권한",
	"admin":           "관리자 — 전체 운영/설정",
	"team_admin":      "팀 관리자 — 팀 단위 운영 조회 + 채팅",
	"team_manager":    "팀 매니저 — 팀 대시보드(사용량/비용/실패), 운영 화면 없음",
	"developer":       "개발자 — 채팅/임베딩/모델, 운영 화면 없음",
	"viewer":          "뷰어 — 운영 조회 전용",
	"service_account": "서비스 계정 — 채팅/임베딩/MCP",
	"ops_admin":       "운영 설정 관리자 — 관측/비용 + 일부 설정 쓰기",
	"ai_admin":        "AI 설정 관리자 — 모델/라우팅 + 일부 설정 쓰기",
	"security_admin":  "보안 관리자 — 보안 대시보드(정책위반·Secret·위험MCP·승인대기)",
	"billing_admin":   "비용 관리자 — 비용 대시보드(비용센터·예산소진·모델전환)",
	"readonly_admin":  "읽기전용 관리자 — 운영 조회, 변경 불가",
}

// roleInfo is one row of the role catalog (GET /admin/roles).
type roleInfo struct {
	Role        string   `json:"role"`
	Scopes      []string `json:"scopes"`
	DefaultHome string   `json:"default_home"`
	IsAdmin     bool     `json:"is_admin"`
	IsSystem    bool     `json:"is_system"`
	Rank        int      `json:"rank"`
	Description string   `json:"description"`
}

// effectiveScopesForRole resolves a role's scopes through the custom-role overlay first,
// falling back to the built-in map. Used at token issuance so custom roles take effect.
func (s *Server) effectiveScopesForRole(ctx context.Context, role string) []string {
	if cr, found, err := s.db.GetCustomRole(ctx, role); err == nil && found {
		return cr.Scopes
	}
	return scopesForRole(role)
}

// effectiveValidRole reports whether a role exists either built-in or as a custom role.
func (s *Server) effectiveValidRole(ctx context.Context, role string) bool {
	if validRole(role) {
		return true
	}
	if _, found, err := s.db.GetCustomRole(ctx, role); err == nil && found {
		return true
	}
	return false
}

// roleCatalog returns every built-in role with its derived scopes, default home, and
// whether it reaches the operational surface (admin:read). Drives a permissions UI and
// keeps the role model discoverable without reading code.
func roleCatalog() []roleInfo {
	out := make([]roleInfo, 0, len(roleScopes))
	for role, scopes := range roleScopes {
		s := append([]string{}, scopes...)
		out = append(out, roleInfo{
			Role:        role,
			Scopes:      s,
			DefaultHome: resolveHome(role, s),
			IsAdmin:     hasScope(s, "admin:read"),
			IsSystem:    true,
			Rank:        roleRank(role),
			Description: roleDescriptions[role],
		})
	}
	// Stable order: highest rank first, then name.
	for i := 0; i < len(out); i++ {
		for j := i + 1; j < len(out); j++ {
			if out[j].Rank > out[i].Rank || (out[j].Rank == out[i].Rank && out[j].Role < out[i].Role) {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	return out
}

// customRoleInfo projects a stored custom role into the catalog row shape.
func customRoleInfo(c store.CustomRole) roleInfo {
	home := strings.TrimSpace(c.DefaultHome)
	if home == "" {
		home = resolveDefaultHome(c.Scopes)
	}
	return roleInfo{
		Role: c.Role, Scopes: c.Scopes, DefaultHome: home,
		IsAdmin: hasScope(c.Scopes, "admin:read"), IsSystem: false,
		Rank: 0, Description: c.Description,
	}
}

// handleAdminRoles manages the role catalog. Admin-only.
// GET    /admin/roles            → built-in + custom roles + all_scopes
// POST   /admin/roles            → create/update a custom role {role, description, scopes, default_home}
// DELETE /admin/roles?role=NAME  → remove a custom role
func (s *Server) handleAdminRoles(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		roles := roleCatalog()
		if custom, err := s.db.ListCustomRoles(r.Context()); err == nil {
			for _, c := range custom {
				roles = append(roles, customRoleInfo(c))
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"roles": roles, "all_scopes": allScopes})
	case http.MethodPost:
		var p struct {
			Role        string   `json:"role"`
			Description string   `json:"description"`
			Scopes      []string `json:"scopes"`
			DefaultHome string   `json:"default_home"`
		}
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		role := strings.ToLower(strings.TrimSpace(p.Role))
		if role == "" {
			writeOpenAIError(w, http.StatusBadRequest, "role is required", "invalid_request_error", "missing_role")
			return
		}
		if _, isBuiltin := roleScopes[role]; isBuiltin {
			writeOpenAIError(w, http.StatusConflict, "'"+role+"' is a built-in role and cannot be overridden", "invalid_request_error", "builtin_role")
			return
		}
		// Validate every scope against the known set.
		clean := []string{}
		for _, sc := range p.Scopes {
			sc = strings.TrimSpace(sc)
			if sc == "" {
				continue
			}
			if !hasScope(allScopes, sc) {
				writeOpenAIError(w, http.StatusBadRequest, "unknown scope: "+sc, "invalid_request_error", "invalid_scope")
				return
			}
			clean = append(clean, sc)
		}
		cr := store.CustomRole{Role: role, Description: strings.TrimSpace(p.Description), Scopes: clean, DefaultHome: strings.TrimSpace(p.DefaultHome)}
		if err := s.db.UpsertCustomRole(r.Context(), cr); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "role_save_failed")
			return
		}
		s.auditAdmin(r, "role.upsert", role, auditJSON(map[string]any{"scopes": clean}))
		writeJSON(w, http.StatusCreated, map[string]any{"role": customRoleInfo(cr)})
	case http.MethodDelete:
		role := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("role")))
		if role == "" {
			writeOpenAIError(w, http.StatusBadRequest, "role query param is required", "invalid_request_error", "missing_role")
			return
		}
		if _, isBuiltin := roleScopes[role]; isBuiltin {
			writeOpenAIError(w, http.StatusConflict, "cannot delete built-in role", "invalid_request_error", "builtin_role")
			return
		}
		if err := s.db.DeleteCustomRole(r.Context(), role); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "role_delete_failed")
			return
		}
		s.auditAdmin(r, "role.delete", role, "")
		writeJSON(w, http.StatusOK, map[string]any{"role": role, "deleted": true})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handlePermissionsEffective returns the caller's effective role/scopes/features plus a
// per-menu allow/deny decision with reasons — the权한 debug view (FE-007/API-008). An admin
// may preview another role via ?role= without changing anyone's actual role.
// GET /permissions/effective[?role=]
func (s *Server) handlePermissionsEffective(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var role string
	var scopes []string
	if !s.cfg.Auth.Enabled {
		role, scopes = "admin", append([]string{}, allScopes...)
	} else {
		claims, ok := s.currentAccessClaims(r)
		if !ok {
			writeOpenAIError(w, http.StatusUnauthorized, "invalid access token", "invalid_request_error", "invalid_access_token")
			return
		}
		role, scopes = claims.Role, claims.Scopes
		// Admins may preview another role's effective permissions.
		if preview := strings.TrimSpace(r.URL.Query().Get("role")); preview != "" {
			if !s.authorizeAdmin(r) {
				writeOpenAIError(w, http.StatusForbidden, "previewing another role requires admin", "invalid_request_error", "forbidden")
				return
			}
			if !s.effectiveValidRole(r.Context(), preview) {
				writeOpenAIError(w, http.StatusBadRequest, "unknown role: "+preview, "invalid_request_error", "invalid_role")
				return
			}
			role, scopes = preview, s.effectiveScopesForRole(r.Context(), preview)
		}
	}

	features := s.featureFlags()
	menus := make([]map[string]any, 0, len(menuRegistry))
	for _, item := range menuRegistry {
		allowed, reason := menuDecision(item, scopes, features)
		menus = append(menus, map[string]any{
			"id": item.ID, "label": item.Label, "path": item.Path, "tab": item.Tab,
			"group": item.Group, "data_scope": item.DataScope,
			"allowed": allowed, "reason": reason,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"role":         role,
		"scopes":       scopes,
		"features":     features,
		"default_home": resolveHome(role, scopes),
		"is_admin":     hasScope(scopes, "admin:read"),
		"menu_version": menuVersion,
		"menus":        menus,
	})
}

// handleMeAccessDenied records a client-side route-guard denial (a user hit a menu/route
// outside their permissions). Lets operators see attempted privilege escalation in the
// auth audit log even though the block happens in the SPA.
// POST /me/access-denied {tab, path}
func (s *Server) handleMeAccessDenied(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	userID, ok := s.meUserID(r)
	if !ok {
		// Not identifiable (e.g. legacy token) — nothing to attribute; accept silently.
		writeJSON(w, http.StatusOK, map[string]any{"status": "ignored"})
		return
	}
	var p struct {
		Tab  string `json:"tab"`
		Path string `json:"path"`
	}
	_ = json.NewDecoder(r.Body).Decode(&p)
	teamID := ""
	if claims, ok := s.currentAccessClaims(r); ok {
		teamID = claims.TeamID
	}
	detail := "menu access denied: tab=" + strings.TrimSpace(p.Tab)
	if p.Path != "" {
		detail += " path=" + strings.TrimSpace(p.Path)
	}
	s.auditAuthEvent(r.Context(), "access_denied", userID, "", teamID, detail)
	writeJSON(w, http.StatusOK, map[string]any{"status": "recorded"})
}
