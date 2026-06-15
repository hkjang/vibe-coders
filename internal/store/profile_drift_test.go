package store

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestProfileDriftForUser(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	insertSnap := func(id string, when time.Time, p PersonalProfile) {
		encoded, _ := json.Marshal(p)
		if _, err := db.db.ExecContext(ctx,
			`INSERT INTO personal_profile_snapshots (id, user_id, profile, created_at) VALUES (?,?,?,?)`,
			id, "u1", string(encoded), when.Format(time.RFC3339Nano)); err != nil {
			t.Fatal(err)
		}
	}

	older := PersonalProfile{
		Requests: 100, TotalCostKRW: 1000, AvgCostPerRequest: 10, SuccessRate: 0.90,
		TopModels:    []ProfileCount{{Key: "gpt-4.1", Requests: 80}},
		TopTaskTypes: []ProfileCount{{Key: "refactor", Requests: 60}},
	}
	newer := PersonalProfile{
		Requests: 150, TotalCostKRW: 900, AvgCostPerRequest: 6, SuccessRate: 0.85,
		TopModels:    []ProfileCount{{Key: "gpt-4.1-mini", Requests: 120}},
		TopTaskTypes: []ProfileCount{{Key: "debug", Requests: 90}},
	}
	insertSnap("s_old", now.Add(-48*time.Hour), older)
	insertSnap("s_new", now.Add(-1*time.Hour), newer)

	d, err := db.ProfileDriftForUser(ctx, "u1")
	if err != nil {
		t.Fatal(err)
	}
	if !d.HasBaseline {
		t.Fatal("expected a baseline with 2 snapshots")
	}
	if d.RequestsDelta != 50 {
		t.Errorf("requests delta = %d, want 50", d.RequestsDelta)
	}
	if d.CostDeltaKRW != -100 {
		t.Errorf("cost delta = %f, want -100", d.CostDeltaKRW)
	}
	if d.AvgCostDelta != -4 {
		t.Errorf("avg cost delta = %f, want -4", d.AvgCostDelta)
	}
	if d.SuccessRateDelta > -0.049 || d.SuccessRateDelta < -0.051 {
		t.Errorf("success delta = %f, want ~-0.05", d.SuccessRateDelta)
	}
	if !d.TopModelChanged || d.TopModelFrom != "gpt-4.1" || d.TopModelTo != "gpt-4.1-mini" {
		t.Errorf("model shift wrong: %+v", d)
	}
	if !d.TopTaskChanged || d.TopTaskFrom != "refactor" || d.TopTaskTo != "debug" {
		t.Errorf("task shift wrong: %+v", d)
	}
	has := func(f string) bool {
		for _, x := range d.Flags {
			if x == f {
				return true
			}
		}
		return false
	}
	if !has("cost_down") || !has("success_down") || !has("model_shift") || !has("task_shift") {
		t.Errorf("flags = %v, want cost_down/success_down/model_shift/task_shift", d.Flags)
	}

	// A user with no snapshots → no baseline.
	none, err := db.ProfileDriftForUser(ctx, "nobody")
	if err != nil {
		t.Fatal(err)
	}
	if none.HasBaseline {
		t.Error("no snapshots should yield no baseline")
	}
}
