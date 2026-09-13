package proxy

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
	"vibe-coders/internal/tracking"
)

// Visitor tracking: the administrator attaches an analytics snippet to the
// consoles from the settings screen, and the gateway does the part a pasted
// <script> cannot do on its own — carry a per-request nonce, widen the CSP by
// exactly the origins the snippet needs, and record what the browser still
// refuses so the settings screen can show it. See internal/tracking.

const (
	trackingEnabledKey            = "tracking.enabled"
	trackingProviderKey           = "tracking.provider"
	trackingMomentoURLKey         = "tracking.momento_url"
	trackingMomentoSiteIDKey      = "tracking.momento_site_id"
	trackingMomentoEnvironmentKey = "tracking.momento_environment"
	trackingMomentoProxyKey       = "tracking.momento_proxy"
	trackingMeasurementIDKey      = "tracking.measurement_id"
	trackingMatomoURLKey          = "tracking.matomo_url"
	trackingMatomoSiteIDKey       = "tracking.matomo_site_id"
	trackingCustomSnippetKey      = "tracking.custom_snippet"
	trackingAllowedHostsKey       = "tracking.allowed_hosts"
	trackingIncludeAdminKey       = "tracking.include_admin"
	trackingPlacementKey          = "tracking.placement"

	// momentoProxyTimeout bounds one forwarded collector call. A tracker
	// beacon is tiny; a collector that takes longer than this is down, and the
	// page must not hold a gateway connection waiting for it.
	momentoProxyTimeout = 10 * time.Second
	// momentoProxyMaxBody bounds a forwarded beacon body.
	momentoProxyMaxBody = 256 * 1024
)

func trackingSettingDefs() []settingDef {
	constant := func(value string) func(config.Config) string {
		return func(config.Config) string { return value }
	}
	oneOf := func(options []string) func(string) error {
		return func(value string) error {
			value = strings.ToLower(strings.TrimSpace(value))
			for _, option := range options {
				if value == option {
					return nil
				}
			}
			return fmt.Errorf("must be one of %s", strings.Join(options, "|"))
		}
	}
	optionalURL := func(value string) error {
		value = strings.TrimSpace(value)
		if value == "" {
			return nil
		}
		parsed, err := url.Parse(value)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return fmt.Errorf("must be an http(s) URL")
		}
		return nil
	}
	snippet := func(value string) error {
		if len(value) > tracking.MaxSnippetBytes {
			return fmt.Errorf("must not exceed %d bytes", tracking.MaxSnippetBytes)
		}
		return nil
	}
	return []settingDef{
		{Key: trackingEnabledKey, Category: "tracking", Type: stBool, envValue: constant("false")},
		{Key: trackingProviderKey, Category: "tracking", Type: stString, validate: oneOf(tracking.Providers), envValue: constant(tracking.ProviderNone)},
		{Key: trackingMomentoURLKey, Category: "tracking", Type: stString, validate: optionalURL, envValue: constant("")},
		{Key: trackingMomentoSiteIDKey, Category: "tracking", Type: stString, envValue: constant("")},
		{Key: trackingMomentoEnvironmentKey, Category: "tracking", Type: stString, envValue: constant("prd")},
		{Key: trackingMomentoProxyKey, Category: "tracking", Type: stBool, envValue: constant("true")},
		{Key: trackingMeasurementIDKey, Category: "tracking", Type: stString, envValue: constant("")},
		{Key: trackingMatomoURLKey, Category: "tracking", Type: stString, validate: optionalURL, envValue: constant("")},
		{Key: trackingMatomoSiteIDKey, Category: "tracking", Type: stString, envValue: constant("")},
		{Key: trackingCustomSnippetKey, Category: "tracking", Type: stString, validate: snippet, envValue: constant("")},
		{Key: trackingAllowedHostsKey, Category: "tracking", Type: stString, envValue: constant("")},
		{Key: trackingIncludeAdminKey, Category: "tracking", Type: stBool, envValue: constant("false")},
		{Key: trackingPlacementKey, Category: "tracking", Type: stString, validate: oneOf([]string{tracking.PlacementHead, tracking.PlacementBody}), envValue: constant(tracking.PlacementHead)},
	}
}

