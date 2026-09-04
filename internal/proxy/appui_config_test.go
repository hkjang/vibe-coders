package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func TestAppUIBootstrapAndRuntimeToggle(t *testing.T) {
	t.Setenv("UI_APP_ENABLED", "false")
	ts, _ := settingsServer(t)

	resp, body := req(t, http.MethodGet, ts.URL+"/admin/ui-bootstrap", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("bootstrap status = %d", resp.StatusCode)
	}
	if requestID := resp.Header.Get("X-Request-ID"); !validRequestID(requestID) {
		t.Fatalf("missing or invalid response request id %q", requestID)
	}
	ui, _ := body["ui"].(map[string]any)
	if enabled, _ := ui["enabled"].(bool); enabled {
		t.Fatal("/app must be disabled by default")
	}
	auth, _ := body["authentication"].(map[string]any)
	if authenticated, _ := auth["authenticated"].(bool); !authenticated {
		t.Fatal("auth-disabled deployment without legacy tokens should bootstrap as an operator")
	}
	features, _ := body["migration_registry"].([]any)
	if len(features) != len(appUIFeatures) {
		t.Fatalf("migration registry length = %d, want %d", len(features), len(appUIFeatures))
	}

	resp, _ = req(t, http.MethodPut, ts.URL+"/admin/settings/by-key/"+appUIEnabledKey, `{"value":"true","reason":"phase 0 preview"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("enable setting status = %d", resp.StatusCode)
	}
	_, body = req(t, http.MethodGet, ts.URL+"/admin/ui-bootstrap", "")
	ui, _ = body["ui"].(map[string]any)
	if enabled, _ := ui["enabled"].(bool); !enabled {
		t.Fatal("runtime setting did not enable /app")
	}

	resp, _ = req(t, http.MethodPut, ts.URL+"/admin/settings/by-key/"+appUILegacyFallbackKey, `{"value":"false","reason":"disable legacy bridge"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("disable legacy fallback setting status = %d", resp.StatusCode)
	}
	_, body = req(t, http.MethodGet, ts.URL+"/admin/ui-bootstrap", "")
	ui, _ = body["ui"].(map[string]any)
	if fallback, _ := ui["legacy_fallback"].(bool); fallback {
		t.Fatal("runtime setting did not disable Legacy fallback")
	}
	legacyRoutes, _ := body["legacy_route_map"].(map[string]any)
	if len(legacyRoutes) != 0 {
		t.Fatalf("legacy route map must be empty when fallback is disabled: %#v", legacyRoutes)
	}
	allowed, _ := body["allowed_features"].([]any)
	wantAllowed := []string{"overview", "gateway.health", "gateway.providers", "gateway.models", "observability.requests", "observability.traces", "system.health"}
	if len(allowed) != len(wantAllowed) {
		t.Fatalf("implemented previews allowed without Legacy fallback = %#v, want %v", allowed, wantAllowed)
	}
	for i, want := range wantAllowed {
		if allowed[i] != want {
			t.Fatalf("implemented previews allowed without Legacy fallback = %#v, want %v", allowed, wantAllowed)
		}
	}
}

func TestAppUIBootstrapResponsesAreNeverCached(t *testing.T) {
	t.Run("method not allowed", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		server := &Server{}
		server.handleAdminUIBootstrap(recorder, httptest.NewRequest(http.MethodPost, "/admin/ui-bootstrap", nil))
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("status = %d, want %d", recorder.Code, http.StatusMethodNotAllowed)
		}
		if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
			t.Fatalf("Cache-Control = %q, want no-store", got)
		}
	})

	t.Run("unauthorized", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		server := &Server{cfg: config.Config{Auth: config.AuthConfig{AdminToken: "admin-secret"}}}
		request := httptest.NewRequest(http.MethodGet, "/admin/ui-bootstrap", nil)
		request.Header.Set("Authorization", "Bearer invalid-secret")
		server.handleAdminUIBootstrap(recorder, request)
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want %d", recorder.Code, http.StatusUnauthorized)
		}
		if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
			t.Fatalf("Cache-Control = %q, want no-store", got)
		}
	})

	t.Run("settings load failure", func(t *testing.T) {
		db := openTestStore(t)
		if err := db.Close(); err != nil {
			t.Fatal(err)
		}
		recorder := httptest.NewRecorder()
		server := &Server{db: db}
		server.handleAdminUIBootstrap(recorder, httptest.NewRequest(http.MethodGet, "/admin/ui-bootstrap", nil))
		if recorder.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want %d", recorder.Code, http.StatusInternalServerError)
		}
		if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
			t.Fatalf("Cache-Control = %q, want no-store", got)
		}
	})
}

