package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"vibe-coders/internal/store"
)

func atomicSettingsServer(t *testing.T) (*httptest.Server, *Server, *store.SQLStore) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	}))
	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		upstream.Close()
		logger.Stop(context.Background())
		db.Close()
		t.Fatal(err)
	}
	ts := httptest.NewServer(server.Routes())
	t.Cleanup(func() {
		ts.Close()
		upstream.Close()
		logger.Stop(context.Background())
		db.Close()
	})
	return ts, server, db
}

func TestAdminSettingWriteAndDeleteExpectedVersion(t *testing.T) {
	ts, _, db := atomicSettingsServer(t)
	base := ts.URL + "/admin/settings/by-key/cache.chat_enabled"

	resp, first := req(t, http.MethodPut, base, `{"value":"true"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("initial put status=%d body=%+v", resp.StatusCode, first)
	}
	v1 := int(first["version"].(float64))
	resp, second := req(t, http.MethodPut, base, `{"value":"false","expected_version":1}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("versioned put status=%d body=%+v", resp.StatusCode, second)
	}
	v2 := int(second["version"].(float64))
	if v2 != v1+1 {
		t.Fatalf("version after update=%d, want %d", v2, v1+1)
	}
	resp, _ = req(t, http.MethodPut, base, `{"value":"true","expected_version":1}`)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("stale put status=%d, want 409", resp.StatusCode)
	}
	resp, _ = req(t, http.MethodDelete, base+"?expected_version=1", "")
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("stale delete status=%d, want 409", resp.StatusCode)
	}
	if _, found, err := db.GetAdminSetting(context.Background(), "cache.chat_enabled"); err != nil || !found {
		t.Fatalf("stale delete removed setting: found=%v err=%v", found, err)
	}
	resp, _ = req(t, http.MethodDelete, base+"?expected_version=2", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("current delete status=%d, want 200", resp.StatusCode)
	}
}

