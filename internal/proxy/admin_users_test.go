package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func TestUserAndIPDetailAggregateAcrossRequests(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":7,"total_tokens":12}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	// create a proxy key so api_key_id maps to a real row
	createResp := postJSON(t, proxy.URL+"/admin/api-keys", "", map[string]any{
		"name":  "Roo",
		"key":   "user-secret",
		"owner": "alice",
		"team":  "platform",
	})
	if createResp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(createResp.Body)
		t.Fatalf("api key create failed: %d %s", createResp.StatusCode, body)
	}
	createResp.Body.Close()

	for i := 0; i < 3; i++ {
		resp := postJSON(t, proxy.URL+"/v1/chat/completions", "user-secret", chatBody("test-model", false))
		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			t.Fatalf("expected 200, got %d: %s", resp.StatusCode, body)
		}
		resp.Body.Close()
	}

	waitFor(t, time.Second, func() bool {
		stats, err := db.Summary(context.Background())
		return err == nil && stats.TotalRequests == 3
	})

	// users list
	usersResp, err := http.Get(proxy.URL + "/admin/users")
	if err != nil {
		t.Fatal(err)
	}
	defer usersResp.Body.Close()
	var users struct {
		Users []store.UserSummary `json:"users"`
	}
	if err := json.NewDecoder(usersResp.Body).Decode(&users); err != nil {
		t.Fatal(err)
	}
	if len(users.Users) == 0 {
		t.Fatal("expected at least one user")
	}
	var target store.UserSummary
	for _, u := range users.Users {
		if u.Requests == 3 {
			target = u
			break
		}
	}
	if target.APIKeyID == "" {
		t.Fatalf("no user matched 3 requests: %#v", users.Users)
	}
	if target.Tokens != 36 {
		t.Fatalf("expected 36 tokens, got %d", target.Tokens)
	}

	// user detail
	detailResp, err := http.Get(proxy.URL + "/admin/users/" + target.APIKeyID)
	if err != nil {
		t.Fatal(err)
	}
	defer detailResp.Body.Close()
	var detail store.UserDetail
	if err := json.NewDecoder(detailResp.Body).Decode(&detail); err != nil {
		t.Fatal(err)
	}
	if detail.Stats.Requests != 3 || detail.Stats.Tokens != 36 {
		t.Fatalf("unexpected user detail stats: %#v", detail.Stats)
	}
	if detail.Advanced.Requests24h != 3 {
		t.Fatalf("expected 3 requests in advanced 24h stats, got %#v", detail.Advanced)
	}
	if detail.Advanced.PromptTokens != 15 || detail.Advanced.CompletionTokens != 21 {
		t.Fatalf("unexpected advanced token split: %#v", detail.Advanced)
	}
	if detail.Advanced.DistinctModels != 1 {
		t.Fatalf("expected one distinct model, got %#v", detail.Advanced)
	}
	if len(detail.ByStatus) != 1 || detail.ByStatus[0].Class != "2xx" || detail.ByStatus[0].Requests != 3 {
		t.Fatalf("unexpected user status breakdown: %#v", detail.ByStatus)
	}
	if detail.Heatmap.Since == "" {
		t.Fatalf("expected user heatmap metadata, got %#v", detail.Heatmap)
	}
	if len(detail.Recent) != 3 {
		t.Fatalf("expected 3 recent rows, got %d", len(detail.Recent))
	}

	teamsResp, err := http.Get(proxy.URL + "/admin/teams")
	if err != nil {
		t.Fatal(err)
	}
	defer teamsResp.Body.Close()
	var teams struct {
		Teams []store.TeamSummary `json:"teams"`
	}
	if err := json.NewDecoder(teamsResp.Body).Decode(&teams); err != nil {
		t.Fatal(err)
	}
	if len(teams.Teams) == 0 || teams.Teams[0].Team != "platform" {
		t.Fatalf("expected platform team summary, got %#v", teams)
	}

	teamDetailResp, err := http.Get(proxy.URL + "/admin/teams/platform")
	if err != nil {
		t.Fatal(err)
	}
	defer teamDetailResp.Body.Close()
	var teamDetail store.TeamDetail
	if err := json.NewDecoder(teamDetailResp.Body).Decode(&teamDetail); err != nil {
		t.Fatal(err)
	}
	if teamDetail.Stats.Requests != 3 || teamDetail.Stats.Keys != 1 {
		t.Fatalf("unexpected team detail stats: %#v", teamDetail.Stats)
	}
	if len(teamDetail.ByKey) != 1 || len(teamDetail.Recent) != 3 {
		t.Fatalf("expected team drill-down data, got %#v", teamDetail)
	}
	if teamDetail.LLM.Summary.Requests != 3 || len(teamDetail.LLM.Timeseries) == 0 {
		t.Fatalf("expected team llm observability, got %#v", teamDetail.LLM)
	}

	// ip list
	ipsResp, err := http.Get(proxy.URL + "/admin/ips")
	if err != nil {
		t.Fatal(err)
	}
	defer ipsResp.Body.Close()
	var ips struct {
		IPs []store.IPSummary `json:"ips"`
	}
	if err := json.NewDecoder(ipsResp.Body).Decode(&ips); err != nil {
		t.Fatal(err)
	}
	if len(ips.IPs) == 0 {
		t.Fatal("expected at least one ip")
	}

	// request detail with full prompt list
	requestsResp, err := http.Get(proxy.URL + "/admin/requests?limit=5")
	if err != nil {
		t.Fatal(err)
	}
	defer requestsResp.Body.Close()
	var recent struct {
		Requests []store.RecentRequest `json:"requests"`
	}
	if err := json.NewDecoder(requestsResp.Body).Decode(&recent); err != nil {
		t.Fatal(err)
	}
	if len(recent.Requests) == 0 {
		t.Fatal("expected recent requests")
	}
	reqID := recent.Requests[0].ID
	detailResp2, err := http.Get(proxy.URL + "/admin/requests/" + reqID)
	if err != nil {
		t.Fatal(err)
	}
	defer detailResp2.Body.Close()
	var rd store.RequestDetail
	if err := json.NewDecoder(detailResp2.Body).Decode(&rd); err != nil {
		t.Fatal(err)
	}
	if rd.Request.ID != reqID {
		t.Fatalf("expected request id %s, got %s", reqID, rd.Request.ID)
	}
	if len(rd.Prompts) == 0 {
		t.Fatal("expected at least one prompt")
	}
	if rd.Prompts[0].RedactedText == "" {
		t.Fatal("expected redacted text in prompt detail")
	}
}

