package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestAdminSettingsRollbackExpectedVersion(t *testing.T) {
	for _, tc := range []struct {
		name, expected string
		status         int
	}{
		{"current", `,"expected_version":2`, http.StatusOK},
		{"stale", `,"expected_version":1`, http.StatusConflict},
		{"absent", `,"expected_version":0`, http.StatusConflict},
		{"negative", `,"expected_version":-1`, http.StatusBadRequest},
		{"omitted legacy", "", http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ts, _, db := atomicSettingsServer(t)
			key := "cache.chat_enabled"
			for _, value := range []string{"false", "true"} {
				resp, out := req(t, http.MethodPut, ts.URL+"/admin/settings/by-key/"+key, fmt.Sprintf(`{"value":%q}`, value))
				if resp.StatusCode != http.StatusOK {
					t.Fatalf("seed status=%d body=%v", resp.StatusCode, out)
				}
			}
			resp, out := req(t, http.MethodPost, ts.URL+"/admin/settings/rollback", `{"key":"cache.chat_enabled","reason":"reviewed"`+tc.expected+`}`)
			if resp.StatusCode != tc.status {
				t.Fatalf("rollback status=%d body=%v, want %d", resp.StatusCode, out, tc.status)
			}
			current, _, err := db.GetAdminSetting(context.Background(), key)
			if err != nil {
				t.Fatal(err)
			}
			wantValue, wantVersion, wantHistory := `"true"`, 2, 2
			if tc.status == http.StatusOK {
				wantValue, wantVersion, wantHistory = `"false"`, 3, 3
			}
			if current.ValueJSON != wantValue || current.Version != wantVersion {
				t.Fatalf("unexpected stored value/version: %+v", current)
			}
			history, err := db.ListAdminSettingHistory(context.Background(), key, 10)
			if err != nil || len(history) != wantHistory {
				t.Fatalf("history length=%d err=%v", len(history), err)
			}
			if tc.status == http.StatusConflict && out["error"].(map[string]any)["code"] != "setting_conflict" {
				t.Fatalf("wrong conflict: %v", out)
			}
			audits, err := db.ListAdminAudit(context.Background(), 20)
			if err != nil {
				t.Fatal(err)
			}
			rollbackAudits := 0
			for _, event := range audits {
				if event.Action == "setting.rollback" {
					rollbackAudits++
				}
			}
			wantAudits := 0
			if tc.status == http.StatusOK {
				wantAudits = 1
			}
			if rollbackAudits != wantAudits {
				t.Fatalf("rollback audit count=%d want=%d", rollbackAudits, wantAudits)
			}
		})
	}
}

func TestAdminSettingsRollbackReloadPendingIsPersisted(t *testing.T) {
	ts, _, db := atomicSettingsServer(t)
	for _, value := range []string{"false", "true"} {
		resp, _ := req(t, http.MethodPut, ts.URL+"/admin/settings/by-key/cache.chat_enabled", fmt.Sprintf(`{"value":%q}`, value))
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("seed status=%d", resp.StatusCode)
		}
	}
	writeReloadBlockingSecret(t, db, "invalid ciphertext")
	resp, out := req(t, http.MethodPost, ts.URL+"/admin/settings/rollback", `{"key":"cache.chat_enabled","expected_version":2}`)
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%v, want 503", resp.StatusCode, out)
	}
	if out["error"].(map[string]any)["code"] != "setting_reload_pending" {
		t.Fatalf("wrong pending error: %v", out)
	}
	encoded, _ := json.Marshal(out)
	if strings.Contains(string(encoded), "ciphertext") || strings.Contains(string(encoded), "decrypt") {
		t.Fatal("pending error exposed internal secret failure")
	}
	current, _, _ := db.GetAdminSetting(context.Background(), "cache.chat_enabled")
	if current.ValueJSON != `"false"` || current.Version != 3 {
		t.Fatalf("rollback not persisted: %+v", current)
	}
	resp, out = req(t, http.MethodPost, ts.URL+"/admin/settings/rollback", `{"key":"cache.chat_enabled","expected_version":2}`)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("retry must not rewrite: status=%d body=%v", resp.StatusCode, out)
	}
	encoded, _ = json.Marshal(out)
	if strings.Contains(string(encoded), "ciphertext") || strings.Contains(string(encoded), "decrypt") {
		t.Fatal("error exposed internal secret failure")
	}
	audits, _ := db.ListAdminAudit(context.Background(), 20)
	count := 0
	for _, event := range audits {
		if event.Action == "setting.rollback" {
			count++
			if !strings.Contains(event.AfterValue, "reload_pending") {
				t.Fatal("missing persisted audit status")
			}
		}
	}
	if count != 1 {
		t.Fatalf("persisted rollback audit count=%d", count)
	}
}

