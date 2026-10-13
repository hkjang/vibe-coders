package store

import (
	"errors"
	"reflect"
	"strconv"
	"testing"
	"time"
)

func TestAPIKeyRotationGrace(t *testing.T) {
	for _, mode := range []string{"unlimited-original", "bounded-grace", "capped-original", "immediate"} {
		t.Run(mode, func(t *testing.T) {
			db := openStoreForTest(t)
			defer db.Close()
			key := rotationSeed(t, db)
			grace := 5 * time.Minute
			if mode == "unlimited-original" {
				key.ExpiresAt = time.Time{}
			} else if mode == "capped-original" {
				key.ExpiresAt = time.Now().UTC().Add(time.Minute)
			} else if mode == "immediate" {
				grace = 0
			}
			if err := db.UpsertAPIKey(t.Context(), key); err != nil {
				t.Fatal("seed update failed")
			}
			created, rotated := rotationAudits(key, mode)
			started := time.Now().UTC()
			next, err := db.RotateAPIKey(t.Context(), key, created.APIKeyID, "synthetic-new-hash", grace, created, rotated)
			if err != nil || !next.ExpiresAt.Equal(key.ExpiresAt) || next.GraceEndsAt.Before(started) || next.GraceEndsAt.After(time.Now().Add(grace)) {
				t.Fatal("grace changed original replacement expiry or exceeded requested duration")
			}
			if mode == "capped-original" && !next.GraceEndsAt.Equal(key.ExpiresAt) {
				t.Fatal("grace extended original expiry")
			}
			old, found, err := db.GetAPIKey(t.Context(), key.ID)
			if err != nil || !found || grace > 0 && (old.Status != "active" || !old.RevokedAt.IsZero() || !old.ExpiresAt.Equal(next.GraceEndsAt)) || grace == 0 && old.Status != "revoked" {
				t.Fatal("old key lifecycle state is incorrect")
			}
			keys, err := db.ListAPIKeys(t.Context())
			if err != nil || len(keys) != 2 {
				t.Fatal("public metadata unavailable")
			}
			revision, err := db.APIKeyRevision(t.Context(), old)
			if err != nil {
				t.Fatal("review protection unavailable")
			}
			for _, public := range keys {
				if public.ID == key.ID && (public.ReplacedBy != next.ID || public.GraceEndsAt != formatTime(next.GraceEndsAt) || public.Revision != revision) {
					t.Fatal("public lineage or reviewed revision mismatch")
				}
			}
			// Audit retention and even stale administrative upserts cannot restore
			// rotation eligibility or extend the credential's effective deadline.
			if _, err := db.db.ExecContext(t.Context(), `DELETE FROM audit_events`); err != nil {
				t.Fatal("audit retention fixture failed")
			}
			if err := db.UpsertAPIKey(t.Context(), key); err != nil {
				t.Fatal("stale admin fixture failed")
			}
			authKey, known, err := db.FindActiveAPIKeyByHash(t.Context(), key.KeyHash)
			if err != nil || !known || !authKey.ExpiresAt.Equal(next.GraceEndsAt) {
				t.Fatal("audit removal or metadata edit bypassed grace deadline")
			}
			secondCreated, secondRotated := rotationAudits(key, "repeat")
			if _, err := db.RotateAPIKey(t.Context(), key, secondCreated.APIKeyID, "second-new-hash", grace, secondCreated, secondRotated); !errors.Is(err, ErrAPIKeyConflict) {
				t.Fatal("old credential rotated repeatedly after audit retention")
			}
			audit := AuthEvent{ID: "scope-after-rotation", EventType: "api_key_scopes_updated", APIKeyID: key.ID, ActorUserID: key.UserID}
			if err := db.UpdateAPIKeyScopes(t.Context(), key, []string{"models:read"}, audit); !errors.Is(err, ErrAPIKeyConflict) {
				t.Fatal("retired credential remained scope-editable")
			}
			if err := db.DeleteAPIKey(t.Context(), key.ID); err != nil {
				t.Fatal("delete fixture failed")
			}
			if err := db.UpsertAPIKey(t.Context(), key); err != nil {
				t.Fatal("recreation fixture failed")
			}
			if _, err := db.RotateAPIKey(t.Context(), key, secondCreated.APIKeyID, "second-new-hash", grace, secondCreated, secondRotated); !errors.Is(err, ErrAPIKeyConflict) {
				t.Fatal("deleted key ID lost its retirement tombstone")
			}
		})
	}
}

func TestAPIKeyRotationGraceBounds(t *testing.T) {
	for _, grace := range []time.Duration{-time.Second, time.Nanosecond, MaxAPIKeyRotationGrace + time.Second} {
		t.Run(strconv.FormatInt(int64(grace), 10), func(t *testing.T) {
			db := openStoreForTest(t)
			defer db.Close()
			key := rotationSeed(t, db)
			created, rotated := rotationAudits(key, "bounds")
			before, _ := db.ListAPIKeys(t.Context())
			if _, err := db.RotateAPIKey(t.Context(), key, created.APIKeyID, "new-hash", grace, created, rotated); err == nil {
				t.Fatal("invalid grace accepted")
			}
			after, err := db.ListAPIKeys(t.Context())
			if err != nil || !reflect.DeepEqual(before, after) {
				t.Fatal("invalid grace modified keys")
			}
		})
	}
}

func TestAPIKeyRotationGraceConcurrentPools(t *testing.T) {
	first, second := routingPatchStores(t)
	key := rotationSeed(t, first)
	start, results := make(chan struct{}), make(chan error, 2)
	for i, db := range []*SQLStore{first, second} {
		go func() {
			<-start
			suffix := strconv.Itoa(i)
			created, rotated := rotationAudits(key, suffix)
			_, err := db.RotateAPIKey(t.Context(), key, created.APIKeyID, "synthetic-new-"+suffix, MaxAPIKeyRotationGrace, created, rotated)
			results <- err
		}()
	}
	close(start)
	wins, conflicts := 0, 0
	for range 2 {
		if err := <-results; err == nil {
			wins++
		} else if errors.Is(err, ErrAPIKeyConflict) {
			conflicts++
		} else {
			t.Fatal("unexpected capped-grace concurrent rotation error")
		}
	}
	if wins != 1 || conflicts != 1 {
		t.Fatal("capped grace did not serialize rotation")
	}
}

func TestAPIKeyRotationGraceAtomicFailure(t *testing.T) {
	for _, failure := range []string{"audit", "commit"} {
		t.Run(failure, func(t *testing.T) {
			db := openStoreForTest(t)
			defer db.Close()
			db.db.SetMaxOpenConns(1)
			key := rotationSeed(t, db)
			created, rotated := rotationAudits(key, failure)
			if failure == "audit" {
				if err := db.InsertAuditEvent(t.Context(), rotated); err != nil {
					t.Fatal("audit collision fixture failed")
				}
			} else {
				installRotationCommitFailure(t, db)
			}
			before, _ := db.ListAPIKeys(t.Context())
			if _, err := db.RotateAPIKey(t.Context(), key, created.APIKeyID, "new-hash", time.Minute, created, rotated); err == nil {
				t.Fatal("faulted grace rotation succeeded")
			}
			after, err := db.ListAPIKeys(t.Context())
			var count int
			if err != nil || !reflect.DeepEqual(before, after) || db.db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM api_key_rotations`).Scan(&count) != nil || count != 0 {
				t.Fatal("faulted rotation left grace, replacement or lineage changes")
			}
		})
	}
}
