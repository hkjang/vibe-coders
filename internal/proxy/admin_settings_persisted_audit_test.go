package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func TestAdminSettingPersistedReloadPendingAudit(t *testing.T) {
	for _, method := range []string{http.MethodPut, http.MethodDelete} {
		for _, secret := range []bool{false, true} {
			name := method + "/public"
			if secret {
				name = method + "/secret"
			}
			t.Run(name, func(t *testing.T) {
				ts, server, db := atomicSettingsServer(t)
				ctx := context.Background()
				key, initial, replacement := "cache.chat_enabled", "true", "false"
				if secret {
					key, initial, replacement = "cache.embedding_api_key", "initial-sensitive-value", "replacement-sensitive-value"
				}
				d, _ := settingDefByKey(key)
				seed := func() {
					t.Helper()
					record, err := server.prepareSettingValue(d, initial)
					if err != nil {
						t.Fatal(err)
					}
					if err := db.UpsertAdminSetting(ctx, record, "seed", "seed override"); err != nil {
						t.Fatal(err)
					}
				}
				seed()
				seedHistory, err := db.ListAdminSettingHistory(ctx, key, 10)
				if err != nil || len(seedHistory) != 1 {
					t.Fatal("seed must create exactly one setting history record")
				}
				seedHistoryID := seedHistory[0].ID
				writeReloadBlockingSecret(t, db, "synthetic-invalid-ciphertext")
				action := "setting.update"
				if method == http.MethodDelete {
					action = "setting.revert"
				}
				audits := func() []store.AdminAuditPublic {
					t.Helper()
					all, err := db.ListAdminAudit(ctx, 200)
					if err != nil {
						t.Fatal(err)
					}
					var result []store.AdminAuditPublic
					for _, event := range all {
						if event.Action == action && event.BeforeValue == key {
							result = append(result, event)
						}
					}
					return result
				}
				request := func(version int, reason string) (*http.Response, map[string]any) {
					t.Helper()
					path := ts.URL + "/admin/settings/by-key/" + key
					if method == http.MethodDelete {
						query := url.Values{"reason": {reason}, "expected_version": {strconv.Itoa(version)}}
						return req(t, method, path+"?"+query.Encode(), "")
					}
					body, _ := json.Marshal(map[string]any{"value": replacement, "reason": reason, "expected_version": version})
					return req(t, method, path, string(body))
				}
				resp, out := request(0, "stale attempt")
				if resp.StatusCode != http.StatusConflict || len(audits()) != 0 {
					t.Fatalf("failed write must not audit: status=%d body=%v audits=%v", resp.StatusCode, out, audits())
				}
				resp, out = request(1, "operator reviewed the change")
				if resp.StatusCode != http.StatusServiceUnavailable || out["error"].(map[string]any)["code"] != "setting_reload_pending" {
					t.Fatalf("persisted reload failure: status=%d body=%v", resp.StatusCode, out)
				}
				encoded, _ := json.Marshal(out)
				if strings.Contains(string(encoded), "ciphertext") || strings.Contains(string(encoded), "decrypt") || strings.Contains(string(encoded), "sensitive-value") {
					t.Fatalf("pending response exposed internal values: %s", encoded)
				}
				current, found, err := db.GetAdminSetting(ctx, key)
				if err != nil || (method == http.MethodPut && (!found || current.Version != 2)) || (method == http.MethodDelete && found) {
					t.Fatalf("pending mutation was not persisted: current=%+v found=%v err=%v", current, found, err)
				}
				events := audits()
				if len(events) != 1 {
					t.Fatalf("persisted pending write audit count=%d, want 1", len(events))
				}
				pendingAuditID := events[0].ID
				var pending map[string]any
				if err := json.Unmarshal([]byte(events[0].AfterValue), &pending); err != nil {
					t.Fatal(err)
				}
				if len(pending) != 4 || pending["key"] != key || pending["secret"] != secret || pending["reason"] != "operator reviewed the change" || pending["reload_pending"] != true {
					t.Fatalf("pending audit metadata=%v", pending)
				}
				history, err := db.ListAdminSettingHistory(ctx, key, 10)
				if err != nil || len(history) != 2 {
					t.Fatalf("pending write history=%v err=%v", history, err)
				}
				newHistory, ok := newPersistedSettingHistory(seedHistoryID, history)
				if !ok || newHistory.Reason != "operator reviewed the change" {
					t.Fatal("pending write must preserve seed history and add one distinct record with the operator reason")
				}
				if secret {
					for _, row := range history {
						if row.OldValueJSON != "" || row.NewValueJSON != "" {
							t.Fatal("secret setting history exposed a value")
						}
					}
				}
				resp, out = request(1, "stale retry")
				if resp.StatusCode != http.StatusConflict || len(audits()) != 1 {
					t.Fatalf("failed retry added an audit: status=%d body=%v audits=%v", resp.StatusCode, out, audits())
				}
				if err := db.DeleteAdminSetting(ctx, "text2sql.exec_dsn", "repair", "remove synthetic blocker"); err != nil {
					t.Fatal(err)
				}
				version := 2
				if method == http.MethodDelete {
					seed()
					version = 1
				}
				resp, out = request(version, "successful follow-up")
				if resp.StatusCode != http.StatusOK || len(audits()) != 2 {
					t.Fatalf("successful follow-up: status=%d body=%v audits=%v", resp.StatusCode, out, audits())
				}
				if secret && method == http.MethodPut && out["value"] != "********" {
					t.Fatalf("secret success response is not masked: %v", out)
				}
				var success map[string]any
				successEvent, ok := newPersistedSettingAudit(pendingAuditID, audits())
				if !ok {
					t.Fatal("successful follow-up must preserve the prior audit ID and add exactly one distinct audit ID")
				}
				if err := json.Unmarshal([]byte(successEvent.AfterValue), &success); err != nil {
					t.Fatal(err)
				}
				if success["reason"] != "successful follow-up" || success["reload_pending"] == true {
					t.Fatalf("success audit metadata=%v", success)
				}
				encoded, _ = json.Marshal(out)
				if strings.Contains(string(encoded), "sensitive-value") {
					t.Fatal("success response exposed a secret")
				}
				for _, event := range audits() {
					if strings.Contains(event.BeforeValue+event.AfterValue, "sensitive-value") || strings.Contains(event.AfterValue, "ciphertext") {
						t.Fatal("audit exposed a secret")
					}
				}
			})
		}
	}
}

