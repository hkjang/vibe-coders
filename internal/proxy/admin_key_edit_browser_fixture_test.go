package proxy

import (
	"encoding/json"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func verifyBrowserAdminKeyEdits(t *testing.T, db *store.SQLStore) {
	t.Helper()
	audits, err := db.ListAdminAudit(t.Context(), 200)
	if err != nil {
		t.Fatal("browser key edit audit unavailable")
	}
	expected := map[string]bool{
		"browser-admin-reviewed-edit":     false,
		"browser-admin-lost-edit":         false,
		"browser-reviewed-scopes-clear":   false,
		"browser-reviewed-scopes-restore": false,
		"browser-reviewed-scopes-late":    false,
	}
	concurrent := 0
	for _, audit := range audits {
		if audit.Action != "api_key.update" {
			continue
		}
		var after struct {
			ID     string   `json:"id"`
			Name   string   `json:"name"`
			Owner  string   `json:"owner"`
			Status string   `json:"status"`
			Scopes []string `json:"scopes"`
			Reason string   `json:"reason"`
		}
		if json.Unmarshal([]byte(audit.AfterValue), &after) != nil {
			t.Fatal("browser key edit audit malformed")
		}
		if after.Reason == "browser-admin-rejected-edit" || after.Name == "browser-admin-stale-edit" {
			t.Fatal("rejected browser edit changed data or produced success audit")
		}
		if after.Name == "browser-admin-edit-conflict" && after.Owner == "browser-concurrent-owner" {
			concurrent++
			key, found, err := db.GetAPIKey(t.Context(), after.ID)
			if err != nil || !found || key.Name != after.Name || key.Owner != after.Owner {
				t.Fatal("stale browser edit overwrote the concurrent management change")
			}
		}
		seen, wanted := expected[after.Reason]
		if !wanted {
			continue
		}
		if seen || audit.AdminID != "browser-local-admin" || after.ID == "" || strings.Contains(audit.AfterValue, "expected_revision") || strings.Contains(audit.AfterValue, "key_hash") {
			t.Fatal("browser key edit audit duplicate or unsafe metadata")
		}
		expected[after.Reason] = true
		key, found, err := db.GetAPIKey(t.Context(), after.ID)
		if err != nil || !found {
			t.Fatal("browser edited key missing")
		}
		switch after.Reason {
		case "browser-admin-reviewed-edit":
			if after.Name != "browser-admin-edited" || after.Status != "disabled" || key.Name != after.Name || key.Status != after.Status {
				t.Fatal("reviewed browser metadata not persisted")
			}
		case "browser-admin-lost-edit":
			if after.Owner != "browser-reviewed-owner" || key.Owner != after.Owner {
				t.Fatal("lost response key edit not persisted")
			}
		case "browser-reviewed-scopes-clear":
			if len(after.Scopes) != 0 {
				t.Fatal("reviewed scope clear was not explicit empty grants")
			}
		case "browser-reviewed-scopes-restore":
			if len(after.Scopes) != 1 || after.Scopes[0] != "chat:completion" || len(key.Scopes) != 1 || key.Scopes[0] != "chat:completion" {
				t.Fatal("reviewed scope restoration not persisted")
			}
		case "browser-reviewed-scopes-late":
			if len(after.Scopes) != 2 || len(key.Scopes) != 2 {
				t.Fatal("late reviewed scope update not persisted")
			}
		}
	}
	for _, seen := range expected {
		if !seen {
			t.Fatal("reviewed browser key audit missing")
		}
	}
	if concurrent != 1 {
		t.Fatal("concurrent management change audit missing or duplicated")
	}
}
