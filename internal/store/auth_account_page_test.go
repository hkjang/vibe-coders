package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestAuthAccountPageScopeSearchSortAndBounds(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { db.Close() })
	ctx := t.Context()
	now := time.Date(2026, 11, 12, 1, 0, 0, 0, time.UTC)
	for _, team := range []AuthTeam{{ID: "alpha", Name: "개발팀"}, {ID: "beta", Name: "운영팀"}} {
		if err := db.UpsertAuthTeam(ctx, team); err != nil {
			t.Fatal(err)
		}
	}
	for index := range 45 {
		id := fmt.Sprintf("account-%02d", index)
		role, status, name := "developer", "active", fmt.Sprintf("사용자 %02d", index)
		if index%3 == 0 {
			role = "viewer"
		}
		if index%5 == 0 {
			status = "disabled"
		}
		if index == 0 {
			name = "literal %_! needle"
		}
		if err := db.CreateAuthUser(ctx, AuthUser{ID: id, Email: id + "@example.test", Name: name,
			Role: role, Status: status, PasswordHash: "private-account-hash", CreatedAt: now}); err != nil {
			t.Fatal(err)
		}
		if index < 44 {
			team := "alpha"
			if index%2 == 1 {
				team = "beta"
			}
			if err := db.UpsertMembership(ctx, UserTeamMembership{UserID: id, TeamID: team, Role: role, CreatedAt: now}); err != nil {
				t.Fatal(err)
			}
		}
	}
	// A later membership must not change the same primary-team scope as Legacy.
	if err := db.UpsertMembership(ctx, UserTeamMembership{UserID: "account-00", TeamID: "beta", Role: "viewer", CreatedAt: now.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	read := func(query AuthAccountQuery) AuthAccountPage {
		t.Helper()
		page, err := db.ListAuthAccountPage(ctx, query)
		if err != nil {
			t.Fatal(err)
		}
		return page
	}
	first := read(AuthAccountQuery{Limit: 25})
	second := read(AuthAccountQuery{Limit: 25, Offset: 25})
	if first.Total != 45 || second.Total != 45 || len(first.Accounts) != 25 || len(second.Accounts) != 20 {
		t.Fatal("page/count mismatch")
	}
	for index, account := range append(first.Accounts, second.Accounts...) {
		if account.ID != fmt.Sprintf("account-%02d", index) {
			t.Fatal("equal timestamp pages are not deterministically ordered")
		}
		if account.CreatedAt != now {
			t.Fatal("account timestamp changed")
		}
	}
	encoded, err := json.Marshal(first)
	if err != nil || strings.Contains(string(encoded), "private-account-hash") || strings.Contains(string(encoded), "password") {
		t.Fatal("credential projection violated")
	}
	outside := read(AuthAccountQuery{Limit: 25, Offset: 100})
	if outside.Total != 45 || outside.Accounts == nil || len(outside.Accounts) != 0 {
		t.Fatal("out-of-range total/empty array mismatch")
	}
	alpha, beta, empty := "alpha", "beta", ""
	for _, tc := range []struct {
		name  string
		query AuthAccountQuery
		total int64
	}{
		{"scope", AuthAccountQuery{ScopeTeam: &alpha}, 22},
		{"scope and foreign filter", AuthAccountQuery{ScopeTeam: &alpha, Team: &beta}, 0},
		{"scope and foreign search", AuthAccountQuery{ScopeTeam: &alpha, Search: "운영팀"}, 0},
		{"empty scope", AuthAccountQuery{ScopeTeam: &empty}, 1},
		{"unassigned filter", AuthAccountQuery{Team: &empty}, 1},
		{"team display name", AuthAccountQuery{Search: "개발팀"}, 22},
		{"literal wildcards", AuthAccountQuery{Search: "%_!"}, 1},
		{"case insensitive email", AuthAccountQuery{Search: "ACCOUNT-03@EXAMPLE.TEST"}, 1},
		{"intersecting filters", AuthAccountQuery{ScopeTeam: &alpha, Role: "viewer", Status: "disabled"}, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.query.Limit = 100
			if read(tc.query).Total != tc.total {
				t.Fatal("scoped total mismatch")
			}
		})
	}
	multi := read(AuthAccountQuery{Limit: 100, Sort: []AuthAccountSort{{Field: "role"}, {Field: "status", Desc: true}, {Field: "email", Desc: true}}})
	for index := 1; index < len(multi.Accounts); index++ {
		a, b := multi.Accounts[index-1], multi.Accounts[index]
		if a.Role > b.Role || (a.Role == b.Role && a.Status < b.Status) || (a.Role == b.Role && a.Status == b.Status && a.Email < b.Email) {
			t.Fatal("multi-sort precedence mismatch")
		}
	}
	if team, err := db.PrimaryTeamForUser(ctx, "account-00"); err != nil || team != first.Accounts[0].TeamID {
		t.Fatal("legacy primary-team semantics changed")
	}
}

func TestAuthAccountPageRejectsInvalidQueryAndCancellation(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { db.Close() })
	badTeam := "team\x00private"
	for _, query := range []AuthAccountQuery{
		{Limit: 0}, {Limit: 101}, {Limit: 25, Offset: -1}, {Limit: 25, Offset: 1_000_001},
		{Limit: 25, Search: strings.Repeat("한", 201)}, {Limit: 25, Search: "\xff"}, {Limit: 25, Search: "a\nb"},
		{Limit: 25, Team: &badTeam}, {Limit: 25, ScopeTeam: &badTeam}, {Limit: 25, Role: strings.Repeat("r", 257)},
		{Limit: 25, Status: "active\x7f"}, {Limit: 25, Sort: []AuthAccountSort{{Field: "password_hash"}}},
		{Limit: 25, Sort: []AuthAccountSort{{Field: "email"}, {Field: "email", Desc: true}}},
		{Limit: 25, Sort: []AuthAccountSort{{Field: "role"}, {Field: "status"}, {Field: "name"}, {Field: "email"}}},
		{Limit: 25, Sort: []AuthAccountSort{{Field: "email; DROP TABLE users"}}},
	} {
		if _, err := db.ListAuthAccountPage(t.Context(), query); !errors.Is(err, ErrInvalidAuthAccountQuery) {
			t.Fatal("invalid filter accepted")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := db.ListAuthAccountPage(ctx, AuthAccountQuery{Limit: 25}); !errors.Is(err, context.Canceled) {
		t.Fatal("canceled query did not stop")
	}
}
