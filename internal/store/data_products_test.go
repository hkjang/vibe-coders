package store

import (
	"context"
	"testing"
)

func TestDataProductRoundtripAndRequests(t *testing.T) {
	ctx := context.Background()
	db := openStoreForTest(t)
	defer db.Close()

	p := DataProduct{
		ProductKey: "team-cost-daily", NameKO: "팀 일별 비용", Description: "daily team cost",
		SourceType: "saved_report", SourceRef: "rep_123", Owner: "data-team",
		AllowedTeams: []string{"alpha", "beta"}, Sensitivity: "internal", Status: "published",
	}
	p.ID = "dp_1"
	if err := db.UpsertDataProduct(ctx, p); err != nil {
		t.Fatal(err)
	}

	got, ok, err := db.GetDataProduct(ctx, "team-cost-daily")
	if err != nil || !ok {
		t.Fatalf("get: ok=%v err=%v", ok, err)
	}
	if got.NameKO != "팀 일별 비용" || got.SourceType != "saved_report" || got.Status != "published" {
		t.Fatalf("roundtrip mismatch: %+v", got)
	}
	if len(got.AllowedTeams) != 2 || got.AllowedTeams[0] != "alpha" {
		t.Fatalf("allowed_teams not preserved: %+v", got.AllowedTeams)
	}

	// Published-only filter.
	pub, err := db.ListDataProducts(ctx, "published")
	if err != nil || len(pub) != 1 {
		t.Fatalf("published list: n=%d err=%v", len(pub), err)
	}
	drafts, _ := db.ListDataProducts(ctx, "draft")
	if len(drafts) != 0 {
		t.Fatalf("expected 0 drafts, got %d", len(drafts))
	}

	// Update bumps version.
	if err := db.UpsertDataProduct(ctx, got); err != nil {
		t.Fatal(err)
	}
	got2, _, _ := db.GetDataProduct(ctx, "team-cost-daily")
	if got2.Version != 2 {
		t.Fatalf("expected version 2 after update, got %d", got2.Version)
	}

	// Access request lifecycle.
	if err := db.AddDataProductAccessRequest(ctx, DataProductAccessRequest{ID: "dpreq_1", ProductKey: "team-cost-daily", UserID: "u1", Team: "gamma", Reason: "need it"}); err != nil {
		t.Fatal(err)
	}
	reqs, err := db.ListDataProductAccessRequests(ctx, "team-cost-daily")
	if err != nil || len(reqs) != 1 || reqs[0].Status != "pending" {
		t.Fatalf("requests: %+v err=%v", reqs, err)
	}
	if err := db.DecideDataProductAccessRequest(ctx, "dpreq_1", true, "admin_z"); err != nil {
		t.Fatal(err)
	}
	reqs, _ = db.ListDataProductAccessRequests(ctx, "")
	if reqs[0].Status != "approved" || reqs[0].DecidedBy != "admin_z" {
		t.Fatalf("decision not applied: %+v", reqs[0])
	}

	if err := db.DeleteDataProduct(ctx, "team-cost-daily"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := db.GetDataProduct(ctx, "team-cost-daily"); ok {
		t.Fatal("expected product deleted")
	}
}
