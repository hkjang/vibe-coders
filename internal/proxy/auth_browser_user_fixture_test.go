//go:build linux

package proxy

import (
	"encoding/json"
	"testing"
	"vibe-coders/internal/store"
)

const browserExternalKeyID = "key_browser_external_user"

func seedBrowserUserFixture(t *testing.T, db *store.SQLStore) {
	t.Helper()
	if err := db.UpsertAPIKey(t.Context(), store.APIKeyRecord{ID: browserExternalKeyID, Name: "브라우저 외부 사용자 키", KeyHash: hashProxyKey(browserFixtureSecret(t)), Status: "external", Team: "browser-team"}); err != nil {
		t.Fatal("external user fixture unavailable")
	}
}

func verifyBrowserUserFixture(t *testing.T, db *store.SQLStore) {
	t.Helper()
	key, found, err := db.GetAPIKey(t.Context(), browserExternalKeyID)
	if err != nil || !found || key.Status != "active" || key.Name != "브라우저 외부 사용자 키" || key.Team != "browser-team" {
		t.Fatal("browser user promotion not persisted")
	}
	audits, err := db.ListAdminAudit(t.Context(), 200)
	if err != nil {
		t.Fatal("browser user promotion audit unavailable")
	}
	count := 0
	for _, entry := range audits {
		if entry.Action != "api_key.update" {
			continue
		}
		var after struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		}
		if json.Unmarshal([]byte(entry.AfterValue), &after) == nil && after.ID == browserExternalKeyID && after.Status == "active" {
			count++
		}
	}
	if count != 1 {
		t.Fatal("browser user promotion audit must occur once")
	}
}