func TestAdminSettingsBatchPersistedReloadPendingAudit(t *testing.T) {
	for _, tc := range []struct {
		method, path string
		importing    bool
	}{
		{http.MethodPut, "/admin/settings/bulk", false},
		{http.MethodPost, "/admin/settings/bulk", false},
		{http.MethodPost, "/admin/settings/import", true},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			ts, server, db := atomicSettingsServer(t)
			ctx := context.Background()
			values := map[string]string{"cache.chat_enabled": "false", "retention.request_days": "45"}
			if !tc.importing {
				values["cache.embedding_api_key"] = "batch-sensitive-value"
			}
			seedHistoryIDs := make(map[string]string, len(values))
			for key, value := range values {
				d, _ := settingDefByKey(key)
				record, err := server.prepareSettingValue(d, value)
				if err != nil {
					t.Fatal(err)
				}
				if err := db.UpsertAdminSetting(ctx, record, "seed", "seed override"); err != nil {
					t.Fatal(err)
				}
				history, err := db.ListAdminSettingHistory(ctx, key, 10)
				if err != nil || len(history) != 1 {
					t.Fatal("batch seed must create exactly one setting history record per key")
				}
				seedHistoryIDs[key] = history[0].ID
			}
			writeReloadBlockingSecret(t, db, "synthetic-invalid-ciphertext")
			audits := func() []store.AdminAuditPublic {
				t.Helper()
				all, err := db.ListAdminAudit(ctx, 200)
				if err != nil {
					t.Fatal(err)
				}
				var result []store.AdminAuditPublic
				for _, event := range all {
					if event.Action == "setting.bulk" {
						result = append(result, event)
					}
				}
				return result
			}
			request := func(version int, reason string) (*http.Response, map[string]any) {
				t.Helper()
				settings := []map[string]any{}
				for key, value := range values {
					settings = append(settings, map[string]any{"key": key, "value": value, "expected_version": version})
				}
				body, _ := json.Marshal(map[string]any{"settings": settings, "reason": reason})
				return req(t, tc.method, ts.URL+tc.path, string(body))
			}
			resp, out := request(0, "stale batch")
			if resp.StatusCode != http.StatusConflict || len(audits()) != 0 {
				t.Fatalf("failed batch must not audit: status=%d body=%v audits=%v", resp.StatusCode, out, audits())
			}
			resp, out = request(1, "operator reviewed this batch")
			if resp.StatusCode != http.StatusServiceUnavailable || out["error"].(map[string]any)["code"] != "setting_reload_pending" {
				t.Fatalf("persisted batch reload failure: status=%d body=%v", resp.StatusCode, out)
			}
			encoded, _ := json.Marshal(out)
			if strings.Contains(string(encoded), "ciphertext") || strings.Contains(string(encoded), "decrypt") || strings.Contains(string(encoded), "sensitive-value") {
				t.Fatalf("pending response exposed internal values: %s", encoded)
			}
			events := audits()
			if len(events) != 1 {
				t.Fatalf("persisted batch audit count=%d, want 1", len(events))
			}
			pendingAuditID := events[0].ID
			var pending map[string]any
			if err := json.Unmarshal([]byte(events[0].AfterValue), &pending); err != nil {
				t.Fatal(err)
			}
			if len(pending) != 4 || pending["count"] != float64(len(values)) || pending["import"] != tc.importing || pending["reason"] != "operator reviewed this batch" || pending["reload_pending"] != true {
				t.Fatalf("batch pending audit metadata=%v", pending)
			}
			for key := range values {
				current, found, err := db.GetAdminSetting(ctx, key)
				if err != nil || !found || current.Version != 2 {
					t.Fatalf("batch did not persist %s: current=%+v found=%v error=%v", key, current, found, err)
				}
				history, err := db.ListAdminSettingHistory(ctx, key, 10)
				if err != nil || len(history) != 2 {
					t.Fatalf("batch history %s=%v error=%v", key, history, err)
				}
				newHistory, ok := newPersistedSettingHistory(seedHistoryIDs[key], history)
				if !ok || newHistory.Reason != "operator reviewed this batch" {
					t.Fatal("pending batch must preserve seed history and add one distinct record with the operator reason")
				}
				if current.IsSecret {
					for _, row := range history {
						if row.OldValueJSON != "" || row.NewValueJSON != "" {
							t.Fatal("secret batch history exposed a value")
						}
					}
				}
			}
			resp, out = request(1, "stale batch retry")
			if resp.StatusCode != http.StatusConflict || len(audits()) != 1 {
				t.Fatalf("failed batch retry added an audit: status=%d body=%v audits=%v", resp.StatusCode, out, audits())
			}
			if err := db.DeleteAdminSetting(ctx, "text2sql.exec_dsn", "repair", "remove synthetic blocker"); err != nil {
				t.Fatal(err)
			}
			resp, out = request(2, "successful batch follow-up")
			if resp.StatusCode != http.StatusOK || len(audits()) != 2 {
				t.Fatalf("successful batch follow-up: status=%d body=%v audits=%v", resp.StatusCode, out, audits())
			}
			var success map[string]any
			successEvent, ok := newPersistedSettingAudit(pendingAuditID, audits())
			if !ok {
				t.Fatal("successful batch follow-up must preserve the prior audit ID and add exactly one distinct audit ID")
			}
			if err := json.Unmarshal([]byte(successEvent.AfterValue), &success); err != nil {
				t.Fatal(err)
			}
			if success["reason"] != "successful batch follow-up" || success["reload_pending"] == true || success["import"] != tc.importing {
				t.Fatalf("success batch audit metadata=%v", success)
			}
			for _, event := range audits() {
				if strings.Contains(event.BeforeValue+event.AfterValue, "sensitive-value") || strings.Contains(event.AfterValue, "ciphertext") {
					t.Fatal("batch audit exposed a secret")
				}
			}
		})
	}
}