func TestAppUIRoutesRemainIsolatedWhenDisabled(t *testing.T) {
	t.Setenv("UI_APP_ENABLED", "false")
	ts, _ := settingsServer(t)
	client := &http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}}

	redirect, err := client.Get(ts.URL + "/app?from=test")
	if err != nil {
		t.Fatal(err)
	}
	redirect.Body.Close()
	if redirect.StatusCode != http.StatusPermanentRedirect || redirect.Header.Get("Location") != "/app/" {
		t.Fatalf("/app redirect = %d %q", redirect.StatusCode, redirect.Header.Get("Location"))
	}

	page, err := http.Get(ts.URL + "/app/providers")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(page.Body)
	page.Body.Close()
	if page.StatusCode != http.StatusOK || !strings.Contains(string(data), "/admin") {
		t.Fatalf("disabled page = %d, legacy link=%v", page.StatusCode, strings.Contains(string(data), "/admin"))
	}
	if csp := page.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "script-src 'self'") || strings.Contains(csp, "unsafe-eval") {
		t.Fatalf("unexpected /app CSP %q", csp)
	}

	asset, err := http.Get(ts.URL + "/app/assets/missing.js")
	if err != nil {
		t.Fatal(err)
	}
	asset.Body.Close()
	if asset.StatusCode != http.StatusNotFound {
		t.Fatalf("missing asset status = %d", asset.StatusCode)
	}

	admin, err := http.Get(ts.URL + "/admin")
	if err != nil {
		t.Fatal(err)
	}
	admin.Body.Close()
	if admin.StatusCode != http.StatusOK {
		t.Fatalf("legacy admin status after /app requests = %d", admin.StatusCode)
	}
}

func TestAppUIRejectsUnsafePathsBeforeServeMuxCanonicalization(t *testing.T) {
	t.Setenv("UI_APP_ENABLED", "true")
	ts, _ := settingsServer(t)
	client := &http.Client{CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}}

	for _, target := range []string{
		"/app/../admin",
		"/app/%2e%2e/admin",
		"/app//overview",
		"/app/assets%2Fmissing.js",
	} {
		t.Run(target, func(t *testing.T) {
			resp, err := client.Get(ts.URL + target)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != http.StatusNotFound {
				t.Fatalf("unsafe app path status = %d, want %d", resp.StatusCode, http.StatusNotFound)
			}
			if location := resp.Header.Get("Location"); location != "" {
				t.Fatalf("unsafe app path redirected to %q", location)
			}
			if csp := resp.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "script-src 'self'") {
				t.Fatalf("unsafe app path missing app CSP: %q", csp)
			}
		})
	}

	req, err := http.NewRequest(http.MethodPost, ts.URL+"/app/../admin", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("unsafe app POST status = %d, want %d", resp.StatusCode, http.StatusMethodNotAllowed)
	}
	if allow := resp.Header.Get("Allow"); allow != "GET, HEAD" {
		t.Fatalf("unsafe app POST Allow = %q", allow)
	}
}

func TestSafeAuthReturnTo(t *testing.T) {
	tests := []struct {
		input string
		want  string
		ok    bool
	}{
		{"", "/admin", true},
		{"/admin", "/admin", true},
		{"/app", "/app/", true},
		{"/app/", "/app/", true},
		{"/app/providers/", "/app/providers/", true},
		{"/app/routing/decisions/123?window=1h", "/app/routing/decisions/123?window=1h", true},
		{"https://evil.example/app/", "", false},
		{"//evil.example/app/", "", false},
		{"/app/../admin", "", false},
		{"/app/%2e%2e/admin", "", false},
		{"/app\\evil", "", false},
		{"/admin#/settings", "", false},
	}
	for _, tc := range tests {
		t.Run(tc.input, func(t *testing.T) {
			got, ok := safeAuthReturnTo(tc.input)
			if got != tc.want || ok != tc.ok {
				t.Fatalf("safeAuthReturnTo(%q) = (%q,%v), want (%q,%v)", tc.input, got, ok, tc.want, tc.ok)
			}
		})
	}
}

