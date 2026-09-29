package proxy

import (
	"context"
	"encoding/json"
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

func TestCommittedSettingAuditPreservesPostChangeRequestCancellation(t *testing.T) {
	for _, tc := range []struct{ action, key string }{
		{"setting.update", "mcp.enabled"},
		{"setting.update", "text2sql.enabled"},
		{"setting.bulk", ""},
	} {
		t.Run(tc.action+"/"+tc.key, func(t *testing.T) {
			_, server, db := atomicSettingsServer(t)
			server.cfg.RedTeam.PostChangeEnabled = true
			redteamKillSwitch.Store(false)
			t.Cleanup(func() { redteamKillSwitch.Store(false) })
			if err := server.ensureDefaultRedTeamProbePacks(t.Context(), "seed"); err != nil {
				t.Fatal(err)
			}
			// Commit a real setting first; only its audit is detached from a
			// subsequent browser disconnect, not new post-change work.
			if err := db.UpsertAdminSetting(t.Context(), store.AdminSetting{
				Key: "cache.chat_enabled", Category: "cache", ValueJSON: "true", ValueType: "bool",
			}, "seed", "reviewed"); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			r := httptest.NewRequest(http.MethodPost, "/admin/settings/bulk", nil).WithContext(ctx)
			r.Header.Set("Authorization", "Bearer synthetic-post-change-operator")
			cancel()
			detail := auditJSON(map[string]any{"key": tc.key, "reason": "reviewed"})
			server.auditCommittedSetting(r, tc.action, tc.key, detail)
			events, err := db.ListAdminAudit(t.Context(), 20)
			if err != nil || len(events) != 1 || events[0].Action != tc.action || events[0].AdminID != adminID(r) || events[0].AfterValue != detail {
				t.Fatalf("committed audit was lost, duplicated, or changed: events=%+v error=%v", events, err)
			}
			campaigns, err := db.ListRedTeamCampaigns(t.Context(), 20)
			if err != nil || len(campaigns) != 0 {
				t.Fatalf("post-change work escaped original request cancellation: campaigns=%+v error=%v", campaigns, err)
			}
		})
	}
}

func TestAdminAuditInsertDeadlineDoesNotExpirePostChangeCampaign(t *testing.T) {
	_, server, db := atomicSettingsServer(t)
	server.cfg.RedTeam.PostChangeEnabled = true
	server.cfg.RedTeam.PostChangeMaxTargets = 1
	redteamKillSwitch.Store(false)
	t.Cleanup(func() { redteamKillSwitch.Store(false) })
	if err := db.UpsertProvider(t.Context(), store.ProviderConfig{
		Name: "synthetic-audit-context", BaseURL: "http://synthetic.invalid", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	// An already-expired insert budget deterministically exercises the lifetime
	// separation, without sleeping or changing the real 2-second audit limit.
	type traceKey struct{}
	original, cancelOriginal := context.WithTimeout(context.WithValue(t.Context(), traceKey{}, "preserved-trace"), 10*time.Second)
	defer cancelOriginal()
	r := httptest.NewRequest(http.MethodPut, "/admin/settings/bulk", nil).WithContext(original)
	r.Header.Set("Authorization", "Bearer synthetic-post-change-operator")
	auditCtx, cancelAudit := context.WithDeadline(context.WithoutCancel(original), time.Now().Add(-time.Second))
	defer cancelAudit()
	if !errors.Is(auditCtx.Err(), context.DeadlineExceeded) {
		t.Fatal("audit deadline fixture did not expire")
	}
	server.auditAdminWithInsertContext(auditCtx, r, "setting.bulk", "", `{"count":1,"reason":"reviewed"}`, "")
	if original.Err() != nil || original.Value(traceKey{}) != "preserved-trace" {
		t.Fatal("audit budget changed the original request lifetime or values")
	}
	campaigns, err := db.ListRedTeamCampaigns(t.Context(), 20)
	if err != nil || len(campaigns) != 1 {
		t.Fatalf("live request did not complete post-change campaign: campaigns=%+v error=%v", campaigns, err)
	}
	campaign := campaigns[0]
	if campaign.Status != "completed" || campaign.ExecutionMode != "dry-run" || campaign.CreatedBy != adminID(r) || campaign.ExternalProviderAllowed || campaign.DestructiveToolPolicy != "dry-run" {
		t.Fatalf("post-change campaign lifetime, actor or safety policy changed: %+v", campaign)
	}
	runs, err := db.ListRedTeamRuns(t.Context(), 20)
	if err != nil || len(runs) != 1 || runs[0].CampaignID != campaign.ID || runs[0].Status == "running" || runs[0].EndedAt == "" || runs[0].Mode != "dry-run" {
		t.Fatalf("post-change run was left unfinished: runs=%+v error=%v", runs, err)
	}
	events, err := db.ListAdminAudit(t.Context(), 20)
	if err != nil {
		t.Fatal(err)
	}
	completed := 0
	for _, event := range events {
		if event.Action == "setting.bulk" {
			t.Fatal("expired best-effort insert unexpectedly persisted")
		}
		if event.Action == "redteam.post_change.completed" {
			completed++
			var detail struct {
				Summary struct {
					LiveCalls int `json:"live_calls"`
				} `json:"summary"`
			}
			if err := json.Unmarshal([]byte(event.AfterValue), &detail); err != nil || detail.Summary.LiveCalls != 0 || event.AdminID != adminID(r) {
				t.Fatalf("post-change completion changed actor or invoked an upstream: event=%+v error=%v", event, err)
			}
		}
	}
	if completed != 1 {
		t.Fatalf("post-change completion audit count=%d, want 1", completed)
	}
}
