package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

const telemetryVisitID = "0123456789abcdef0123456789abcdef"

func newAppUITelemetryTestServer(t *testing.T) *Server {
	t.Helper()
	t.Setenv("UI_APP_ENABLED", "false")
	t.Setenv("UI_APP_TELEMETRY_ENABLED", "false")
	t.Setenv("UI_APP_LEGACY_FALLBACK", "true")
	s := &Server{db: openTestStore(t), cfg: testConfig("http://upstream.invalid", ""), appUITelemetryGate: &appUITelemetryLimiter{}, appUITelemetryCallerQuota: &appUITelemetryCallerQuota{}}
	s.cfg.Auth.JWTSecret = "telemetry-test-jwt-signing-key"
	for _, key := range []string{appUIEnabledKey, appUITelemetryEnabledKey} {
		setAppUITelemetryTestSetting(t, s, key, "true")
	}
	return s
}

func setAppUITelemetryTestSetting(t *testing.T, s *Server, key, value string) {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.db.UpsertAdminSetting(t.Context(), store.AdminSetting{Key: key, Category: "ui.app", ValueJSON: string(encoded), ValueType: "string"}, "test", "test"); err != nil {
		t.Fatal(err)
	}
}

func appUITelemetryRequest(t *testing.T, s *Server, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("User-Agent", "private-agent-do-not-record")
	r.Header.Set("Referer", "https://example.invalid/private-prompt")
	r.Header.Set("X-Vibe-Route", "untrusted-private-route")
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	s.Routes().ServeHTTP(w, r)
	if w.Header().Get("Cache-Control") != "no-store" || !validRequestID(w.Header().Get("X-Request-ID")) {
		t.Fatalf("missing privacy/diagnostic headers: %v", w.Header())
	}
	return w
}

func appUITelemetryPayload(feature, event string) string {
	return fmt.Sprintf(`{"feature_id":%q,"visit_id":%q,"event":%q}`, feature, telemetryVisitID, event)
}