func TestValidateAppUIPathRejectsTraversalExternalAndUnregisteredTargets(t *testing.T) {
	for _, value := range []string{"/app/overview", "/app/gateway/providers", "/app/system/settings"} {
		if err := validateAppUIPath(value); err != nil {
			t.Errorf("validateAppUIPath(%q): %v", value, err)
		}
	}
	for _, value := range []string{
		"/app", "/app/", "/app/not-registered", "/app/settings/ui.app.enabled",
		"https://evil.example/app/", "//evil.example/app/", "/admin", "/app/../admin",
		"/app/%2e%2e/admin", "/app//overview", "/app/overview?next=/admin", "/app/overview#fragment",
	} {
		if err := validateAppUIPath(value); err == nil {
			t.Errorf("validateAppUIPath(%q) unexpectedly succeeded", value)
		}
	}
}

func TestRequestIDValidation(t *testing.T) {
	for _, value := range []string{"trace_123", "client.request-1", "abc:123"} {
		if !validRequestID(value) {
			t.Fatalf("expected request id %q to be valid", value)
		}
	}
	for _, value := range []string{"", "contains space", "line\nbreak", strings.Repeat("x", 129)} {
		if validRequestID(value) {
			t.Fatalf("expected request id %q to be invalid", value)
		}
	}
}

func TestAppUIMigrationRegistryContract(t *testing.T) {
	seenIDs := map[string]bool{}
	seenPaths := map[string]bool{}
	for _, feature := range appUIFeatures {
		if feature.FeatureID == "" || seenIDs[feature.FeatureID] {
			t.Fatalf("feature id must be non-empty and unique: %q", feature.FeatureID)
		}
		seenIDs[feature.FeatureID] = true
		if err := validateAppUIPath(feature.AppPath); err != nil || seenPaths[feature.AppPath] {
			t.Fatalf("feature %q has invalid or duplicate app path %q: %v", feature.FeatureID, feature.AppPath, err)
		}
		seenPaths[feature.AppPath] = true
		if !strings.HasPrefix(feature.LegacyPath, "/admin#/") {
			t.Fatalf("feature %q has unsafe legacy path %q", feature.FeatureID, feature.LegacyPath)
		}
		if err := validateAppUIStatus(feature.Status); err != nil {
			t.Fatalf("feature %q has invalid status %q: %v", feature.FeatureID, feature.Status, err)
		}
		if feature.RolloutPercent < 0 || feature.RolloutPercent > 100 {
			t.Fatalf("feature %q has invalid rollout %d", feature.FeatureID, feature.RolloutPercent)
		}
	}

	wantLegacyPaths := map[string]string{
		"gateway.health":       "/admin#/routing/health",
		"gateway.providers":    "/admin#/settings",
		"gateway.models":       "/admin#/model-contracts",
		"observability.traces": "/admin#/llm",
		"prompts.lab":          "/admin#/prompt-lab",
		"access.users":         "/admin#/users",
		"governance.policies":  "/admin#/safety",
		"finops.overview":      "/admin#/billing",
		"system.health":        "/admin#/ops-home",
	}
	for _, feature := range appUIFeatures {
		if want, ok := wantLegacyPaths[feature.FeatureID]; ok && feature.LegacyPath != want {
			t.Fatalf("feature %q legacy path = %q, want %q", feature.FeatureID, feature.LegacyPath, want)
		}
	}
	for id := range wantLegacyPaths {
		if !seenIDs[id] {
			t.Fatalf("required migration feature %q is missing", id)
		}
	}
	if got, want := len(appUIFeatureSettingDefs()), len(appUIFeatures)*4; got != want {
		t.Fatalf("feature setting definitions = %d, want %d", got, want)
	}
}

func TestGatewayCatalogFeaturesAreSafeReadOnlyPreviewDefaults(t *testing.T) {
	wantRoles := "super_admin,admin,ai_admin"
	for _, id := range []string{"gateway.providers", "gateway.models"} {
		var feature *appUIFeature
		for i := range appUIFeatures {
			if appUIFeatures[i].FeatureID == id {
				feature = &appUIFeatures[i]
				break
			}
		}
		if feature == nil {
			t.Fatalf("gateway catalog feature %q is not registered", id)
		}
		if feature.Status != "preview_read_only" || !feature.ReadOnly || feature.RequiredPermission != "admin:read" {
			t.Errorf("feature %q safety contract is incomplete: %+v", id, *feature)
		}
		if got := strings.Join(feature.EnabledRoles, ","); got != wantRoles {
			t.Errorf("feature %q enabled roles = %q, want %q", id, got, wantRoles)
		}
		if feature.RolloutPercent != 100 || !feature.FallbackEnabled || feature.MinimumAPIVersion != "v0.82.0" {
			t.Errorf("feature %q rollout contract is incomplete: %+v", id, *feature)
		}
		if _, implemented := appUIImplementedFeatureIDs[id]; !implemented {
			t.Errorf("feature %q must be implemented", id)
		}
	}
}

