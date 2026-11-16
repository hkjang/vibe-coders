package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestMCPOverviewCountsBeyondToolListLimit(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	now := time.Now().UTC().Add(-time.Minute)
	record := store.LogRecord{Request: store.RequestLog{ID: "summary-request", CreatedAt: now}}
	for i := range 503 {
		record.Tools = append(record.Tools, store.ToolInvocation{ID: fmt.Sprintf("tool-%d", i), RequestID: "summary-request", ServerLabel: "fixture", ToolName: fmt.Sprintf("tool-%d", i), Source: "call", IsMCP: true, IsError: i < 2, CreatedAt: now})
	}
	for _, tool := range []store.ToolInvocation{
		{ID: "non-mcp", Source: "call", IsError: true, CreatedAt: now},
		{ID: "old", Source: "call", IsMCP: true, IsError: true, CreatedAt: now.Add(-25 * time.Hour)},
		{ID: "definition", Source: "definition", IsMCP: true, CreatedAt: now},
		{ID: "result", Source: "result", IsMCP: true, IsError: true, CreatedAt: now},
	} {
		tool.RequestID, tool.ToolName, tool.ServerLabel = "summary-request", tool.ID, "fixture"
		record.Tools = append(record.Tools, tool)
	}
	if err := db.InsertLogRecord(t.Context(), record); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	s.Routes().ServeHTTP(w, httptest.NewRequest("GET", "/admin/mcp/overview", nil))
	var out struct {
		Calls     int64            `json:"recent_call_count"`
		Errors    int64            `json:"recent_error_count"`
		Summary   store.MCPSummary `json:"summary"`
		Since     time.Time        `json:"since"`
		Generated time.Time        `json:"generated_at"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil || out.Calls != 503 || out.Errors != 3 || out.Summary.TotalCalls != 505 || out.Generated.Sub(out.Since) != 24*time.Hour || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("full MCP aggregate mismatch: status=%d calls=%d errors=%d", w.Code, out.Calls, out.Errors)
	}
}

func TestServiceSummaryFailureAndValidation(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	handler := s.Routes()
	for _, query := range []string{"window=", "window=2h", "window=1h&window=7d", "window=7d&team=other", "window=%zz", "extra=7d", "window=1h;extra=7d"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", "/admin/text2sql/summary?"+query, nil))
		if w.Code != 400 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("invalid summary accepted: %d", w.Code)
		}
	}
	for _, method := range []string{"POST", "PUT", "DELETE", "HEAD"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(method, "/admin/text2sql/summary", nil))
		if w.Code != 405 {
			t.Fatalf("method accepted: %s %d", method, w.Code)
		}
	}
	db.Close()
	for _, path := range []string{"/admin/text2sql/summary", "/admin/mcp/overview"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 500 || strings.Contains(w.Body.String(), "database") || strings.Contains(w.Body.String(), `"total":0`) {
			t.Fatalf("storage failure presented as data: %d", w.Code)
		}
	}
}

func TestText2SQLSummaryMatchesScopedLegacyWithoutRawContent(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "public-service-summary-session"
	now := time.Now().UTC().Add(-time.Minute)
	for _, team := range []string{"alpha", "beta"} {
		if err := db.UpsertAuthTeam(t.Context(), store.AuthTeam{ID: team, Name: team}); err != nil {
			t.Fatal(err)
		}
		if err := db.UpsertAPIKey(t.Context(), store.APIKeyRecord{ID: team, Name: team, Team: team, KeyHash: team, Status: "active"}); err != nil {
			t.Fatal(err)
		}
		if err := db.InsertLogRecord(t.Context(), store.LogRecord{Request: store.RequestLog{ID: team, APIKeyID: team, CreatedAt: now}}); err != nil {
			t.Fatal(err)
		}
		if err := db.InsertText2SQLLog(t.Context(), store.Text2SQLQueryLog{ID: team, RequestID: team, APIKeyID: team, Team: team, Question: "private-question", GeneratedSQL: "private-sql", Valid: team == "alpha", Executed: team == "alpha", Error: map[bool]string{true: "private-error"}[team == "beta"], CostKRW: 10, CreatedAt: now}); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		role, team string
		total      int64
	}{{"admin", "", 2}, {"readonly_admin", "", 2}, {"team_admin", "alpha", 1}, {"team_admin", "", 0}, {"team_admin", "missing", 0}} {
		t.Run(tc.role+tc.team, func(t *testing.T) {
			token := issueLLMScopedTestToken(t, db, s, "summary-"+tc.role+tc.team, tc.role, tc.team, []string{"admin:read"}, now)
			for _, window := range []string{"1h", "24h", "7d", "30d"} {
				var stats []store.Text2SQLStats
				for _, path := range []string{"/admin/text2sql", "/admin/text2sql/summary"} {
					r := httptest.NewRequest("GET", path+"?window="+window, nil)
					r.Header.Set("Authorization", "Bearer "+token)
					w := httptest.NewRecorder()
					s.Routes().ServeHTTP(w, r)
					var out struct {
						Stats store.Text2SQLStats `json:"stats"`
					}
					if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil {
						t.Fatalf("summary read: %d", w.Code)
					}
					stats = append(stats, out.Stats)
					if strings.HasSuffix(path, "/summary") {
						var fields map[string]json.RawMessage
						if json.Unmarshal(w.Body.Bytes(), &fields) != nil || len(fields) != 5 {
							t.Fatal("unexpected metadata fields")
						}
						for _, forbidden := range []string{"private-", "question", "generated_sql", "schema", "api_key", "logs"} {
							if strings.Contains(w.Body.String(), forbidden) {
								t.Fatal("raw content reached summary")
							}
						}
					}
				}
				if !reflect.DeepEqual(stats[0], stats[1]) || stats[1].Total != tc.total {
					t.Fatalf("scope or legacy mismatch: %+v", stats)
				}
			}
		})
	}
	for _, token := range []string{"", issueLLMScopedTestToken(t, db, s, "summary-denied", "user", "alpha", []string{"models:read"}, now)} {
		r := httptest.NewRequest(http.MethodGet, "/admin/text2sql/summary", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		s.Routes().ServeHTTP(w, r)
		if w.Code != 401 && w.Code != 403 {
			t.Fatalf("unauthorized summary: %d", w.Code)
		}
	}
}