func TestAdminSettingsBulkRejectsStaleExpectedVersion(t *testing.T) {
	ts, _, db := atomicSettingsServer(t)
	base := ts.URL + "/admin/settings"
	resp, _ := req(t, http.MethodPut, base+"/bulk", `{"settings":[{"key":"cache.chat_enabled","value":"true"}]}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("initial bulk status=%d", resp.StatusCode)
	}
	current, _, _ := db.GetAdminSetting(context.Background(), "cache.chat_enabled")
	resp, _ = req(t, http.MethodPut, base+"/bulk", `{"settings":[{"key":"cache.chat_enabled","value":"false","expected_version":0}]}`)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("stale bulk status=%d, want 409", resp.StatusCode)
	}
	after, _, _ := db.GetAdminSetting(context.Background(), "cache.chat_enabled")
	if after.Version != current.Version || after.ValueJSON != current.ValueJSON {
		t.Fatalf("stale bulk changed setting: before=%+v after=%+v", current, after)
	}
}

func writeReloadBlockingSecret(t *testing.T, db *store.SQLStore, value string) {
	t.Helper()
	ctx := context.Background()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	record := store.AdminSetting{
		Key: "text2sql.exec_dsn", Category: "text2sql", ValueJSON: string(encoded),
		ValueType: "string", IsSecret: true, Source: "admin",
	}
	if current, found, err := db.GetAdminSetting(ctx, record.Key); err != nil {
		t.Fatal(err)
	} else if found {
		version := current.Version
		record.Version = version
		record.ExpectedVersion = &version
	}
	if err := db.UpsertAdminSetting(ctx, record, "test", "reload blocker"); err != nil {
		t.Fatal(err)
	}
}

func TestChangeSetApplyRollbackPendingResumeWithoutRewrite(t *testing.T) {
	ts, server, db := atomicSettingsServer(t)
	ctx := context.Background()
	target := "cache.chat_enabled"
	d, _ := settingDefByKey(target)
	proposed := "true"
	if d.envValue(server.cfg) == proposed {
		proposed = "false"
	}
	cs := store.ChangeSet{
		ID: "cs-resume", Title: "resumable", Status: "approved",
		Items: []store.ChangeSetItem{{Kind: "setting", Key: target, Value: proposed}},
	}
	if err := db.CreateChangeSet(ctx, cs); err != nil {
		t.Fatal(err)
	}

	writeReloadBlockingSecret(t, db, "not-a-valid-ciphertext")
	applyURL := ts.URL + "/admin/change-sets/" + cs.ID + "/apply"
	resp, _ := req(t, http.MethodPost, applyURL, "")
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("apply with reload failure status=%d, want 503", resp.StatusCode)
	}
	pending, _, _ := db.GetChangeSet(ctx, cs.ID)
	if pending.Status != "apply_pending" || len(pending.Prior) != 1 {
		t.Fatalf("apply failure did not retain resumable marker/prior: %+v", pending)
	}
	afterApply, _, _ := db.GetAdminSetting(ctx, target)
	applyHistory, _ := db.ListAdminSettingHistory(ctx, target, 10)
	if len(applyHistory) != 1 {
		t.Fatalf("apply history rows=%d, want 1", len(applyHistory))
	}

	validCiphertext, err := server.secrets.Load().Encrypt("postgres://readonly@example/db")
	if err != nil {
		t.Fatal(err)
	}
	writeReloadBlockingSecret(t, db, validCiphertext)
	resp, out := req(t, http.MethodPost, applyURL, "")
	if resp.StatusCode != http.StatusOK || out["status"] != "applied" {
		t.Fatalf("resumed apply status=%d body=%+v", resp.StatusCode, out)
	}
	afterResume, _, _ := db.GetAdminSetting(ctx, target)
	resumeHistory, _ := db.ListAdminSettingHistory(ctx, target, 10)
	if afterResume.Version != afterApply.Version || len(resumeHistory) != len(applyHistory) {
		t.Fatalf("resumed apply rewrote target: before=%+v/%d after=%+v/%d", afterApply, len(applyHistory), afterResume, len(resumeHistory))
	}

	writeReloadBlockingSecret(t, db, "invalid-again")
	rollbackURL := ts.URL + "/admin/change-sets/" + cs.ID + "/rollback"
	resp, _ = req(t, http.MethodPost, rollbackURL, "")
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("rollback with reload failure status=%d, want 503", resp.StatusCode)
	}
	rollbackPending, _, _ := db.GetChangeSet(ctx, cs.ID)
	if rollbackPending.Status != "rollback_pending" {
		t.Fatalf("rollback failure status=%q, want rollback_pending", rollbackPending.Status)
	}
	afterRollback, _, _ := db.GetAdminSetting(ctx, target)
	rollbackHistory, _ := db.ListAdminSettingHistory(ctx, target, 10)
	if len(rollbackHistory) != 2 {
		t.Fatalf("rollback history rows=%d, want 2", len(rollbackHistory))
	}

	validCiphertext, err = server.secrets.Load().Encrypt("postgres://readonly@example/db")
	if err != nil {
		t.Fatal(err)
	}
	writeReloadBlockingSecret(t, db, validCiphertext)
	resp, out = req(t, http.MethodPost, rollbackURL, "")
	if resp.StatusCode != http.StatusOK || out["status"] != "rolled_back" {
		t.Fatalf("resumed rollback status=%d body=%+v", resp.StatusCode, out)
	}
	afterRollbackResume, _, _ := db.GetAdminSetting(ctx, target)
	rollbackResumeHistory, _ := db.ListAdminSettingHistory(ctx, target, 10)
	if afterRollbackResume.Version != afterRollback.Version || len(rollbackResumeHistory) != len(rollbackHistory) {
		t.Fatalf("resumed rollback rewrote target: before=%+v/%d after=%+v/%d", afterRollback, len(rollbackHistory), afterRollbackResume, len(rollbackResumeHistory))
	}
}

func TestStoredSettingsMapFailsClosed(t *testing.T) {
	_, server, _ := atomicSettingsServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := httptest.NewRequest(http.MethodGet, "/admin/change-sets/cs/dryrun", nil).WithContext(ctx)
	if _, err := server.storedSettingsMap(r); err == nil {
		t.Fatal("storedSettingsMap should return a canceled database read error")
	}
}
