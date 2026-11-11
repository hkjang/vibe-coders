package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func teamConsoleRequest(t *testing.T, handler http.Handler, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func TestTeamConsoleReportScopeRevisionAndReason(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	ctx := t.Context()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "team.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	cfg := testConfig("http://unused.invalid", "secret")
	cfg.Auth.Enabled, cfg.Auth.JWTSecret, cfg.Auth.AccessTokenTTL = true, "team-console-fixture", time.Hour
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	own := issueLLMScopedTestToken(t, db, server, "team-console-own", "team_manager", "own", []string{"team:read"}, now)
	admin := issueLLMScopedTestToken(t, db, server, "team-console-admin", "super_admin", "own", []string{"team:read", "admin:read"}, now)
	denied := issueLLMScopedTestToken(t, db, server, "team-console-denied", "team_manager", "own", []string{"chat:completion"}, now)
	report := store.Text2SQLSavedReport{ID: "team-console-report", Name: "공개 검토", SQL: "SELECT 1", CreatedBy: "public-author"}
	if err := db.UpsertText2SQLSavedReport(ctx, report); err != nil {
		t.Fatal(err)
	}
	const team = "데이터 플랫폼"
	if err := db.SubmitReportForTeam(ctx, report.ID, team); err != nil {
		t.Fatal(err)
	}
	route := "/team/reports?team=" + url.QueryEscape(team)
	routes := server.Routes()
	for _, tc := range []struct {
		method, token, body string
		status              int
	}{
		{"GET", denied, "", 403},
		{"POST", denied, `{"report_id":"team-console-report","action":"approve"}`, 403},
		{"POST", own, `{"report_id":"team-console-report","action":"approve"}`, 404},
		{"POST", admin, `{"report_id":"team-console-report","action":"typo"}`, 400},
		{"POST", admin, `{"report_id":"team-console-report","action":"approve","reason":"` + strings.Repeat("가", 501) + `"}`, 400},
	} {
		response := teamConsoleRequest(t, routes, tc.method, route, tc.token, tc.body)
		if response.Code != tc.status {
			t.Fatalf("%s status=%d want=%d", tc.method, response.Code, tc.status)
		}
		current, _, err := db.GetText2SQLSavedReport(ctx, report.ID)
		if err != nil || current.ApprovalStatus != "pending" {
			t.Fatal("invalid request changed report")
		}
	}
	read := func(token string) []teamReportReview {
		response := teamConsoleRequest(t, routes, "GET", route, token, "")
		if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("read status=%d", response.Code)
		}
		var result struct {
			TeamID  string             `json:"team_id"`
			Reports []teamReportReview `json:"reports"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal("invalid report response")
		}
		return result.Reports
	}
	if len(read(own)) != 0 {
		t.Fatal("ordinary team reader override widened access")
	}
	before := read(admin)
	if len(before) != 1 || len(before[0].Revision) != 64 {
		t.Fatal("missing review fingerprint")
	}
	report.SQL = "SELECT 2"
	if err := db.UpsertText2SQLSavedReport(ctx, report); err != nil {
		t.Fatal(err)
	}
	after := read(admin)
	if len(after) != 1 || after[0].Revision == before[0].Revision {
		t.Fatal("SQL change did not change fingerprint")
	}
	response := teamConsoleRequest(t, routes, "POST", route, admin, `{"report_id":"team-console-report","action":"approve","reason":"공유 범위 검토 완료"}`)
	if response.Code != 200 {
		t.Fatalf("approval status=%d", response.Code)
	}
	current, _, err := db.GetText2SQLSavedReport(ctx, report.ID)
	if err != nil || current.ApprovalStatus != "approved" || current.Team != team {
		t.Fatal("selected team approval failed")
	}
	audits, err := db.ListAdminAudit(ctx, 20)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, audit := range audits {
		if audit.Action == "team_report.approved" && strings.Contains(audit.AfterValue, "공유 범위 검토 완료") {
			found = true
		}
	}
	if !found {
		t.Fatal("decision reason missing from audit")
	}
	// Existing legacy clients may omit the reason and may decide an approved report.
	response = teamConsoleRequest(t, routes, "POST", route, admin, `{"report_id":"team-console-report","action":"reject"}`)
	if response.Code != 200 {
		t.Fatalf("legacy decision status=%d", response.Code)
	}
}

func TestTeamConsolePortalPreservesRatios(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	ctx := t.Context()
	if err := db.UpsertAPIKey(ctx, store.APIKeyRecord{ID: "team-ratio-key", Name: "public", KeyHash: "team-ratio-hash", Team: "ratio", Status: "active"}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Add(-time.Minute)
	for i := 0; i < 100; i++ {
		status := 200
		if i == 0 {
			status = 500
		}
		id := fmt.Sprintf("team-ratio-%d", i)
		if err := db.InsertLogRecord(ctx, store.LogRecord{Request: store.RequestLog{ID: id, APIKeyID: "team-ratio-key", Endpoint: "/v1/chat/completions", StatusCode: status, CreatedAt: now},
			Usage: &store.TokenUsage{ID: id + "-usage", RequestID: id, EstimatedCost: 0.99, Currency: "KRW", CreatedAt: now}}); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.UpsertBudget(ctx, store.Budget{ID: "ratio-budget", Scope: "team", ScopeValue: "ratio", MonthlyKRW: 100}); err != nil {
		t.Fatal(err)
	}
	server, err := NewServer(testConfig("http://unused.invalid", "secret"), db, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	server.handleTeamPortal(w, httptest.NewRequest("GET", "/team/portal?team=ratio", nil))
	var result struct {
		Usage struct {
			SuccessRate float64 `json:"success_rate"`
		} `json:"usage"`
		Budgets []struct {
			BurnRatio float64 `json:"burn_ratio"`
		} `json:"budgets"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil {
		t.Fatalf("portal status=%d", w.Code)
	}
	if result.Usage.SuccessRate != 0.99 || len(result.Budgets) != 1 || result.Budgets[0].BurnRatio < 0.989 || result.Budgets[0].BurnRatio > 0.991 {
		t.Fatal("fraction was rounded before rendering")
	}
}

func TestTeamConsolePartialFailureProjection(t *testing.T) {
	for _, tc := range []struct {
		route, table string
		codes        []string
	}{
		{"/team/risk", "policy_decision_events", []string{"policy_current", "policy_prior"}},
		{"/team/risk", "secret_events", []string{"secrets"}},
		{"/team/risk", "approvals", []string{"approvals"}},
		{"/team/onboarding", "skill_runs", []string{"skills"}},
		{"/team/onboarding", "tool_invocations", []string{"mcp"}},
		{"/team/onboarding", "request_logs", []string{"models", "mcp"}},
		{"/team/portal", "budgets", []string{"budgets"}},
		{"/team/portal", "skills", []string{"skills"}},
		{"/team/portal", "skill_access_requests", []string{"requests"}},
	} {
		t.Run(tc.route+"/"+tc.table, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "partial.db")
			db := openSQLiteTestStore(t, path)
			server, err := NewServer(testConfig("http://unused.invalid", "secret"), db, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			raw := fixtureRawDB(t, path)
			if _, err := raw.ExecContext(t.Context(), "DROP TABLE "+tc.table); err != nil {
				t.Fatal(err)
			}
			handlers := map[string]http.HandlerFunc{"/team/risk": server.handleTeamRisk, "/team/onboarding": server.handleTeamOnboarding, "/team/portal": server.handleTeamPortal}
			w := httptest.NewRecorder()
			handlers[tc.route](w, httptest.NewRequest("GET", tc.route+"?team=public", nil))
			var result struct {
				Failures []string `json:"partial_failures"`
			}
			if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil {
				t.Fatalf("partial status=%d", w.Code)
			}
			for _, code := range tc.codes {
				if !slices.Contains(result.Failures, code) {
					t.Fatalf("missing partial code %s", code)
				}
			}
			if strings.Contains(w.Body.String(), "no such table") {
				t.Fatal("storage details leaked")
			}
		})
	}
}

func TestTeamConsoleScopeFailureNeverFallsBack(t *testing.T) {
	path := filepath.Join(t.TempDir(), "scope.db")
	db := openSQLiteTestStore(t, path)
	server, err := NewServer(testConfig("http://unused.invalid", "secret"), db, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	raw := fixtureRawDB(t, path)
	if _, err := raw.ExecContext(t.Context(), "DROP TABLE teams"); err != nil {
		t.Fatal(err)
	}
	for _, handler := range []http.HandlerFunc{server.handleTeamDashboard, server.handleTeamReports, server.handleTeamSavingsChallenge, server.handleTeamRisk, server.handleTeamOnboarding, server.handleTeamPortal, server.handleTeamPopularSkills, server.handleTeamTemplateCandidates} {
		w := httptest.NewRecorder()
		handler(w, httptest.NewRequest("GET", "/team/fixture?team=public", nil))
		if w.Code != 500 || !strings.Contains(w.Body.String(), "team_scope_failed") || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("scope failure status=%d", w.Code)
		}
	}
}
