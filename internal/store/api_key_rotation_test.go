package store

import (
	"errors"
	"reflect"
	"strconv"
	"testing"
	"time"
)

func rotationSeed(t *testing.T, db *SQLStore) APIKeyRecord {
	t.Helper()
	key := APIKeyRecord{ID: "rotation-old", Name: "rotation fixture", KeyHash: "synthetic-old-hash", Owner: "fixture", UserID: "user-fixture", Team: "team-fixture", Role: "developer", Status: "active",
		Scopes: []string{}, AllowedIPs: []string{"192.0.2.0/24"}, AllowedModels: []string{"fixture-*"}, DeniedModels: []string{"fixture-blocked"},
		AllowedProviders: []string{"fixture-provider"}, DeniedProviders: []string{"fixture-blocked"}, BudgetLimitKRW: 15.125,
		ExpiresAt: time.Now().UTC().Add(time.Hour), CreatedAt: time.Now().UTC().Add(-time.Hour)}
	if err := db.UpsertAPIKey(t.Context(), key); err != nil {
		t.Fatal("seed failed")
	}
	stored, found, err := db.GetAPIKey(t.Context(), key.ID)
	if err != nil || !found {
		t.Fatal("seed unavailable")
	}
	return stored
}

func rotationAudits(key APIKeyRecord, suffix string) (AuthEvent, AuthEvent) {
	created := AuthEvent{ID: "created-" + suffix, EventType: "api_key_created", APIKeyID: "replacement-" + suffix, ActorUserID: key.UserID, TeamID: key.Team, Detail: "synthetic rotation review"}
	rotated := created
	rotated.ID, rotated.EventType, rotated.APIKeyID = "rotated-"+suffix, "api_key_rotated", key.ID
	return created, rotated
}

func TestAPIKeyRotationAtomicFailure(t *testing.T) {
	for _, failure := range []string{"replacement-collision", "created-audit", "rotated-audit", "missing-audit", "commit"} {
		t.Run(failure, func(t *testing.T) {
			db := openStoreForTest(t)
			defer db.Close()
			db.db.SetMaxOpenConns(1)
			key := rotationSeed(t, db)
			created, rotated := rotationAudits(key, "failure")
			var drop string
			switch failure {
			case "replacement-collision":
				if err := db.UpsertAPIKey(t.Context(), APIKeyRecord{ID: created.APIKeyID, Name: "existing", KeyHash: "existing-hash"}); err != nil {
					t.Fatal("collision seed failed")
				}
			case "created-audit", "rotated-audit":
				event := created
				if failure == "rotated-audit" {
					event = rotated
				}
				if err := db.InsertAuditEvent(t.Context(), event); err != nil {
					t.Fatal("audit seed failed")
				}
			case "missing-audit":
				rotated.ID = ""
			case "commit":
				drop = installRotationCommitFailure(t, db)
			}
			beforeKeys, _ := db.ListAPIKeys(t.Context())
			beforeAudit, _ := db.ListAuditEvents(t.Context(), 10)
			result, err := db.RotateAPIKey(t.Context(), key, created.APIKeyID, "synthetic-new-hash", 0, created, rotated)
			if err == nil || result.ID != "" {
				t.Fatal("failed rotation returned a replacement")
			}
			afterKeys, keyErr := db.ListAPIKeys(t.Context())
			afterAudit, auditErr := db.ListAuditEvents(t.Context(), 10)
			stored, _, storedErr := db.GetAPIKey(t.Context(), key.ID)
			if keyErr != nil || auditErr != nil || storedErr != nil || !reflect.DeepEqual(beforeKeys, afterKeys) || !reflect.DeepEqual(beforeAudit, afterAudit) || !reflect.DeepEqual(key, stored) {
				t.Fatal("failed rotation changed persisted keys or audit")
			}
			if drop != "" {
				if _, err := db.db.ExecContext(t.Context(), drop); err != nil {
					t.Fatal("failed transaction left connection unusable")
				}
				if _, err := db.RotateAPIKey(t.Context(), key, created.APIKeyID, "synthetic-new-hash", 0, created, rotated); err != nil {
					t.Fatal("recovery after rejected commit failed")
				}
			}
		})
	}
}

