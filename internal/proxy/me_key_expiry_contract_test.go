package proxy

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

func TestSelfServiceKeyExpiryContract(t *testing.T) {
	testKeyExpiryContract(t, "/me/keys", "usersecret")
}

func TestAdminKeyExpiryContract(t *testing.T) {
	testKeyExpiryContract(t, "/admin/api-keys", "")
}

func testKeyExpiryContract(t *testing.T, path, bearer string) {
	t.Helper()
	for _, tc := range []struct {
		name, value string
		valid       bool
	}{
		{"malformed", "not-a-date", false},
		{"missing-zone", "2099-10-13T09:30", false},
		// Administrative imports may intentionally register an already expired key.
		{"past", "2000-01-01T00:00:00Z", path == "/admin/api-keys"},
		{"future-offset", "2099-10-13T09:30:00+09:00", true},
		{"unlimited", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ts, db := meKeysServer(t, true)
			before, err := db.ListAPIKeys(t.Context())
			if err != nil {
				t.Fatal("catalog fixture failed")
			}
			resp := postJSON(t, ts.URL+path, bearer, map[string]any{"name": "expiry fixture", "expires_at": tc.value})
			defer resp.Body.Close()
			if !tc.valid {
				after, err := db.ListAPIKeys(t.Context())
				if resp.StatusCode != http.StatusBadRequest || err != nil || len(after) != len(before) {
					t.Fatalf("invalid expiry must reject without creation: status=%d", resp.StatusCode)
				}
				return
			}
			var result struct {
				APIKey struct {
					ID string `json:"id"`
				} `json:"api_key"`
			}
			if resp.StatusCode != http.StatusCreated || json.NewDecoder(resp.Body).Decode(&result) != nil {
				t.Fatal("valid expiry rejected")
			}
			key, found, err := db.GetAPIKey(t.Context(), result.APIKey.ID)
			if err != nil || !found {
				t.Fatal("created key missing")
			}
			if tc.value == "" {
				if !key.ExpiresAt.IsZero() {
					t.Fatal("omitted expiry gained a deadline")
				}
			} else {
				want, err := time.Parse(time.RFC3339, tc.value)
				if err != nil || !key.ExpiresAt.Equal(want) {
					t.Fatal("expiry instant changed")
				}
			}
		})
	}
}
