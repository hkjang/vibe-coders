package proxy

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func actionPayload(nonce, feature, outcome string) string {
	return fmt.Sprintf(`{"event_id":%q,"feature_id":%q,"action":"save","outcome":%q}`, nonce, feature, outcome)
}

func TestAppUIActionsHTTPContractAndOptOut(t *testing.T) {
	s := newAppUITelemetryTestServer(t)
	for i, outcome := range []string{"success", "rejected", "unknown"} {
		for range 2 {
			w := appUITelemetryRequest(t, s, "POST", "/admin/ui-actions/events", "", actionPayload(fmt.Sprintf("%032x", i), "overview", outcome))
			if w.Code != 204 {
				t.Fatal(w.Code, w.Body.String())
			}
		}
	}
	setAppUITelemetryTestSetting(t, s, appUITelemetryEnabledKey, "false")
	w := appUITelemetryRequest(t, s, "POST", "/admin/ui-actions/events", "invalid-private", `{"private":"secret"}`)
	if w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = appUITelemetryRequest(t, s, "GET", "/admin/ui-actions/summary?days=30", "", "")
	var result appUIActionSummary
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Enabled || result.Success != 1 || result.Rejected != 1 || result.Unknown != 1 || len(result.Groups) != 1 {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, private := range []string{"event_id", "event_hash", "user_id", "private", "prompt", "payload"} {
		if strings.Contains(w.Body.String(), private) {
			t.Fatal("private field", private, w.Body.String())
		}
	}
	for _, path := range []string{"/admin/ui-actions/events", "/admin/ui-actions/summary"} {
		w = appUITelemetryRequest(t, s, "PUT", path, "", "")
		if w.Code != 405 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}

func TestAppUIActionsStrictPayloadAndQueries(t *testing.T) {
	good := actionPayload(telemetryVisitID, "overview", "success")
	for _, body := range []string{
		strings.Replace(good, `"save"`, `null`, 1), strings.Replace(good, `"action"`, `"Action"`, 1), strings.Replace(good, `"save"`, `"private"`, 1),
		strings.Replace(good, `"save"`, `"save","action":"delete"`, 1), strings.Replace(good, `"save"`, `"save","message":"private"`, 1),
		strings.Replace(good, `"success"`, `"private"`, 1), strings.Replace(good, telemetryVisitID, "private", 1), good + `{}`, strings.Repeat(" ", 1024) + good,
	} {
		s := newAppUITelemetryTestServer(t)
		w := appUITelemetryRequest(t, s, "POST", "/admin/ui-actions/events", "", body)
		if w.Code != 400 || strings.Contains(w.Body.String(), "private") {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	s := newAppUITelemetryTestServer(t)
	for _, query := range []string{"days=0", "days=7&days=30", "days=%zz", "user_id=private"} {
		w := appUITelemetryRequest(t, s, "GET", "/admin/ui-actions/summary?"+query, "", "")
		if w.Code != 400 {
			t.Fatal(query, w.Code)
		}
	}
}

func TestAppUIActionsFreshFeaturePermissionAndIdentity(t *testing.T) {
	s := newAppUITelemetryTestServer(t)
	s.cfg.Auth.Enabled = true
	token := issueLLMScopedTestToken(t, s.db, s, "private-user", "viewer", "private-team", scopesForRole("viewer"), time.Now())
	for _, unauthorized := range []string{"", "private-invalid"} {
		w := appUITelemetryRequest(t, s, "POST", "/admin/ui-actions/events", unauthorized, actionPayload(telemetryVisitID, "overview", "success"))
		if w.Code != 401 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	w := appUITelemetryRequest(t, s, "POST", "/admin/ui-actions/events", token, actionPayload(telemetryVisitID, "overview", "success"))
	if w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
	setAppUITelemetryTestSetting(t, s, "ui.app.feature.overview.status", "hidden")
	w = appUITelemetryRequest(t, s, "POST", "/admin/ui-actions/events", token, actionPayload(strings.Repeat("a", 32), "overview", "success"))
	if w.Code != 403 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = appUITelemetryRequest(t, s, "GET", "/admin/ui-actions/summary", token, "")
	var summary appUIActionSummary
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &summary) != nil || summary.Success != 0 || len(summary.Groups) != 0 {
		t.Fatal(w.Code, w.Body.String())
	}
}
