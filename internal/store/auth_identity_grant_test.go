package store

import (
	"context"
	"testing"
)

func TestProvisionAuthIdentityRecordsIdPGrantsAndCanLeaveTeamAlone(t *testing.T) {
	db := openStoreForTest(t)
	ctx := context.Background()
	user := AuthUser{ID: "sso-user", Email: "sso@example.com", Role: "admin", Status: "active"}
	identity := AuthIdentity{ID: "ident-1", Provider: "keycloak", Issuer: "https://issuer.example/realms/main", Subject: "grant-subject", IdPRole: "admin", IdPTeam: "platform"}
	if err := db.ProvisionAuthIdentity(ctx, user, true, identity, "platform", true); err != nil {
		t.Fatal(err)
	}
	got, found, err := db.AuthIdentityBySubject(ctx, "keycloak", identity.Issuer, identity.Subject)
	if err != nil || !found || got.IdPRole != "admin" || got.IdPTeam != "platform" {
		t.Fatalf("identity = %+v found=%v err=%v", got, found, err)
	}
	if team, err := db.PrimaryTeamForUser(ctx, user.ID); err != nil || team != "platform" {
		t.Fatalf("team = %q err=%v", team, err)
	}

	// A login that says nothing about the team must not touch the membership, while the
	// identity's recorded grants are updated to what this login actually granted.
	relogin := AuthIdentity{ID: "ident-2", Provider: "keycloak", Issuer: identity.Issuer, Subject: identity.Subject}
	if err := db.ProvisionAuthIdentity(ctx, AuthUser{ID: user.ID, Role: "", Status: "active"}, false, relogin, "", false); err != nil {
		t.Fatal(err)
	}
	if team, err := db.PrimaryTeamForUser(ctx, user.ID); err != nil || team != "platform" {
		t.Fatalf("membership changed although syncTeam=false: %q err=%v", team, err)
	}
	got, _, err = db.AuthIdentityBySubject(ctx, "keycloak", identity.Issuer, identity.Subject)
	if err != nil || got.ID != "ident-1" || got.IdPRole != "" || got.IdPTeam != "" {
		t.Fatalf("identity after relogin = %+v err=%v", got, err)
	}

	if err := db.ProvisionAuthIdentity(ctx, AuthUser{ID: user.ID, Status: "active"}, false, relogin, "", true); err != nil {
		t.Fatal(err)
	}
	if team, err := db.PrimaryTeamForUser(ctx, user.ID); err != nil || team != "" {
		t.Fatalf("syncTeam=true with an empty team must remove the membership: %q err=%v", team, err)
	}
}
