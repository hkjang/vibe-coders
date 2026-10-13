package store

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

func adminKeyAudits(key APIKeyRecord, hard bool) (AdminAuditLog, AuthEvent) {
	action := "api_key.status"
	if hard {
		action = "api_key.delete"
	}
	return AdminAuditLog{ID: "admin-revoke", AdminID: "actor", Action: action}, AuthEvent{ID: "auth-revoke", ActorUserID: "actor", APIKeyID: key.ID, EventType: "api_key_revoked"}
}

func TestAdminAPIKeyPatchAtomicFailure(t *testing.T) {
	for _, fault := range []string{"admin-audit", "auth-audit", "commit"} {
		t.Run(fault, func(t *testing.T) {
			db := openStoreForTest(t)
			defer db.Close()
			db.db.SetMaxOpenConns(1)
			key := rotationSeed(t, db)
			updated := key
			updated.Name, updated.Role = "changed", "viewer"
			audit := AdminAuditLog{ID: "patch-audit", AdminID: "actor", Action: "api_key.update"}
			event := AuthEvent{ID: "patch-role", ActorUserID: "actor", APIKeyID: key.ID, EventType: "role_changed"}
			switch fault {
			case "admin-audit":
				if db.InsertAdminAudit(t.Context(), audit) != nil {
					t.Fatal("audit fixture failed")
				}
			case "auth-audit":
				if db.InsertAuditEvent(t.Context(), event) != nil {
					t.Fatal("audit fixture failed")
				}
			case "commit":
				installRotationCommitFailure(t, db)
			}
			beforeAdmin, errAdmin := db.ListAdminAudit(t.Context(), 20)
			beforeAuth, errAuth := db.ListAuditEvents(t.Context(), 20)
			if errAdmin != nil || errAuth != nil {
				t.Fatal("audit fixture unavailable")
			}
			if db.PatchAdminAPIKey(t.Context(), key, updated, audit, &event) == nil {
				t.Fatal("fault must reject patch")
			}
			current, found, err := db.GetAPIKey(t.Context(), key.ID)
			afterAdmin, errAdmin := db.ListAdminAudit(t.Context(), 20)
			afterAuth, errAuth := db.ListAuditEvents(t.Context(), 20)
			if err != nil || errAdmin != nil || errAuth != nil || !found || !reflect.DeepEqual(key, current) || !reflect.DeepEqual(beforeAdmin, afterAdmin) || !reflect.DeepEqual(beforeAuth, afterAuth) {
				t.Fatal("failed patch leaked metadata, role or audit changes")
			}
		})
	}
}

func TestAdminAPIKeyDeletePreservesRotationLineage(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	key := rotationSeed(t, db)
	created, rotated := rotationAudits(key, "admin-delete")
	next, err := db.RotateAPIKey(t.Context(), key, created.APIKeyID, "synthetic-next-hash", time.Minute, created, rotated)
	if err != nil {
		t.Fatal("rotation fixture failed")
	}
	old, found, err := db.GetAPIKey(t.Context(), key.ID)
	if err != nil || !found {
		t.Fatal("rotation fixture unavailable")
	}
	audit, event := adminKeyAudits(old, true)
	if db.RevokeAdminAPIKey(t.Context(), old, true, audit, event) != nil {
		t.Fatal("reviewed hard delete failed")
	}
	if _, found, err := db.GetAPIKey(t.Context(), old.ID); err != nil || found {
		t.Fatal("hard delete retained key row")
	}
	if replacement, found, err := db.GetAPIKey(t.Context(), next.ID); err != nil || !found || replacement.Status != "active" {
		t.Fatal("hard delete damaged replacement")
	}
	events, err := db.ListAuditEvents(t.Context(), 20)
	if err != nil || len(events) != 3 {
		t.Fatal("hard delete removed historical rotation audit")
	}
	// Recreating a retired ID must not erase its independent retirement marker.
	if db.UpsertAPIKey(t.Context(), key) != nil {
		t.Fatal("recreation fixture failed")
	}
	secondCreated, secondRotated := rotationAudits(key, "repeat")
	if _, err := db.RotateAPIKey(t.Context(), key, secondCreated.APIKeyID, "synthetic-repeat-hash", time.Minute, secondCreated, secondRotated); !errors.Is(err, ErrAPIKeyConflict) {
		t.Fatal("hard delete erased durable rotation lineage")
	}
}

