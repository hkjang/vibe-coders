package store

import (
	"fmt"
	"testing"
	"time"
)

func TestAuthTeamPageUnicodeSearchAndChronologicalSort(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { db.Close() })
	base := time.Date(2026, 11, 12, 2, 0, 0, 0, time.UTC)
	deltas := []time.Duration{0, time.Nanosecond, 100 * time.Millisecond, time.Second}
	names := []string{"Équipe %_!", "Друг", "ΑΛΦΑ", "운영팀"}
	for index, delta := range deltas {
		if err := db.UpsertAuthTeam(t.Context(), AuthTeam{ID: fmt.Sprintf("team-order-%d", index), Name: names[index],
			CreatedAt: base.Add(delta), UpdatedAt: base.Add(deltas[len(deltas)-1-index])}); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		query string
		index int
	}{{"éQUIPE %_!", 0}, {"друг", 1}, {"αλφα", 2}, {"운영팀", 3}} {
		page, err := db.ListAuthTeamPage(t.Context(), AuthTeamQuery{Search: tc.query, Limit: 25})
		if err != nil || page.Total != 1 || len(page.Teams) != 1 || page.Teams[0].ID != fmt.Sprintf("team-order-%d", tc.index) {
			t.Errorf("Unicode team search mismatch for case %d: total=%d err=%v", tc.index, page.Total, err)
		}
	}
	for _, field := range []string{"created_at", "updated_at"} {
		for _, descending := range []bool{false, true} {
			for offset := range deltas {
				page, err := db.ListAuthTeamPage(t.Context(), AuthTeamQuery{Limit: 1, Offset: offset,
					Sort: []AuthTeamSort{{Field: field, Desc: descending}}})
				index := offset
				if descending != (field == "updated_at") {
					index = len(deltas) - 1 - offset
				}
				if err != nil || page.Total != 4 || len(page.Teams) != 1 || page.Teams[0].ID != fmt.Sprintf("team-order-%d", index) ||
					!page.Teams[0].CreatedAt.Equal(base.Add(deltas[index])) || !page.Teams[0].UpdatedAt.Equal(base.Add(deltas[len(deltas)-1-index])) {
					t.Errorf("team chronological page mismatch: field=%s descending=%t offset=%d err=%v", field, descending, offset, err)
				}
			}
		}
	}
}
