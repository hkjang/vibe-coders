package store

import (
	"errors"
	"reflect"
	"testing"
)

func TestAPIKeyRotationVersusScopeEdit(t *testing.T) {
	for _, order := range []string{"scope-first", "rotation-first", "concurrent"} {
		t.Run(order, func(t *testing.T) {
			first, second := routingPatchStores(t)
			key := rotationSeed(t, first)
			created, rotated := rotationAudits(key, "scope-race")
			audit := AuthEvent{ID: "scope-edit", EventType: "api_key_scopes_updated", APIKeyID: key.ID, ActorUserID: key.UserID}
			rotate := func() error {
				_, err := first.RotateAPIKey(t.Context(), key, created.APIKeyID, "synthetic-new-hash", 0, created, rotated)
				return err
			}
			edit := func() error { return second.UpdateAPIKeyScopes(t.Context(), key, []string{"models:read"}, audit) }
			var rotateErr, editErr error
			switch order {
			case "scope-first":
				editErr, rotateErr = edit(), rotate()
			case "rotation-first":
				rotateErr, editErr = rotate(), edit()
			default:
				start, done := make(chan struct{}), make(chan error, 1)
				go func() { <-start; done <- rotate() }()
				close(start)
				editErr, rotateErr = edit(), <-done
			}
			if !((rotateErr == nil && errors.Is(editErr, ErrAPIKeyConflict)) || (editErr == nil && errors.Is(rotateErr, ErrAPIKeyConflict))) {
				t.Fatal("competing security changes must have exactly one winner")
			}
			old, found, err := first.GetAPIKey(t.Context(), key.ID)
			if err != nil || !found {
				t.Fatal("original unavailable")
			}
			keys, _ := second.ListAPIKeys(t.Context())
			audits, _ := second.ListAuditEvents(t.Context(), 10)
			if rotateErr == nil {
				if old.Status != "revoked" || len(keys) != 2 || len(audits) != 2 || !reflect.DeepEqual(old.Scopes, key.Scopes) {
					t.Fatal("stale scope edit resurrected or modified the rotated key")
				}
			} else if old.Status != "active" || len(keys) != 1 || len(audits) != 1 || !reflect.DeepEqual(old.Scopes, []string{"models:read"}) {
				t.Fatal("rotation overwrote the winning scope edit")
			}
		})
	}
}

func TestAPIKeyScopesAtomicFailure(t *testing.T) {
	for _, fault := range []string{"audit", "commit"} {
		t.Run(fault, func(t *testing.T) {
			db := openStoreForTest(t)
			defer db.Close()
			db.db.SetMaxOpenConns(1)
			key := rotationSeed(t, db)
			audit := AuthEvent{ID: "scope-edit", EventType: "api_key_scopes_updated", APIKeyID: key.ID, ActorUserID: key.UserID}
			if fault == "audit" {
				if err := db.InsertAuditEvent(t.Context(), audit); err != nil {
					t.Fatal("audit setup failed")
				}
			} else {
				installRotationCommitFailure(t, db)
			}
			beforeAudit, _ := db.ListAuditEvents(t.Context(), 10)
			if err := db.UpdateAPIKeyScopes(t.Context(), key, []string{"models:read"}, audit); err == nil {
				t.Fatal("failed audit was accepted")
			}
			stored, found, err := db.GetAPIKey(t.Context(), key.ID)
			afterAudit, auditErr := db.ListAuditEvents(t.Context(), 10)
			if err != nil || !found || auditErr != nil || !reflect.DeepEqual(key, stored) || !reflect.DeepEqual(beforeAudit, afterAudit) {
				t.Fatal("failed scope edit changed security state or audit")
			}
		})
	}
}
