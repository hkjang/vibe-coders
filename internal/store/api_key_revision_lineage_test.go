package store

import (
	"errors"
	"reflect"
	"testing"
)

func TestAPIKeyRevisionChangesWhenRotationKeepsRecordUnchanged(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	key := rotationSeed(t, db)
	before, err := db.APIKeyRevision(t.Context(), key)
	if err != nil {
		t.Fatal("revision fixture unavailable")
	}
	created, rotated := rotationAudits(key, "review-lineage")
	if _, err := db.RotateAPIKey(t.Context(), key, created.APIKeyID, "synthetic-lineage-hash", MaxAPIKeyRotationGrace, created, rotated); err != nil {
		t.Fatal("rotation fixture failed")
	}
	after, found, err := db.GetAPIKey(t.Context(), key.ID)
	if err != nil || !found || !reflect.DeepEqual(key, after) {
		t.Fatal("fixture must cap grace to the unchanged original expiry")
	}
	revision, err := db.APIKeyRevision(t.Context(), after)
	if err != nil || revision == before {
		t.Fatal("rotation lineage must invalidate the pre-rotation review")
	}
	rows, err := db.ListAPIKeys(t.Context())
	if err != nil {
		t.Fatal("catalog unavailable")
	}
	for _, row := range rows {
		if row.ID == key.ID && row.Revision != revision {
			t.Fatal("catalog and server disagree on rotated snapshot")
		}
	}
}

func TestReviewedAdminKeyPatchChecksLineageInsideTransaction(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	db.db.SetMaxOpenConns(1)
	key := rotationSeed(t, db)
	revision, err := db.APIKeyRevision(t.Context(), key)
	if err != nil {
		t.Fatal("revision unavailable")
	}
	created, rotated := rotationAudits(key, "atomic-review")
	if _, err := db.RotateAPIKey(t.Context(), key, created.APIKeyID, "synthetic-atomic-lineage", MaxAPIKeyRotationGrace, created, rotated); err != nil {
		t.Fatal("rotation failed")
	}
	updated := key
	updated.Role, updated.Scopes = "viewer", []string{"models:read"}
	audit := AdminAuditLog{ID: "atomic-review-patch", AdminID: "actor", Action: "api_key.update"}
	event := AuthEvent{ID: "atomic-review-role", ActorUserID: "actor", APIKeyID: key.ID, EventType: "role_changed"}
	if err := db.PatchAdminAPIKey(t.Context(), key, updated, audit, &event, revision); !errors.Is(err, ErrAPIKeyConflict) {
		t.Fatal("storage must reject review made before rotation even if its row predicate matches")
	}
	after, found, err := db.GetAPIKey(t.Context(), key.ID)
	if err != nil || !found || !reflect.DeepEqual(after, key) {
		t.Fatal("conflict failed to roll back key edit")
	}
	audits, err := db.ListAdminAudit(t.Context(), 20)
	if err != nil || len(audits) != 0 {
		t.Fatal("conflict leaked admin audit")
	}
	events, err := db.ListAuditEvents(t.Context(), 20)
	if err != nil || len(events) != 2 {
		t.Fatal("conflict leaked role audit")
	}
	// Explicitly reopening and reviewing the retiring key remains supported;
	// it changes only that key, not the replacement's independent permissions.
	fresh, err := db.APIKeyRevision(t.Context(), key)
	if err != nil || fresh == revision {
		t.Fatal("new lineage revision missing")
	}
	if err := db.PatchAdminAPIKey(t.Context(), key, updated, audit, &event, fresh); err != nil {
		t.Fatal("fresh review rejected")
	}
	replacement, found, err := db.GetAPIKey(t.Context(), created.APIKeyID)
	if err != nil || !found || replacement.Role != key.Role || !reflect.DeepEqual(replacement.Scopes, key.Scopes) {
		t.Fatal("edit changed replacement authority")
	}
}

func TestReviewedAdminKeyPatchVersusCappedRotation(t *testing.T) {
	first, second := routingPatchStores(t)
	key := rotationSeed(t, first)
	revision, err := first.APIKeyRevision(t.Context(), key)
	if err != nil {
		t.Fatal("revision unavailable")
	}
	updated := key
	updated.Scopes = []string{"models:read"}
	created, rotated := rotationAudits(key, "edit-race")
	start := make(chan struct{})
	results := make(chan error, 2)
	go func() {
		<-start
		_, err := first.RotateAPIKey(t.Context(), key, created.APIKeyID, "synthetic-edit-race", MaxAPIKeyRotationGrace, created, rotated)
		results <- err
	}()
	go func() {
		<-start
		results <- second.PatchAdminAPIKey(t.Context(), key, updated, AdminAuditLog{ID: "edit-race-audit", AdminID: "actor", Action: "api_key.update"}, nil, revision)
	}()
	close(start)
	wins, conflicts := 0, 0
	for range 2 {
		err := <-results
		if err == nil {
			wins++
		} else if errors.Is(err, ErrAPIKeyConflict) {
			conflicts++
		} else {
			t.Fatal("unexpected concurrent edit/rotation error")
		}
	}
	if wins != 1 || conflicts != 1 {
		t.Fatal("reviewed edit and capped rotation must not both commit")
	}
	original, found, err := first.GetAPIKey(t.Context(), key.ID)
	if err != nil || !found {
		t.Fatal("original key missing")
	}
	replacement, exists, err := first.GetAPIKey(t.Context(), created.APIKeyID)
	if err != nil {
		t.Fatal("replacement lookup unavailable")
	}
	audits, err := first.ListAdminAudit(t.Context(), 20)
	if err != nil {
		t.Fatal("audit unavailable")
	}
	if exists {
		if !reflect.DeepEqual(original.Scopes, key.Scopes) || !reflect.DeepEqual(replacement.Scopes, key.Scopes) || len(audits) != 0 {
			t.Fatal("losing edit changed grants or audit")
		}
	} else if !reflect.DeepEqual(original.Scopes, updated.Scopes) || len(audits) != 1 {
		t.Fatal("winning edit not persisted atomically")
	}
}
