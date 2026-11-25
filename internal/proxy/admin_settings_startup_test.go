package proxy

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func TestReadOnlySettingsIgnoreStoredOverrides(t *testing.T) {
	ts, server, db := scopedSettingsSecurityServer(t, "http://127.0.0.1:1")
	token := scopedSettingsToken(t, server, db, "admin")
	const key = "env.listen_addr"
	if err := db.UpsertAdminSetting(t.Context(), store.AdminSetting{Key: key, ValueJSON: `"stale-db-value"`}, "seed", "historical row"); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/admin/settings/env", "/admin/settings/effective?category=env"} {
		status, body := doLegacySettingsRequest(t, http.MethodGet, ts.URL+path, "", token)
		if status != http.StatusOK {
			t.Fatalf("status=%d body=%s", status, body)
		}
		var out struct {
			Settings []map[string]any `json:"settings"`
		}
		if err := json.Unmarshal(body, &out); err != nil {
			t.Fatal(err)
		}
		found := false
		for _, row := range out.Settings {
			if row["key"] != key {
				continue
			}
			found = true
			if row["source"] != "env" || row["value"] != server.cfg.ListenAddr || row["version"] != nil || row["can_write"] != false {
				t.Fatalf("startup-only value misrepresented: %+v", row)
			}
			if layers, ok := row["layers"].([]any); ok {
				for _, item := range layers {
					layer := item.(map[string]any)
					if layer["name"] == "db_setting" && (layer["active"] != false || layer["configured"] != false || layer["value"] != "") {
						t.Fatalf("inapplicable DB layer shown: %+v", layer)
					}
				}
			}
		}
		if !found {
			t.Fatal("missing startup-only value")
		}
	}
	if row, found, err := db.GetAdminSetting(t.Context(), key); err != nil || !found || row.ValueJSON != `"stale-db-value"` {
		t.Fatalf("read changed historical record: found=%v err=%v", found, err)
	}
}

func TestAuthenticationStartupSettings(t *testing.T) {
	ts, server, db := scopedSettingsSecurityServer(t, "http://127.0.0.1:1")
	token := scopedSettingsToken(t, server, db, "admin")
	want := map[string]string{
		"env.auth_enabled":              strconv.FormatBool(server.cfg.Auth.Enabled),
		"env.auth_access_token_ttl":     server.cfg.Auth.AccessTokenTTL.String(),
		"env.auth_refresh_token_ttl":    server.cfg.Auth.RefreshTokenTTL.String(),
		"env.auth_jwt_configured":       "true",
		"env.self_service_keys_enabled": strconv.FormatBool(server.cfg.Auth.SelfServiceKeys),
	}
	for key := range want {
		if err := db.UpsertAdminSetting(t.Context(), store.AdminSetting{Key: key, ValueJSON: `"ignored-override"`}, "seed", "historical row"); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{"/admin/settings/env.auth", "/admin/settings/effective?category=env.auth"} {
		status, body := doLegacySettingsRequest(t, http.MethodGet, ts.URL+path, "", token)
		if status != http.StatusOK {
			t.Fatalf("status=%d body=%s", status, body)
		}
		if strings.Contains(string(body), server.cfg.Auth.JWTSecret) || strings.Contains(string(body), "ignored-override") {
			t.Fatal("startup metadata disclosed secret or ineffective override")
		}
		var out struct {
			Settings []map[string]any `json:"settings"`
		}
		if err := json.Unmarshal(body, &out); err != nil {
			t.Fatal(err)
		}
		if len(out.Settings) != len(want) {
			t.Fatalf("got %d settings, want %d", len(out.Settings), len(want))
		}
		seen := map[string]bool{}
		for _, row := range out.Settings {
			key, _ := row["key"].(string)
			value, ok := want[key]
			if !ok || seen[key] || row["value"] != value || row["read_only"] != true || row["can_write"] != false || row["restart_required"] != true || row["source"] != "env" || row["description"] == "" {
				t.Fatalf("incorrect startup view: %+v", row)
			}
			seen[key] = true
		}
		status, _ = doLegacySettingsRequest(t, http.MethodGet, ts.URL+path, "", "")
		if status != http.StatusUnauthorized {
			t.Fatalf("unauthenticated settings status=%d", status)
		}
	}
	for key := range want {
		for _, method := range []string{http.MethodPut, http.MethodDelete} {
			status, _ := doLegacySettingsRequest(t, method, ts.URL+"/admin/settings/by-key/"+key, `{"value":"false","expected_version":1}`, token)
			if status != http.StatusMethodNotAllowed {
				t.Fatalf("%s %s status=%d", method, key, status)
			}
		}
		row, exists, err := db.GetAdminSetting(t.Context(), key)
		if err != nil || !exists || row.ValueJSON != `"ignored-override"` {
			t.Fatal("denied mutation changed DB record")
		}
	}
	for _, attempt := range []struct{ method, path string }{{http.MethodPut, "/admin/settings/bulk"}, {http.MethodPost, "/admin/settings/import"}} {
		status, _ := doLegacySettingsRequest(t, attempt.method, ts.URL+attempt.path, `{"settings":[{"key":"cache.chat_enabled","value":"false"},{"key":"env.auth_enabled","value":"false"}]}`, token)
		if status != http.StatusUnprocessableEntity {
			t.Fatalf("mixed startup write status=%d", status)
		}
		if _, exists, err := db.GetAdminSetting(t.Context(), "cache.chat_enabled"); err != nil || exists {
			t.Fatal("partial batch applied")
		}
	}
}
