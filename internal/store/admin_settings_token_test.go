package store

import (
	"context"
	"strings"
	"testing"
)

func TestAdminSettingsChangeToken(t *testing.T) {
	ctx := context.Background()
	db := openStoreForTest(t)
	defer db.Close()

	empty, err := db.AdminSettingsChangeToken(ctx)
	if err != nil {
		t.Fatal(err)
	}

	set := AdminSetting{Key: "text2sql.enabled", Category: "text2sql", ValueJSON: "true", ValueType: "bool"}
	if err := db.UpsertAdminSetting(ctx, set, "admin@x", "enable"); err != nil {
		t.Fatal(err)
	}
	afterUpsert, _ := db.AdminSettingsChangeToken(ctx)
	if afterUpsert == empty {
		t.Fatal("token must change after an upsert")
	}

	// Re-upserting the same key bumps version → token changes again (a pod must reload).
	set.ValueJSON = "false"
	if err := db.UpsertAdminSetting(ctx, set, "admin@x", "disable"); err != nil {
		t.Fatal(err)
	}
	afterUpdate, _ := db.AdminSettingsChangeToken(ctx)
	if afterUpdate == afterUpsert {
		t.Fatal("token must change after updating an existing key (version bump)")
	}

	// Deleting changes COUNT → token changes (covers cross-pod delete propagation).
	if err := db.DeleteAdminSetting(ctx, "text2sql.enabled", "admin@x", "remove"); err != nil {
		t.Fatal(err)
	}
	afterDelete, _ := db.AdminSettingsChangeToken(ctx)
	if afterDelete == afterUpdate {
		t.Fatal("token must change after a delete")
	}

	sso := SSOProviderConfig{
		Provider:        "keycloak",
		Enabled:         true,
		IssuerURL:       "https://idp.example.test/realms/vibe",
		ClientID:        "gateway",
		ClientSecretEnc: "encrypted-client-secret",
		RedirectURI:     "https://gateway.example.test/auth/keycloak/callback",
		Scopes:          []string{"openid", "profile", "email"},
		DefaultRole:     "viewer",
		RoleClaim:       "realm_access.roles",
		GroupClaim:      "groups",
		AllowLocalLogin: true,
		RoleMap:         map[string]string{"vibe-admin": "admin"},
		UpdatedBy:       "admin@x",
	}
	if err := db.SaveSSOProviderConfig(ctx, sso); err != nil {
		t.Fatal(err)
	}
	afterSSOCreate, err := db.AdminSettingsChangeToken(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if afterSSOCreate == afterDelete {
		t.Fatal("token must change after creating an SSO provider config")
	}
	if strings.Contains(afterSSOCreate, sso.ClientSecretEnc) {
		t.Fatal("change token must not expose the encrypted client secret")
	}

	// A content digest, rather than MAX(updated_at) alone, makes rapid successive
	// writes observable even on databases with coarse timestamp precision.
	storedSSO, found, err := db.GetSSOProviderConfig(ctx, "keycloak")
	if err != nil || !found {
		t.Fatalf("load SSO config: found=%v err=%v", found, err)
	}
	sso.Version = storedSSO.Version
	sso.ClientID = "gateway-v2"
	if err := db.SaveSSOProviderConfig(ctx, sso); err != nil {
		t.Fatal(err)
	}
	afterSSOUpdate, err := db.AdminSettingsChangeToken(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if afterSSOUpdate == afterSSOCreate {
		t.Fatal("token must change after updating an SSO provider config")
	}
	if err := db.SetText2SQLFeatureFlag(ctx, "cumulative_risk_enforce", true); err != nil {
		t.Fatal(err)
	}
	afterFeature, err := db.AdminSettingsChangeToken(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if afterFeature == afterSSOUpdate {
		t.Fatal("token must change after updating a Text2SQL runtime feature")
	}
}