func init() {
	settingDescriptions[trackingEnabledKey] = "방문 추적 스니펫 삽입 여부. 기본 꺼짐. 켜면 /app 콘솔 페이지에 provider 스니펫이 요청마다 nonce 를 달고 들어갑니다."
	settingDescriptions[trackingProviderKey] = "추적 도구: momento(사내 수집기, 권장)·ga4·gtm·matomo·custom(붙여넣은 스니펫)·none."
	settingDescriptions[trackingMomentoURLKey] = "Momento 수집기 주소(예: https://momento.corp.example)."
	settingDescriptions[trackingMomentoSiteIDKey] = "Momento 사이트 id."
	settingDescriptions[trackingMomentoEnvironmentKey] = "Momento data-environment 값(기본 prd)."
	settingDescriptions[trackingMomentoProxyKey] = "Momento 를 같은 오리진 프록시(/momento/*)로 넘길지. 켜면 외부 출처가 CSP 에 등장하지 않습니다(기본 켜짐)."
	settingDescriptions[trackingMeasurementIDKey] = "GA4 측정 ID(G-…) 또는 GTM 컨테이너 ID(GTM-…)."
	settingDescriptions[trackingMatomoURLKey] = "Matomo 주소(예: https://matomo.corp.example)."
	settingDescriptions[trackingMatomoSiteIDKey] = "Matomo 사이트 id."
	settingDescriptions[trackingCustomSnippetKey] = "provider=custom 일 때 붙여넣는 스니펫(8KB 이하). 모든 <script> 태그에 nonce 가 자동으로 붙고, 스니펫 안의 http(s) 출처는 CSP 에 자동 추가됩니다."
	settingDescriptions[trackingAllowedHostsKey] = "스니펫에서 자동으로 읽지 못한 출처를 더하는 자리(쉼표·공백 구분, 예: https://cdn.example). 차단된 출처 목록에서 한 번에 추가할 수 있습니다."
	settingDescriptions[trackingIncludeAdminKey] = "기존 관리자 콘솔(/admin)에도 스니펫을 붙일지. 기본 아니오."
	settingDescriptions[trackingPlacementKey] = "스니펫 위치: head 또는 body."
}

// trackingConf returns the runtime tracking snapshot; the zero value (off) until
// the first settings reload.
func (s *Server) trackingConf() tracking.Config {
	if value := s.trackingRuntime.Load(); value != nil {
		return *value
	}
	return tracking.Config{Provider: tracking.ProviderNone, Placement: tracking.PlacementHead, MomentoProxy: true}
}

func (s *Server) reloadTrackingRuntime(stored map[string]store.AdminSetting) {
	get := func(key string) string {
		def, ok := settingDefByKey(key)
		if !ok {
			return ""
		}
		value, _, _ := s.effectiveSettingValue(stored, def)
		return strings.TrimSpace(value)
	}
	boolValue := func(key string, fallback bool) bool {
		value, err := strconv.ParseBool(get(key))
		if err != nil {
			return fallback
		}
		return value
	}
	conf := tracking.Config{
		Enabled:            boolValue(trackingEnabledKey, false),
		Provider:           get(trackingProviderKey),
		MomentoURL:         get(trackingMomentoURLKey),
		MomentoSiteID:      get(trackingMomentoSiteIDKey),
		MomentoEnvironment: get(trackingMomentoEnvironmentKey),
		MomentoProxy:       boolValue(trackingMomentoProxyKey, true),
		MeasurementID:      get(trackingMeasurementIDKey),
		MatomoURL:          get(trackingMatomoURLKey),
		MatomoSiteID:       get(trackingMatomoSiteIDKey),
		CustomSnippet:      get(trackingCustomSnippetKey),
		AllowedHosts:       get(trackingAllowedHostsKey),
		IncludeAdmin:       boolValue(trackingIncludeAdminKey, false),
		Placement:          get(trackingPlacementKey),
	}.Normalized()
	s.trackingRuntime.Store(&conf)
}

// serveTrackedLegacyPage serves the legacy console with the tracking snippet
// when the administrator asked for admin pages to be tracked. The legacy
// console is otherwise served from a pre-rendered, ETag-validated copy; a
// page carrying a per-request nonce cannot be, so it is rendered fresh and
// sent with no-store. It reports false when the console should be served
// as before.
func (s *Server) serveTrackedLegacyPage(w http.ResponseWriter, r *http.Request, page renderedPage) bool {
	config := s.trackingConf()
	if !config.Active(true) {
		return false
	}
	nonce, err := randomURLSafe(18)
	if err != nil {
		return false
	}
	body := tracking.Inject(page.body, config.Snippet(nonce), config.Placement)
	h := w.Header()
	h.Set("Content-Type", page.mimeType)
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
	return true
}

