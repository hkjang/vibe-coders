//go:build linux

package proxy

import (
	"encoding/json"
	"strings"
	"testing"
	"vibe-coders/internal/store"
)

func seedBrowserChangeSetFixture(t *testing.T, db *store.SQLStore) {
	t.Helper()
	if err := db.UpsertAdminSetting(t.Context(), store.AdminSetting{Key: "retention.request_days", Category: "retention", ValueJSON: `"30"`, ValueType: "int"}, "browser-fixture", "fixture baseline"); err != nil {
		t.Fatal("change set baseline unavailable")
	}
	if err := db.CreateChangeSet(t.Context(), store.ChangeSet{ID: "browser-readonly-set", Title: "browser-changeset-readonly", Status: "approved", Items: []store.ChangeSetItem{{Kind: "setting", Key: "retention.request_days", Value: "90"}}}); err != nil {
		t.Fatal("readonly change set fixture unavailable")
	}
}

func verifyBrowserChangeSetFixture(t *testing.T, db *store.SQLStore) {
	t.Helper()
	rows, err := db.ListChangeSets(t.Context())
	if err != nil || len(rows) != 1 || rows[0].ID != "browser-readonly-set" || rows[0].Status != "approved" {
		t.Fatal("browser change set lifecycle or readonly guard did not preserve expected rows")
	}
	setting, found, err := db.GetAdminSetting(t.Context(), "retention.request_days")
	if err != nil || !found || setting.ValueJSON != `"30"` {
		t.Fatal("browser rollback did not restore the actual stored setting")
	}
	history, err := db.ListAdminSettingHistory(t.Context(), "retention.request_days", 10)
	if err != nil || len(history) != 3 {
		t.Fatal("browser setting history is missing or contains duplicate writes")
	}
	audits, err := db.ListAdminAudit(t.Context(), 1000)
	if err != nil {
		t.Fatal("browser change set audit unavailable")
	}
	want := map[string]string{
		"change_set.pending": "submit", "change_set.approved": "approve",
		"change_set.apply.persisted": "apply", "change_set.apply": "apply",
		"change_set.rollback.persisted": "rollback", "change_set.rollback": "rollback",
		"change_set.delete": "delete",
	}
	counts := map[string]int{}
	for _, audit := range audits {
		if !strings.HasPrefix(audit.Action, "change_set.") {
			continue
		}
		counts[audit.Action]++
		if !strings.HasPrefix(audit.AdminID, "admin_") || len(audit.AdminID) != 18 {
			t.Fatal("browser change set actor reference missing")
		}
		if suffix, ok := want[audit.Action]; ok {
			var detail struct {
				Reason string `json:"reason"`
			}
			if json.Unmarshal([]byte(audit.AfterValue), &detail) != nil || detail.Reason != "browser-changeset-"+suffix {
				t.Fatal("browser change set audit reason did not match")
			}
		}
	}
	if len(counts) != len(want)+1 || counts["change_set.create"] != 1 {
		t.Fatal("unexpected browser change set audit actions")
	}
	for action := range want {
		if counts[action] != 1 {
			t.Fatal("missing or duplicate browser change set audit action")
		}
	}
}
