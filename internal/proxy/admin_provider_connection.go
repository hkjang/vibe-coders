package proxy

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

const providerConnectionMaxTimeout = 10 * time.Second

type providerConnectionResult struct {
	Outcome        string `json:"outcome"`
	UpstreamStatus *int   `json:"upstream_status"`
	DurationMS     int64  `json:"duration_ms"`
	TimeoutMS      int    `json:"timeout_ms"`
	ModelCount     *int   `json:"model_count"`
}

// This explicit draft probe never saves a provider, fills a catalogue cache, or
// performs inference. An action audit is its only intentional persistent write.
func (s *Server) handleProviderConnectionTest(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	ctx, cancel := context.WithTimeout(r.Context(), providerConnectionMaxTimeout)
	defer cancel()
	r = r.WithContext(ctx)
	controller := http.NewResponseController(w)
	bodyConsumed := false
	if deadline, ok := ctx.Deadline(); ok {
		_ = controller.SetReadDeadline(deadline)
		defer func() {
			if bodyConsumed {
				_ = controller.SetReadDeadline(time.Time{})
			}
		}()
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		connectionError(w, 405, "method_not_allowed", "POST 요청만 지원합니다.")
		return
	}
	if !s.providerConnectionAllowed(w, r) {
		return
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10))
	input, valid := decodeProviderConnectionRequest(decoder)
	bodyConsumed = valid
	if !valid || r.URL.RawQuery != "" {
		connectionError(w, 400, "invalid_body", "연결 테스트 입력 형식과 크기를 확인하세요.")
		return
	}
	if code := s.validateProviderConnectionRequest(input); code != "" {
		connectionError(w, 400, code, "공급자 이름, 주소와 인증 방식 입력을 확인하세요.")
		return
	}
	timeout := s.cfg.Upstream.Timeout
	if input.TimeoutMS > 0 {
		timeout = time.Duration(input.TimeoutMS) * time.Millisecond
	}
	timeout = min(max(timeout, time.Millisecond), providerConnectionMaxTimeout)
	probeCtx, stopProbe := context.WithTimeout(ctx, timeout)
	defer stopProbe()
	r = r.WithContext(probeCtx)
	start := time.Now()
	result := providerConnectionResult{TimeoutMS: int(timeout / time.Millisecond)}
	release, err := s.acquireModelsCatalogSlot(probeCtx)
	if err != nil {
		result.Outcome = providerConnectionFailure(probeCtx, err)
	} else {
		defer release()
		// A queued request cannot reuse a feature decision or stored credential
		// snapshot taken before waiting for an outbound slot.
		if !s.providerConnectionAllowed(w, r) {
			return
		}
		baseURL, apiKey, status, code := s.providerConnectionTarget(probeCtx, input)
		if code != "" {
			connectionError(w, status, code, "현재 공급자와 인증 설정을 다시 확인하세요.")
			return
		}
		result = s.probeProviderConnection(probeCtx, baseURL, apiKey, input.CredentialMode, result)
	}
	result.DurationMS = max(time.Since(start).Milliseconds(), 0)
	// Do not invoke auditAdmin's configuration-change/red-team hooks for a probe.
	// Audit cancellation is bounded independently, and only this fixed DTO is kept.
	auditCtx, stopAudit := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
	defer stopAudit()
	if err := s.db.InsertAdminAudit(auditCtx, store.AdminAuditLog{
		ID: newID("audit"), AdminID: adminID(r), Action: "provider.connection_test", AfterValue: auditJSON(result),
	}); err != nil {
		slog.Warn("provider connection test audit unavailable")
	}
	writeJSON(w, http.StatusOK, result)
}

func connectionError(w http.ResponseWriter, status int, code, message string) {
	writeOpenAIError(w, status, message, "invalid_request_error", code)
}

