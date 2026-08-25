package store

import (
	"context"
	"time"
)

// Sweeping rows that have already expired.
//
// Several tables carry expires_at and are correctly treated as expired when read —
// an expired refresh token is refused, an expired cache entry misses — but the rows
// themselves were never deleted. They are dead weight the moment they expire, and they
// accumulate with authentication traffic rather than staying bounded.
//
// refresh_tokens is the sharpest: a token is not written once per login but once per
// rotation, so a long-lived session leaves a row behind on every refresh interval, each
// one immediately revoked and never removed.
//
// The codebase already sweeps oidc_flow_states, inferred_sessions, embedding_cache and
// chat_semantic_cache the same way; these were omissions rather than decisions.
//
// Deliberately not swept here: login_attempts and secret_events have no expiry and are
// never read by the application — they exist as a security audit trail, where the value
// is in keeping them.

// PurgeExpiredRefreshTokens removes refresh tokens that can no longer be redeemed.
// A revoked token is finished the moment it is rotated, so it is dropped too — but only
// after a grace period, so a rotation racing with a retry can still be recognised as
// "already used" rather than looking like an unknown token.
func (s *SQLStore) PurgeExpiredRefreshTokens(ctx context.Context, revokedGrace time.Duration) (int64, error) {
	now := time.Now().UTC()
	if revokedGrace <= 0 {
		revokedGrace = 24 * time.Hour
	}
	res, err := s.db.ExecContext(ctx, s.bind(
		`DELETE FROM refresh_tokens WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)`),
		formatTime(now), formatTime(now.Add(-revokedGrace)))
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// PurgeExpiredAuthSessions removes sessions that can no longer authenticate anything.
// Revoked sessions keep the same grace period as tokens so an explicit logout still
// reads as "revoked" rather than "never existed" for a short while afterwards.
func (s *SQLStore) PurgeExpiredAuthSessions(ctx context.Context, revokedGrace time.Duration) (int64, error) {
	now := time.Now().UTC()
	if revokedGrace <= 0 {
		revokedGrace = 24 * time.Hour
	}
	res, err := s.db.ExecContext(ctx, s.bind(
		`DELETE FROM auth_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)`),
		formatTime(now), formatTime(now.Add(-revokedGrace)))
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// PurgeExpiredText2SQLCache removes cache entries that already miss on read.
func (s *SQLStore) PurgeExpiredText2SQLCache(ctx context.Context) (int64, error) {
	res, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM text2sql_cache WHERE expires_at < ?`),
		formatTime(time.Now().UTC()))
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}