// handleTrackingReport receives the browser's content security policy
// violation reports. It is unauthenticated because browsers send reports
// without credentials, so it accepts nothing while tracking is off, reads a
// bounded body, and keeps only http(s) origins in a small in-memory list.
// POST /tracking/csp-report
func (s *Server) handleTrackingReport(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	config := s.trackingConf()
	if !config.Active(false) && !config.Active(true) {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, tracking.MaxReportBytes+1))
	if err != nil || len(body) > tracking.MaxReportBytes {
		w.WriteHeader(http.StatusRequestEntityTooLarge)
		return
	}
	for _, report := range tracking.ParseReports(body) {
		s.cspViolations.Record(report.BlockedURI, report.Directive, report.Document)
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleMomentoProxy forwards /momento/* to the Momento collector so the
// tracker script and its beacons stay same-origin. Nothing is forwarded
// unless tracking is on, the provider is Momento and the proxy is chosen.
func (s *Server) handleMomentoProxy(w http.ResponseWriter, r *http.Request) {
	config := s.trackingConf()
	if !config.MomentoProxyActive() {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, HEAD, POST")
		http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
		return
	}
	target, err := url.Parse(config.Normalized().MomentoURL)
	if err != nil || target.Host == "" {
		http.NotFound(w, r)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, tracking.MomentoProxyPrefix)
	proxy := &httputil.ReverseProxy{
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(target)
			request.Out.URL.Path = strings.TrimRight(target.Path, "/") + rest
			request.Out.URL.RawPath = ""
			request.Out.Host = target.Host
			// The collector sees a visitor, not the gateway's operator session.
			request.Out.Header.Del("Authorization")
			request.Out.Header.Del("Cookie")
			request.SetXForwarded()
		},
		Transport: &http.Transport{ResponseHeaderTimeout: momentoProxyTimeout, Proxy: http.ProxyFromEnvironment},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			w.WriteHeader(http.StatusBadGateway)
		},
	}
	r.Body = http.MaxBytesReader(w, r.Body, momentoProxyMaxBody)
	proxy.ServeHTTP(w, r)
}

// handleTrackingViolations lists (GET) or clears (DELETE) the origins the
// browser refused, together with the state the console needs to explain them.
// GET|DELETE /admin/tracking/violations
func (s *Server) handleTrackingViolations(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.trackingStatus())
	case http.MethodDelete:
		s.cspViolations.Forget()
		s.auditAdmin(r, "tracking.violations.clear", "", "")
		writeJSON(w, http.StatusOK, s.trackingStatus())
	default:
		w.Header().Set("Allow", "GET, DELETE")
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) trackingStatus() map[string]any {
	config := s.trackingConf()
	status := map[string]any{
		"enabled":       config.Enabled,
		"provider":      config.Provider,
		"active":        config.Active(false),
		"include_admin": config.IncludeAdmin,
		"placement":     config.Placement,
		"momento_proxy": config.Provider == tracking.ProviderMomento && config.MomentoProxy,
		"allowed_hosts": tracking.SplitHosts(config.AllowedHosts),
		"violations":    s.cspViolations.List(config),
	}
	if err := config.Validate(); err != nil {
		status["error"] = err.Error()
	}
	return status
}

// handleTrackingAllow adds one blocked origin to tracking.allowed_hosts. It
// goes through the ordinary setting write so the change is audited, versioned
// and reloaded on every pod like any other setting.
// POST /admin/tracking/violations/allow
func (s *Server) handleTrackingAllow(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var input struct {
		Origin string `json:"origin"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&input); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_json")
		return
	}
	origin := strings.TrimSuffix(strings.TrimSpace(input.Origin), "/")
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		writeOpenAIError(w, http.StatusBadRequest, "origin must be an http(s) origin such as https://cdn.example", "invalid_request_error", "invalid_origin")
		return
	}
	def, _ := settingDefByKey(trackingAllowedHostsKey)
	if !s.canWriteSetting(r, def) {
		writeOpenAIError(w, http.StatusForbidden, "insufficient permission for tracking settings", "invalid_request_error", "permission_denied")
		return
	}
	before := s.trackingConf().AllowedHosts
	after := tracking.AddAllowedHost(before, origin)
	if after != before {
		if err := s.applySettingWrite(r, def, after, "allow blocked origin "+origin); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, err.Error(), "invalid_request_error", "setting_write_failed")
			return
		}
		s.auditAdmin(r, "tracking.allowed_hosts.add", before, after)
	}
	writeJSON(w, http.StatusOK, s.trackingStatus())
}
