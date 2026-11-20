package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func diagnosticPayload(id, feature string) string {
	return fmt.Sprintf(`{"event_id":%q,"feature_id":%q,"kind":"api_error","endpoint":"/admin/requests/{id}/io","method":"GET","status":503,"failure":"http","request_id":"trace_0123456789abcdef0123456789abcdef"}`, id, feature)
}

func TestAppUIDiagnosticsHTTPContractAndOptOut(t *testing.T) {
	s := newAppUITelemetryTestServer(t)
	for _, body := range []string{diagnosticPayload(telemetryVisitID, "overview"), `{"event_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","feature_id":"overview","kind":"js_error","boundary":"root","failure":"type"}`} {
		w := appUITelemetryRequest(t, s, http.MethodPost, "/admin/ui-diagnostics/events", "", body)
		if w.Code != 204 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	setAppUITelemetryTestSetting(t, s, appUITelemetryEnabledKey, "false")
	w := appUITelemetryRequest(t, s, http.MethodPost, "/admin/ui-diagnostics/events", "invalid-private-token", `{"private":"secret"}`)
	if w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = appUITelemetryRequest(t, s, http.MethodGet, "/admin/ui-diagnostics/summary?days=30", "", "")
	var result appUIDiagnosticSummary
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Enabled || result.Total != 2 || len(result.Recent) != 2 {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, private := range []string{telemetryVisitID, "private", "event_hash", "user_id", "user_agent", "prompt", "componentStack"} {
		// The allowed request correlation happens to include the nonce fixture.
		if private == telemetryVisitID {
			continue
		}
		if strings.Contains(w.Body.String(), private) {
			t.Fatal("private field", private, w.Body.String())
		}
	}
}

func TestAppUIDiagnosticsRejectPayloadChannels(t *testing.T) {
	good := diagnosticPayload(telemetryVisitID, "overview")
	for _, body := range []string{
		strings.Replace(good, `"status":503`, `"status":null`, 1), strings.Replace(good, `"status":503`, `"status":5e2`, 1),
		strings.Replace(good, `"status":503`, `"Status":503`, 1), strings.Replace(good, `"status":503`, `"status":503,"status":500`, 1),
		strings.Replace(good, `"status":503`, `"status":503,"message":"private"`, 1), strings.Replace(good, "/admin/requests/{id}/io", "/admin/requests/private/io", 1),
		strings.Replace(good, "/admin/requests/{id}/io", "/admin/providers?secret=private", 1), strings.Replace(good, "/admin/requests/{id}/io", "/admin/ui-diagnostics/events", 1),
		strings.Replace(good, telemetryVisitID, "invalid", 1), strings.Replace(good, `"http"`, `"private-error"`, 1),
		`{"event_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","feature_id":"overview","kind":"js_error","boundary":"root","failure":"type","status":0}`,
	} {
		s := newAppUITelemetryTestServer(t)
		w := appUITelemetryRequest(t, s, "POST", "/admin/ui-diagnostics/events", "", body)
		if w.Code != 400 || strings.Contains(w.Body.String(), "private") {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	}
}

func TestAppUIDiagnosticsFreshFeatureAccessAndSummaryScope(t *testing.T) {
	s := newAppUITelemetryTestServer(t)
	s.cfg.Auth.Enabled = true
	viewer := issueLLMScopedTestToken(t, s.db, s, "private-viewer", "viewer", "private-team", scopesForRole("viewer"), time.Now())
	for _, token := range []string{"", "invalid-private-token"} {
		w := appUITelemetryRequest(t, s, "POST", "/admin/ui-diagnostics/events", token, diagnosticPayload(telemetryVisitID, "overview"))
		if w.Code != 401 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	w := appUITelemetryRequest(t, s, "POST", "/admin/ui-diagnostics/events", viewer, diagnosticPayload(telemetryVisitID, "overview"))
	if w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
	setAppUITelemetryTestSetting(t, s, "ui.app.feature.overview.status", "hidden")
	w = appUITelemetryRequest(t, s, "POST", "/admin/ui-diagnostics/events", viewer, diagnosticPayload(telemetryVisitID, "overview"))
	if w.Code != 403 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = appUITelemetryRequest(t, s, "GET", "/admin/ui-diagnostics/summary", viewer, "")
	var summary appUIDiagnosticSummary
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &summary) != nil || summary.Total != 0 || len(summary.Recent) != 0 {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, query := range []string{"days=0", "days=7&days=30", "user_id=private", "days=%zz"} {
		w = appUITelemetryRequest(t, s, "GET", "/admin/ui-diagnostics/summary?"+query, viewer, "")
		if w.Code != 400 {
			t.Fatal(query, w.Code)
		}
	}
}

func TestAppUIDiagnosticsSummaryBlocksOutOfBandPaths(t *testing.T) {
	s := newAppUITelemetryTestServer(t)
	event := store.AppUIDiagnostic{FeatureID: "overview", Kind: "api_error", Endpoint: "/private/customer", Method: "GET", Status: 503, Failure: "http"}
	if ok, err := s.db.RecordAppUIDiagnostic(t.Context(), telemetryVisitID, event, time.Now().Add(-time.Minute)); err != nil || !ok {
		t.Fatal(ok, err)
	}
	w := appUITelemetryRequest(t, s, "GET", "/admin/ui-diagnostics/summary", "", "")
	var summary appUIDiagnosticSummary
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &summary) != nil || len(summary.Groups) != 0 || len(summary.Recent) != 0 || summary.OtherGroupEvents != 1 || strings.Contains(w.Body.String(), "private") {
		t.Fatal(w.Code, w.Body.String())
	}
}
