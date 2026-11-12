package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func personalConsoleFixture(t *testing.T, db *store.SQLStore) (*Server, string) {
	t.Helper()
	cfg := testConfig("http://unused.invalid", "secret")
	cfg.Auth.Enabled, cfg.Auth.JWTSecret, cfg.Auth.AccessTokenTTL = true, "personal-console-fixture", time.Hour
	server, err := NewServer(cfg, db, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	token := issueLLMScopedTestToken(t, db, server, "personal-own", "developer", "personal-team", nil, time.Now().UTC())
	return server, token
}

func TestPersonalConsoleStoredRecommendationsAndLegacyGeneration(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	server, token := personalConsoleFixture(t, db)
	routes := server.Routes()
	ctx := t.Context()
	seed := func() {
		t.Helper()
		for _, user := range []string{"personal-own", "personal-other"} {
			if err := db.ReplaceUserRecommendations(ctx, user, []store.PersonalRecommendation{{ID: user + "-recommendation", Kind: "template", Title: "공개 추천"}}); err != nil {
				t.Fatal(err)
			}
		}
	}
	seed()
	for range 2 {
		response := teamConsoleRequest(t, routes, "GET", "/me/recommendations?refresh=false", token, "")
		var body struct {
			UserID          string                         `json:"user_id"`
			Recommendations []store.PersonalRecommendation `json:"recommendations"`
		}
		if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" || json.Unmarshal(response.Body.Bytes(), &body) != nil {
			t.Fatalf("stored read status=%d", response.Code)
		}
		if body.UserID != "personal-own" || len(body.Recommendations) != 1 || body.Recommendations[0].ID != "personal-own-recommendation" || body.Recommendations[0].UserID != "personal-own" {
			t.Fatal("stored read changed or broadened recommendation ownership")
		}
	}
	for _, tc := range []struct {
		path   string
		status int
	}{
		{"/me/recommendations/personal-other-recommendation/feedback", 404},
		{"/me/recommendations/personal-own-recommendation/feedback", 200},
	} {
		response := teamConsoleRequest(t, routes, "POST", tc.path, token, `{"action":"later"}`)
		if response.Code != tc.status {
			t.Fatalf("feedback status=%d want=%d", response.Code, tc.status)
		}
		if response.Code == 200 {
			var body struct{ Status, Kind, Action string }
			if json.Unmarshal(response.Body.Bytes(), &body) != nil || body.Status != "recorded" || body.Kind != "template" || body.Action != "later" {
				t.Fatal("feedback acknowledgment contract changed")
			}
		}
	}
	for _, suffix := range []string{"", "?refresh=true"} {
		seed()
		response := teamConsoleRequest(t, routes, "GET", "/me/recommendations"+suffix, token, "")
		if response.Code != 200 {
			t.Fatalf("legacy generation status=%d", response.Code)
		}
		own, err := db.ListUserRecommendations(ctx, "personal-own")
		if err != nil || slices.ContainsFunc(own, func(r store.PersonalRecommendation) bool { return r.ID == "personal-own-recommendation" }) {
			t.Fatal("legacy generation did not replace stored IDs")
		}
		other, err := db.ListUserRecommendations(ctx, "personal-other")
		if err != nil || len(other) != 1 || other[0].ID != "personal-other-recommendation" {
			t.Fatal("generation changed another user")
		}
	}
	if response := teamConsoleRequest(t, routes, "POST", "/me/recommendations?refresh=false", token, ""); response.Code != 405 {
		t.Fatalf("read method status=%d", response.Code)
	}
}

