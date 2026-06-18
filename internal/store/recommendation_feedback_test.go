package store

import (
	"context"
	"testing"
	"time"
)

func TestRecommendationFeedbackAndAdoption(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	// A current recommendation we can look up by id.
	recs := []PersonalRecommendation{{ID: "rms", Kind: "model_switch", Ref: "gpt-4.1-mini", Title: "use mini", EstSavingsKRW: 50}}
	if err := db.ReplaceUserRecommendations(ctx, "u1", recs); err != nil {
		t.Fatal(err)
	}
	got, found, err := db.GetUserRecommendation(ctx, "u1", "rms")
	if err != nil {
		t.Fatal(err)
	}
	if !found || got.Kind != "model_switch" || got.Ref != "gpt-4.1-mini" {
		t.Errorf("lookup = %+v found=%v, want model_switch/gpt-4.1-mini", got, found)
	}
	if _, found, _ := db.GetUserRecommendation(ctx, "u1", "nope"); found {
		t.Error("missing recommendation should not be found")
	}

	fb := func(user, kind, action string) {
		if err := db.InsertRecommendationFeedback(ctx, RecommendationFeedback{
			ID: kind + "_" + user + "_" + action, UserID: user, Kind: kind, Action: action,
		}); err != nil {
			t.Fatal(err)
		}
	}
	fb("u1", "model_switch", "adopted")
	fb("u2", "model_switch", "dismissed")
	fb("u3", "model_switch", "adopted")
	fb("u1", "template", "adopted")
	if err := db.InsertRecommendationFeedback(ctx, RecommendationFeedback{
		ID: "model_switch_u4_later", UserID: "u4", Kind: "model_switch", Action: "later", Reason: "decide after team review",
	}); err != nil {
		t.Fatal(err)
	}
	var reason string
	if err := db.db.QueryRowContext(ctx, `SELECT COALESCE(reason, '') FROM recommendation_feedback WHERE id = ?`, "model_switch_u4_later").Scan(&reason); err != nil {
		t.Fatal(err)
	}
	if reason != "decide after team review" {
		t.Fatalf("feedback reason = %q", reason)
	}

	adoption, err := db.RecommendationAdoption(ctx, now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	byKind := map[string]RecommendationAdoptionByKind{}
	for _, a := range adoption {
		byKind[a.Kind] = a
	}
	ms := byKind["model_switch"]
	if ms.Adopted != 2 || ms.Dismissed != 1 || ms.DistinctAdopters != 2 {
		t.Errorf("model_switch = %+v, want adopted 2 / dismissed 1 / distinct 2", ms)
	}
	// adoption rate = 2 / (2+1) = 0.666...
	if ms.AdoptionRate < 0.66 || ms.AdoptionRate > 0.67 {
		t.Errorf("model_switch adoption rate = %f, want ~0.667", ms.AdoptionRate)
	}
	if tpl := byKind["template"]; tpl.Adopted != 1 || tpl.AdoptionRate != 1 {
		t.Errorf("template = %+v, want adopted 1 / rate 1", tpl)
	}
}