func TestAdminSettingsRollbackSnapshotGuards(t *testing.T) {
	for _, scenario := range []string{"matched", "stale-timestamp", "stale-history", "stale-count", "present-aba", "env-matched", "env-aba"} {
		t.Run(scenario, func(t *testing.T) {
			ts, _, db := atomicSettingsServer(t)
			ctx := context.Background()
			key := "text2sql.default_limit"
			write := func(value string) {
				t.Helper()
				resp, out := req(t, http.MethodPut, ts.URL+"/admin/settings/by-key/"+key, fmt.Sprintf(`{"value":%q}`, value))
				if resp.StatusCode != 200 {
					t.Fatalf("seed %d: %v", resp.StatusCode, out)
				}
			}
			remove := func() {
				t.Helper()
				resp, out := req(t, http.MethodDelete, ts.URL+"/admin/settings/by-key/"+key, "")
				if resp.StatusCode != 200 {
					t.Fatalf("delete %d: %v", resp.StatusCode, out)
				}
			}
			write("50")
			write("70")
			if strings.HasPrefix(scenario, "env-") {
				remove()
			}
			current, _, _ := db.GetAdminSetting(ctx, key)
			history, _ := db.ListAdminSettingHistory(ctx, key, 1)
			body := map[string]any{"key": key, "reason": "reviewed", "expected_version": current.Version, "expected_updated_at": current.UpdatedAt, "expected_history_id": history[0].ID, "expected_history_count": history[0].HistoryCount}
			switch scenario {
			case "stale-timestamp":
				body["expected_updated_at"] = "old timestamp"
			case "stale-history":
				body["expected_history_id"] = "old history"
			case "stale-count":
				body["expected_history_count"] = history[0].HistoryCount - 1
			case "present-aba":
				remove()
				write("90")
				write("100")
			case "env-aba":
				write("100")
				remove()
			}
			before, _, _ := db.GetAdminSetting(ctx, key)
			encoded, _ := json.Marshal(body)
			resp, out := req(t, http.MethodPost, ts.URL+"/admin/settings/rollback", string(encoded))
			if scenario == "matched" || scenario == "env-matched" {
				want := "50"
				if scenario == "env-matched" {
					want = "70"
				}
				if resp.StatusCode != 200 || out["value"] != want {
					t.Fatalf("rollback status=%d body=%v", resp.StatusCode, out)
				}
			} else {
				if resp.StatusCode != 409 || out["error"].(map[string]any)["code"] != "setting_conflict" {
					t.Fatalf("stale status=%d body=%v", resp.StatusCode, out)
				}
				after, _, _ := db.GetAdminSetting(ctx, key)
				if before.ValueJSON != after.ValueJSON || before.Version != after.Version || before.UpdatedAt != after.UpdatedAt {
					t.Fatal("stale rollback changed setting")
				}
			}
		})
	}
}

func TestAdminSettingsRollbackHistoryCountValidation(t *testing.T) {
	ts, _, db := atomicSettingsServer(t)
	for _, value := range []string{"false", "true"} {
		resp, out := req(t, http.MethodPut, ts.URL+"/admin/settings/by-key/cache.chat_enabled", fmt.Sprintf(`{"value":%q}`, value))
		if resp.StatusCode != 200 {
			t.Fatalf("seed status=%d body=%v", resp.StatusCode, out)
		}
	}
	resp, out := req(t, http.MethodGet, ts.URL+"/admin/settings/history?key=cache.chat_enabled&limit=1", "")
	history := out["history"].([]any)
	if resp.StatusCode != 200 || len(history) != 1 || history[0].(map[string]any)["history_count"] != float64(2) {
		t.Fatalf("history count must precede response limit: status=%d body=%v", resp.StatusCode, out)
	}
	for _, tc := range []struct {
		count, code string
		status      int
	}{
		{"-1", "bad_expected_history_count", 400},
		{"9007199254740992", "bad_expected_history_count", 400},
		{"1.5", "invalid_body", 400},
		{`"2"`, "invalid_body", 400},
		{"0", "setting_conflict", 409},
	} {
		resp, out := req(t, http.MethodPost, ts.URL+"/admin/settings/rollback", `{"key":"cache.chat_enabled","expected_history_count":`+tc.count+`}`)
		if resp.StatusCode != tc.status || out["error"].(map[string]any)["code"] != tc.code {
			t.Fatalf("count %s: status=%d body=%v", tc.count, resp.StatusCode, out)
		}
	}
	current, _, err := db.GetAdminSetting(context.Background(), "cache.chat_enabled")
	if err != nil || current.Version != 2 || current.ValueJSON != `"true"` {
		t.Fatalf("invalid count changed setting: %+v error=%v", current, err)
	}
}

func TestAdminSettingsRollbackPreservesRestrictions(t *testing.T) {
	ts, _, db := atomicSettingsServer(t)
	for _, tc := range []struct {
		key, code string
		status    int
	}{
		{"text2sql.exec_dsn", "secret_rollback_unsupported", 400},
		{"env.listen_addr", "setting_read_only", 405},
		{"cache.chat_enabled", "no_history", 400},
		{"unknown.setting", "unknown_key", 404},
	} {
		resp, out := req(t, http.MethodPost, ts.URL+"/admin/settings/rollback", fmt.Sprintf(`{"key":%q,"expected_version":0}`, tc.key))
		if resp.StatusCode != tc.status || out["error"].(map[string]any)["code"] != tc.code {
			t.Fatalf("%s status=%d body=%v", tc.key, resp.StatusCode, out)
		}
	}
	history, _ := db.ListAdminSettingHistory(context.Background(), "", 20)
	if len(history) != 0 {
		t.Fatal("rejected rollbacks created history")
	}
}
