package proxy

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
	"vibe-coders/internal/store"
)

func TestAdminKeyRevokeReview(t *testing.T) {
	for _, mode := range []string{"reason", "stale", "invalid", "catalog"} {
		t.Run(mode, func(t *testing.T) {
			f := newAPIKeyScopeContractFixture(t)
			key := store.APIKeyRecord{ID: "key-revoke-review", Name: "검토 키", KeyHash: "synthetic-revoke-hash", Role: "developer", Status: "active"}
			if err := f.db.UpsertAPIKey(t.Context(), key); err != nil {
				t.Fatal("seed failed")
			}
			key = f.key(t, key.ID)
			revision, err := f.db.APIKeyRevision(t.Context(), key)
			if err != nil {
				t.Fatal("revision unavailable")
			}
			if mode == "catalog" {
				data := f.request(t, http.MethodGet, "/admin/api-keys", f.adminToken, "", http.StatusOK)
				var catalog struct {
					RevokeReviewSupported bool `json:"revoke_review_supported"`
				}
				if json.Unmarshal(data, &catalog) != nil || !catalog.RevokeReviewSupported {
					t.Fatal("review capability missing")
				}
				return
			}
			body, _ := json.Marshal(map[string]string{"reason": "운영 키 정리", "expected_revision": revision})
			want := http.StatusOK
			if mode == "invalid" {
				body = []byte(`{"reason":" "}`)
				want = http.StatusBadRequest
			}
			if mode == "stale" {
				key.Team = "changed-team"
				if f.db.UpsertAPIKey(t.Context(), key) != nil {
					t.Fatal("change failed")
				}
				want = http.StatusConflict
			}
			f.request(t, http.MethodDelete, "/admin/api-keys/"+key.ID, f.adminToken, string(body), want)
			stored := f.key(t, key.ID)
			if mode != "reason" {
				if stored.Status != "active" {
					t.Fatal("rejected review changed key")
				}
				return
			}
			events, err := f.db.ListAuditEvents(t.Context(), 20)
			if err != nil {
				t.Fatal("audit unavailable")
			}
			found := false
			for _, event := range events {
				if event.APIKeyID == key.ID && event.EventType == "api_key_revoked" && strings.Contains(event.Detail, "운영 키 정리") && event.ActorUserID != "" {
					found = true
				}
			}
			if !found || stored.Status != "revoked" {
				t.Fatal("revocation must retain reason and actor")
			}
		})
	}
}

func TestAdminKeyRevokeHardDeleteAuthority(t *testing.T) {
	for _, role := range []string{"admin", "super_admin"} {
		t.Run(role, func(t *testing.T) {
			gateway, server, db := scopedSettingsSecurityServer(t, "http://127.0.0.1:1")
			f := &apiKeyScopeContractFixture{gateway: gateway, db: db}
			token := issueLLMScopedTestToken(t, db, server, "hard-delete-actor", role, "", []string{"admin:read", "admin:write"}, time.Now().UTC())
			key := store.APIKeyRecord{ID: "hard-delete-target", KeyHash: "synthetic-hard-delete-hash", Role: "developer", Status: "active"}
			if db.UpsertAPIKey(t.Context(), key) != nil {
				t.Fatal("authority fixture failed")
			}
			want := http.StatusForbidden
			if role == "super_admin" {
				want = http.StatusOK
			}
			f.request(t, http.MethodDelete, "/admin/api-keys/"+key.ID+"?hard=1", token, "{}", want)
			current, found, err := db.GetAPIKey(t.Context(), key.ID)
			if err != nil || role == "super_admin" && found || role == "admin" && (!found || current.Status != "active") {
				t.Fatal("hard-delete role authority was not enforced")
			}
			audits, err := db.ListAdminAudit(t.Context(), 20)
			if err != nil {
				t.Fatal("authority audit unavailable")
			}
			count := 0
			for _, audit := range audits {
				if audit.Action == "api_key.delete" {
					count++
				}
			}
			if role == "admin" && count != 0 || role == "super_admin" && count != 1 {
				t.Fatal("hard-delete audit did not match authorized change")
			}
		})
	}
}

func TestAdminKeyRevokeLegacyBodies(t *testing.T) {
	for _, method := range []string{http.MethodDelete, http.MethodPost} {
		for _, body := range []string{"", "{}", "null"} {
			t.Run(method+"/"+body, func(t *testing.T) {
				f := newAPIKeyScopeContractFixture(t)
				key := store.APIKeyRecord{ID: "legacy-revoke", KeyHash: "synthetic-legacy-hash", Role: "developer", Status: "active"}
				if f.db.UpsertAPIKey(t.Context(), key) != nil {
					t.Fatal("legacy fixture failed")
				}
				path := "/admin/api-keys/" + key.ID
				if method == http.MethodPost {
					path += "/revoke"
				}
				f.request(t, method, path, f.adminToken, body, http.StatusOK)
				stored := f.key(t, key.ID)
				if stored.Status != "revoked" || stored.RevokedAt.IsZero() {
					t.Fatal("legacy revocation did not persist")
				}
			})
		}
	}
}
