package proxy

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func TestChangeSetAuditFailurePreservesData(t *testing.T) {
	for _, action := range []string{"create", "delete", "submit", "approve"} {
		t.Run(action, func(t *testing.T) {
			db, raw := impactFailureStore(t)
			s := &Server{db: db}
			ctx := t.Context()
			state := "draft"
			if action == "approve" {
				state = "pending"
			}
			if action != "create" {
				if err := db.CreateChangeSet(ctx, store.ChangeSet{ID: "audit-failure-target", Title: "public fixture", Status: state}); err != nil {
					t.Fatal(err)
				}
			}
			before, err := db.ListChangeSets(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := raw.ExecContext(ctx, "ALTER TABLE admin_audit_logs RENAME TO unavailable_changeset_audit"); err != nil {
				t.Fatal(err)
			}
			method, path, body := http.MethodPost, "/admin/change-sets", `{"title":"public draft"}`
			if action != "create" {
				path += "/audit-failure-target"
				body = `{"note":"public reason"}`
				if action == "delete" {
					method = http.MethodDelete
				} else {
					path += "/" + action
				}
			}
			r := httptest.NewRequest(method, path, strings.NewReader(body)).WithContext(ctx)
			w := httptest.NewRecorder()
			if action == "create" {
				s.handleAdminChangeSets(w, r)
			} else {
				s.handleAdminChangeSetByID(w, r)
			}
			if w.Code != http.StatusInternalServerError {
				t.Errorf("audit failure returned status %d, want 500", w.Code)
			}
			for _, forbidden := range []string{"admin_audit_logs", "SQL", "unavailable_changeset_audit"} {
				if strings.Contains(w.Body.String(), forbidden) {
					t.Error("database internals exposed by failed mutation")
				}
			}
			after, err := db.ListChangeSets(ctx)
			if err != nil || !reflect.DeepEqual(before, after) {
				t.Error("audit failure changed committed data")
			}
			if _, err := raw.ExecContext(ctx, "ALTER TABLE unavailable_changeset_audit RENAME TO admin_audit_logs"); err != nil {
				t.Fatal(err)
			}
			audits, err := db.ListAdminAudit(ctx, 10)
			if err != nil || len(audits) != 0 {
				t.Error("failed mutation recorded a success audit")
			}
		})
	}
}