func TestRequestExplorerIsAdminReadOnlyPreview(t *testing.T) {
	wantRoles := "super_admin,admin,ops_admin,ai_admin,security_admin,billing_admin,readonly_admin"
	for i := range appUIFeatures {
		feature := appUIFeatures[i]
		if feature.FeatureID != "observability.requests" {
			continue
		}
		if feature.Status != "preview_read_only" || !feature.ReadOnly || feature.RequiredPermission != "admin:read" {
			t.Fatalf("request explorer permission contract widened: %+v", feature)
		}
		if got := strings.Join(feature.EnabledRoles, ","); got != wantRoles {
			t.Fatalf("request explorer roles = %q, want %q", got, wantRoles)
		}
		if feature.MinimumAPIVersion != "v0.82.1" || feature.RolloutPercent != 100 || !feature.FallbackEnabled {
			t.Fatalf("request explorer rollout contract is incomplete: %+v", feature)
		}
		if _, ok := appUIImplementedFeatureIDs[feature.FeatureID]; !ok {
			t.Fatal("request explorer must be marked implemented")
		}
		return
	}
	t.Fatal("request explorer feature is missing")
}

func TestTraceExplorerIsAdminReadOnlyPreview(t *testing.T) {
	wantRoles := "super_admin,admin,ops_admin,ai_admin,security_admin,billing_admin,readonly_admin"
	for i := range appUIFeatures {
		feature := appUIFeatures[i]
		if feature.FeatureID != "observability.traces" {
			continue
		}
		if feature.Status != "preview_read_only" || !feature.ReadOnly || feature.RequiredPermission != "admin:read" {
			t.Fatalf("trace explorer permission contract widened: %+v", feature)
		}
		if got := strings.Join(feature.EnabledRoles, ","); got != wantRoles {
			t.Fatalf("trace explorer roles = %q, want %q", got, wantRoles)
		}
		if feature.MinimumAPIVersion != "v0.83.0" || feature.RolloutPercent != 100 || !feature.FallbackEnabled {
			t.Fatalf("trace explorer rollout contract is incomplete: %+v", feature)
		}
		if _, ok := appUIImplementedFeatureIDs[feature.FeatureID]; !ok {
			t.Fatal("trace explorer must be marked implemented")
		}
		return
	}
	t.Fatal("trace explorer feature is missing")
}

func TestOverviewMigrationContractRemainsConservative(t *testing.T) {
	var overview *appUIFeature
	for i := range appUIFeatures {
		if appUIFeatures[i].FeatureID == "overview" {
			overview = &appUIFeatures[i]
			break
		}
	}
	if overview == nil {
		t.Fatal("overview migration feature is not registered")
	}
	if overview.Status != "preview_read_only" || !overview.ReadOnly || overview.RequiredPermission != "admin:read" {
		t.Fatalf("overview safety contract changed: %+v", *overview)
	}
	if got, want := strings.Join(overview.EnabledRoles, ","), "super_admin,admin,ops_admin,ai_admin,security_admin,billing_admin,readonly_admin,viewer"; got != want {
		t.Fatalf("overview enabled roles = %q, want authoritative role cohort %q", got, want)
	}
	if overview.MinimumAPIVersion != "v0.80.0" {
		t.Fatalf("overview minimum API version = %q, want foundation API v0.80.0", overview.MinimumAPIVersion)
	}
}