func TestAdminUsersResolvesTeamNames(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	ctx := context.Background()
	if err := db.UpsertAuthTeam(ctx, store.AuthTeam{ID: "team_security", Name: "Security"}); err != nil {
		t.Fatal(err)
	}
	// A self-service-style key stores the team ID, not the display name.
	if err := db.UpsertAPIKey(ctx, store.APIKeyRecord{
		ID: "key_member", Name: "member", KeyHash: "h_member", Team: "team_security",
		UserID: "user_1", Role: "developer", Status: "active",
	}); err != nil {
		t.Fatal(err)
	}

	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	resp, err := http.Get(proxy.URL + "/admin/users")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		TeamNames map[string]string `json:"team_names"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.TeamNames["team_security"] != "Security" {
		t.Fatalf("expected team_names to resolve team_security -> Security, got %#v", out.TeamNames)
	}
}

func TestQuotaBlocksWhenKRWLimitReached(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1000,"completion_tokens":1000,"total_tokens":2000}}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())

	cfg := testConfig(upstream.URL, "secret")
	cfg.Pricing = map[string]config.ModelPrice{
		"test-model": {InputKRWPer1M: 1_000_000, OutputKRWPer1M: 1_000_000}, // 1 KRW per token
	}
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	createResp := postJSON(t, proxy.URL+"/admin/api-keys", "", map[string]any{"name": "Cap", "key": "cap-secret"})
	if createResp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(createResp.Body)
		t.Fatalf("api key create failed: %d %s", createResp.StatusCode, body)
	}
	createResp.Body.Close()

	// global daily 500 KRW quota
	quotaResp := postJSON(t, proxy.URL+"/admin/quotas", "", map[string]any{
		"scope":     "global",
		"period":    "daily",
		"krw_limit": 500,
		"enabled":   true,
		"note":      "test",
	})
	if quotaResp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(quotaResp.Body)
		t.Fatalf("quota create failed: %d %s", quotaResp.StatusCode, body)
	}
	quotaResp.Body.Close()

	// first request: ok, consumes 2000 KRW (above quota of 500)
	first := postJSON(t, proxy.URL+"/v1/chat/completions", "cap-secret", chatBody("test-model", false))
	if first.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(first.Body)
		t.Fatalf("first request expected 200, got %d: %s", first.StatusCode, body)
	}
	first.Body.Close()

	// wait for async log so quota usage table is populated
	waitFor(t, time.Second, func() bool {
		_, _, t, err := db.UsageSince(context.Background(), store.UsageFilter{Scope: "global", ScopeValue: "*", Since: time.Now().Add(-time.Hour)})
		return err == nil && t > 0
	})

	// second request must be blocked with 429 + Retry-After
	second := postJSON(t, proxy.URL+"/v1/chat/completions", "cap-secret", chatBody("test-model", false))
	if second.StatusCode != http.StatusTooManyRequests {
		body, _ := io.ReadAll(second.Body)
		t.Fatalf("expected 429 from quota, got %d: %s", second.StatusCode, body)
	}
	if second.Header.Get("Retry-After") == "" {
		t.Fatal("expected Retry-After header")
	}
	if second.Header.Get("X-Quota-Scope") == "" {
		t.Fatal("expected X-Quota-Scope header")
	}
	second.Body.Close()
}

func TestRetentionPurgeRemovesOldRows(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()

	now := time.Now().UTC()
	old := now.Add(-72 * time.Hour)

	insertReq := func(id string, ts time.Time) {
		err := db.InsertLogRecord(context.Background(), store.LogRecord{
			Request: store.RequestLog{ID: id, TraceID: id, Endpoint: "/v1/chat/completions", StatusCode: 200, CreatedAt: ts},
			Prompts: []store.PromptLog{{ID: id + "-p", RequestID: id, Role: "user", ContentHash: "h", RedactedText: "x", CreatedAt: ts}},
			Usage:   &store.TokenUsage{ID: id + "-u", RequestID: id, TotalTokens: 10, Currency: "KRW", Source: "usage", CreatedAt: ts},
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	insertReq("req-old", old)
	insertReq("req-new", now)

	worker := store.NewRetentionWorker(db, config.RetentionConfig{RequestDays: 2, PromptDays: 2, ResponseDays: 2})
	deleted := worker.RunOnce(context.Background())
	if deleted == 0 {
		t.Fatal("expected retention worker to delete old rows")
	}

	requests, prompts, _, err := db.Counts(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if requests != 1 || prompts != 1 {
		t.Fatalf("expected one remaining request/prompt, got requests=%d prompts=%d", requests, prompts)
	}
}
