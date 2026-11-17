package proxy

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestActivitySummaryMetadataAndLimits(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	now := time.Now().UTC().Add(-time.Minute)
	for i := range 7 {
		id := fmt.Sprintf("private-row-%d", i)
		if err := db.InsertAdminAudit(t.Context(), store.AdminAuditLog{ID: id, AdminID: "private-admin", Action: "provider.private-target.update", BeforeValue: "private-before", AfterValue: "private-after", CreatedAt: now.Add(time.Duration(i) * time.Nanosecond)}); err != nil {
			t.Fatal(err)
		}
		if err := db.InsertAlertEvent(t.Context(), store.AlertEvent{ID: id, RuleID: "private-rule-id", RuleName: "private-rule", Metric: "requests", Value: float64(i), Threshold: 1, DeliveryError: "private-error", CreatedAt: now.Add(time.Duration(i) * time.Nanosecond)}); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{"/admin/audit-logs/summary", "/admin/alerts/summary"} {
		w := httptest.NewRecorder()
		s.Routes().ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		var result map[string]json.RawMessage
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result) != 5 || string(result["has_more"]) != "true" || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("summary shape status=%d fields=%d", w.Code, len(result))
		}
		if strings.Contains(w.Body.String(), "private-") || strings.Contains(w.Body.String(), "before_value") || strings.Contains(w.Body.String(), "delivery_error") {
			t.Fatal("private metadata reached overview")
		}
		key, size := "events", 6
		if strings.Contains(path, "audit") {
			key, size = "changes", 3
		}
		var rows []map[string]json.RawMessage
		if err := json.Unmarshal(result[key], &rows); err != nil || len(rows) != 5 {
			t.Fatal("summary limit mismatch")
		}
		for _, row := range rows {
			if len(row) != size {
				t.Fatalf("metadata field allowlist: %d", len(row))
			}
		}
		if key == "events" && string(rows[0]["value"]) != "6" {
			t.Fatal("latest event order mismatch")
		}
	}
	category, operation := auditActivityKinds("private-target.private-secret")
	if category != "other" || operation != "other" {
		t.Fatal("unrecognised audit action exposed")
	}
}

func TestActivitySummaryIncidentsMatchLegacy(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	// Keep fixture and observation away from the moving hour boundary.
	at := time.Now().UTC().Truncate(time.Hour).Add(-30 * time.Minute)
	for i := range 6 {
		if err := db.InsertLogRecord(t.Context(), store.LogRecord{Request: store.RequestLog{ID: fmt.Sprintf("activity-request-%d", i), Provider: "https://example.test/?token=private-credential", StatusCode: 503, CreatedAt: at}}); err != nil {
			t.Fatal(err)
		}
	}
	legacy, err := db.Incidents(t.Context(), at.Add(-time.Hour), 5)
	if err != nil || len(legacy) != 1 {
		t.Fatal("legacy fixture failed")
	}
	w := httptest.NewRecorder()
	s.Routes().ServeHTTP(w, httptest.NewRequest("GET", "/admin/incidents/summary", nil))
	var result struct {
		Signals []incidentActivity `json:"signals"`
		Total   int                `json:"total"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Total != 1 || len(result.Signals) != 1 || result.Signals[0].Errors5xx != legacy[0].Errors5xx || result.Signals[0].Requests != legacy[0].Requests || result.Signals[0].Provider != providerNameOmitted {
		t.Fatalf("incident projection mismatch status=%d", w.Code)
	}
	if strings.Contains(w.Body.String(), "private-") || strings.Contains(w.Body.String(), "affected_users") || strings.Contains(w.Body.String(), "ongoing") {
		t.Fatal("private or misleading incident fields")
	}
}

func TestActivitySummaryAccessValidationAndFailures(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	paths := []string{"/admin/incidents/summary", "/admin/alerts/summary", "/admin/audit-logs/summary"}
	for _, path := range paths {
		for _, query := range []string{"window=", "window=2h", "window=1h&window=7d", "window=7d&team=other", "window=%zz", "extra=7d", "window=1h;extra=7d"} {
			w := httptest.NewRecorder()
			s.Routes().ServeHTTP(w, httptest.NewRequest("GET", path+"?"+query, nil))
			if w.Code != 400 || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("invalid query accepted: %d", w.Code)
			}
		}
		for _, method := range []string{"POST", "PUT", "DELETE", "HEAD"} {
			w := httptest.NewRecorder()
			s.Routes().ServeHTTP(w, httptest.NewRequest(method, path, nil))
			if w.Code != 405 {
				t.Fatalf("method accepted: %s %d", method, w.Code)
			}
		}
		for _, period := range []string{"1h", "24h", "7d", "30d"} {
			w := httptest.NewRecorder()
			s.Routes().ServeHTTP(w, httptest.NewRequest("GET", path+"?window="+period, nil))
			if w.Code != 200 || strings.Contains(w.Body.String(), "null") {
				t.Fatalf("empty summary: %d", w.Code)
			}
		}
	}
	s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "public-activity-fixture"
	now := time.Now().UTC()
	for _, tc := range []struct {
		role    string
		scopes  []string
		allowed bool
	}{
		{"admin", []string{"admin:read"}, true}, {"readonly_admin", []string{"admin:read"}, true},
		{"user", []string{"models:read"}, false},
	} {
		token := issueLLMScopedTestToken(t, db, s, "activity-"+tc.role, tc.role, "", tc.scopes, now)
		for _, path := range paths {
			r := httptest.NewRequest("GET", path, nil)
			r.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			s.Routes().ServeHTTP(w, r)
			if (w.Code == 200) != tc.allowed {
				t.Fatalf("permission mismatch: %s %d", tc.role, w.Code)
			}
		}
	}
	for _, path := range paths {
		w := httptest.NewRecorder()
		s.Routes().ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 401 {
			t.Fatalf("anonymous read: %d", w.Code)
		}
	}
	s.cfg.Auth.Enabled = false
	db.Close()
	for _, path := range paths {
		w := httptest.NewRecorder()
		s.Routes().ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 500 || strings.Contains(w.Body.String(), "database") || strings.Contains(w.Body.String(), `"total":0`) {
			t.Fatalf("failed storage returned data: %d", w.Code)
		}
	}
}
