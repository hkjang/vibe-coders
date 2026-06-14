package store

import (
	"context"
	"testing"
	"time"
)

func TestAuthStoreUserTeamTokenAuditAndAPIKeyLifecycle(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	if err := db.CreateAuthUser(ctx, AuthUser{ID: "user_1", Email: "dev@example.com", PasswordHash: "hash", Name: "Dev"}); err != nil {
		t.Fatal(err)
	}
	user, found, err := db.AuthUserByEmail(ctx, "dev@example.com")
	if err != nil || !found {
		t.Fatalf("user by email found=%v err=%v", found, err)
	}
	if user.Role != "developer" || user.Status != "active" || user.CreatedAt.IsZero() || user.UpdatedAt.IsZero() {
		t.Fatalf("auth user defaults mismatch: %+v", user)
	}
	if err := db.UpdateAuthUserRoleStatus(ctx, "user_1", "team_admin", "suspended"); err != nil {
		t.Fatal(err)
	}
	user, found, err = db.AuthUserByID(ctx, "user_1")
	if err != nil || !found || user.Role != "team_admin" || user.Status != "suspended" {
		t.Fatalf("user update mismatch found=%v user=%+v err=%v", found, user, err)
	}
	users, err := db.ListAuthUsers(ctx)
	if err != nil || len(users) != 1 {
		t.Fatalf("list auth users mismatch len=%d err=%v", len(users), err)
	}

	if err := db.UpsertAuthTeam(ctx, AuthTeam{ID: "team_platform", Name: "Platform"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertAuthTeam(ctx, AuthTeam{ID: "team_security", Name: "Security"}); err != nil {
		t.Fatal(err)
	}
	teams, err := db.ListAuthTeams(ctx)
	if err != nil || len(teams) != 2 {
		t.Fatalf("list auth teams mismatch len=%d err=%v", len(teams), err)
	}
	team, found, err := db.AuthTeamByIDOrName(ctx, "SECURITY")
	if err != nil || !found || team.ID != "team_security" {
		t.Fatalf("team lookup by name mismatch found=%v team=%+v err=%v", found, team, err)
	}
	if _, found, err := db.AuthTeamByIDOrName(ctx, ""); err != nil || found {
		t.Fatalf("empty team lookup should miss found=%v err=%v", found, err)
	}
	if err := db.UpsertMembership(ctx, UserTeamMembership{UserID: "user_1", TeamID: "team_platform", Role: "developer"}); err != nil {
		t.Fatal(err)
	}
	if primary, err := db.PrimaryTeamForUser(ctx, "user_1"); err != nil || primary != "team_platform" {
		t.Fatalf("primary team mismatch team=%q err=%v", primary, err)
	}
	if err := db.SetUserTeam(ctx, "user_1", "team_security", "team_admin"); err != nil {
		t.Fatal(err)
	}
	if primary, err := db.PrimaryTeamForUser(ctx, "user_1"); err != nil || primary != "team_security" {
		t.Fatalf("changed primary team mismatch team=%q err=%v", primary, err)
	}
	if err := db.SetUserTeam(ctx, "user_1", "", ""); err != nil {
		t.Fatal(err)
	}
	if primary, err := db.PrimaryTeamForUser(ctx, "user_1"); err != nil || primary != "" {
		t.Fatalf("cleared primary team mismatch team=%q err=%v", primary, err)
	}

	if err := db.InsertAuthSession(ctx, "session_live", "user_1", "10.0.0.1", "agent", now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertAuthSession(ctx, "session_expired", "user_1", "10.0.0.1", "agent", now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	if active, err := db.AuthSessionActive(ctx, "session_live"); err != nil || !active {
		t.Fatalf("live session should be active active=%v err=%v", active, err)
	}
	if active, err := db.AuthSessionActive(ctx, "session_expired"); err != nil || active {
		t.Fatalf("expired session should be inactive active=%v err=%v", active, err)
	}
	if active, err := db.AuthSessionActive(ctx, "missing"); err != nil || active {
		t.Fatalf("missing session should be inactive active=%v err=%v", active, err)
	}
	if err := db.RevokeAuthSession(ctx, "session_live"); err != nil {
		t.Fatal(err)
	}
	if active, err := db.AuthSessionActive(ctx, "session_live"); err != nil || active {
		t.Fatalf("revoked session should be inactive active=%v err=%v", active, err)
	}

	if err := db.InsertAuthSession(ctx, "session_rotate", "user_1", "10.0.0.1", "agent", now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertRefreshToken(ctx, RefreshTokenRecord{ID: "refresh_1", UserID: "user_1", SessionID: "session_rotate", TokenHash: "hash_refresh_1", ExpiresAt: now.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	token, found, err := db.RefreshTokenByHash(ctx, "hash_refresh_1")
	if err != nil || !found || token.ID != "refresh_1" || token.RevokedAt.IsZero() == false {
		t.Fatalf("refresh token lookup mismatch found=%v token=%+v err=%v", found, token, err)
	}
	if err := db.RevokeRefreshToken(ctx, "refresh_1"); err != nil {
		t.Fatal(err)
	}
	token, found, err = db.RefreshTokenByHash(ctx, "hash_refresh_1")
	if err != nil || !found || token.RevokedAt.IsZero() {
		t.Fatalf("refresh token revoke mismatch found=%v token=%+v err=%v", found, token, err)
	}
	if err := db.InsertRefreshToken(ctx, RefreshTokenRecord{ID: "refresh_2", UserID: "user_1", SessionID: "session_rotate", TokenHash: "hash_refresh_2", ExpiresAt: now.Add(time.Hour), RotatedFrom: "refresh_1"}); err != nil {
		t.Fatal(err)
	}
	if err := db.RevokeAuthSessionsForUser(ctx, "user_1"); err != nil {
		t.Fatal(err)
	}
	if active, err := db.AuthSessionActive(ctx, "session_rotate"); err != nil || active {
		t.Fatalf("user session revoke mismatch active=%v err=%v", active, err)
	}
	token, found, err = db.RefreshTokenByHash(ctx, "hash_refresh_2")
	if err != nil || !found || token.RotatedFrom != "refresh_1" || token.RevokedAt.IsZero() {
		t.Fatalf("rotated refresh revoke mismatch found=%v token=%+v err=%v", found, token, err)
	}

	if err := db.InsertAuditEvent(ctx, AuthEvent{ID: "auth_event_1", EventType: "login_failed", ActorUserID: "user_1", TeamID: "team_security", IP: "10.0.0.1", UserAgent: "agent", Detail: "bad password"}); err != nil {
		t.Fatal(err)
	}
	events, err := db.ListAuditEvents(ctx, 0)
	if err != nil || len(events) != 1 || events[0].EventType != "login_failed" || events[0].CreatedAt.IsZero() {
		t.Fatalf("audit events mismatch events=%+v err=%v", events, err)
	}
	if err := db.InsertLoginAttempt(ctx, "dev@example.com", false, "10.0.0.1", "agent", "bad password"); err != nil {
		t.Fatal(err)
	}
	var loginAttempts int
	if err := db.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM login_attempts WHERE email = ? AND success = 0`, "dev@example.com").Scan(&loginAttempts); err != nil {
		t.Fatal(err)
	}
	if loginAttempts != 1 {
		t.Fatalf("login attempt count mismatch: %d", loginAttempts)
	}

	expiresAt := now.Add(24 * time.Hour)
	if err := db.UpsertAPIKey(ctx, APIKeyRecord{
		ID: "api_key_1", Name: "proxy", KeyHash: "hash_api_1", Owner: "Dev", Team: "team_security", UserID: "user_1", Role: "developer",
		Scopes: []string{"chat:completion", "models:read"}, AllowedIPs: []string{"10.0.0.1"}, AllowedModels: []string{"gpt-4.1"},
		DeniedModels: []string{"gpt-5"}, AllowedProviders: []string{"openai"}, DeniedProviders: []string{"anthropic"}, BudgetLimitKRW: 100,
		ExpiresAt: expiresAt,
	}); err != nil {
		t.Fatal(err)
	}
	if hasActive, err := db.HasActiveAPIKeys(ctx); err != nil || !hasActive {
		t.Fatalf("expected active api key active=%v err=%v", hasActive, err)
	}
	key, found, err := db.FindActiveAPIKeyByHash(ctx, "hash_api_1")
	if err != nil || !found || key.ID != "api_key_1" || key.Scopes[0] != "chat:completion" || key.AllowedIPs[0] != "10.0.0.1" || key.ExpiresAt.IsZero() {
		t.Fatalf("active api key lookup mismatch found=%v key=%+v err=%v", found, key, err)
	}
	key, found, err = db.GetAPIKey(ctx, "api_key_1")
	if err != nil || !found || key.DeniedProviders[0] != "anthropic" || key.BudgetLimitKRW != 100 {
		t.Fatalf("get api key mismatch found=%v key=%+v err=%v", found, key, err)
	}
	publicKeys, err := db.ListAPIKeys(ctx)
	if err != nil || len(publicKeys) != 1 || publicKeys[0].Scopes[1] != "models:read" {
		t.Fatalf("public api key list mismatch keys=%+v err=%v", publicKeys, err)
	}
	if err := db.RevokeAPIKey(ctx, "api_key_1"); err != nil {
		t.Fatal(err)
	}
	if _, found, err := db.FindActiveAPIKeyByHash(ctx, "hash_api_1"); err != nil || found {
		t.Fatalf("revoked key should not be active found=%v err=%v", found, err)
	}
	key, found, err = db.GetAPIKey(ctx, "api_key_1")
	if err != nil || !found || key.Status != "revoked" || key.RevokedAt.IsZero() {
		t.Fatalf("revoked api key mismatch found=%v key=%+v err=%v", found, key, err)
	}
	if err := db.SetAPIKeyStatus(ctx, "api_key_1", "suspended"); err != nil {
		t.Fatal(err)
	}
	key, found, err = db.GetAPIKey(ctx, "api_key_1")
	if err != nil || !found || key.Status != "suspended" {
		t.Fatalf("api key status update mismatch found=%v key=%+v err=%v", found, key, err)
	}
	if err := db.DeleteAPIKey(ctx, "api_key_1"); err != nil {
		t.Fatal(err)
	}
	if _, found, err := db.GetAPIKey(ctx, "api_key_1"); err != nil || found {
		t.Fatalf("deleted api key should miss found=%v err=%v", found, err)
	}

	if err := db.UpsertAPIKey(ctx, APIKeyRecord{ID: "api_key_manual", Name: "manual", KeyHash: "hash_manual", Status: "active"}); err != nil {
		t.Fatal(err)
	}
	if err := db.EnsureExternalAPIKey(ctx, APIKeyRecord{ID: "api_key_manual", Name: "external", KeyHash: "hash_external"}); err != nil {
		t.Fatal(err)
	}
	key, found, err = db.GetAPIKey(ctx, "api_key_manual")
	if err != nil || !found || key.Name != "manual" || key.KeyHash != "hash_manual" || key.Status != "active" {
		t.Fatalf("external ensure should not clobber manual key found=%v key=%+v err=%v", found, key, err)
	}
	if err := db.DeleteAPIKey(ctx, "api_key_manual"); err != nil {
		t.Fatal(err)
	}
	if hasActive, err := db.HasActiveAPIKeys(ctx); err != nil || hasActive {
		t.Fatalf("no active api keys expected active=%v err=%v", hasActive, err)
	}

	if encoded := encodeStringList(nil); encoded != "[]" {
		t.Fatalf("empty string list encoding mismatch: %q", encoded)
	}
	if values := decodeStringList(`not-json`); len(values) != 0 {
		t.Fatalf("invalid string list should decode empty: %+v", values)
	}
	if formatOptionalTime(time.Time{}) != "" || parseOptionalTime("bad").IsZero() == false || parseOptionalTime(now.Format(time.RFC3339)).IsZero() {
		t.Fatal("optional time helper mismatch")
	}
}
