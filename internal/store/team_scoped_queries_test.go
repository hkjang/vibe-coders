package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestTeamScopedIPAndDistinctValueQueries(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()

	ctx := context.Background()
	now := time.Now().UTC()
	for _, key := range []APIKeyRecord{
		{ID: "key_alpha", Name: "alpha", Team: "alpha", KeyHash: "alpha-hash", Status: "active"},
		{ID: "key_beta", Name: "beta", Team: "beta", KeyHash: "beta-hash", Status: "active"},
	} {
		if err := db.UpsertAPIKey(ctx, key); err != nil {
			t.Fatal(err)
		}
	}

	insertTeamScopedQueryFixture(t, db, "alpha_shared", "key_alpha", "10.0.0.1", "alpha-model", "ko", []string{"alpha-tag", "shared-tag"}, 10, now.Add(-5*time.Minute))
	insertTeamScopedQueryFixture(t, db, "alpha_only", "key_alpha", "10.0.0.2", "alpha-model-2", "ko", []string{"alpha-only"}, 20, now.Add(-4*time.Minute))
	insertTeamScopedQueryFixture(t, db, "beta_shared", "key_beta", "10.0.0.1", "beta-model", "en", []string{"beta-tag", "shared-tag"}, 30, now.Add(-3*time.Minute))
	insertTeamScopedQueryFixture(t, db, "beta_only", "key_beta", "10.0.0.3", "beta-model-2", "en", []string{"beta-only"}, 40, now.Add(-2*time.Minute))
	insertTeamScopedQueryFixture(t, db, "unassigned", "anonymous", "10.0.0.4", "unassigned-model", "ja", []string{"unassigned-tag"}, 50, now.Add(-time.Minute))
	if err := db.UpsertRequestNote(ctx, RequestNote{
		RequestID: "retained_operator_note", Tags: []string{"retained-operator-tag"},
		Note: "request log already expired", CreatedBy: "operator", UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	t.Run("legacy wrappers remain unrestricted", func(t *testing.T) {
		ips, err := db.ListIPs(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if got := ipSummaryByAddress(ips)["10.0.0.1"].Requests; got != 2 {
			t.Fatalf("unrestricted shared IP requests = %d, want 2", got)
		}

		detail, err := db.GetIPDetail(ctx, "10.0.0.1", 10)
		if err != nil {
			t.Fatal(err)
		}
		if detail.Stats.Requests != 2 || len(detail.Recent) != 2 {
			t.Fatalf("unrestricted IP detail mismatch: %+v", detail)
		}

		models, err := db.DistinctValues(ctx, "model", 20)
		if err != nil {
			t.Fatal(err)
		}
		if !containsString(models, "alpha-model") || !containsString(models, "beta-model") || !containsString(models, "unassigned-model") {
			t.Fatalf("unrestricted model values missing fixtures: %v", models)
		}
		tags, err := db.DistinctValues(ctx, "tag", 20)
		if err != nil {
			t.Fatal(err)
		}
		if !containsString(tags, "retained-operator-tag") {
			t.Fatalf("unrestricted tags must preserve retained operator notes: %v", tags)
		}
	})

	t.Run("IP list and detail stay inside one team", func(t *testing.T) {
		ips, err := db.ListIPsScoped(ctx, []string{"alpha"}, true)
		if err != nil {
			t.Fatal(err)
		}
		byIP := ipSummaryByAddress(ips)
		if len(byIP) != 2 {
			t.Fatalf("alpha IP count = %d, want 2: %+v", len(byIP), ips)
		}
		if shared := byIP["10.0.0.1"]; shared.Requests != 1 || shared.Tokens != 10 || shared.DistinctKeys != 1 {
			t.Fatalf("alpha shared IP aggregate mismatch: %+v", shared)
		}
		if _, ok := byIP["10.0.0.3"]; ok {
			t.Fatalf("beta-only IP leaked into alpha list: %+v", ips)
		}

		detail, err := db.GetIPDetailScoped(ctx, "10.0.0.1", 10, []string{"alpha"}, true)
		if err != nil {
			t.Fatal(err)
		}
		if detail.Stats.Requests != 1 || detail.Stats.Tokens != 10 || len(detail.Daily) != 1 {
			t.Fatalf("alpha detail aggregate mismatch: %+v", detail)
		}
		if len(detail.ByModel) != 1 || detail.ByModel[0].Key != "alpha-model" {
			t.Fatalf("beta model leaked into alpha detail: %+v", detail.ByModel)
		}
		if len(detail.ByLanguage) != 1 || detail.ByLanguage[0].Language != "ko" {
			t.Fatalf("beta language leaked into alpha detail: %+v", detail.ByLanguage)
		}
		if len(detail.ByKey) != 1 || detail.ByKey[0].Key != "key_alpha" {
			t.Fatalf("beta API key leaked into alpha detail: %+v", detail.ByKey)
		}
		if len(detail.Recent) != 1 || detail.Recent[0].ID != "alpha_shared" {
			t.Fatalf("beta request leaked into alpha detail: %+v", detail.Recent)
		}

		if _, err := db.GetIPDetailScoped(ctx, "10.0.0.3", 10, []string{"alpha"}, true); !errors.Is(err, ErrNotFound) {
			t.Fatalf("another team's IP must be hidden as not found, got %v", err)
		}
	})

	t.Run("filter suggestions stay inside one team", func(t *testing.T) {
		checks := []struct {
			field string
			want  string
			deny  []string
		}{
			{field: "model", want: "alpha-model", deny: []string{"beta-model", "unassigned-model"}},
			{field: "ip", want: "10.0.0.2", deny: []string{"10.0.0.3", "10.0.0.4"}},
			{field: "language", want: "ko", deny: []string{"en", "ja"}},
			{field: "tag", want: "alpha-tag", deny: []string{"beta-tag", "unassigned-tag", "retained-operator-tag"}},
		}
		for _, check := range checks {
			t.Run(check.field, func(t *testing.T) {
				values, err := db.DistinctValuesScoped(ctx, check.field, 20, []string{"alpha"}, true)
				if err != nil {
					t.Fatal(err)
				}
				if !containsString(values, check.want) {
					t.Fatalf("%s values missing %q: %v", check.field, check.want, values)
				}
				for _, denied := range check.deny {
					if containsString(values, denied) {
						t.Fatalf("%s value %q crossed team boundary: %v", check.field, denied, values)
					}
				}
			})
		}
	})

	t.Run("empty scoped identity fails closed", func(t *testing.T) {
		ips, err := db.ListIPsScoped(ctx, nil, true)
		if err != nil {
			t.Fatal(err)
		}
		if len(ips) != 0 {
			t.Fatalf("empty scoped IP list must be empty: %+v", ips)
		}
		if _, err := db.GetIPDetailScoped(ctx, "10.0.0.1", 10, nil, true); !errors.Is(err, ErrNotFound) {
			t.Fatalf("empty scoped IP detail must fail closed, got %v", err)
		}
		for _, field := range []string{"model", "ip", "language", "tag"} {
			values, err := db.DistinctValuesScoped(ctx, field, 20, nil, true)
			if err != nil {
				t.Fatalf("%s distinct values: %v", field, err)
			}
			if len(values) != 0 {
				t.Fatalf("empty scoped %s values must be empty: %v", field, values)
			}
		}
	})
}

func insertTeamScopedQueryFixture(t *testing.T, db *SQLStore, id, apiKeyID, ip, model, language string, tags []string, tokens int, createdAt time.Time) {
	t.Helper()
	record := LogRecord{
		Request: RequestLog{
			ID: id, TraceID: id, APIKeyID: apiKeyID, ClientIP: ip,
			Endpoint: "/v1/chat/completions", Model: model, Provider: "fixture",
			StatusCode: 200, LatencyMS: int64(tokens), CreatedAt: createdAt,
		},
		Usage: &TokenUsage{
			ID: id + "_usage", RequestID: id, TotalTokens: tokens,
			EstimatedCost: float64(tokens), Currency: "KRW", Source: "usage", CreatedAt: createdAt,
		},
		Languages: []LanguageStat{{
			ID: id + "_language", RequestID: id, Language: language,
			Confidence: 0.9, Evidence: "fixture", CreatedAt: createdAt,
		}},
	}
	if err := db.InsertLogRecord(context.Background(), record); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRequestNote(context.Background(), RequestNote{
		RequestID: id, Tags: tags, Note: "fixture", CreatedBy: "test", UpdatedAt: createdAt,
	}); err != nil {
		t.Fatal(err)
	}
}

func ipSummaryByAddress(items []IPSummary) map[string]IPSummary {
	result := make(map[string]IPSummary, len(items))
	for _, item := range items {
		result[item.IP] = item
	}
	return result
}
