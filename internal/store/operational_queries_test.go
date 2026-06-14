package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"vibe-coders/internal/config"
)

func TestOperationalSearchTimeseriesQuotaAndRetentionQueries(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()
	old := now.AddDate(0, 0, -45)

	if err := db.UpsertAPIKey(ctx, APIKeyRecord{ID: "key_ops", Name: "ops", Team: "platform", KeyHash: "hash", Status: "active"}); err != nil {
		t.Fatal(err)
	}
	insertOperationalRecord(t, db, "ops_recent_1", "key_ops", "10.0.0.1", "gpt-4.1", "openai", "sess_ops", "ops-prompt", "v1", "hello search target", "go", 200, 100, 100, 10, now.Add(-2*time.Hour), `{"model":"gpt-4.1"}`)
	insertOperationalRecord(t, db, "ops_recent_2", "key_ops", "10.0.0.1", "gpt-4.1-mini", "openai", "sess_ops", "ops-prompt", "v2", "another prompt", "python", 500, 200, 50, 5, now.Add(-time.Hour), "")
	insertOperationalRecord(t, db, "ops_old", "key_ops", "10.0.0.2", "gpt-4.1", "openai", "sess_old", "old-prompt", "v1", "old search target", "go", 200, 100, 25, 2.5, old, `{"old":true}`)
	if err := db.UpsertRequestNote(ctx, RequestNote{RequestID: "ops_recent_1", Tags: []string{"review", "incident"}, Note: "check", CreatedBy: "tester", UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}

	search, err := db.SearchPrompts(ctx, PromptSearch{Keyword: "search target", APIKeyID: "key_ops", IP: "10.0.0.1", Language: "go", Since: now.Add(-24 * time.Hour).Format(time.RFC3339Nano), Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(search) != 1 || search[0].ID != "ops_recent_1" || len(search[0].Prompts) == 0 || search[0].Tags[0] != "review" {
		t.Fatalf("keyword prompt search mismatch: %+v", search)
	}
	tagged, err := db.SearchPrompts(ctx, PromptSearch{Keyword: "#incident", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(tagged) != 1 || tagged[0].ID != "ops_recent_1" {
		t.Fatalf("tag prompt search mismatch: %+v", tagged)
	}

	requests, cost, tokens, err := db.UsageSince(ctx, UsageFilter{Scope: "api_key", ScopeValue: "key_ops", Since: now.Add(-24 * time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	if requests != 2 || tokens != 150 || cost != 15 {
		t.Fatalf("api key usage mismatch requests=%d tokens=%d cost=%v", requests, tokens, cost)
	}
	if requests, cost, tokens, err = db.UsageSince(ctx, UsageFilter{Scope: "team", ScopeValue: "platform", Since: now.Add(-24 * time.Hour)}); err != nil || requests != 2 || tokens != 150 || cost != 15 {
		t.Fatalf("team usage mismatch requests=%d tokens=%d cost=%v err=%v", requests, tokens, cost, err)
	}
	if _, _, _, err := db.UsageSince(ctx, UsageFilter{Scope: "unsupported", Since: now.Add(-24 * time.Hour)}); err == nil {
		t.Fatal("unsupported usage scope should fail")
	}
	if team, err := db.GetTeamForAPIKey(ctx, "key_ops"); err != nil || team != "platform" {
		t.Fatalf("team for api key mismatch team=%q err=%v", team, err)
	}

	if err := db.UpsertQuota(ctx, QuotaRecord{ID: "quota_ops", Scope: "api_key", ScopeValue: "key_ops", Period: "daily", TokenLimit: 1000, KRWLimit: 100, Enabled: true, Note: "ops"}); err != nil {
		t.Fatal(err)
	}
	quotas, err := db.ListQuotas(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(quotas) != 1 || quotas[0].ID != "quota_ops" || !quotas[0].Enabled {
		t.Fatalf("quota list mismatch: %+v", quotas)
	}
	activeQuotas, err := db.ActiveQuotasFor(ctx, "api_key", "key_ops")
	if err != nil {
		t.Fatal(err)
	}
	if len(activeQuotas) != 1 || activeQuotas[0].TokenLimit != 1000 {
		t.Fatalf("active quota mismatch: %+v", activeQuotas)
	}
	if err := db.DeleteQuota(ctx, "quota_ops"); err != nil {
		t.Fatal(err)
	}
	quotas, _ = db.ListQuotas(ctx)
	if len(quotas) != 0 {
		t.Fatalf("quota delete mismatch: %+v", quotas)
	}

	hourly, err := db.Timeseries(ctx, TimeseriesQuery{Bucket: "hour", Scope: "api_key", ScopeValue: "key_ops", Since: now.Add(-24 * time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	if len(hourly) != 2 || hourly[0].Bucket != "hour" || hourly[0].Requests != 1 {
		t.Fatalf("hourly timeseries mismatch: %+v", hourly)
	}
	daily, err := db.Timeseries(ctx, TimeseriesQuery{Bucket: "day", Scope: "model", ScopeValue: "gpt-4.1", Since: now.Add(-24 * time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	if len(daily) != 1 || daily[0].Bucket != "day" || daily[0].Tokens != 100 {
		t.Fatalf("daily timeseries mismatch: %+v", daily)
	}
	if _, err := db.Timeseries(ctx, TimeseriesQuery{Scope: "bad", Since: now.Add(-24 * time.Hour)}); err == nil {
		t.Fatal("unsupported timeseries scope should fail")
	}
	heat, err := db.HeatmapKST(ctx, now.Add(-24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(heat.Cells) == 0 {
		t.Fatalf("expected heatmap cells, got %+v", heat)
	}
	body, endpoint, found, err := db.RequestRawBody(ctx, "ops_recent_1")
	if err != nil || !found || body == "" || endpoint != "/v1/chat/completions" {
		t.Fatalf("raw body mismatch found=%v endpoint=%q body=%q err=%v", found, endpoint, body, err)
	}
	if _, _, _, err := db.RequestRawBody(ctx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing raw body should return ErrNotFound, got %v", err)
	}
	for field, want := range map[string]string{"model": "gpt-4.1", "ip": "10.0.0.1", "language": "go", "tag": "incident"} {
		values, err := db.DistinctValues(ctx, field, 10)
		if err != nil {
			t.Fatal(err)
		}
		if !containsString(values, want) {
			t.Fatalf("distinct %s should contain %q, got %+v", field, want, values)
		}
	}
	if _, err := db.DistinctValues(ctx, "bad", 10); err == nil {
		t.Fatal("unsupported distinct field should fail")
	}
	reqs, prompts, responses, err := db.Counts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if reqs != 3 || prompts != 3 || responses != 3 {
		t.Fatalf("counts mismatch reqs=%d prompts=%d responses=%d", reqs, prompts, responses)
	}

	if n, err := db.PurgeOlderThan(ctx, "bad_table", 30); err == nil || n != 0 {
		t.Fatalf("unsupported purge should fail with zero deleted, n=%d err=%v", n, err)
	}
	if n, err := db.PurgeOlderThan(ctx, "prompt_logs", 0); err != nil || n != 0 {
		t.Fatalf("zero-day purge should noop, n=%d err=%v", n, err)
	}
	worker := NewRetentionWorker(db, config.RetentionConfig{RequestDays: 30, Interval: 0})
	if worker.LastRun() != "" || worker.TotalDeleted() != 0 {
		t.Fatalf("new retention worker state mismatch last=%q deleted=%d", worker.LastRun(), worker.TotalDeleted())
	}
	deleted := worker.RunOnce(ctx)
	if deleted == 0 || worker.LastRun() == "" || worker.TotalDeleted() != deleted {
		t.Fatalf("retention run mismatch deleted=%d last=%q total=%d", deleted, worker.LastRun(), worker.TotalDeleted())
	}
	reqs, prompts, responses, err = db.Counts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if reqs != 2 || prompts != 2 || responses != 2 {
		t.Fatalf("retention should purge old request and children, counts reqs=%d prompts=%d responses=%d", reqs, prompts, responses)
	}
}

func insertOperationalRecord(t *testing.T, db *SQLStore, id, apiKeyID, ip, model, provider, sessionID, promptName, promptVersion, promptText, language string, status int, latency int64, tokens int, cost float64, when time.Time, rawBody string) {
	t.Helper()
	rec := LogRecord{
		Request: RequestLog{
			ID: id, TraceID: id, APIKeyID: apiKeyID, ClientIP: ip, Endpoint: "/v1/chat/completions",
			Model: model, Provider: provider, StatusCode: status, LatencyMS: latency, SessionID: sessionID,
			PromptName: promptName, PromptVersion: promptVersion, BodyRaw: rawBody, CreatedAt: when,
		},
		Prompts: []PromptLog{{
			ID: id + "_prompt", RequestID: id, Role: "user", ContentText: promptText, RedactedText: promptText,
			LanguageHint: language, CreatedAt: when,
		}},
		Response: &ResponseLog{ID: id + "_response", RequestID: id, StatusCode: status, FinishReason: "stop", CreatedAt: when},
		Usage: &TokenUsage{
			ID: id + "_usage", RequestID: id, PromptTokens: tokens / 2, CompletionTokens: tokens - tokens/2,
			TotalTokens: tokens, EstimatedCost: cost, Currency: "KRW", Source: "usage", CreatedAt: when,
		},
		Languages: []LanguageStat{{
			ID: id + "_lang", RequestID: id, Language: language, Confidence: 0.9, Evidence: "fixture", CreatedAt: when,
		}},
	}
	if err := db.InsertLogRecord(context.Background(), rec); err != nil {
		t.Fatal(err)
	}
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
