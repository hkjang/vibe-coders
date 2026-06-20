package store

import (
	"context"
	"testing"
	"time"
)

func TestSessionManagementListAndRevoke(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	for _, id := range []string{"s-current", "s-other", "s-sso"} {
		if err := db.InsertAuthSession(ctx, id, "u-1", "10.0.0.1", "agent/"+id, now.Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	// Expired + revoked sessions must be excluded from the active list.
	if err := db.InsertAuthSession(ctx, "s-expired", "u-1", "ip", "ua", now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := db.LinkAuthSessionKeycloakSID(ctx, "s-sso", "kc-sid-9"); err != nil {
		t.Fatal(err)
	}

	list, err := db.ListActiveAuthSessionsForUser(ctx, "u-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 3 {
		t.Fatalf("active sessions = %d, want 3 (expired excluded)", len(list))
	}
	var ssoSeen bool
	for _, si := range list {
		if si.ID == "s-sso" {
			ssoSeen = si.SSOLinked
		}
	}
	if !ssoSeen {
		t.Error("s-sso should be flagged sso_linked")
	}

	// Cannot revoke a session owned by someone else.
	if ok, _ := db.RevokeAuthSessionOwned(ctx, "s-other", "someone-else"); ok {
		t.Error("must not revoke a session owned by a different user")
	}
	// Owner can revoke their own session.
	if ok, _ := db.RevokeAuthSessionOwned(ctx, "s-other", "u-1"); !ok {
		t.Error("owner should revoke own session")
	}
	if active, _ := db.AuthSessionActive(ctx, "s-other"); active {
		t.Error("s-other should be revoked")
	}

	// Revoke all others, keeping the current session.
	n, err := db.RevokeOtherAuthSessionsForUser(ctx, "u-1", "s-current")
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 { // s-sso + s-expired (expired but not yet revoked) flipped; s-current kept
		t.Fatalf("revoked others = %d, want 2", n)
	}
	if active, _ := db.AuthSessionActive(ctx, "s-current"); !active {
		t.Error("current session must stay active")
	}
	if active, _ := db.AuthSessionActive(ctx, "s-sso"); active {
		t.Error("s-sso should be revoked by revoke-others")
	}
}
