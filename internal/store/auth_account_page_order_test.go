package store

import (
	"fmt"
	"testing"
	"time"
)

func TestAuthAccountPageUnicodeSearchAndChronologicalSort(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { db.Close() })
	base := time.Date(2026, 11, 12, 2, 0, 0, 0, time.UTC)
	deltas := []time.Duration{0, time.Nanosecond, 100 * time.Millisecond, time.Second}
	names := []string{"Équipe %_!", "Друг", "ΑΛΦΑ", "운영팀"}
	for index, delta := range deltas {
		id := fmt.Sprintf("order-%d", index)
		if err := db.CreateAuthUser(t.Context(), AuthUser{ID: id, Email: id + "@example.test", Name: names[index],
			Role: "developer", Status: "active", PasswordHash: "fixture-unused", CreatedAt: base.Add(delta)}); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		query string
		index int
	}{{"éQUIPE %_!", 0}, {"друг", 1}, {"αλφα", 2}, {"운영팀", 3}} {
		page, err := db.ListAuthAccountPage(t.Context(), AuthAccountQuery{Search: tc.query, Limit: 25})
		if err != nil || page.Total != 1 || len(page.Accounts) != 1 || page.Accounts[0].ID != fmt.Sprintf("order-%d", tc.index) {
			t.Errorf("Unicode search did not match metadata for case %d: total=%d err=%v", tc.index, page.Total, err)
		}
	}
	for _, order := range []string{"asc", "desc", "default"} {
		descending := order != "asc"
		for offset := range deltas {
			query := AuthAccountQuery{Limit: 1, Offset: offset}
			if order != "default" {
				query.Sort = []AuthAccountSort{{Field: "created_at", Desc: descending}}
			}
			page, err := db.ListAuthAccountPage(t.Context(), query)
			index := offset
			if descending {
				index = len(deltas) - 1 - offset
			}
			if err != nil || page.Total != 4 || len(page.Accounts) != 1 || page.Accounts[0].ID != fmt.Sprintf("order-%d", index) || !page.Accounts[0].CreatedAt.Equal(base.Add(deltas[index])) {
				t.Errorf("chronological page mismatch: descending=%t offset=%d err=%v", descending, offset, err)
			}
		}
	}
}