func TestPhaseOneHealthFeaturesAreSafeReadOnlyPreviews(t *testing.T) {
	systemAdminRoles := map[string]bool{
		"super_admin":    true,
		"admin":          true,
		"ops_admin":      true,
		"ai_admin":       true,
		"security_admin": true,
		"billing_admin":  true,
		"readonly_admin": true,
	}
	expectedRoles := map[string]map[string]bool{
		"gateway.health": {"super_admin": true, "admin": true, "ai_admin": true},
		"system.health":  systemAdminRoles,
	}
	expectedPermission := map[string]string{
		"gateway.health": "routing:read",
		"system.health":  "admin:read",
	}
	for _, id := range []string{"gateway.health", "system.health"} {
		var feature *appUIFeature
		for i := range appUIFeatures {
			if appUIFeatures[i].FeatureID == id {
				feature = &appUIFeatures[i]
				break
			}
		}
		if feature == nil {
			t.Fatalf("phase one feature %q is not registered", id)
		}
		if feature.Status != "preview_read_only" || !feature.ReadOnly {
			t.Errorf("feature %q safety = status %q read_only=%v", id, feature.Status, feature.ReadOnly)
		}
		if feature.RequiredPermission != expectedPermission[id] {
			t.Errorf("feature %q permission = %q, want %q", id, feature.RequiredPermission, expectedPermission[id])
		}
		if feature.RolloutPercent != 100 || !feature.FallbackEnabled || feature.MinimumAPIVersion != "v0.81.0" {
			t.Errorf("feature %q rollout contract is unsafe or incomplete: %+v", id, *feature)
		}
		if _, implemented := appUIImplementedFeatureIDs[id]; !implemented {
			t.Errorf("feature %q is not marked as implemented", id)
		}
		gotRoles := map[string]bool{}
		for _, role := range feature.EnabledRoles {
			gotRoles[role] = true
		}
		if len(gotRoles) != len(expectedRoles[id]) {
			t.Errorf("feature %q enabled roles = %v, want roles %v", id, feature.EnabledRoles, expectedRoles[id])
		}
		for role := range expectedRoles[id] {
			if !gotRoles[role] {
				t.Errorf("feature %q missing preview role %q", id, role)
			}
		}
		for _, role := range []string{"viewer", "team_admin", "developer"} {
			if gotRoles[role] {
				t.Errorf("feature %q must not preview for non-operator role %q", id, role)
			}
		}
	}
}

func TestPreviewRolloutMissFallsBackToAuthorizedLegacyRoute(t *testing.T) {
	server := &Server{}
	server.appUIRuntime.Store(&appUIRuntimeConfig{LegacyFallback: true})
	feature := appUIFeature{
		FeatureID: "preview.test", AppPath: "/app/preview", LegacyPath: "/admin#/preview",
		Status: "preview", RequiredPermission: "admin:read", EnabledRoles: []string{"admin"},
		RolloutPercent: 100, FallbackEnabled: true,
	}
	original := appUIFeatures
	appUIFeatures = []appUIFeature{feature}
	t.Cleanup(func() { appUIFeatures = original })
	features := effectiveAppUIFeatures(map[string]store.AdminSetting{}, server, "viewer-1", "viewer", []string{"admin:read"}, true)
	if len(features) != 1 || !features[0].Available || features[0].Status != "legacy" || features[0].LegacyPath == "" || features[0].AvailabilityReason != "legacy_fallback" {
		t.Fatalf("preview miss did not become legacy fallback: %+v", features)
	}
}

func TestRetiredAppUIFeatureRemainsAppOnly(t *testing.T) {
	feature := appUIFeature{
		FeatureID: "retired.test", AppPath: "/app/retired", LegacyPath: "/admin#/retired",
		Status: "retired", RequiredPermission: "admin:read", RolloutPercent: 100, FallbackEnabled: true,
	}
	available, reason := appUIFeatureAvailable(feature, "admin-1", "admin", []string{"admin:read"}, true)
	if !available || reason != "" {
		t.Fatalf("retired app feature availability = (%v, %q), want (true, empty)", available, reason)
	}

	server := &Server{}
	server.appUIRuntime.Store(&appUIRuntimeConfig{LegacyFallback: true})
	original := appUIFeatures
	originalImplemented := appUIImplementedFeatureIDs
	appUIFeatures = []appUIFeature{feature}
	appUIImplementedFeatureIDs = map[string]struct{}{feature.FeatureID: {}}
	t.Cleanup(func() {
		appUIFeatures = original
		appUIImplementedFeatureIDs = originalImplemented
	})
	features := effectiveAppUIFeatures(map[string]store.AdminSetting{}, server, "admin-1", "admin", []string{"admin:read"}, true)
	if len(features) != 1 || !features[0].Available || features[0].Status != "retired" || features[0].AvailabilityReason != "" {
		t.Fatalf("retired feature must remain available without Legacy fallback: %+v", features)
	}

	unimplemented := feature
	unimplemented.FeatureID = "future.retired"
	unimplemented.AppPath = "/app/future-retired"
	appUIFeatures = []appUIFeature{unimplemented}
	features = effectiveAppUIFeatures(map[string]store.AdminSetting{}, server, "admin-1", "admin", []string{"admin:read"}, true)
	if len(features) != 1 || features[0].Available || features[0].Status != "retired" || features[0].AvailabilityReason != "ui_not_implemented" {
		t.Fatalf("unimplemented retired feature must fail closed without Legacy fallback: %+v", features)
	}

	feature.Status = "hidden"
	available, reason = appUIFeatureAvailable(feature, "admin-1", "admin", []string{"admin:read"}, true)
	if available || reason != "feature_hidden" {
		t.Fatalf("hidden feature availability = (%v, %q), want (false, feature_hidden)", available, reason)
	}
}

