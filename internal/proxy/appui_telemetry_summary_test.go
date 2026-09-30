package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestAppUITelemetrySummaryIsAggregateOnlyAndKeepsOptOutHistory(t *testing.T) {
	s := newAppUITelemetryTestServer(t)
	// This test owns summary/opt-out/privacy, not intake timing. Seed safely
	// inside the query window: a wall-clock correction between HTTP intake
	// and summary can otherwise place a just-received event in the future.
	// Dedicated HTTP intake and fixed-time store boundary tests remain intact.
	receivedAt := time.Now().UTC().Add(-time.Minute)
	for _, legacyOpen := range []bool{false, true} {
		accepted, err := s.db.RecordAppUITelemetry(t.Context(), "overview", telemetryVisitID, legacyOpen, receivedAt)
		if err != nil || !accepted {
			t.Fatalf("summary fixture was not recorded: accepted=%v err=%v", accepted, err)
		}
	}
	setAppUITelemetryTestSetting(t, s, appUITelemetryEnabledKey, "false")
	w := appUITelemetryRequest(t, s, http.MethodGet, "/admin/ui-telemetry/summary?days=30", "", "")
	if w.Code != http.StatusOK {
		t.Fatal(w.Code, w.Body.String())
	}
	var summary appUITelemetrySummary
	if err := json.Unmarshal(w.Body.Bytes(), &summary); err != nil {
		t.Fatal(err)
	}
	if summary.Enabled || summary.Days != 30 || summary.RetentionDays != 30 || summary.VisitLimit != 100000 || len(summary.Features) != len(appUIFeatures) {
		t.Fatalf("summary metadata=%+v", summary)
	}
	from, errFrom := time.Parse(time.RFC3339, summary.From)
	to, errTo := time.Parse(time.RFC3339, summary.To)
	if errFrom != nil || errTo != nil || to.Sub(from) != 30*24*time.Hour {
		t.Fatalf("summary window=%s..%s", summary.From, summary.To)
	}
	for _, feature := range summary.Features {
		want := int64(0)
		if feature.FeatureID == "overview" {
			want = 1
		}
		if feature.Visits != want || feature.LegacyOpens != want {
			t.Errorf("aggregate or explicit zero count=%+v", feature)
		}
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil || len(raw) != 7 {
		t.Fatalf("unexpected summary fields=%v err=%v", raw, err)
	}
	var features []map[string]json.RawMessage
	if err := json.Unmarshal(raw["features"], &features); err != nil {
		t.Fatal(err)
	}
	for _, feature := range features {
		if len(feature) != 3 || feature["feature_id"] == nil || feature["visits"] == nil || feature["legacy_opens"] == nil {
			t.Fatalf("row crosses privacy allowlist: %v", feature)
		}
	}
	for _, forbidden := range []string{telemetryVisitID, "visit_hash", "private", "user_id", "user_agent", "ip", "prompt", "request_id"} {
		// Registry IDs may legitimately contain "prompts"; inspect raw field names
		// rather than banning the names of public console features.
		if strings.Contains(w.Body.String(), `"`+forbidden+`"`) || strings.Contains(w.Body.String(), telemetryVisitID) {
			t.Errorf("private telemetry field or visit ID exposed: %s", forbidden)
		}
	}
}

func TestAppUITelemetrySummaryPermissionsAndWindows(t *testing.T) {
	s := newAppUITelemetryTestServer(t)
	s.cfg.Auth.Enabled = true
	viewer := issueLLMScopedTestToken(t, s.db, s, "viewer-user", "viewer", "private-team", scopesForRole("viewer"), time.Now())
	developer := issueLLMScopedTestToken(t, s.db, s, "developer-user", "developer", "private-team", scopesForRole("developer"), time.Now())
	setAppUITelemetryTestSetting(t, s, appUILegacyFallbackKey, "false")
	setAppUITelemetryTestSetting(t, s, "ui.app.feature.system.settings.status", "hidden")
	for _, token := range []string{"", "invalid-private-token", developer} {
		w := appUITelemetryRequest(t, s, http.MethodGet, "/admin/ui-telemetry/summary", token, "")
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("summary without admin read: %d %s", w.Code, w.Body.String())
		}
	}
	w := appUITelemetryRequest(t, s, http.MethodGet, "/admin/ui-telemetry/summary", viewer, "")
	if w.Code != http.StatusOK {
		t.Fatal(w.Code, w.Body.String())
	}
	var summary appUITelemetrySummary
	if err := json.Unmarshal(w.Body.Bytes(), &summary); err != nil {
		t.Fatal(err)
	}
	if summary.Days != 7 {
		t.Fatal("default window must be seven days")
	}
	stored, err := s.loadStoredSettings(appUITelemetrySettingsRequest(t))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{}
	for _, feature := range effectiveAppUIFeaturesWithFallback(stored, s, "viewer-user", "viewer", scopesForRole("viewer"), true, false) {
		if feature.Available {
			want[feature.FeatureID] = true
		}
	}
	if len(summary.Features) != len(want) {
		t.Fatalf("summary does not match accessible registry: %+v want=%v", summary.Features, want)
	}
	for _, feature := range summary.Features {
		if !want[feature.FeatureID] || feature.FeatureID == "system.settings" || feature.FeatureID == "gateway.providers" {
			t.Fatalf("inaccessible feature leaked into summary: %+v", feature)
		}
	}
	for _, query := range []string{"days=0", "days=31", "days=7&days=30", "days=", "user_id=private", "days=7&feature=private", "days=%zz"} {
		w := appUITelemetryRequest(t, s, http.MethodGet, "/admin/ui-telemetry/summary?"+query, viewer, "")
		if w.Code != http.StatusBadRequest || strings.Contains(w.Body.String(), "private") {
			t.Fatalf("invalid summary window %q: %d %s", query, w.Code, w.Body.String())
		}
	}
}

