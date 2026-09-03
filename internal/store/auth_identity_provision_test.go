package store

import (
	"errors"
	"testing"
)

func TestProvisionAuthIdentityIsAtomicWhenIdentityInsertFails(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := t.Context()

	if err := db.CreateAuthUser(ctx, AuthUser{
		ID: "owner", Email: "owner@example.com", PasswordHash: "hash", Role: "developer", Status: "active",
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertAuthIdentity(ctx, AuthIdentity{
		ID: "identity-primary-key", UserID: "owner", Provider: "keycloak",
		Issuer: "https://issuer.example/realms/main", Subject: "existing-subject",
	}); err != nil {
		t.Fatal(err)
	}

	candidate := AuthUser{ID: "candidate", Email: "candidate@example.com", Role: "admin", Status: "active"}
	err := db.ProvisionAuthIdentity(ctx, candidate, true, AuthIdentity{
		// Reusing another identity's primary key makes the identity insert fail after the
		// user insert. The transaction must roll the user insert back.
		ID: "identity-primary-key", Provider: "keycloak",
		Issuer: "https://issuer.example/realms/main", Subject: "candidate-subject",
	}, "")
	if err == nil {
		t.Fatal("expected identity primary-key conflict")
	}
	if _, found, lookupErr := db.AuthUserByID(ctx, candidate.ID); lookupErr != nil || found {
		t.Fatalf("failed provisioning left a user behind: found=%v err=%v", found, lookupErr)
	}
}

func TestProvisionAuthIdentityRollsBackUserAndMembershipOnSubjectConflict(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := t.Context()

	for _, user := range []AuthUser{
		{ID: "owner", Email: "owner@example.com", Role: "developer", Status: "active"},
		{ID: "candidate", Email: "candidate@example.com", Role: "developer", Status: "active"},
	} {
		if err := db.CreateAuthUser(ctx, user); err != nil {
			t.Fatal(err)
		}
	}
	for _, team := range []AuthTeam{{ID: "old-team", Name: "Old"}, {ID: "new-team", Name: "New"}} {
		if err := db.UpsertAuthTeam(ctx, team); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.SetUserTeam(ctx, "candidate", "old-team", ""); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertAuthIdentity(ctx, AuthIdentity{
		ID: "owned-identity", UserID: "owner", Provider: "keycloak",
		Issuer: "https://issuer.example/realms/main", Subject: "shared-subject",
	}); err != nil {
		t.Fatal(err)
	}

	err := db.ProvisionAuthIdentity(ctx,
		AuthUser{ID: "candidate", Role: "admin", Status: "active"}, false,
		AuthIdentity{ID: "new-identity", Provider: "keycloak", Issuer: "https://issuer.example/realms/main", Subject: "shared-subject"},
		"new-team")
	if !errors.Is(err, ErrAuthIdentityUserConflict) {
		t.Fatalf("subject owner conflict error = %v", err)
	}
	user, found, err := db.AuthUserByID(ctx, "candidate")
	if err != nil || !found || user.Role != "developer" {
		t.Fatalf("failed provision changed candidate role: user=%+v found=%v err=%v", user, found, err)
	}
	team, err := db.PrimaryTeamForUser(ctx, "candidate")
	if err != nil || team != "old-team" {
		t.Fatalf("failed provision changed candidate team: team=%q err=%v", team, err)
	}
}