func telemetryStoredCount(t *testing.T, s *Server) int64 {
	t.Helper()
	rows, err := s.db.AppUITelemetrySummary(t.Context(), time.Now().Add(-24*time.Hour), time.Now().Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	var total int64
	for _, row := range rows {
		total += row.Visits
	}
	return total
}

func TestAppUITelemetryAcceptsReadOnlyAndScopedVisitorsWithoutAuthAudits(t *testing.T) {
	for _, role := range []string{"open", "legacy_readonly", "viewer", "readonly_admin", "developer"} {
		t.Run(role, func(t *testing.T) {
			s := newAppUITelemetryTestServer(t)
			token, feature := "", "overview"
			if role == "legacy_readonly" {
				s.cfg.Auth.AdminReadonlyToken = "readonly-secret"
				token = s.cfg.Auth.AdminReadonlyToken
			} else if role != "open" {
				s.cfg.Auth.Enabled = true
				token = issueLLMScopedTestToken(t, s.db, s, "private-user", role, "private-team", scopesForRole(role), time.Now())
				if role == "developer" {
					feature = "me.home"
				}
			}
			// Legacy-before-visit and replay remain one observation, not >100%.
			for _, event := range []string{"legacy_fallback", "visit", "legacy_fallback", "visit"} {
				w := appUITelemetryRequest(t, s, http.MethodPost, "/admin/ui-telemetry/events", token, appUITelemetryPayload(feature, event))
				if w.Code != http.StatusNoContent || w.Body.Len() != 0 {
					t.Fatalf("%s: status=%d body=%s", event, w.Code, w.Body.String())
				}
			}
			counts, err := s.db.AppUITelemetrySummary(t.Context(), time.Now().Add(-time.Hour), time.Now().Add(time.Second))
			if err != nil || len(counts) != 1 || counts[0].Visits != 1 || counts[0].LegacyOpens != 1 || counts[0].FeatureID != feature {
				t.Fatalf("deduplicated counts=%+v err=%v", counts, err)
			}
			authEvents, err := s.db.ListAuditEvents(t.Context(), 100)
			if err != nil || len(authEvents) != 0 {
				t.Fatalf("telemetry must not create identity-bearing auth events: %+v err=%v", authEvents, err)
			}
			adminEvents, err := s.db.ListAdminAudit(t.Context(), 100)
			if err != nil || len(adminEvents) != 0 {
				t.Fatalf("telemetry must not create admin audit events: %+v err=%v", adminEvents, err)
			}
		})
	}
}

func TestAppUITelemetryRejectsInvalidExpiredRevokedAndMissingTokens(t *testing.T) {
	for _, kind := range []string{"missing", "invalid", "expired", "revoked"} {
		t.Run(kind, func(t *testing.T) {
			s := newAppUITelemetryTestServer(t)
			s.cfg.Auth.Enabled = true
			token := "private-bad-token"
			if kind == "missing" {
				token = ""
			} else if kind == "expired" || kind == "revoked" {
				now := time.Now()
				if kind == "expired" {
					now = now.Add(-2 * time.Hour)
				}
				token = issueLLMScopedTestToken(t, s.db, s, "private-user", "viewer", "private-team", scopesForRole("viewer"), now)
				if kind == "revoked" {
					if err := s.db.RevokeAuthSession(t.Context(), "private-user-session"); err != nil {
						t.Fatal(err)
					}
				}
			}
			w := appUITelemetryRequest(t, s, http.MethodPost, "/admin/ui-telemetry/events", token, appUITelemetryPayload("overview", "visit"))
			if w.Code != http.StatusUnauthorized || telemetryStoredCount(t, s) != 0 || strings.Contains(w.Body.String(), "private") {
				t.Fatalf("unauthorized intake: status=%d body=%s", w.Code, w.Body.String())
			}
			events, err := s.db.ListAuditEvents(t.Context(), 100)
			if err != nil || len(events) != 0 {
				t.Fatalf("failed telemetry generated auth audit: %+v err=%v", events, err)
			}
		})
	}
}

func TestAppUITelemetryFreshDBOptOutAndFailClosed(t *testing.T) {
	for _, key := range []string{appUIEnabledKey, appUITelemetryEnabledKey} {
		t.Run(key, func(t *testing.T) {
			s := newAppUITelemetryTestServer(t)
			s.cfg.Auth.Enabled = true
			s.appUIRuntime.Store(&appUIRuntimeConfig{Enabled: true, TelemetryEnabled: true, LegacyFallback: true})
			for _, value := range []string{"false", "not-a-boolean"} {
				setAppUITelemetryTestSetting(t, s, key, value)
				w := appUITelemetryRequest(t, s, http.MethodPost, "/admin/ui-telemetry/events", "private-invalid-token", `{"private":"payload"}`)
				if w.Code != http.StatusNoContent || telemetryStoredCount(t, s) != 0 {
					t.Fatalf("stale runtime must not bypass DB opt-out: %d %s", w.Code, w.Body.String())
				}
			}
			events, err := s.db.ListAuditEvents(t.Context(), 100)
			if err != nil || len(events) != 0 {
				t.Fatalf("opt-out authenticated request: %+v err=%v", events, err)
			}
			if err := s.db.Close(); err != nil {
				t.Fatal(err)
			}
			w := appUITelemetryRequest(t, s, http.MethodPost, "/admin/ui-telemetry/events", "private-invalid-token", "broken-json")
			if w.Code != http.StatusNoContent {
				t.Fatalf("settings failure must fail closed without identifying errors: %d %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestAppUITelemetryStrictPayload(t *testing.T) {
	s := newAppUITelemetryTestServer(t)
	valid := appUITelemetryPayload("overview", "visit")
	invalid := []string{
		"", "null", "[]", `{}`, valid + `{}`, valid + `private`,
		strings.Replace(valid, `"feature_id"`, `"Feature_ID"`, 1),
		strings.Replace(valid, `"event":"visit"`, `"event":"visit","event":"visit"`, 1),
		strings.Replace(valid, `"event":"visit"`, `"event":"visit","prompt":"private-prompt"`, 1),
		strings.Replace(valid, `"event":"visit"`, `"event":"visit","timestamp":1`, 1),
		strings.Replace(valid, `"event":"visit"`, `"event":null`, 1),
		strings.Replace(valid, `"event":"visit"`, `"event":[]`, 1),
		strings.Replace(valid, telemetryVisitID, strings.ToUpper(telemetryVisitID), 1),
		strings.Replace(valid, telemetryVisitID, telemetryVisitID+"a", 1),
		strings.Replace(valid, telemetryVisitID, "private-user", 1),
		appUITelemetryPayload("private-feature", "visit"), appUITelemetryPayload("overview", "private-event"),
		valid + strings.Repeat(" ", appUITelemetryBodyLimit),
	}
	for i, body := range invalid {
		w := appUITelemetryRequest(t, s, http.MethodPost, "/admin/ui-telemetry/events", "", body)
		if w.Code != http.StatusBadRequest || strings.Contains(w.Body.String(), "private") {
			t.Errorf("payload %d returned %d %s", i, w.Code, w.Body.String())
		}
	}
	if telemetryStoredCount(t, s) != 0 {
		t.Fatal("invalid event persisted")
	}
}

func TestAppUITelemetryRBACRolloutAndFallbackUseFreshSettings(t *testing.T) {
	for _, tc := range []struct {
		name, role, feature, setting, value, event string
		status                                     int
	}{
		{"missing permission", "developer", "overview", "", "", "visit", 403},
		{"hidden", "viewer", "overview", "ui.app.feature.overview.status", "hidden", "visit", 403},
		{"retired visit", "viewer", "overview", "ui.app.feature.overview.status", "retired", "visit", 204},
		{"retired legacy", "viewer", "overview", "ui.app.feature.overview.status", "retired", "legacy_fallback", 403},
		{"legacy disabled", "viewer", "overview", appUILegacyFallbackKey, "false", "legacy_fallback", 403},
		{"visit with legacy disabled", "viewer", "overview", appUILegacyFallbackKey, "false", "visit", 204},
		{"outside rollout uses bridge", "viewer", "overview", "ui.app.feature.overview.rollout", "0", "legacy_fallback", 204},
		{"role bridge disabled", "viewer", "gateway.providers", appUILegacyFallbackKey, "false", "visit", 403},
		{"outside rollout bridge disabled", "viewer", "overview", "ui.app.feature.overview.rollout", "0", "visit", 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newAppUITelemetryTestServer(t)
			s.cfg.Auth.Enabled = true
			s.appUIRuntime.Store(&appUIRuntimeConfig{Enabled: true, TelemetryEnabled: true, LegacyFallback: true})
			if tc.setting != "" {
				setAppUITelemetryTestSetting(t, s, tc.setting, tc.value)
			}
			if tc.name == "outside rollout bridge disabled" {
				setAppUITelemetryTestSetting(t, s, appUILegacyFallbackKey, "false")
			}
			token := issueLLMScopedTestToken(t, s.db, s, "private-user", tc.role, "private-team", scopesForRole(tc.role), time.Now())
			w := appUITelemetryRequest(t, s, http.MethodPost, "/admin/ui-telemetry/events", token, appUITelemetryPayload(tc.feature, tc.event))
			if w.Code != tc.status {
				t.Fatalf("status=%d want=%d body=%s", w.Code, tc.status, w.Body.String())
			}
			want := int64(0)
			if tc.status == 204 {
				want = 1
			}
			if got := telemetryStoredCount(t, s); got != want {
				t.Fatalf("visits=%d want=%d", got, want)
			}
		})
	}
}

func TestAppUITelemetryLimiterBoundsRateAndConcurrency(t *testing.T) {
	var limiter appUITelemetryLimiter
	now := time.Now()
	for i := 0; i < 4; i++ {
		if !limiter.acquire(now) {
			t.Fatal("initial concurrency slots unavailable")
		}
	}
	if limiter.acquire(now) {
		t.Fatal("more than four concurrent intake requests")
	}
	for i := 0; i < 4; i++ {
		limiter.release()
	}
	for i := 4; i < 40; i++ {
		if !limiter.acquire(now) {
			t.Fatal("burst allowance lost")
		}
		limiter.release()
	}
	if limiter.acquire(now) || limiter.acquire(now.Add(49*time.Millisecond)) {
		t.Fatal("burst limit exceeded")
	}
	if !limiter.acquire(now.Add(50 * time.Millisecond)) {
		t.Fatal("20/s refill not applied")
	}
	limiter.release()
	s := newAppUITelemetryTestServer(t)
	s.appUITelemetryGate.inFlight = 4
	w := appUITelemetryRequest(t, s, http.MethodPost, "/admin/ui-telemetry/events", "", appUITelemetryPayload("overview", "visit"))
	if w.Code != http.StatusNoContent || telemetryStoredCount(t, s) != 0 {
		t.Fatal("saturated intake must drop without recording or retry")
	}
}

func TestAppUITelemetryRetentionRunsWhileCollectionDisabled(t *testing.T) {
	s := newAppUITelemetryTestServer(t)
	setAppUITelemetryTestSetting(t, s, appUITelemetryEnabledKey, "false")
	setAppUITelemetryTestSetting(t, s, appUIEnabledKey, "false")
	old := time.Now().Add(-31 * 24 * time.Hour)
	if accepted, err := s.db.RecordAppUITelemetry(t.Context(), "overview", telemetryVisitID, false, old); err != nil || !accepted {
		t.Fatalf("seed expired observation: %v %v", accepted, err)
	}
	ctx, cancel := context.WithCancel(s.db.LifecycleContext())
	done := make(chan struct{})
	go func() { s.appUITelemetryRetentionLoop(ctx, 20*time.Millisecond); close(done) }()
	t.Cleanup(cancel)
	deadline := time.After(3 * time.Second)
	for {
		counts, err := s.db.AppUITelemetrySummary(t.Context(), old.Add(-time.Hour), old.Add(time.Hour))
		if err != nil {
			t.Fatal(err)
		}
		if len(counts) == 0 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("startup purge did not remove opted-out expired observations")
		case <-time.After(10 * time.Millisecond):
		}
	}
	// Also prove the periodic tick, not just startup, continues while all UI
	// collection flags and the ordinary retention worker are disabled.
	if accepted, err := s.db.RecordAppUITelemetry(t.Context(), "overview", telemetryVisitID, false, old); err != nil || !accepted {
		t.Fatalf("seed next expired observation: %v %v", accepted, err)
	}
	deadline = time.After(3 * time.Second)
	for {
		counts, err := s.db.AppUITelemetrySummary(t.Context(), old.Add(-time.Hour), old.Add(time.Hour))
		if err != nil {
			t.Fatal(err)
		}
		if len(counts) == 0 {
			break
		}
		select {
		case <-deadline:
			t.Fatal("periodic purge did not remove opted-out expired observations")
		case <-time.After(10 * time.Millisecond):
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("retention loop did not stop with lifecycle")
	}
}
