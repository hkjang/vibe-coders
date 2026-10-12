package proxy

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func TestChangeSetStageAuditFailurePreservesSettingAndMarker(t *testing.T) {
	for _, action := range []string{"apply", "rollback"} {
		t.Run(action, func(t *testing.T) {
			db, raw := impactFailureStore(t)
			_, server := serveAdminModelsTestStore(t, "", db)
			ctx := t.Context()
			status := "approved"
			if action == "rollback" {
				status = "applied"
			}
			if err := db.CreateChangeSet(ctx, store.ChangeSet{ID: "stage-audit", Title: "stage audit", Status: status,
				Items: []store.ChangeSetItem{{Kind: "setting", Key: "retention.request_days", Value: "45"}},
				Prior: []store.ChangeSetItem{{Kind: "setting", Key: "retention.request_days", Value: "30"}},
			}); err != nil {
				t.Fatal(err)
			}
			before, _, err := db.GetChangeSet(ctx, "stage-audit")
			if err != nil {
				t.Fatal(err)
			}
			beforeSettings, err := db.ListAdminSettings(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := raw.ExecContext(ctx, "ALTER TABLE admin_audit_logs RENAME TO unavailable_stage_audit"); err != nil {
				t.Fatal(err)
			}
			response, _ := req(t, http.MethodPost, server.URL+"/admin/change-sets/stage-audit/"+action, `{"note":"stage reason"}`)
			if response.StatusCode != http.StatusInternalServerError {
				t.Errorf("audit failure returned %d, want 500", response.StatusCode)
			}
			after, _, err := db.GetChangeSet(ctx, "stage-audit")
			if err != nil || !reflect.DeepEqual(before, after) {
				t.Error("failed stage changed recovery marker or prior values")
			}
			afterSettings, err := db.ListAdminSettings(ctx)
			if err != nil || !reflect.DeepEqual(beforeSettings, afterSettings) {
				t.Error("failed stage changed settings")
			}
			history, err := db.ListAdminSettingHistory(ctx, "retention.request_days", 10)
			if err != nil || len(history) != 0 {
				t.Error("failed stage appended setting history")
			}
		})
	}
}

func TestChangeSetPendingDeletionRequiresRecovery(t *testing.T) {
	for _, status := range []string{"apply_pending", "rollback_pending"} {
		t.Run(status, func(t *testing.T) {
			db := openTestStore(t)
			defer db.Close()
			s := &Server{db: db}
			if err := db.CreateChangeSet(t.Context(), store.ChangeSet{ID: "pending-recovery", Title: "pending", Status: status,
				Prior: []store.ChangeSetItem{{Kind: "setting", Key: "retention.request_days", Value: "30"}},
			}); err != nil {
				t.Fatal(err)
			}
			before, _, err := db.GetChangeSet(t.Context(), "pending-recovery")
			if err != nil {
				t.Fatal(err)
			}
			r := httptest.NewRequest(http.MethodDelete, "/admin/change-sets/pending-recovery", strings.NewReader(`{"note":"delete pending"}`))
			w := httptest.NewRecorder()
			s.handleAdminChangeSetByID(w, r)
			if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "change_set_recovery_pending") {
				t.Error("pending recovery deletion was not refused")
			}
			after, found, err := db.GetChangeSet(t.Context(), before.ID)
			if err != nil || !found || !reflect.DeepEqual(before, after) {
				t.Error("pending recovery marker or prior values were lost")
			}
			audits, err := db.ListAdminAudit(t.Context(), 10)
			if err != nil || len(audits) != 0 {
				t.Error("refused deletion recorded a success audit")
			}
		})
	}
}

