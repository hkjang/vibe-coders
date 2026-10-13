package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestSelfServiceRotationPreservesConstraints(t *testing.T) {
	for _, emptyScopes := range []bool{false, true} {
		t.Run(map[bool]string{false: "restricted", true: "empty-scopes"}[emptyScopes], func(t *testing.T) {
			ts, db := meKeysServer(t, true)
			ctx := context.Background()
			old := store.APIKeyRecord{
				ID: "key_rotation_target", Name: "rotation fixture", KeyHash: "synthetic-old-hash",
				Owner: "fixture-owner", UserID: "u1", Team: "t1", Role: "viewer", Status: "active",
				Scopes: []string{"models:read"}, AllowedIPs: []string{"192.0.2.0/24"},
				AllowedModels: []string{"fixture-*"}, DeniedModels: []string{"fixture-blocked"},
				AllowedProviders: []string{"fixture-provider"}, DeniedProviders: []string{"fixture-denied"},
				BudgetLimitKRW: 123.45, ExpiresAt: time.Now().UTC().Add(time.Hour).Truncate(time.Second),
				CreatedAt: time.Now().UTC().Add(-time.Hour).Truncate(time.Second),
			}
			if emptyScopes {
				old.Scopes = []string{}
			}
			if err := db.UpsertAPIKey(ctx, old); err != nil {
				t.Fatal("seed failed")
			}
			resp := postJSON(t, ts.URL+"/me/keys/"+old.ID+"/rotate", "usersecret", map[string]any{})
			defer resp.Body.Close()
			var body struct {
				Secret string `json:"secret"`
				APIKey struct {
					ID string `json:"id"`
				} `json:"api_key"`
			}
			if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || resp.StatusCode != http.StatusOK {
				t.Fatalf("rotation failed: status %d", resp.StatusCode)
			}
			next, found, err := db.GetAPIKey(ctx, body.APIKey.ID)
			if err != nil || !found || body.Secret == "" || next.ID == old.ID || next.KeyHash != hashProxyKey(body.Secret) {
				t.Fatal("replacement unavailable or invalid")
			}
			// Only credential identity and creation time may change. No raw key is logged.
			next.ID, next.KeyHash, next.CreatedAt = old.ID, old.KeyHash, old.CreatedAt
			if !reflect.DeepEqual(old, next) {
				t.Fatal("rotation changed existing authorization or expiration constraints")
			}
			prior, found, err := db.GetAPIKey(ctx, old.ID)
			if err != nil || !found || prior.Status != "revoked" || prior.RevokedAt.IsZero() {
				t.Fatal("original was not revoked")
			}
			repeat := postJSON(t, ts.URL+"/me/keys/"+old.ID+"/rotate", "usersecret", map[string]any{})
			repeat.Body.Close()
			audits, auditErr := db.ListAuditEvents(ctx, 10)
			if repeat.StatusCode != http.StatusConflict || auditErr != nil || len(audits) != 2 {
				t.Fatal("repeated rotation created another replacement or audit")
			}
		})
	}
}

func TestSelfServiceRotationRejectsUnusableOrBroaderKeys(t *testing.T) {
	for _, mode := range []string{"revoked", "disabled", "expired", "higher-role", "different-team", "different-owner"} {
		t.Run(mode, func(t *testing.T) {
			ts, db := meKeysServer(t, true)
			ctx := context.Background()
			old := store.APIKeyRecord{ID: "key_rotation_target", Name: "rotation fixture", KeyHash: "synthetic-old-hash", UserID: "u1", Team: "t1", Role: "developer", Status: "active", Scopes: []string{"models:read"}}
			want := http.StatusConflict
			switch mode {
			case "revoked", "disabled":
				old.Status = mode
			case "expired":
				old.ExpiresAt = time.Now().UTC().Add(-time.Minute)
			case "higher-role":
				old.Role, want = "admin", http.StatusForbidden
			case "different-team":
				old.Team, want = "other-team", http.StatusForbidden
			case "different-owner":
				old.UserID, want = "u2", http.StatusNotFound
			}
			if err := db.UpsertAPIKey(ctx, old); err != nil {
				t.Fatal("seed failed")
			}
			before, _ := db.ListAPIKeys(ctx)
			resp := postJSON(t, ts.URL+"/me/keys/"+old.ID+"/rotate", "usersecret", map[string]any{})
			resp.Body.Close()
			after, _ := db.ListAPIKeys(ctx)
			if resp.StatusCode != want || !reflect.DeepEqual(before, after) {
				t.Fatalf("rotation rejection must preserve all keys: got %d want %d", resp.StatusCode, want)
			}
		})
	}
}
