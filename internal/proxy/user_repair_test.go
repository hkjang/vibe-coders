package proxy

import (
	"errors"
	"testing"

	"vibe-coders/internal/store"
)

func TestAssignUserRoleRepairsRoleAndRevokesSessions(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	ctx := t.Context()
	if err := db.CreateAuthUser(ctx, store.AuthUser{ID: "usr_demoted", Email: "owner@example.com", Role: "developer", Status: "active"}); err != nil {
		t.Fatal(err)
	}

	if _, err := AssignUserRole(ctx, db, "owner@example.com", "not-a-role"); err == nil {
		t.Fatal("unknown role must be rejected")
	}
	if _, err := AssignUserRole(ctx, db, "nobody@example.com", "super_admin"); !errors.Is(err, ErrUnknownUser) {
		t.Fatalf("unknown user error = %v", err)
	}
	persisted, _, _ := db.AuthUserByID(ctx, "usr_demoted")
	if persisted.Role != "developer" {
		t.Fatalf("rejected calls must not change the role: %+v", persisted)
	}

	user, err := AssignUserRole(ctx, db, " owner@example.com ", "super_admin")
	if err != nil || user.Role != "super_admin" || user.ID != "usr_demoted" {
		t.Fatalf("AssignUserRole = %+v err=%v", user, err)
	}
	persisted, _, _ = db.AuthUserByID(ctx, "usr_demoted")
	if persisted.Role != "super_admin" || persisted.Status != "active" {
		t.Fatalf("persisted = %+v", persisted)
	}
	events, err := db.ListAuditEvents(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range events {
		if e.EventType == "role_repaired" && e.ActorUserID == "usr_demoted" {
			found = true
		}
	}
	if !found {
		t.Fatalf("repair was not audited: %+v", events)
	}

	if err := db.UpsertCustomRole(ctx, store.CustomRole{Role: "auditor_plus", Scopes: []string{"admin:read"}}); err != nil {
		t.Fatal(err)
	}
	if user, err := AssignUserRole(ctx, db, "owner@example.com", "auditor_plus"); err != nil || user.Role != "auditor_plus" {
		t.Fatalf("custom role = %+v err=%v", user, err)
	}
}
