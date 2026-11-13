package store

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestResourceSearchAccountNamesScopeAndDetailParity(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { db.Close() })
	ctx := t.Context()
	stamp := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	for _, id := range []string{"alpha", "beta", "legacy/" + strings.Repeat("가", 2048)} {
		if err := db.UpsertAuthTeam(ctx, AuthTeam{ID: id, Name: "소속 " + id}); err != nil {
			t.Fatal(err)
		}
	}
	for index := range 13 {
		id := fmt.Sprintf("account-%02d", index)
		if err := db.CreateAuthUser(ctx, AuthUser{ID: id, Email: id + "@example.invalid", Name: fmt.Sprintf("정산 Search %02d", index), Role: "viewer", Status: "active", PasswordHash: "excluded-fixture-hash", CreatedAt: stamp}); err != nil {
			t.Fatal(err)
		}
		if index == 12 {
			continue
		}
		team := "alpha"
		if index >= 10 {
			team = "beta"
		}
		if err := db.UpsertMembership(ctx, UserTeamMembership{UserID: id, TeamID: team, Role: "member", CreatedAt: stamp}); err != nil {
			t.Fatal(err)
		}
	}
	// A secondary membership must never grant navigation to the primary team.
	if err := db.CreateAuthUser(ctx, AuthUser{ID: "legacy-account", Email: "legacy@example.invalid", Name: "기존 정산 계정", Role: "viewer", Status: "active"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertMembership(ctx, UserTeamMembership{UserID: "legacy-account", TeamID: "legacy/" + strings.Repeat("가", 2048), Role: "member", CreatedAt: stamp}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertMembership(ctx, UserTeamMembership{UserID: "account-00", TeamID: "beta", Role: "member", CreatedAt: stamp.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	items, more, err := db.SearchAuthAccountMetadata(ctx, "search", 10, nil)
	if err != nil || !more || len(items) != 10 || items[0].ID != "account-00" || items[9].ID != "account-09" {
		t.Fatal("bounded name order failed")
	}
	for _, scope := range []string{"alpha", "beta", "", "ALPHA", "alp", "foreign", "legacy/" + strings.Repeat("가", 2048)} {
		rows, limited, err := db.SearchAuthAccountMetadata(ctx, "정산", 50, &scope)
		if err != nil || limited {
			t.Fatal("scoped metadata failed")
		}
		page, err := db.ListAuthAccountPage(ctx, AuthAccountQuery{Search: "정산", ScopeTeam: &scope, Limit: 100})
		if err != nil || len(rows) != len(page.Accounts) {
			t.Fatal("search and existing account page scope disagree")
		}
		byID := map[string]AuthAccount{}
		for _, account := range page.Accounts {
			byID[account.ID] = account
		}
		for _, row := range rows {
			if byID[row.ID].Name != row.Title {
				t.Fatal("name-only navigation changed identity")
			}
			primary, err := db.PrimaryTeamForUser(ctx, row.ID)
			if err != nil || primary != scope {
				t.Fatal("secondary membership broadened scope")
			}
		}
	}
	for _, query := range []string{"account-00", "example.invalid", "viewer", "excluded-fixture-hash", "%_", "' OR 1=1 --"} {
		rows, _, err := db.SearchAuthAccountMetadata(ctx, query, 10, nil)
		if err != nil || len(rows) != 0 {
			t.Fatal("account search included non-name fields or interpreted syntax")
		}
	}
	if _, _, err := db.SearchResourceMetadata(ctx, "account", "정산", 10); err == nil {
		t.Fatal("generic unscoped API accepted account kind")
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, _, err := db.SearchAuthAccountMetadata(cancelled, "정산", 10, nil); err == nil {
		t.Fatal("cancelled account search succeeded")
	}
}

func TestResourceSearchAccountUnicodeLiteralAndBounds(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { db.Close() })
	ctx := t.Context()
	fixtures := []AuthUser{
		{ID: "literal", Name: "100%_! 정산"},
		{ID: "unicode", Name: "ÄPFEL ΣΥΝΟΛΟ 분석"},
		{ID: "blank", Name: ""},
		{ID: strings.Repeat("i", 513), Name: "oversized identifier"},
		{ID: "long-title", Name: "oversized " + strings.Repeat("가", 256)},
		{ID: strings.Repeat("😀", 512), Name: "boundary name"},
	}
	if db.dialect == "sqlite" {
		fixtures = append(fixtures, AuthUser{ID: "nul", Name: "oversized\x00" + strings.Repeat("x", 64<<10)})
	}
	for i, row := range fixtures {
		row.Email = fmt.Sprintf("boundary-%d@example.invalid", i)
		row.Role = "viewer"
		row.Status = "active"
		if err := db.CreateAuthUser(ctx, row); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct{ query, id string }{{"%_!", "literal"}, {"äpfel συνολο", "unicode"}, {"oversized", ""}, {"boundary name", strings.Repeat("😀", 512)}} {
		rows, _, err := db.SearchAuthAccountMetadata(ctx, tc.query, 10, nil)
		if err != nil || (tc.id == "" && len(rows) != 0) || (tc.id != "" && (len(rows) != 1 || rows[0].ID != tc.id)) {
			t.Fatal("account name literal/Unicode/bounds contract failed")
		}
	}
	for _, tc := range []struct {
		q     string
		limit int
	}{{"x", 10}, {strings.Repeat("가", 129), 10}, {"\xffbad", 10}, {"정산", 0}, {"정산", 51}} {
		if _, _, err := db.SearchAuthAccountMetadata(ctx, tc.q, tc.limit, nil); err == nil {
			t.Fatal("invalid search bounds accepted")
		}
	}
}
