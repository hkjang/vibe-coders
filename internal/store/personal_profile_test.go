package store

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestPersonalProfile(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	// Seed an api key mapped to user u1 (team platform, role developer).
	if _, err := db.db.ExecContext(ctx,
		`INSERT INTO api_keys (id, name, key_hash, status, created_at, user_id, team, role) VALUES (?,?,?,?,?,?,?,?)`,
		"k1", "key one", "hash-k1", "active", now.Format(time.RFC3339Nano), "u1", "platform", "developer"); err != nil {
		t.Fatal(err)
	}

	rec := func(id, model, taskType, lang string, status int, cost float64) {
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{ID: id, TraceID: id, APIKeyID: "k1", Endpoint: "/v1/chat/completions",
				Model: model, TaskType: taskType, PromptFingerprint: "fp_" + taskType, StatusCode: status, CreatedAt: now},
			Prompts: []PromptLog{{ID: id + "_p", RequestID: id, Role: "user", LanguageHint: lang, CreatedAt: now}},
			Usage:   &TokenUsage{ID: id + "_u", RequestID: id, TotalTokens: 100, EstimatedCost: cost, Currency: "KRW", CreatedAt: now},
		}); err != nil {
			t.Fatal(err)
		}
	}

	// 4 refactor (java), 2 sql_analysis (sql), 1 failing debug.
	for i := 0; i < 4; i++ {
		rec("r"+itoaStore(i), "gpt-4.1-mini", "refactor", "java", 200, 1)
	}
	rec("s0", "gpt-4.1-mini", "sql_analysis", "sql", 200, 1)
	rec("s1", "gpt-4.1", "sql_analysis", "sql", 200, 5)
	rec("d0", "gpt-4.1", "debug", "go", 500, 5)

	p, err := db.BuildPersonalProfile(ctx, "u1", now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if p.Team != "platform" || p.Role != "developer" {
		t.Errorf("identity = %s/%s, want platform/developer", p.Team, p.Role)
	}
	if p.Requests != 7 {
		t.Errorf("requests = %d, want 7", p.Requests)
	}
	// 6 of 7 succeeded.
	if p.SuccessRate < 0.85 || p.SuccessRate > 0.858 {
		t.Errorf("success rate = %f, want ~0.857", p.SuccessRate)
	}
	if p.DistinctModels != 2 {
		t.Errorf("distinct models = %d, want 2", p.DistinctModels)
	}
	// Top task type = refactor (4).
	if len(p.TopTaskTypes) == 0 || p.TopTaskTypes[0].Key != "refactor" || p.TopTaskTypes[0].Requests != 4 {
		t.Errorf("top task type = %+v, want refactor/4", p.TopTaskTypes)
	}
	// Top model = gpt-4.1-mini (5 reqs).
	if len(p.TopModels) == 0 || p.TopModels[0].Key != "gpt-4.1-mini" {
		t.Errorf("top model = %+v, want gpt-4.1-mini", p.TopModels)
	}
	// Top language = java (4).
	if len(p.TopLanguages) == 0 || p.TopLanguages[0].Key != "java" {
		t.Errorf("top language = %+v, want java", p.TopLanguages)
	}
	if p.Summary == "" {
		t.Error("summary should be non-empty")
	}

	// Active users includes u1.
	users, err := db.PersonalProfileActiveUsers(ctx, now.Add(-time.Hour), 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(users) != 1 || users[0] != "u1" {
		t.Errorf("active users = %v, want [u1]", users)
	}

	// Persistence: upsert + snapshot round-trip.
	encoded, _ := json.Marshal(p)
	if err := db.UpsertPersonalProfile(ctx, "u1", string(encoded)); err != nil {
		t.Fatal(err)
	}
	if _, _, ok, _ := db.GetStoredPersonalProfile(ctx, "u1"); !ok {
		t.Error("stored profile should be retrievable")
	}
	if err := db.InsertPersonalProfileSnapshot(ctx, "pps1", "u1", string(encoded)); err != nil {
		t.Fatal(err)
	}
	snaps, err := db.ListPersonalProfileSnapshots(ctx, "u1", 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(snaps) != 1 {
		t.Errorf("expected 1 snapshot, got %d", len(snaps))
	}
}
