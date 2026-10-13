package proxy

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
	"vibe-coders/internal/store"
)

func verifyBrowserAdminKeyRevocations(t *testing.T, db *store.SQLStore) {
	t.Helper()
	expected := map[string]string{
		"browser-admin-reviewed-revoke": "browser-local-admin",
		"browser-admin-lost-revoke":     "browser-local-admin",
		"browser-admin-reviewed-delete": "browser-local-super",
	}
	admins, err := db.ListAdminAudit(t.Context(), 200)
	if err != nil {
		t.Fatal("admin key audits unavailable")
	}
	events, err := db.ListAuditEvents(t.Context(), 200)
	if err != nil {
		t.Fatal("key lifecycle audits unavailable")
	}
	for reason, actor := range expected {
		id := ""
		count := 0
		hard := reason == "browser-admin-reviewed-delete"
		for _, audit := range admins {
			if audit.Action != "api_key.status" && audit.Action != "api_key.delete" {
				continue
			}
			var detail struct {
				ID     string `json:"id"`
				Reason string `json:"reason"`
				Status string `json:"status"`
				Hard   bool   `json:"hard_delete"`
			}
			if json.Unmarshal([]byte(audit.AfterValue), &detail) != nil || detail.Reason != reason {
				continue
			}
			count++
			id = detail.ID
			wantAction, wantStatus := "api_key.status", "revoked"
			if hard {
				wantAction, wantStatus = "api_key.delete", "deleted"
			}
			if id == "" || audit.AdminID != actor || audit.Action != wantAction || detail.Status != wantStatus || detail.Hard != hard || strings.Contains(audit.AfterValue, "key_hash") {
				t.Fatal("reviewed key audit metadata invalid")
			}
		}
		if count != 1 {
			t.Fatal("reviewed browser revocation must commit one management audit")
		}
		lifecycle := 0
		for _, event := range events {
			if event.APIKeyID != id || event.EventType != "api_key_revoked" {
				continue
			}
			var detail struct {
				Reason string `json:"reason"`
			}
			if json.Unmarshal([]byte(event.Detail), &detail) != nil || detail.Reason != reason || event.ActorUserID != actor {
				t.Fatal("lifecycle audit reason or actor mismatch")
			}
			lifecycle++
		}
		if lifecycle != 1 {
			t.Fatal("lost response must not duplicate lifecycle audit")
		}
		key, found, err := db.GetAPIKey(t.Context(), id)
		if err != nil || hard && found || !hard && (!found || key.Status != "revoked" || key.RevokedAt.IsZero()) {
			t.Fatal("browser key change not persisted")
		}
		if hard {
			// The request logger is asynchronous; poll a bounded read, not a fixed sleep.
			deadline := time.Now().Add(3 * time.Second)
			retained := false
			for !retained && time.Now().Before(deadline) {
				requests, err := db.RecentRequests(t.Context(), store.RequestFilter{APIKeyID: id, Limit: 100})
				if err != nil {
					t.Fatal("historical key request lookup failed")
				}
				for _, request := range requests {
					if request.APIKeyID == id && request.StatusCode == 200 {
						retained = true
					}
				}
				if !retained {
					time.Sleep(20 * time.Millisecond)
				}
			}
			if !retained {
				t.Fatal("hard deletion removed or lost successful request history")
			}
		}
	}
}
