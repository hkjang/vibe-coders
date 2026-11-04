package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"vibe-coders/internal/config"
	"vibe-coders/internal/secret"
	"vibe-coders/internal/store"
)

func TestSecretsRotatePreservesRuntimeAndReloadedValues(t *testing.T) {
	for _, corrupt := range []bool{false, true} {
		name := "success"
		if corrupt {
			name = "corrupt_setting"
		}
		t.Run(name, func(t *testing.T) {
			db := openTestStore(t)
			t.Cleanup(func() { _ = db.Close() })
			oldCipher, err := secret.New("synthetic-old-gateway-secret")
			if err != nil {
				t.Fatal(err)
			}
			s := &Server{db: db, cfg: config.Config{Auth: config.AuthConfig{AdminToken: "synthetic-admin-token"}}}
			s.secrets.Store(oldCipher)
			def := settingDef{Key: "CLICKHOUSE_DSN", Category: "clickhouse", Type: stString, Secret: true}
			setting, err := s.prepareSettingValue(def, "synthetic-setting-secret")
			if err != nil {
				t.Fatal(err)
			}
			if corrupt {
				setting.ValueJSON = `"v1:damaged-ciphertext"`
			}
			if err := db.UpsertAdminSetting(t.Context(), setting, "test-admin", "synthetic fixture"); err != nil {
				t.Fatal(err)
			}
			enc, err := oldCipher.Encrypt("synthetic-sso-secret")
			if err != nil {
				t.Fatal(err)
			}
			if err := db.SaveSSOProviderConfig(t.Context(), store.SSOProviderConfig{
				Provider: "keycloak", ClientID: "test-client", ClientSecretEnc: enc,
			}); err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPost, "/admin/secrets/rotate", strings.NewReader(`{"new_secret":"synthetic-new-gateway-secret"}`))
			request.Header.Set("Authorization", "Bearer synthetic-admin-token")
			response := httptest.NewRecorder()
			s.handleSecretsRotate(response, request)
			if corrupt {
				if response.Code != http.StatusInternalServerError || s.secrets.Load() != oldCipher {
					t.Fatal("failed rotation must return an error and retain the running cipher")
				}
				loaded, err := s.loadKeycloakConfig(t.Context())
				if err != nil || loaded.ClientSecret != "synthetic-sso-secret" {
					t.Fatal("failed rotation must retain decryptable SSO configuration")
				}
				return
			}
			if response.Code != http.StatusOK || s.secrets.Load() == oldCipher {
				t.Fatal("successful rotation must publish the new cipher")
			}
			var result struct {
				Status  string         `json:"status"`
				Rotated map[string]int `json:"rotated"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || result.Status != "ok" || result.Rotated["admin_settings"] != 1 || result.Rotated["sso_provider_config"] != 1 {
				t.Fatal("rotation response must account for settings and SSO")
			}
			newCipher, err := secret.New("synthetic-new-gateway-secret")
			if err != nil {
				t.Fatal(err)
			}
			reloaded := &Server{db: db, cfg: s.cfg}
			reloaded.secrets.Store(newCipher)
			for _, server := range []*Server{s, reloaded} {
				loaded, err := server.loadKeycloakConfig(t.Context())
				if err != nil || loaded.ClientSecret != "synthetic-sso-secret" {
					t.Fatal("running and reloaded servers must decrypt the SSO secret")
				}
				stored, found, err := db.GetAdminSetting(t.Context(), def.Key)
				if err != nil || !found {
					t.Fatal("setting must remain available")
				}
				value, source, err := server.effectiveSettingValue(map[string]store.AdminSetting{def.Key: stored}, def)
				if err != nil || value != "synthetic-setting-secret" || source != "admin" {
					t.Fatal("running and reloaded servers must decrypt the stored setting")
				}
			}
			for _, value := range []string{"synthetic-setting-secret", "synthetic-sso-secret", "synthetic-new-gateway-secret", enc} {
				if strings.Contains(response.Body.String(), value) {
					t.Fatal("rotation response leaked a credential")
				}
			}
		})
	}
}