func TestAdminAPIKeyChangeAtomicFailure(t *testing.T) {
	for _, hard := range []bool{false, true} {
		for _, fault := range []string{"admin-audit", "auth-audit", "commit"} {
			t.Run(map[bool]string{false: "revoke", true: "delete"}[hard]+"/"+fault, func(t *testing.T) {
				db := openStoreForTest(t)
				defer db.Close()
				db.db.SetMaxOpenConns(1)
				key := rotationSeed(t, db)
				audit, event := adminKeyAudits(key, hard)
				switch fault {
				case "admin-audit":
					if db.InsertAdminAudit(t.Context(), audit) != nil {
						t.Fatal("fixture failed")
					}
				case "auth-audit":
					if db.InsertAuditEvent(t.Context(), event) != nil {
						t.Fatal("fixture failed")
					}
				case "commit":
					installRotationCommitFailure(t, db)
				}
				beforeAdmin, _ := db.ListAdminAudit(t.Context(), 20)
				beforeAuth, _ := db.ListAuditEvents(t.Context(), 20)
				if db.RevokeAdminAPIKey(t.Context(), key, hard, audit, event) == nil {
					t.Fatal("fault must reject change")
				}
				current, found, err := db.GetAPIKey(t.Context(), key.ID)
				afterAdmin, errAdmin := db.ListAdminAudit(t.Context(), 20)
				afterAuth, errAuth := db.ListAuditEvents(t.Context(), 20)
				if err != nil || errAdmin != nil || errAuth != nil || !found || !reflect.DeepEqual(key, current) || !reflect.DeepEqual(beforeAdmin, afterAdmin) || !reflect.DeepEqual(beforeAuth, afterAuth) {
					t.Fatal("failed transaction leaked a key change or audit")
				}
			})
		}
	}
}

func TestAdminAPIKeyPatchVersusRevoke(t *testing.T) {
	for _, hard := range []bool{false, true} {
		for _, order := range []string{"patch-first", "revoke-first", "concurrent"} {
			t.Run(map[bool]string{false: "revoke", true: "delete"}[hard]+"/"+order, func(t *testing.T) {
				first, second := routingPatchStores(t)
				key := rotationSeed(t, first)
				updated := key
				updated.Name = "new name"
				audit, event := adminKeyAudits(key, hard)
				revoke := func() error { return first.RevokeAdminAPIKey(t.Context(), key, hard, audit, event) }
				patch := func() error {
					return second.PatchAdminAPIKey(t.Context(), key, updated, AdminAuditLog{ID: "patch", AdminID: "actor", Action: "api_key.update"}, nil)
				}
				var revokeErr, patchErr error
				switch order {
				case "patch-first":
					patchErr, revokeErr = patch(), revoke()
				case "revoke-first":
					revokeErr, patchErr = revoke(), patch()
				default:
					start, done := make(chan struct{}), make(chan error, 1)
					go func() { <-start; done <- revoke() }()
					close(start)
					patchErr, revokeErr = patch(), <-done
				}
				if !((revokeErr == nil && errors.Is(patchErr, ErrAPIKeyConflict)) || (patchErr == nil && errors.Is(revokeErr, ErrAPIKeyConflict))) {
					t.Fatal("competing changes must have one winner")
				}
				current, found, err := first.GetAPIKey(t.Context(), key.ID)
				if err != nil {
					t.Fatal("lookup failed")
				}
				audits, err := first.ListAdminAudit(t.Context(), 20)
				if err != nil || len(audits) != 1 {
					t.Fatal("only winning audit may commit")
				}
				if revokeErr == nil {
					if hard && found || !hard && (!found || current.Status != "revoked" || current.Name != key.Name) {
						t.Fatal("stale patch restored revoked/deleted key")
					}
				} else if !found || current.Name != updated.Name || current.Status != "active" {
					t.Fatal("stale revocation overwrote patch")
				}
			})
		}
	}
}
