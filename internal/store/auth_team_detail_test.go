package store

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestAuthTeamPageExactIdentityWithinScope(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { db.Close() })
	stamp := time.Date(2026, 11, 12, 0, 0, 0, 1, time.UTC)
	ids := []string{"team", "team-longer", "팀 %_! / 이름", "long-" + strings.Repeat("가", 1024)}
	for _, id := range ids {
		if err := db.UpsertAuthTeam(t.Context(), AuthTeam{ID: id, Name: "등록 정보 " + id, CreatedAt: stamp}); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range ids {
		page, err := db.ListAuthTeamPage(t.Context(), AuthTeamQuery{ID: &id, Limit: 1})
		if err != nil || page.Total != 1 || len(page.Teams) != 1 || page.Teams[0].ID != id || !page.Teams[0].CreatedAt.Equal(stamp) {
			t.Fatalf("exact identity/metadata lookup failed: %v", err)
		}
		foreign := "another-team"
		page, err = db.ListAuthTeamPage(t.Context(), AuthTeamQuery{ID: &id, ScopeTeam: &foreign, Limit: 1})
		if err != nil || page.Total != 0 || len(page.Teams) != 0 {
			t.Fatal("requested ID replaced authenticated scope")
		}
	}
	for _, id := range []string{"missing", "TEAM", "%", "tea"} {
		page, err := db.ListAuthTeamPage(t.Context(), AuthTeamQuery{ID: &id, Limit: 1})
		if err != nil || page.Total != 0 || len(page.Teams) != 0 {
			t.Fatal("exact ID lookup used substring, wildcard or case-insensitive comparison")
		}
	}
	for _, id := range []string{"", "\xff", "team\nname", "team\u0085name", strings.Repeat("x", 4097)} {
		if _, err := db.ListAuthTeamPage(t.Context(), AuthTeamQuery{ID: &id, Limit: 1}); !errors.Is(err, ErrInvalidAuthTeamQuery) {
			t.Fatal("invalid exact identity input accepted")
		}
	}
}
