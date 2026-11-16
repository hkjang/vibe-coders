package store

import (
	"context"
	"fmt"
	"testing"
)

func TestResourceSearchRoutingSelectorsAndExactDetail(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { _ = db.Close() })
	for i := range 12 {
		rule := RoutingRule{ID: fmt.Sprintf("route-%02d", i), MatchPattern: "정산-*", TargetModel: "balanced-model", TargetProvider: "private-provider", Note: "private-note", Priority: i + 1}
		if err := db.UpsertRoutingRule(t.Context(), rule); err != nil {
			t.Fatal(err)
		}
	}
	for _, q := range []string{"route-", "정산", "balanced"} {
		rows, more, err := db.SearchResourceMetadata(t.Context(), "routing_rule", q, 10)
		if err != nil || !more || len(rows) != 10 || rows[0].ID != "route-00" || rows[9].ID != "route-09" || rows[0].Title != "balanced-model" {
			t.Fatalf("routing metadata bounds/selector mismatch: count=%d more=%v err=%v", len(rows), more, err)
		}
	}
	for _, q := range []string{"private-provider", "private-note", "%_", "' OR 1=1 --"} {
		rows, _, err := db.SearchResourceMetadata(t.Context(), "routing_rule", q, 10)
		if err != nil || len(rows) != 0 {
			t.Fatal("routing search inspected private fields or interpreted query syntax")
		}
	}
	if err := db.UpsertRoutingRule(t.Context(), RoutingRule{ID: "분기/한글%_", MatchPattern: "100%_!", TargetModel: "literal"}); err != nil {
		t.Fatal(err)
	}
	rows, _, err := db.SearchResourceMetadata(t.Context(), "routing_rule", "%_!", 10)
	if err != nil || len(rows) != 1 || rows[0].ID != "분기/한글%_" {
		t.Fatal("routing selectors did not escape literal LIKE metacharacters")
	}
	for _, id := range []string{"route-00", "분기/한글%_", "ROUTE-00", "route-0", "missing", "' OR 1=1 --"} {
		rows, err := db.ListRoutingRulesByID(t.Context(), id)
		want := 0
		if id == "route-00" || id == "분기/한글%_" {
			want = 1
		}
		if err != nil || len(rows) != want || (want == 1 && rows[0].ID != id) {
			t.Fatal("detail did not preserve exact bound identity")
		}
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := db.ListRoutingRulesByID(cancelled, "route-00"); err == nil {
		t.Fatal("detail ignored cancellation")
	}
}

func TestResourceSearchRoutingWithoutTargetModel(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { _ = db.Close() })
	if err := db.UpsertRoutingRule(t.Context(), RoutingRule{ID: "no-target-rule", MatchPattern: "보류-*"}); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"no-target", "보류"} {
		rows, _, err := db.SearchResourceMetadata(t.Context(), "routing_rule", query, 10)
		if err != nil || len(rows) != 1 || rows[0].ID != "no-target-rule" || rows[0].Title != "대상 모델 미지정" {
			t.Fatal("rules without a target model must remain discoverable by ID and pattern")
		}
	}
}
