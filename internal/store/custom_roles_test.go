package store

import (
	"context"
	"testing"
)

func TestCustomRolesCRUD(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	// Initially empty.
	if list, err := db.ListCustomRoles(ctx); err != nil || len(list) != 0 {
		t.Fatalf("expected no custom roles, got %+v err=%v", list, err)
	}

	// Create.
	if err := db.UpsertCustomRole(ctx, CustomRole{
		Role: "billing_admin", Description: "비용센터 관리자",
		Scopes: []string{"admin:read", "costs:read"}, DefaultHome: "#/dashboard",
	}); err != nil {
		t.Fatal(err)
	}
	got, found, err := db.GetCustomRole(ctx, "billing_admin")
	if err != nil || !found {
		t.Fatalf("get after create: found=%v err=%v", found, err)
	}
	if len(got.Scopes) != 2 || got.Scopes[0] != "admin:read" || got.CreatedAt == "" {
		t.Fatalf("unexpected stored role: %+v", got)
	}

	// Update preserves created_at, changes scopes.
	created := got.CreatedAt
	if err := db.UpsertCustomRole(ctx, CustomRole{Role: "billing_admin", Scopes: []string{"costs:read"}}); err != nil {
		t.Fatal(err)
	}
	got2, _, _ := db.GetCustomRole(ctx, "billing_admin")
	if got2.CreatedAt != created {
		t.Errorf("created_at should be preserved on update: %q vs %q", got2.CreatedAt, created)
	}
	if len(got2.Scopes) != 1 || got2.Scopes[0] != "costs:read" {
		t.Errorf("scopes not updated: %+v", got2.Scopes)
	}

	// Delete.
	if err := db.DeleteCustomRole(ctx, "billing_admin"); err != nil {
		t.Fatal(err)
	}
	if _, found, _ := db.GetCustomRole(ctx, "billing_admin"); found {
		t.Fatal("role should be deleted")
	}
}