// Identify the added event by identity, not wall-clock order or the metadata
// whose contents the caller still needs to verify.
func newPersistedSettingAudit(previousID string, events []store.AdminAuditPublic) (store.AdminAuditPublic, bool) {
	ids := make([]string, len(events))
	for i, event := range events {
		ids[i] = event.ID
	}
	index, ok := newPersistedSettingRecordIndex(previousID, ids)
	if !ok {
		return store.AdminAuditPublic{}, false
	}
	return events[index], true
}

func newPersistedSettingHistory(previousID string, events []store.AdminSettingHistory) (store.AdminSettingHistory, bool) {
	ids := make([]string, len(events))
	for i, event := range events {
		ids[i] = event.ID
	}
	index, ok := newPersistedSettingRecordIndex(previousID, ids)
	if !ok {
		return store.AdminSettingHistory{}, false
	}
	return events[index], true
}

func newPersistedSettingRecordIndex(previousID string, ids []string) (int, bool) {
	if strings.TrimSpace(previousID) == "" || len(ids) != 2 {
		return 0, false
	}
	added := 0
	previousCount, addedCount := 0, 0
	for i, id := range ids {
		if strings.TrimSpace(id) == "" {
			return 0, false
		}
		if id == previousID {
			previousCount++
		} else {
			added = i
			addedCount++
		}
	}
	return added, previousCount == 1 && addedCount == 1
}

