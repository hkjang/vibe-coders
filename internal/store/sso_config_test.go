package store

import (
	"context"
	"errors"
	"testing"
)

func TestSSOProviderConfigRequiresVersionCAS(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	base := SSOProviderConfig{
		Provider: "keycloak", Enabled: true, IssuerURL: "https://issuer.example/realms/vibe",
		ClientID: "client-v1", Scopes: []string{"openid"}, DefaultRole: "developer",
	}
	if err := db.SaveSSOProviderConfig(ctx, base); err != nil {
		t.Fatal(err)
	}
	current, found, err := db.GetSSOProviderConfig(ctx, "keycloak")
	if err != nil || !found || current.Version != 1 {
		t.Fatalf("created config = %+v found=%v err=%v", current, found, err)
	}

	first, stale := current, current
	first.ClientID = "client-v2"
	if err := db.SaveSSOProviderConfig(ctx, first); err != nil {
		t.Fatal(err)
	}
	stale.ClientID = "stale-client"
	if err := db.SaveSSOProviderConfig(ctx, stale); !errors.Is(err, ErrSSOConfigConflict) {
		t.Fatalf("stale update error = %v, want ErrSSOConfigConflict", err)
	}
	withoutVersion := first
	withoutVersion.Version = 0
	if err := db.SaveSSOProviderConfig(ctx, withoutVersion); !errors.Is(err, ErrSSOConfigConflict) {
		t.Fatalf("versionless update error = %v, want ErrSSOConfigConflict", err)
	}

	latest, found, err := db.GetSSOProviderConfig(ctx, "keycloak")
	if err != nil || !found || latest.ClientID != "client-v2" || latest.Version != 2 {
		t.Fatalf("latest config = %+v found=%v err=%v", latest, found, err)
	}
}
