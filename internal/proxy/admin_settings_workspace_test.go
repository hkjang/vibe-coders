package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"testing"
)

// The React settings editor may honor a scoped administrator's can_write
// metadata without admin:write; all category and CAS enforcement stays here.
func TestSettingsWorkspaceScopedWriteContract(t *testing.T) {
	ts, server, db := scopedSettingsSecurityServer(t, "http://127.0.0.1:1")
	cases := []struct{ role, key string }{
		{"ops_admin", "cache.chat_enabled"},
		{"ai_admin", "text2sql.cache_enabled"},
		{"security_admin", "logging.raw_prompts"},
	}
	for _, tc := range cases {
		t.Run(tc.role, func(t *testing.T) {
			if slices.Contains(roleScopes[tc.role], "admin:write") {
				t.Fatal("fixture must exercise scoped admin without global write")
			}
			token := scopedSettingsToken(t, server, db, tc.role)
			status, body := doLegacySettingsRequest(t, http.MethodGet, ts.URL+"/admin/settings/effective", "", token)
			if status != http.StatusOK {
				t.Fatalf("effective status=%d body=%s", status, body)
			}
			var out struct {
				Settings []struct {
					Key      string `json:"key"`
					CanWrite bool   `json:"can_write"`
				} `json:"settings"`
			}
			if err := json.Unmarshal(body, &out); err != nil {
				t.Fatal(err)
			}
			allowed := map[string]bool{}
			for _, row := range out.Settings {
				allowed[row.Key] = row.CanWrite
			}
			for _, target := range cases {
				want := target.role == tc.role
				if flag, ok := allowed[target.key]; !ok || flag != want {
					t.Fatalf("%s can_write=%v present=%v want=%v", target.key, flag, ok, want)
				}
				if want {
					continue
				}
				before, found, err := db.GetAdminSetting(t.Context(), target.key)
				if err != nil {
					t.Fatal(err)
				}
				status, _ = doLegacySettingsRequest(t, http.MethodPut, ts.URL+"/admin/settings/by-key/"+target.key, `{"value":"false","expected_version":0,"reason":"must not write"}`, token)
				if status != http.StatusForbidden {
					t.Fatalf("cross-category update status=%d want 403", status)
				}
				after, exists, err := db.GetAdminSetting(t.Context(), target.key)
				if err != nil || exists != found || after.Version != before.Version || after.ValueJSON != before.ValueJSON {
					t.Fatalf("denied write changed state: err=%v", err)
				}
			}
			for i, want := range []int{http.StatusOK, http.StatusConflict} {
				status, body = doLegacySettingsRequest(t, http.MethodPut, ts.URL+"/admin/settings/by-key/"+tc.key, `{"value":"false","expected_version":0,"reason":"reviewed scoped change"}`, token)
				if status != want {
					t.Fatalf("write %d status=%d body=%s want=%d", i, status, body, want)
				}
			}
			current, found, err := db.GetAdminSetting(t.Context(), tc.key)
			if err != nil || !found || current.Version != 1 {
				t.Fatalf("CAS version: found=%v version=%d err=%v", found, current.Version, err)
			}
			status, body = doLegacySettingsRequest(t, http.MethodDelete, fmt.Sprintf("%s/admin/settings/by-key/%s?expected_version=1&reason=reviewed", ts.URL, tc.key), "", token)
			if status != http.StatusOK {
				t.Fatalf("revert status=%d body=%s", status, body)
			}
		})
	}
}