func TestUnimplementedAppUIRuntimePromotionIsClampedToBuildCapability(t *testing.T) {
	server := &Server{}
	server.appUIRuntime.Store(&appUIRuntimeConfig{LegacyFallback: true})
	feature := appUIFeature{
		FeatureID: "future.test", AppPath: "/app/future", LegacyPath: "/admin#/future",
		RequiredPermission: "admin:read", RolloutPercent: 100, FallbackEnabled: true,
	}
	original := appUIFeatures
	t.Cleanup(func() { appUIFeatures = original })

	for _, status := range []string{"preview", "stable"} {
		feature.Status = status
		appUIFeatures = []appUIFeature{feature}
		features := effectiveAppUIFeatures(map[string]store.AdminSetting{}, server, "admin-1", "admin", []string{"admin:read"}, true)
		if len(features) != 1 || !features[0].Available || features[0].Status != "legacy" || features[0].AvailabilityReason != "ui_not_implemented" {
			t.Fatalf("unimplemented %s promotion was not clamped to Legacy: %+v", status, features)
		}
	}

	feature.Status = "retired"
	appUIFeatures = []appUIFeature{feature}
	features := effectiveAppUIFeatures(map[string]store.AdminSetting{}, server, "admin-1", "admin", []string{"admin:read"}, true)
	if len(features) != 1 || features[0].Available || features[0].Status != "retired" || features[0].AvailabilityReason != "ui_not_implemented" {
		t.Fatalf("unimplemented Retired promotion must fail closed: %+v", features)
	}

	server.appUIRuntime.Store(&appUIRuntimeConfig{LegacyFallback: false})
	feature.Status = "stable"
	appUIFeatures = []appUIFeature{feature}
	features = effectiveAppUIFeatures(map[string]store.AdminSetting{}, server, "admin-1", "admin", []string{"admin:read"}, true)
	if len(features) != 1 || features[0].Available || features[0].AvailabilityReason != "ui_not_implemented" {
		t.Fatalf("unimplemented Stable promotion must be unavailable without Legacy fallback: %+v", features)
	}
}

func TestLegacyFallbackGateAppliesToImplementedFeatures(t *testing.T) {
	server := &Server{}
	server.appUIRuntime.Store(&appUIRuntimeConfig{LegacyFallback: false})
	feature := appUIFeature{
		FeatureID: "implemented.test", AppPath: "/app/implemented", LegacyPath: "/admin#/implemented",
		Status: "legacy", RequiredPermission: "admin:read", RolloutPercent: 100, FallbackEnabled: true,
	}
	original := appUIFeatures
	originalImplemented := appUIImplementedFeatureIDs
	appUIFeatures = []appUIFeature{feature}
	appUIImplementedFeatureIDs = map[string]struct{}{feature.FeatureID: {}}
	t.Cleanup(func() {
		appUIFeatures = original
		appUIImplementedFeatureIDs = originalImplemented
	})

	features := effectiveAppUIFeatures(map[string]store.AdminSetting{}, server, "admin-1", "admin", []string{"admin:read"}, true)
	if len(features) != 1 || features[0].Available || features[0].AvailabilityReason != "legacy_fallback_disabled" {
		t.Fatalf("implemented Legacy feature bypassed the global fallback gate: %+v", features)
	}
}
