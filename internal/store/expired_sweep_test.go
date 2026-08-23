package store

import (
	"context"
	"testing"
	"time"
)

// These tables carry expires_at and are already treated as expired on read, but the
// rows were never deleted — so they accumulated with authentication traffic. The one
// thing a sweep must never do is take a credential that still works.
func TestSweepRemovesExpiredCredentialsButNotLiveOnes(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	live := RefreshTokenRecord{
		ID: "rt-live", UserID: "u1", SessionID: "s-live", TokenHash: "h-live",
		ExpiresAt: now.Add(24 * time.Hour), CreatedAt: now,
	}
	expired := RefreshTokenRecord{
		ID: "rt-expired", UserID: "u1", SessionID: "s-live", TokenHash: "h-expired",
		ExpiresAt: now.Add(-time.Hour), CreatedAt: now.Add(-48 * time.Hour),
	}
	// Rotation revokes the previous token; those are the rows that pile up fastest.
	rotatedOut := RefreshTokenRecord{
		ID: "rt-rotated", UserID: "u1", SessionID: "s-live", TokenHash: "h-rotated",
		ExpiresAt: now.Add(24 * time.Hour), CreatedAt: now.Add(-72 * time.Hour),
	}
	// Revoked moments ago: still worth recognising as "already used" on a retry.
	justRevoked := RefreshTokenRecord{
		ID: "rt-fresh-revoke", UserID: "u1", SessionID: "s-live", TokenHash: "h-fresh",
		ExpiresAt: now.Add(24 * time.Hour), CreatedAt: now,
	}
	for _, tok := range []RefreshTokenRecord{live, expired, rotatedOut, justRevoked} {
		if err := db.InsertRefreshToken(ctx, tok); err != nil {
			t.Fatal(err)
		}
	}
	// InsertRefreshToken does not carry revoked_at — revocation is a separate update in
	// production, so the test has to go through the same path to be meaningful.
	if err := db.RevokeRefreshToken(ctx, "rt-rotated"); err != nil {
		t.Fatal(err)
	}
	if err := db.RevokeRefreshToken(ctx, "rt-fresh-revoke"); err != nil {
		t.Fatal(err)
	}
	// Age the rotated-out token's revocation past the grace period.
	if _, err := db.db.ExecContext(ctx, db.bind(`UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?`),
		formatTime(now.Add(-48*time.Hour)), "rt-rotated"); err != nil {
		t.Fatal(err)
	}

	removed, err := db.PurgeExpiredRefreshTokens(ctx, 24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 2 {
		t.Fatalf("removed %d refresh tokens, want 2 (the expired one and the long-revoked one)", removed)
	}
	// The only thing that must never happen.
	if _, found, err := db.RefreshTokenByHash(ctx, "h-live"); err != nil || !found {
		t.Fatal("a live refresh token was deleted")
	}
	if _, found, err := db.RefreshTokenByHash(ctx, "h-fresh"); err != nil || !found {
		t.Fatal("a just-revoked token was deleted inside its grace period, so a retry " +
			"would read as an unknown token instead of an already-used one")
	}
	if _, found, _ := db.RefreshTokenByHash(ctx, "h-expired"); found {
		t.Fatal("an expired refresh token survived the sweep")
	}
}

func TestSweepRemovesExpiredSessionsButNotLiveOnes(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	if err := db.InsertAuthSession(ctx, "sess-live", "u1", "10.0.0.1", "ua", now.Add(12*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertAuthSession(ctx, "sess-expired", "u1", "10.0.0.1", "ua", now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}

	removed, err := db.PurgeExpiredAuthSessions(ctx, 24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed %d sessions, want 1", removed)
	}
	if active, err := db.AuthSessionActive(ctx, "sess-live"); err != nil || !active {
		t.Fatal("a live session was deleted by the sweep")
	}
}

func TestSweepRemovesExpiredText2SQLCache(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	insert := func(key, sql string, expires time.Time) {
		t.Helper()
		if _, err := db.db.ExecContext(ctx, db.bind(
			`INSERT INTO text2sql_cache (cache_key, schema_name, mode, generated_sql, created_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?)`),
			key, "public", "generate", sql, formatTime(now), formatTime(expires)); err != nil {
			t.Fatalf("insert text2sql_cache: %v", err)
		}
	}
	insert("live", "SELECT 1", now.Add(time.Hour))
	insert("stale", "SELECT 2", now.Add(-time.Hour))

	removed, err := db.PurgeExpiredText2SQLCache(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed %d cache entries, want 1", removed)
	}
	var remaining int
	if err := db.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM text2sql_cache`).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 1 {
		t.Fatalf("text2sql_cache has %d rows after the sweep, want 1 (the live one)", remaining)
	}
}
