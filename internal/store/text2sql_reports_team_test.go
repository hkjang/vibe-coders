package store

import (
	"context"
	"testing"
)

func TestTeamReportApprovalWorkflow(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	if err := db.UpsertText2SQLSavedReport(ctx, Text2SQLSavedReport{ID: "r1", Name: "월별 매출", SQL: "SELECT 1", CreatedBy: "u1"}); err != nil {
		t.Fatal(err)
	}
	// Initially private, not in any team list.
	if list, _ := db.ListTeamReports(ctx, "team_platform"); len(list) != 0 {
		t.Fatalf("expected no team reports initially, got %d", len(list))
	}

	// Submit → pending for team_platform.
	if err := db.SubmitReportForTeam(ctx, "r1", "team_platform"); err != nil {
		t.Fatal(err)
	}
	list, _ := db.ListTeamReports(ctx, "team_platform")
	if len(list) != 1 || list[0].ApprovalStatus != "pending" || list[0].Visibility != "private" {
		t.Fatalf("after submit = %+v, want one pending/private", list)
	}
	// Other team sees nothing.
	if other, _ := db.ListTeamReports(ctx, "team_other"); len(other) != 0 {
		t.Fatalf("other team must not see the report, got %d", len(other))
	}

	// Approve → visibility team.
	if err := db.DecideTeamReport(ctx, "r1", true, "lead@x"); err != nil {
		t.Fatal(err)
	}
	got, found, _ := db.GetText2SQLSavedReport(ctx, "r1")
	if !found || got.ApprovalStatus != "approved" || got.Visibility != "team" || got.ApprovedBy != "lead@x" {
		t.Fatalf("after approve = %+v", got)
	}

	// Reject another submission → back to private/rejected.
	_ = db.SubmitReportForTeam(ctx, "r1", "team_platform")
	if err := db.DecideTeamReport(ctx, "r1", false, "lead@x"); err != nil {
		t.Fatal(err)
	}
	got, _, _ = db.GetText2SQLSavedReport(ctx, "r1")
	if got.ApprovalStatus != "rejected" || got.Visibility != "private" {
		t.Fatalf("after reject = %+v", got)
	}
}
