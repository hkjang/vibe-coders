package proxy

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestCommittedSettingAuditSurvivesRequestCancellation(t *testing.T) {
	for _, action := range []string{"setting.update", "setting.revert", "setting.rollback", "setting.bulk"} {
		for _, pending := range []bool{false, true} {
			name := action + "/after-successful-reload"
			if pending {
				name = action + "/before-reload"
			}
			t.Run(name, func(t *testing.T) {
				_, server, db := atomicSettingsServer(t)
				key := "cache.chat_enabled"
				d, _ := settingDefByKey(key)
				initial, err := server.prepareSettingValue(d, "true")
				if err != nil {
					t.Fatal(err)
				}
				if err := db.UpsertAdminSetting(t.Context(), initial, "seed", "initial"); err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				r := httptest.NewRequest(http.MethodPut, "/admin/settings/by-key/"+key, nil).WithContext(ctx)
				r.Header.Set("Authorization", "Bearer synthetic-operator-token")
				actor := adminID(r)
				switch action {
				case "setting.revert":
					err = db.DeleteAdminSetting(r.Context(), key, actor, "reviewed", 1)
				case "setting.bulk":
					record, prepareErr := server.prepareSettingValue(d, "false")
					if prepareErr != nil {
						t.Fatal(prepareErr)
					}
					record.Version = 1
					err = db.UpsertAdminSettings(r.Context(), []store.AdminSetting{record}, actor, "reviewed")
				default:
					err = server.persistSettingValue(r, d, "false", "reviewed")
				}
				if err != nil {
					t.Fatalf("actual database commit failed: %v", err)
				}
				if pending {
					cancel()
					if err := server.reloadRuntimeConfig(r.Context()); !errors.Is(err, context.Canceled) {
						t.Fatalf("canceled post-commit reload error=%v", err)
					}
				} else {
					if err := server.reloadRuntimeConfig(r.Context()); err != nil {
						t.Fatal(err)
					}
					cancel() // The normal commit/reload-to-audit gap is protected too.
				}
				detail := auditJSON(map[string]any{"key": key, "reason": "reviewed", "reload_pending": pending})
				server.auditCommittedSetting(r, action, key, detail)
				events, err := db.ListAdminAudit(context.Background(), 20)
				if err != nil || len(events) != 1 {
					t.Fatalf("committed write lost its audit after cancellation: events=%v error=%v", events, err)
				}
				if events[0].Action != action || events[0].AdminID != actor || events[0].BeforeValue != key || events[0].AfterValue != detail {
					t.Fatalf("detached audit changed actor or metadata: %+v", events[0])
				}
				current, found, err := db.GetAdminSetting(context.Background(), key)
				if err != nil || (action == "setting.revert" && found) || (action != "setting.revert" && (!found || current.Version != 2)) {
					t.Fatalf("committed state changed: %+v found=%v err=%v", current, found, err)
				}
			})
		}
	}
}

func TestCommittedSettingAuditContextIsDetachedBoundedAndPreservesValues(t *testing.T) {
	type markerKey struct{}
	original, cancelOriginal := context.WithCancel(context.WithValue(t.Context(), markerKey{}, "request-trace"))
	r := httptest.NewRequest(http.MethodPut, "/admin/settings/by-key/cache.chat_enabled", nil).WithContext(original)
	r.Header.Set("Authorization", "Bearer synthetic-operator-token")
	cancelOriginal()
	started := time.Now()
	auditRequest, cancel := committedSettingAuditRequest(r)
	defer cancel()
	if err := auditRequest.Context().Err(); err != nil {
		t.Fatalf("audit inherited request cancellation: %v", err)
	}
	deadline, ok := auditRequest.Context().Deadline()
	if !ok || deadline.Before(started) || deadline.After(started.Add(committedSettingAuditTimeout+100*time.Millisecond)) {
		t.Fatalf("audit cancellation budget is missing or unbounded: deadline=%v present=%v", deadline, ok)
	}
	if auditRequest.Context().Value(markerKey{}) != "request-trace" || adminID(auditRequest) != adminID(r) || auditRequest.URL != r.URL {
		t.Fatal("detachment lost request values or actor")
	}
	cancel()
	if !errors.Is(auditRequest.Context().Err(), context.Canceled) {
		t.Fatal("audit cleanup did not release its context")
	}
}
