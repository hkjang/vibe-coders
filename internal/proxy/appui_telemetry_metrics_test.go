package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestAppUITelemetryMetricsStrictDuration(t *testing.T) {
	base := strings.TrimSuffix(appUITelemetryPayload("overview", "page_load"), "}")
	for _, suffix := range []string{"}", `,"load_ms":null}`, `,"load_ms":-1}`, `,"load_ms":120001}`, `,"load_ms":1.5}`, `,"load_ms":"5"}`, `,"load_ms":1e3}`, `,"load_ms":{}}`, `,"load_ms":1,"load_ms":2}`, `,"Load_MS":1}`, `,"load_ms":5,"url":"private"}`} {
		t.Run(suffix, func(t *testing.T) {
			s := newAppUITelemetryTestServer(t)
			w := appUITelemetryRequest(t, s, http.MethodPost, "/admin/ui-telemetry/events", "", base+suffix)
			if w.Code != 400 || telemetryStoredCount(t, s) != 0 || strings.Contains(w.Body.String(), "private") {
				t.Fatalf("invalid duration: %d %s", w.Code, w.Body.String())
			}
		})
	}
	for _, event := range []string{"visit", "legacy_fallback"} {
		s := newAppUITelemetryTestServer(t)
		body := strings.TrimSuffix(appUITelemetryPayload("overview", event), "}") + `,"load_ms":0}`
		if w := appUITelemetryRequest(t, s, http.MethodPost, "/admin/ui-telemetry/events", "", body); w.Code != 400 || telemetryStoredCount(t, s) != 0 {
			t.Fatalf("duration accepted on %s: %d", event, w.Code)
		}
	}
}

func TestAppUITelemetryMetricsHTTPVersionPrivacyAndFirstSample(t *testing.T) {
	for _, version := range []string{"0.86.179", "v0.86.179", "private-user@example.com", "v1.2.3+private-branch", ""} {
		t.Run(version, func(t *testing.T) {
			s := newAppUITelemetryTestServer(t)
			for _, ms := range []string{"0", "120000"} {
				body := strings.TrimSuffix(appUITelemetryPayload("overview", "page_load"), "}") + `,"load_ms":` + ms + `}`
				r := httptest.NewRequest(http.MethodPost, "/admin/ui-telemetry/events", strings.NewReader(body))
				r.Header.Set("X-Vibe-UI-Version", version)
				w := httptest.NewRecorder()
				s.Routes().ServeHTTP(w, r)
				if w.Code != 204 {
					t.Fatalf("intake %d %s", w.Code, w.Body.String())
				}
			}
			if w := appUITelemetryRequest(t, s, http.MethodPost, "/admin/ui-telemetry/events", "", appUITelemetryPayload("overview", "legacy_fallback")); w.Code != 204 {
				t.Fatal(w.Code)
			}
			now := time.Now()
			usage, err := s.db.AppUITelemetryUsageSummary(t.Context(), now.Add(-time.Hour), now.Add(time.Minute), []string{"overview"})
			if err != nil || len(usage.Versions) != 1 || len(usage.Features) != 1 {
				t.Fatalf("summary: %+v %v", usage, err)
			}
			row := usage.Features[0]
			if row.Visits != 1 || row.LegacyOpens != 1 || row.LoadSamples != 1 || row.LoadTotalMS != 0 || row.LoadMaxMS != 0 || usage.Versions[0].UIVersion != store.NormalizeAppUIReleaseVersion(version) {
				t.Fatalf("first sample or version changed: %+v", usage)
			}
			raw, _ := json.Marshal(usage)
			if strings.Contains(string(raw), "private") || strings.Contains(string(raw), telemetryVisitID) {
				t.Fatalf("private data exposed: %s", raw)
			}
			audits, err := s.db.ListAuditEvents(t.Context(), 100)
			if err != nil || len(audits) != 0 {
				t.Fatalf("identity-bearing audit: %+v %v", audits, err)
			}
		})
	}
}

func TestAppUITelemetryMetricsSummaryFiltersVersionsWithFeatureAccess(t *testing.T) {
	s := newAppUITelemetryTestServer(t)
	received := time.Now().Add(-time.Minute)
	ms := int64(120000)
	for i, feature := range []string{"overview", "gateway.providers"} {
		version := "v0.86.179"
		if i == 1 {
			version = "v999.999.999"
		}
		id := strings.Repeat(string(rune('a'+i)), 32)
		if ok, err := s.db.RecordAppUITelemetryMetrics(t.Context(), feature, id, false, store.AppUITelemetryMetrics{UIVersion: version, LoadMS: &ms}, received); err != nil || !ok {
			t.Fatal(ok, err)
		}
	}
	setAppUITelemetryTestSetting(t, s, "ui.app.feature.gateway.providers.status", "hidden")
	w := appUITelemetryRequest(t, s, http.MethodGet, "/admin/ui-telemetry/summary", "", "")
	var result appUITelemetrySummary
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil {
		t.Fatal(w.Code, w.Body.String())
	}
	if !result.LoadMetricsAvailable || result.LoadLimitMS != 120000 || result.VersionLimit != 20 || len(result.Versions) != 1 || result.Versions[0].UIVersion != "v0.86.179" || result.OtherVersionVisits != 0 || strings.Contains(w.Body.String(), "v999") {
		t.Fatalf("scope leak or missing metrics: %s", w.Body.String())
	}
	// New events use the same immediate DB opt-out and effective RBAC as visits.
	body := strings.TrimSuffix(appUITelemetryPayload("gateway.providers", "page_load"), "}") + `,"load_ms":5}`
	if w := appUITelemetryRequest(t, s, http.MethodPost, "/admin/ui-telemetry/events", "", body); w.Code != 403 {
		t.Fatal(w.Code)
	}
	setAppUITelemetryTestSetting(t, s, appUITelemetryEnabledKey, "false")
	if w := appUITelemetryRequest(t, s, http.MethodPost, "/admin/ui-telemetry/events", "", `{"load_ms":"private"}`); w.Code != 204 {
		t.Fatal(w.Code)
	}
}