func TestChangeSetFinalizeAuditFailureResumesWithoutRewrite(t *testing.T) {
	for _, action := range []string{"apply", "rollback"} {
		t.Run(action, func(t *testing.T) {
			db, raw := impactFailureStore(t)
			_, server := serveAdminModelsTestStore(t, "", db)
			ctx := t.Context()
			status, final := "apply_pending", "applied"
			if action == "rollback" {
				status, final = "rollback_pending", "rolled_back"
			}
			// Represents a durable pending row, including one created by an older
			// version. Recovery must not invent the original persistence event.
			if err := db.CreateChangeSet(ctx, store.ChangeSet{ID: "finish-audit", Title: "finish", Status: status,
				Prior: []store.ChangeSetItem{{Kind: "setting", Key: "retention.request_days", Value: "30"}},
			}); err != nil {
				t.Fatal(err)
			}
			if err := db.UpsertAdminSetting(ctx, store.AdminSetting{Key: "retention.request_days", Category: "retention", ValueJSON: "30", ValueType: "int"}, "original-operator", "already stored"); err != nil {
				t.Fatal(err)
			}
			before, _, _ := db.GetChangeSet(ctx, "finish-audit")
			beforeSetting, _, _ := db.GetAdminSetting(ctx, "retention.request_days")
			if _, err := raw.ExecContext(ctx, "ALTER TABLE admin_audit_logs RENAME TO unavailable_finalize_audit"); err != nil {
				t.Fatal(err)
			}
			url := server.URL + "/admin/change-sets/finish-audit/" + action
			response, body := req(t, http.MethodPost, url, `{"note":"recovery reason"}`)
			if response.StatusCode != http.StatusServiceUnavailable {
				t.Fatalf("final audit failure returned %d, want 503", response.StatusCode)
			}
			errBody, ok := body["error"].(map[string]any)
			if !ok || errBody["code"] != "change_set_finalize_pending" {
				t.Error("completion failure did not retain explicit recovery error")
			}
			afterFailure, found, err := db.GetChangeSet(ctx, before.ID)
			if err != nil || !found || !reflect.DeepEqual(before, afterFailure) {
				t.Fatal("failed final audit lost the recovery marker")
			}
			if _, err := raw.ExecContext(ctx, "ALTER TABLE unavailable_finalize_audit RENAME TO admin_audit_logs"); err != nil {
				t.Fatal(err)
			}
			response, body = req(t, http.MethodPost, url, `{"note":"recovery reason"}`)
			if response.StatusCode != http.StatusOK || body["status"] != final {
				t.Fatal("pending operation did not resume")
			}
			afterSetting, _, err := db.GetAdminSetting(ctx, "retention.request_days")
			history, historyErr := db.ListAdminSettingHistory(ctx, "retention.request_days", 10)
			audits, auditErr := db.ListAdminAudit(ctx, 10)
			if err != nil || historyErr != nil || auditErr != nil || !reflect.DeepEqual(beforeSetting, afterSetting) || len(history) != 1 || len(audits) != 1 || audits[0].Action != "change_set."+action {
				t.Fatal("recovery rewrote settings/history or fabricated a persistence audit")
			}
		})
	}
}

func TestChangeSetMutationAuthorizationRemainsRequired(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	cfg := testConfig("http://unused.invalid", "")
	cfg.Auth.AdminToken, cfg.Auth.AdminReadonlyToken = "write-fixture", "read-fixture"
	s := &Server{db: db, cfg: cfg}
	if err := db.CreateChangeSet(t.Context(), store.ChangeSet{ID: "auth-target", Title: "auth", Status: "draft"}); err != nil {
		t.Fatal(err)
	}
	for _, token := range []string{"", "read-fixture"} {
		for _, action := range []string{"create", "submit", "approve", "apply", "rollback", "delete"} {
			method, path := http.MethodPost, "/admin/change-sets"
			if action != "create" {
				path += "/auth-target"
				if action == "delete" {
					method = http.MethodDelete
				} else {
					path += "/" + action
				}
			}
			r := httptest.NewRequest(method, path, strings.NewReader(`{"title":"unauthorized","note":"unauthorized"}`))
			if token != "" {
				r.Header.Set("Authorization", "Bearer "+token)
			}
			w := httptest.NewRecorder()
			if action == "create" {
				s.handleAdminChangeSets(w, r)
			} else {
				s.handleAdminChangeSetByID(w, r)
			}
			if w.Code != http.StatusUnauthorized {
				t.Errorf("unauthorized %s returned %d", action, w.Code)
			}
		}
	}
	r := httptest.NewRequest(http.MethodGet, "/admin/change-sets", nil)
	r.Header.Set("Authorization", "Bearer read-fixture")
	w := httptest.NewRecorder()
	s.handleAdminChangeSets(w, r)
	if w.Code != http.StatusOK {
		t.Error("readonly role lost list access")
	}
	sets, err := db.ListChangeSets(t.Context())
	audits, auditErr := db.ListAdminAudit(t.Context(), 10)
	if err != nil || auditErr != nil || len(sets) != 1 || sets[0].Status != "draft" || len(audits) != 0 {
		t.Error("unauthorized mutation changed state or success audit")
	}
}