func (s *Server) providerConnectionAllowed(w http.ResponseWriter, r *http.Request) bool {
	if !s.authorizeAdmin(r) {
		if r.Context().Err() != nil {
			connectionError(w, 503, "provider_connection_unavailable", "현재 권한 확인을 완료할 수 없습니다.")
			return false
		}
		connectionError(w, 401, "invalid_api_key", "관리자 변경 권한이 필요합니다.")
		return false
	}
	user, authenticated, valid := s.appUIBootstrapIdentity(r)
	if !valid || !authenticated || user == nil || !hasScope(user.Scopes, "admin:write") {
		// A deadline during session lookup is not invalid authentication. In
		// particular, never provoke the client's 401 refresh/replay for a timeout.
		if r.Context().Err() != nil {
			connectionError(w, 503, "provider_connection_unavailable", "현재 권한 확인을 완료할 수 없습니다.")
			return false
		}
		connectionError(w, 401, "invalid_api_key", "관리자 변경 권한이 필요합니다.")
		return false
	}
	stored, err := s.loadStoredSettings(r)
	if err != nil {
		connectionError(w, 503, "provider_connection_unavailable", "화면 접근 설정을 확인할 수 없습니다.")
		return false
	}
	// The general registry intentionally tolerates malformed historical values.
	// An external execution must not turn that fallback into permission to run.
	for _, key := range []string{appUIEnabledKey, appUILegacyFallbackKey,
		"ui.app.feature.gateway.providers.status", "ui.app.feature.gateway.providers.roles",
		"ui.app.feature.gateway.providers.rollout", "ui.app.feature.gateway.providers.readonly"} {
		definition, found := settingDefByKey(key)
		value, _, valueErr := s.effectiveSettingValue(stored, definition)
		if !found || valueErr != nil || validateSettingValue(definition, value) != nil {
			connectionError(w, 503, "provider_connection_unavailable", "화면 접근 설정을 확인할 수 없습니다.")
			return false
		}
	}
	if s.appUITelemetryFlag(stored, appUIEnabledKey) {
		for _, feature := range effectiveAppUIFeaturesWithFallback(stored, s, user.ID, user.Role, user.Scopes, authenticated, s.appUITelemetryFlag(stored, appUILegacyFallbackKey)) {
			if feature.FeatureID != "gateway.providers" || !feature.Available || feature.ReadOnly {
				continue
			}
			switch feature.Status {
			case "preview", "stable", "deprecated", "retired":
				return true
			}
		}
	}
	connectionError(w, 403, "provider_connection_forbidden", "현재 공급자 화면에서는 외부 연결 테스트를 실행할 수 없습니다.")
	return false
}

func (s *Server) providerConnectionTarget(ctx context.Context, input providerConnectionRequest) (baseURL, apiKey string, status int, code string) {
	name := strings.TrimSpace(input.Name)
	if input.ProviderRef != "" {
		candidates, incomplete, err := s.db.AppRequestProviderCandidates(ctx)
		if err != nil || incomplete {
			return "", "", 503, "provider_connection_unavailable"
		}
		refs := s.providerRefSnapshot()
		for _, candidate := range candidates {
			if subtle.ConstantTimeCompare([]byte(refs(candidate)), []byte(input.ProviderRef)) == 1 {
				name = candidate
				break
			}
		}
		if name == "" {
			return "", "", 404, "provider_not_found"
		}
	}
	provider, found, err := s.db.GetProvider(ctx, name)
	if err != nil {
		return "", "", 503, "provider_connection_unavailable"
	}
	if input.ProviderRef == "" && found {
		return "", "", 409, "provider_already_exists"
	}
	if input.ProviderRef != "" && !found {
		return "", "", 404, "provider_not_found"
	}
	// Match the established provider-save normalization, including its treatment
	// of a slash at the end of the full query string. Never normalize the stored
	// row before comparison: a legacy discrepancy must require an explicit key.
	baseURL = strings.TrimRight(strings.TrimSpace(input.BaseURL), "/")
	switch input.CredentialMode {
	case "stored":
		// Display markers are never resolved back into an unsafe legacy address.
		if s.validateProviderBaseURLForApp(provider.BaseURL) != nil {
			return "", "", 409, "provider_destination_changed"
		}
		current, _ := parseProviderBaseURL(provider.BaseURL)
		submitted, _ := parseProviderBaseURL(baseURL)
		if current.String() != submitted.String() {
			return "", "", 409, "provider_destination_changed"
		}
		apiKey, err = s.secrets.Load().Decrypt(provider.EncryptedAPIKey)
		if err != nil || !validProviderConnectionKey(apiKey) {
			return "", "", 409, "stored_credential_unavailable"
		}
		baseURL = provider.BaseURL
	case "draft":
		apiKey = strings.TrimSpace(input.APIKey)
	case "none":
		if provider.EncryptedAPIKey != "" {
			return "", "", 409, "stored_credential_present"
		}
	}
	return baseURL, apiKey, 0, ""
}
