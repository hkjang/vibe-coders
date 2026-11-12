package store

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestAuthAccountPageExactIdentityAndScope(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { db.Close() })
	now := time.Now().UTC()
	for _, team := range []string{"detail-alpha", "detail-beta"} {
		if err := db.UpsertAuthTeam(t.Context(), AuthTeam{ID: team, Name: team}); err != nil {
			t.Fatal(err)
		}
	}
	ids := []string{"account-exact", "account-exact-more", " 계정/%_! ?# + ", "계정" + strings.Repeat("가", 1024), strings.Repeat("a", 4096), "account-' OR 1=1 --"}
	for index, id := range ids {
		if err := db.CreateAuthUser(t.Context(), AuthUser{ID: id, Email: fmt.Sprintf("detail-%d@example.test", index), Name: "상세 계정", Role: "viewer", Status: "disabled", CreatedAt: now}); err != nil {
			t.Fatal(err)
		}
		if err := db.SetUserTeam(t.Context(), id, "detail-alpha", "viewer"); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range ids {
		t.Run(fmt.Sprintf("identity length %d", len(id)), func(t *testing.T) {
			alpha, beta := "detail-alpha", "detail-beta"
			for _, scope := range []*string{nil, &alpha, &beta} {
				page, err := db.ListAuthAccountPage(t.Context(), AuthAccountQuery{ID: &id, ScopeTeam: scope, Limit: 1})
				if err != nil {
					t.Fatal(err)
				}
				if scope == &beta {
					if page.Total != 0 || len(page.Accounts) != 0 {
						t.Fatal("exact ID escaped team authority")
					}
				} else if page.Total != 1 || len(page.Accounts) != 1 || page.Accounts[0].ID != id {
					t.Fatal("exact identity changed")
				}
			}
			for _, query := range []AuthAccountQuery{
				{ID: &id, Team: &beta, Limit: 1}, {ID: &id, Role: "developer", Limit: 1},
				{ID: &id, Status: "active", Limit: 1}, {ID: &id, Search: "no matching name", Limit: 1},
			} {
				page, err := db.ListAuthAccountPage(t.Context(), query)
				if err != nil || page.Total != 0 || len(page.Accounts) != 0 {
					t.Fatal("exact identity ignored another filter")
				}
			}
			page, err := db.ListAuthAccountPage(t.Context(), AuthAccountQuery{ID: &id, Offset: 1, Limit: 1})
			if err != nil || page.Total != 1 || len(page.Accounts) != 0 {
				t.Fatal("exact identity lost page count")
			}
		})
	}
	for _, id := range []string{"", strings.Repeat("a", 4097), strings.Repeat("가", 1366), "a\n", "a\u0085", "a\x00", "\xff"} {
		if _, err := db.ListAuthAccountPage(t.Context(), AuthAccountQuery{ID: &id, Limit: 1}); !errors.Is(err, ErrInvalidAuthAccountQuery) {
			t.Fatal("invalid exact ID accepted")
		}
	}
}