func installRotationCommitFailure(t *testing.T, db *SQLStore) string {
	t.Helper()
	statements := []string{
		`CREATE TABLE rotation_fk_parent (id INTEGER PRIMARY KEY)`,
		`CREATE TABLE rotation_fk_child (parent_id INTEGER REFERENCES rotation_fk_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
	}
	drop := `DROP TRIGGER rotation_bad_commit`
	if db.dialect == "postgres" {
		statements = append(statements,
			`CREATE FUNCTION rotation_bad_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO rotation_fk_child VALUES (1); RETURN NEW; END $$`,
			`CREATE TRIGGER rotation_bad_commit AFTER INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION rotation_bad_commit()`)
		drop += ` ON audit_events`
	} else {
		statements = append([]string{`PRAGMA foreign_keys = ON`}, statements...)
		statements = append(statements, `CREATE TRIGGER rotation_bad_commit AFTER INSERT ON audit_events BEGIN INSERT INTO rotation_fk_child VALUES (1); END`)
	}
	for _, statement := range statements {
		if _, err := db.db.ExecContext(t.Context(), statement); err != nil {
			t.Fatal("commit fault setup failed")
		}
	}
	return drop
}

func TestAPIKeyRotationConcurrentPools(t *testing.T) {
	first, second := routingPatchStores(t)
	key := rotationSeed(t, first)
	start, results := make(chan struct{}), make(chan error, 2)
	for i, db := range []*SQLStore{first, second} {
		go func() {
			<-start
			suffix := strconv.Itoa(i)
			created, rotated := rotationAudits(key, suffix)
			_, err := db.RotateAPIKey(t.Context(), key, created.APIKeyID, "synthetic-new-"+suffix, 0, created, rotated)
			results <- err
		}()
	}
	close(start)
	wins, conflicts := 0, 0
	for range 2 {
		err := <-results
		if err == nil {
			wins++
		} else if errors.Is(err, ErrAPIKeyConflict) {
			conflicts++
		} else {
			t.Fatal("unexpected concurrent rotation error")
		}
	}
	keys, keyErr := second.ListAPIKeys(t.Context())
	audits, auditErr := second.ListAuditEvents(t.Context(), 10)
	if wins != 1 || conflicts != 1 || keyErr != nil || auditErr != nil || len(keys) != 2 || len(audits) != 2 {
		t.Fatal("rotation did not leave exactly one replacement and its audit pair")
	}
}

func TestAPIKeyRotationRejectsStaleConstraints(t *testing.T) {
	for _, field := range []string{"name", "hash", "owner", "team", "user", "service", "role", "status", "scope", "ip", "model", "denied-model", "provider", "denied-provider", "budget", "expiry", "revoked"} {
		t.Run(field, func(t *testing.T) {
			db := openStoreForTest(t)
			defer db.Close()
			key := rotationSeed(t, db)
			next := key
			switch field {
			case "name":
				next.Name = "changed"
			case "hash":
				next.KeyHash = "changed"
			case "owner":
				next.Owner = "changed"
			case "team":
				next.Team = "changed"
			case "user":
				next.UserID = "changed"
			case "service":
				next.ServiceAccountID = "changed"
			case "role":
				next.Role = "viewer"
			case "status":
				next.Status = "revoked"
			case "scope":
				next.Scopes = []string{"models:read"}
			case "ip":
				next.AllowedIPs = []string{}
			case "model":
				next.AllowedModels = []string{}
			case "denied-model":
				next.DeniedModels = []string{}
			case "provider":
				next.AllowedProviders = []string{}
			case "denied-provider":
				next.DeniedProviders = []string{}
			case "budget":
				next.BudgetLimitKRW = 1
			case "expiry":
				next.ExpiresAt = time.Now().UTC().Add(time.Minute)
			case "revoked":
				next.RevokedAt = time.Now().UTC()
			}
			if err := db.UpsertAPIKey(t.Context(), next); err != nil {
				t.Fatal("edit failed")
			}
			created, rotated := rotationAudits(key, "stale")
			result, err := db.RotateAPIKey(t.Context(), key, created.APIKeyID, "synthetic-new-hash", 0, created, rotated)
			if !errors.Is(err, ErrAPIKeyConflict) || result.ID != "" {
				t.Fatal("stale security snapshot was accepted")
			}
			keys, _ := db.ListAPIKeys(t.Context())
			audits, _ := db.ListAuditEvents(t.Context(), 10)
			if len(keys) != 1 || len(audits) != 0 {
				t.Fatal("stale rotation left replacement or audit")
			}
		})
	}
}
