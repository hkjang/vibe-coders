package store

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestAuthTeamPageScopeSearchSortAndBounds(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { db.Close() })
	now := time.Date(2026, 11, 12, 2, 0, 0, 0, time.UTC)
	for index := range 37 {
		name := fmt.Sprintf("등록 팀 %02d", index)
		if index == 0 {
			name = "literal %_! team"
		}
		if err := db.UpsertAuthTeam(t.Context(), AuthTeam{ID: fmt.Sprintf("team-%02d", index), Name: name, CreatedAt: now}); err != nil {
			t.Fatal(err)
		}
	}
	read := func(query AuthTeamQuery) AuthTeamPage {
		t.Helper()
		page, err := db.ListAuthTeamPage(t.Context(), query)
		if err != nil {
			t.Fatal(err)
		}
		return page
	}
	first := read(AuthTeamQuery{Limit: 25, Sort: []AuthTeamSort{{Field: "created_at"}}})
	second := read(AuthTeamQuery{Limit: 25, Offset: 25, Sort: []AuthTeamSort{{Field: "created_at"}}})
	if first.Total != 37 || second.Total != 37 || len(first.Teams) != 25 || len(second.Teams) != 12 {
		t.Fatal("team page/count mismatch")
	}
	for index, team := range append(first.Teams, second.Teams...) {
		if team.ID != fmt.Sprintf("team-%02d", index) || team.CreatedAt != now || team.UpdatedAt != now {
			t.Fatal("equal timestamp pages changed team order/metadata")
		}
	}
	outside := read(AuthTeamQuery{Limit: 25, Offset: 100})
	if outside.Total != 37 || outside.Teams == nil || len(outside.Teams) != 0 {
		t.Fatal("empty page lost total/array")
	}
	team, empty := "team-03", ""
	for _, tc := range []struct {
		query AuthTeamQuery
		total int64
	}{
		{AuthTeamQuery{Search: "%_!"}, 1}, {AuthTeamQuery{Search: "TEAM-03"}, 1},
		{AuthTeamQuery{ScopeTeam: &team}, 1}, {AuthTeamQuery{ScopeTeam: &empty}, 0},
		{AuthTeamQuery{ScopeTeam: &team, Search: "team-04"}, 0},
	} {
		tc.query.Limit = 100
		if read(tc.query).Total != tc.total {
			t.Fatal("team scope/search total mismatch")
		}
	}
	legacy, err := db.ListAuthTeams(t.Context())
	if err != nil || !reflect.DeepEqual(read(AuthTeamQuery{Limit: 100}).Teams, legacy) {
		t.Fatal("default ordering or registered metadata differs from Legacy")
	}
	for index, id := range []string{"team_" + strings.Repeat("x", 1024), "team_with\nseparator"} {
		value := AuthTeam{ID: id, Name: fmt.Sprintf("large %d ", index) + strings.Repeat("기존 팀 ", 2048), CreatedAt: now, UpdatedAt: now}
		if err := db.UpsertAuthTeam(t.Context(), value); err != nil {
			t.Fatal(err)
		}
		page := read(AuthTeamQuery{Limit: 25, ScopeTeam: &id})
		if page.Total != 1 || len(page.Teams) != 1 || !reflect.DeepEqual(page.Teams[0], value) {
			t.Fatal("existing authenticated team identifier/metadata rejected")
		}
	}
}

func TestAuthTeamPageRejectsInvalidQueryAndCancellation(t *testing.T) {
	db := openStoreForTest(t)
	for _, query := range []AuthTeamQuery{
		{Limit: 0}, {Limit: 101}, {Limit: 25, Offset: -1}, {Limit: 25, Offset: 1_000_001},
		{Limit: 25, Search: strings.Repeat("한", 201)}, {Limit: 25, Search: "\xff"}, {Limit: 25, Search: "a\nb"},
		{Limit: 25, Sort: []AuthTeamSort{{Field: "name; DROP TABLE teams"}}},
		{Limit: 25, Sort: []AuthTeamSort{{Field: "name"}, {Field: "name"}}},
		{Limit: 25, Sort: []AuthTeamSort{{Field: "name"}, {Field: "id"}, {Field: "created_at"}, {Field: "updated_at"}}},
	} {
		if _, err := db.ListAuthTeamPage(t.Context(), query); !errors.Is(err, ErrInvalidAuthTeamQuery) {
			t.Fatal("invalid team filter accepted")
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := db.ListAuthTeamPage(ctx, AuthTeamQuery{Limit: 25}); !errors.Is(err, context.Canceled) {
		t.Fatal("canceled team query did not stop")
	}
}