func TestPersistedSettingAuditNewEventIdentity(t *testing.T) {
	previous := store.AdminAuditPublic{ID: "audit-before", AfterValue: "previous metadata", CreatedAt: "2000-01-01T00:00:02Z"}
	added := store.AdminAuditPublic{ID: "audit-after", AfterValue: "new metadata", CreatedAt: "2000-01-01T00:00:01Z"}
	for _, tc := range []struct {
		name       string
		previousID string
		events     []store.AdminAuditPublic
		want       bool
	}{
		{"previous first despite clock rollback", previous.ID, []store.AdminAuditPublic{previous, added}, true},
		{"new first", previous.ID, []store.AdminAuditPublic{added, previous}, true},
		{"previous missing", previous.ID, []store.AdminAuditPublic{added, {ID: "another"}}, false},
		{"previous duplicated", previous.ID, []store.AdminAuditPublic{previous, previous}, false},
		{"new duplicated", previous.ID, []store.AdminAuditPublic{added, added}, false},
		{"empty previous ID", "", []store.AdminAuditPublic{previous, added}, false},
		{"blank new ID", previous.ID, []store.AdminAuditPublic{previous, {ID: " "}}, false},
		{"extra event", previous.ID, []store.AdminAuditPublic{previous, added, {ID: "another"}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := newPersistedSettingAudit(tc.previousID, tc.events)
			if ok != tc.want {
				t.Fatalf("new audit identity result=%v, want %v", ok, tc.want)
			}
			if ok && got != added {
				t.Fatal("new audit identity did not return the complete added event")
			}
			history := make([]store.AdminSettingHistory, len(tc.events))
			for i, event := range tc.events {
				history[i] = store.AdminSettingHistory{ID: event.ID, Reason: event.AfterValue, ChangedAt: event.CreatedAt}
			}
			newHistory, historyOK := newPersistedSettingHistory(tc.previousID, history)
			if historyOK != tc.want {
				t.Fatalf("new history identity result=%v, want %v", historyOK, tc.want)
			}
			if historyOK && (newHistory.ID != added.ID || newHistory.Reason != added.AfterValue || newHistory.ChangedAt != added.CreatedAt) {
				t.Fatal("new history identity did not preserve the added record")
			}
		})
	}
}
