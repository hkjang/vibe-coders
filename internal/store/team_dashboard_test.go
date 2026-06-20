package store

import (
	"context"
	"testing"
	"time"
)

func TestTeamDashboardSince(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()
	base := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).Add(2 * time.Hour)

	// Two members of team_platform and one of team_other.
	keys := []struct{ id, user, team string }{
		{"k1", "u1", "team_platform"},
		{"k2", "u2", "team_platform"},
		{"k3", "u3", "team_other"},
	}
	for _, k := range keys {
		if _, err := db.db.ExecContext(ctx,
			`INSERT INTO api_keys (id, name, key_hash, status, created_at, user_id, team, role) VALUES (?,?,?,?,?,?,?,?)`,
			k.id, k.id, "hash-"+k.id, "active", now.Format(time.RFC3339Nano), k.user, k.team, "developer"); err != nil {
			t.Fatal(err)
		}
	}

	rec := func(id, apiKey, model string, status int, cost float64, when time.Time) {
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{ID: id, TraceID: id, APIKeyID: apiKey, Endpoint: "/v1/chat/completions",
				Model: model, TaskType: "generate", StatusCode: status, LatencyMS: 100, CreatedAt: when},
			Usage: &TokenUsage{ID: id + "_u", RequestID: id, TotalTokens: 50, EstimatedCost: cost, Currency: "KRW", CreatedAt: when},
		}); err != nil {
			t.Fatal(err)
		}
	}
	// team_platform: 3 requests (1 failure), team_other: 1 request (should be excluded).
	rec("p1", "k1", "gpt-4.1", 200, 10, base.Add(1*time.Hour))
	rec("p2", "k1", "gpt-4.1", 500, 10, base.Add(2*time.Hour))
	rec("p3", "k2", "gpt-4.1-mini", 200, 2, base.Add(3*time.Hour))
	rec("o1", "k3", "gpt-4.1", 200, 99, base.Add(1*time.Hour))

	d, err := db.TeamDashboardSince(ctx, []string{"team_platform"}, base, 10)
	if err != nil {
		t.Fatal(err)
	}
	if d.Totals.Requests != 3 || d.Totals.Errors != 1 {
		t.Fatalf("team totals = %d reqs / %d errors, want 3 / 1", d.Totals.Requests, d.Totals.Errors)
	}
	if d.Totals.CostKRW < 21.9 || d.Totals.CostKRW > 22.1 {
		t.Fatalf("team cost = %f, want ~22 (10+10+2, no team_other)", d.Totals.CostKRW)
	}
	if d.Totals.SuccessRate < 0.66 || d.Totals.SuccessRate > 0.67 {
		t.Fatalf("team success rate = %f, want ~0.667", d.Totals.SuccessRate)
	}
	// Top users: u1 (2 reqs) before u2 (1 req); no u3 (other team).
	if len(d.TopUsers) != 2 || d.TopUsers[0].UserID != "u1" || d.TopUsers[0].Requests != 2 {
		t.Fatalf("top users = %+v, want u1(2) then u2(1)", d.TopUsers)
	}
	for _, u := range d.TopUsers {
		if u.UserID == "u3" {
			t.Fatal("team_other member u3 must not appear in team_platform dashboard")
		}
	}
	// One failure in-team.
	if len(d.RecentFailures) != 1 || d.RecentFailures[0].StatusCode != 500 {
		t.Fatalf("recent failures = %+v, want one 500", d.RecentFailures)
	}
	// Empty keys → zero-valued, no error.
	empty, err := db.TeamDashboardSince(ctx, nil, base, 10)
	if err != nil || empty.Totals.Requests != 0 {
		t.Fatalf("empty keys should be zero data, got %+v err=%v", empty.Totals, err)
	}
}