func TestPersonalConsoleReceiptOwnershipAndBooleanToolError(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	server, token := personalConsoleFixture(t, db)
	now := time.Now().UTC()
	for _, user := range []string{"personal-own", "personal-other"} {
		if err := db.UpsertAPIKey(t.Context(), store.APIKeyRecord{ID: user + "-key", KeyHash: hashProxyKey(user + "-fixture-key"), UserID: user, Team: "personal-team", Status: "active"}); err != nil {
			t.Fatal(err)
		}
		if err := db.InsertLogRecord(t.Context(), store.LogRecord{
			Request: store.RequestLog{ID: user + "-request", APIKeyID: user + "-key", Model: "public-model", Endpoint: "/v1/chat/completions", StatusCode: 200, CreatedAt: now},
			Usage:   &store.TokenUsage{ID: user + "-usage", RequestID: user + "-request", TotalTokens: 12, EstimatedCost: 1.5},
			Tools:   []store.ToolInvocation{{ID: user + "-tool", RequestID: user + "-request", APIKeyID: user + "-key", ServerLabel: "public-server", ToolName: "public-tool", IsMCP: true, IsError: true, CreatedAt: now}},
		}); err != nil {
			t.Fatal(err)
		}
	}
	routes := server.Routes()
	for _, credential := range []string{token, "personal-own-fixture-key"} {
		response := teamConsoleRequest(t, routes, "GET", "/me/requests?limit=100", credential, "")
		var list struct {
			Requests []store.UserRequestSummary `json:"requests"`
		}
		if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &list) != nil || len(list.Requests) != 1 || list.Requests[0].ID != "personal-own-request" {
			t.Fatalf("request ownership status=%d", response.Code)
		}
		for _, tc := range []struct {
			id     string
			status int
		}{{"personal-own-request", 200}, {"personal-other-request", 403}, {"missing", 404}} {
			response = teamConsoleRequest(t, routes, "GET", "/me/requests/"+tc.id+"/receipt", credential, "")
			if response.Code != tc.status || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("receipt status=%d want=%d", response.Code, tc.status)
			}
			if response.Code == 200 {
				var body struct {
					RequestID string `json:"request_id"`
					MCPUsed   bool   `json:"mcp_used"`
					Tools     []struct {
						Error bool `json:"error"`
					} `json:"mcp_tools"`
				}
				if json.Unmarshal(response.Body.Bytes(), &body) != nil || body.RequestID != tc.id || !body.MCPUsed || len(body.Tools) != 1 || !body.Tools[0].Error {
					t.Fatal("receipt safe metadata contract mismatch")
				}
				for _, key := range []string{`"prompt_text"`, `"raw_prompt"`, `"arguments"`, `"sql"`} {
					if strings.Contains(response.Body.String(), key) {
						t.Fatal("receipt exposed raw detail")
					}
				}
			}
		}
	}
}

func TestPersonalConsoleSkillPercentAndAcknowledgments(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	server, token := personalConsoleFixture(t, db)
	if _, err := db.UpsertSkill(t.Context(), store.Skill{Name: "public-skill", Status: "production"}, "fixture"); err != nil {
		t.Fatal(err)
	}
	for i := range 100 {
		status := "error"
		if i == 0 {
			status = "ok"
		}
		if err := db.RecordSkillRun(t.Context(), store.SkillRun{ID: fmt.Sprintf("personal-run-%d", i), SkillName: "public-skill", Actor: "personal-own", Status: status}); err != nil {
			t.Fatal(err)
		}
	}
	routes := server.Routes()
	response := teamConsoleRequest(t, routes, "GET", "/me/skills", token, "")
	var body struct {
		Team      string `json:"team"`
		Available []struct {
			Runs    int     `json:"runs_30d"`
			Success float64 `json:"success_rate"`
		} `json:"available"`
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &body) != nil || body.Team != "personal-team" || len(body.Available) != 1 || body.Available[0].Runs != 100 || body.Available[0].Success != 1 {
		t.Fatal("skill success must be a percentage, including 1%")
	}
	for _, tc := range []struct{ action, body, status string }{{"request-access", `{"reason":"공개 신청 사유"}`, "requested"}, {"feedback", `{"rating":4,"comment":"공개 평가"}`, "recorded"}} {
		response = teamConsoleRequest(t, routes, "POST", "/me/skills/public-skill/"+tc.action, token, tc.body)
		var ack struct{ Status, Skill string }
		if response.Code != 201 || json.Unmarshal(response.Body.Bytes(), &ack) != nil || ack.Status != tc.status || ack.Skill != "public-skill" {
			t.Fatalf("skill write status=%d", response.Code)
		}
	}
}

func TestPersonalConsolePartialFailures(t *testing.T) {
	for _, tc := range []struct {
		table, route, component string
		status                  int
	}{
		{"skill_runs", "/me/skills", "runs", 200},
		{"skill_feedback", "/me/skills", "feedback", 200},
		{"personal_recommendations", "/me/notifications", "recommendations", 200},
		{"personal_recommendations", "/me/actions", "recommendations", 200},
		{"multi_model_test_judgements", "/me/recommended-models", "team_winners", 200},
		{"request_logs", "/me/report?window=weekly", "", 500},
		{"personal_recommendations", "/me/recommendations?refresh=false", "", 500},
	} {
		t.Run(tc.table+tc.route, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "personal.sqlite")
			db := openSQLiteTestStore(t, path)
			defer db.Close()
			server, token := personalConsoleFixture(t, db)
			raw := fixtureRawDB(t, path)
			defer raw.Close()
			if _, err := raw.Exec("DROP TABLE " + tc.table); err != nil {
				t.Fatal(err)
			}
			response := teamConsoleRequest(t, server.Routes(), http.MethodGet, tc.route, token, "")
			if response.Code != tc.status {
				t.Fatalf("fault status=%d want=%d", response.Code, tc.status)
			}
			if tc.status == 200 {
				var result struct {
					Partial []string `json:"partial_failures"`
				}
				if json.Unmarshal(response.Body.Bytes(), &result) != nil || !slices.Contains(result.Partial, tc.component) {
					t.Fatal("failed component was presented as complete data")
				}
			} else if strings.Contains(response.Body.String(), tc.table) || strings.Contains(response.Body.String(), "SQL") {
				t.Fatal("database error detail escaped")
			}
		})
	}
}
