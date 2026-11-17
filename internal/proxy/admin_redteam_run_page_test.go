package proxy

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestRedTeamRunPageAPIAndLegacy(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	for i := 0; i < 105; i++ {
		if err := db.InsertRedTeamRun(t.Context(), store.RedTeamRun{ID: fmt.Sprintf("run-%03d", i), CampaignID: "campaign", Status: "passed", Mode: "dry-run"}); err != nil {
			t.Fatal(err)
		}
	}
	w := httptest.NewRecorder()
	s.Routes().ServeHTTP(w, httptest.NewRequest("GET", "/admin/redteam/runs?view=page&limit=25&offset=100&sort=id:asc", nil))
	var page redTeamRunPageResponse
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &page) != nil || page.Total != 105 || page.Limit != 25 || page.Offset != 100 || len(page.Runs) != 5 || page.Runs[0].ID != "run-100" || page.GeneratedAt.IsZero() || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("bounded page unavailable", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	s.Routes().ServeHTTP(w, httptest.NewRequest("GET", "/admin/redteam/runs", nil))
	var legacy struct {
		Runs  []store.RedTeamRun `json:"runs"`
		Count int                `json:"count"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &legacy) != nil || len(legacy.Runs) != 100 || legacy.Count != 100 || strings.Contains(w.Body.String(), "generated_at") {
		t.Fatal("legacy contract changed")
	}
	for _, query := range []string{
		"view=", "view=raw", "view=page&view=page", "view=page&limit=0", "view=page&limit=101", "view=page&limit=025", "view=page&offset=-1", "view=page&offset=1000001", "view=page&status=unknown", "view=page&mode=unknown", "view=page&kind=unknown", "view=page&extra=1", "view=page&run_id=a&run_id=b", "view=%zz", "view=page;other=1", "view=page&from=2026-11-01T00:00:00Z", "view=page&from=bad&to=bad", "view=page&sort=id:desc,id:asc", "view=page&run_id=" + url.QueryEscape("sk-proj-privatecredential1234567890"), "view=page&source_result_id=" + url.QueryEscape("../../secret"),
	} {
		w = httptest.NewRecorder()
		s.Routes().ServeHTTP(w, httptest.NewRequest("GET", "/admin/redteam/runs?"+query, nil))
		if w.Code != 400 || strings.Contains(w.Body.String(), "privatecredential") || strings.Contains(w.Body.String(), `"runs"`) {
			t.Fatal("invalid query accepted or echoed", query, w.Code)
		}
	}
}

func TestRedTeamRunPagePermissionsAndFailure(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "public-run-history-fixture"
	for _, tc := range []struct {
		role    string
		scopes  []string
		allowed bool
	}{{"admin", []string{"admin:read"}, true}, {"readonly_admin", []string{"admin:read"}, true}, {"user", []string{"models:read"}, false}} {
		token := issueLLMScopedTestToken(t, db, s, "history-"+tc.role, tc.role, "", tc.scopes, time.Now().UTC())
		for _, path := range []string{"/admin/redteam/runs", "/admin/redteam/runs?view=page"} {
			r := httptest.NewRequest("GET", path, nil)
			r.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			s.Routes().ServeHTTP(w, r)
			if (w.Code == 200) != tc.allowed {
				t.Fatal("permission differs", tc.role, w.Code)
			}
		}
	}
	w := httptest.NewRecorder()
	s.Routes().ServeHTTP(w, httptest.NewRequest("GET", "/admin/redteam/runs?view=page", nil))
	if w.Code != 401 {
		t.Fatal("anonymous read allowed")
	}
	s.cfg.Auth.Enabled = false
	w = httptest.NewRecorder()
	s.Routes().ServeHTTP(w, httptest.NewRequest("POST", "/admin/redteam/runs?view=page", nil))
	if w.Code != 405 {
		t.Fatal("mutation accepted")
	}
	db.Close()
	w = httptest.NewRecorder()
	s.Routes().ServeHTTP(w, httptest.NewRequest("GET", "/admin/redteam/runs?view=page", nil))
	if w.Code != 503 || strings.Contains(w.Body.String(), "database") || strings.Contains(w.Body.String(), `"runs"`) {
		t.Fatal("storage failure became empty or leaked details")
	}
}