func appUITelemetrySettingsRequest(t *testing.T) *http.Request {
	t.Helper()
	r, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "/", nil)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestAppUITelemetryMethodsAndDefaultOff(t *testing.T) {
	for _, tc := range []struct{ path, method, allow string }{
		{"/admin/ui-telemetry/events", http.MethodGet, "POST"},
		{"/admin/ui-telemetry/events", http.MethodPut, "POST"},
		{"/admin/ui-telemetry/summary", http.MethodPost, "GET"},
		{"/admin/ui-telemetry/summary", http.MethodHead, "GET"},
	} {
		s := newAppUITelemetryTestServer(t)
		w := appUITelemetryRequest(t, s, tc.method, tc.path, "", "")
		if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != tc.allow {
			t.Errorf("method gate %s %s: status=%d allow=%q", tc.method, tc.path, w.Code, w.Header().Get("Allow"))
		}
	}
	s := newAppUITelemetryTestServer(t)
	for _, key := range []string{appUIEnabledKey, appUITelemetryEnabledKey} {
		if s.appUITelemetryFlag(nil, key) {
			t.Errorf("default %s must not opt in", key)
		}
	}
}

func TestAppUITelemetryOpenAPIContract(t *testing.T) {
	spec := buildOpenAPISpec()
	paths := spec["paths"].(map[string]any)
	event := paths["/admin/ui-telemetry/events"].(map[string]any)["post"].(map[string]any)
	summary := paths["/admin/ui-telemetry/summary"].(map[string]any)["get"].(map[string]any)
	if event["requestBody"] == nil || summary["security"] == nil {
		t.Fatal("event request or summary authentication missing")
	}
	responses := event["responses"].(map[string]any)
	if responses["204"] == nil || responses["200"] != nil || responses["403"] == nil || responses["503"] == nil {
		t.Fatalf("intake response contract=%v", responses)
	}
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	for _, name := range []string{"UITelemetryEventRequest", "UITelemetrySummaryResponse", "UITelemetryFeatureCount"} {
		schema, ok := schemas[name].(map[string]any)
		if !ok || schema["additionalProperties"] != false {
			t.Fatalf("missing closed privacy schema %s", name)
		}
	}
	eventSchema := schemas["UITelemetryEventRequest"].(map[string]any)
	props := eventSchema["properties"].(map[string]any)
	if len(props) != 3 || len(eventSchema["required"].([]string)) != 3 {
		t.Fatal("event must have exactly three required fields")
	}
	ids := props["feature_id"].(map[string]any)["enum"].([]string)
	if len(ids) != len(appUIFeatures) {
		t.Fatal("feature enum does not cover registry")
	}
	for i, feature := range appUIFeatures {
		if ids[i] != feature.FeatureID {
			t.Fatalf("feature enum[%d]=%q want=%q", i, ids[i], feature.FeatureID)
		}
	}
	if props["visit_id"].(map[string]any)["pattern"] != "^[0-9a-f]{32}$" {
		t.Fatal("random nonce format missing")
	}
}
