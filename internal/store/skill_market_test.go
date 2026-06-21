package store

import (
	"context"
	"testing"
)

func TestSkillMarketStore(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	if err := db.AddSkillAccessRequest(ctx, SkillAccessRequest{ID: "r1", SkillName: "cr", UserID: "u1", Team: "t1", Reason: "need it"}); err != nil {
		t.Fatal(err)
	}
	reqs, err := db.ListSkillAccessRequests(ctx, "cr")
	if err != nil || len(reqs) != 1 || reqs[0].Status != "pending" {
		t.Fatalf("access requests mismatch: %+v err=%v", reqs, err)
	}
	// Different skill filter excludes it.
	if other, _ := db.ListSkillAccessRequests(ctx, "other"); len(other) != 0 {
		t.Error("filter by skill should exclude unrelated requests")
	}

	for _, r := range []int{5, 3} {
		if err := db.AddSkillFeedback(ctx, SkillFeedback{ID: "f" + string(rune('0'+r)), SkillName: "cr", UserID: "u1", Rating: r}); err != nil {
			t.Fatal(err)
		}
	}
	stats, err := db.SkillFeedbackStats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stats["cr"].Count != 2 || stats["cr"].AvgRating != 4 {
		t.Fatalf("feedback stats wrong: %+v", stats["cr"])
	}
}
