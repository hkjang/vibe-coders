package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func TestKeycloakAdminConfigUsesStoredSnapshotWithoutPublishing(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	s := &Server{db: db, cfg: config.Config{Keycloak: config.KeycloakConfig{ClientID: "environment-client"}}}
	cached := config.KeycloakConfig{ClientID: "stale-runtime-client", RoleMap: map[string]string{"old": "developer"}, ClientSecret: "stale-secret"}
	s.keycloakCfg.Store(&cached)
	record := store.SSOProviderConfig{Provider: "keycloak", ClientID: "current-stored-client", IssuerURL: "https://fixture.invalid/realm", RoleMap: map[string]string{"new": "operator"}, AutoLogin: true}
	if err := db.SaveSSOProviderConfig(t.Context(), record); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	s.handleKeycloakConfig(w, httptest.NewRequest(http.MethodGet, "/admin/sso/keycloak/config", nil))
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || body["client_id"] != record.ClientID || body["version"] != float64(1) || body["client_secret_set"] != false || body["auto_login"] != true || body["role_map"].(map[string]any)["new"] != "operator" {
		t.Fatalf("admin snapshot mixed stored and runtime values: %v", body)
	}
	if s.keycloakCfg.Load() != &cached || s.keycloakConfig().ClientID != cached.ClientID {
		t.Fatal("GET config published a new login runtime")
	}
}

func TestMattermostPostMasksWebhookAndAudit(t *testing.T) {
	_, s, db := atomicSettingsServer(t)
	const webhook = "https://fixture.invalid/hooks/synthetic-private-token"
	w := httptest.NewRecorder()
	s.handleMattermostConfig(w, httptest.NewRequest(http.MethodPost, "/admin/notifications/mattermost", strings.NewReader(`{"enabled":true,"webhook_url":"`+webhook+`","events":["secret"]}`)))
	if w.Code != 200 || strings.Contains(w.Body.String(), webhook) || strings.Contains(w.Body.String(), "synthetic-private-token") {
		t.Fatalf("POST must return masked config: status=%d body=%s", w.Code, w.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if body["webhook_url"] != "********" || body["webhook_url_set"] != true {
		t.Fatalf("POST secret metadata missing: %v", body)
	}
	audits, err := db.ListAdminAudit(t.Context(), 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(audits) != 1 || strings.Contains(audits[0].AfterValue, "synthetic-private-token") {
		t.Fatalf("webhook leaked into audit: %+v", audits)
	}
}

func TestMattermostExplicitEmptyEventsDisableAll(t *testing.T) {
	_, s, _ := atomicSettingsServer(t)
	w := httptest.NewRecorder()
	s.handleMattermostConfig(w, httptest.NewRequest(http.MethodPost, "/admin/notifications/mattermost", strings.NewReader(`{"events":[]}`)))
	if w.Code != 200 {
		t.Fatalf("save status=%d", w.Code)
	}
	for _, event := range mattermostEventCategories {
		if s.mattermostConfig(t.Context()).events[event] {
			t.Fatalf("explicit empty events enabled %s", event)
		}
	}
}

func TestMattermostTestRejectsMalformedURLWithoutPanic(t *testing.T) {
	_, s, db := atomicSettingsServer(t)
	if err := db.SetFlag(t.Context(), store.RuntimeFlag{Key: "mattermost_webhook_url", Value: "http://fixture.invalid/%secret-invalid-escape"}); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if cause := recover(); cause != nil {
			t.Errorf("malformed webhook caused panic: %v", cause)
		}
	}()
	w := httptest.NewRecorder()
	s.handleMattermostTest(w, httptest.NewRequest(http.MethodPost, "/admin/notifications/mattermost/test", nil))
	if w.Code != 400 || strings.Contains(w.Body.String(), "secret-invalid-escape") {
		t.Fatalf("malformed webhook response=%d %s", w.Code, w.Body.String())
	}
}

func TestMattermostTestDoesNotExposeTransportURL(t *testing.T) {
	_, s, db := atomicSettingsServer(t)
	const webhook = "https://fixture.invalid/hooks/synthetic-private-token"
	if err := db.SetFlag(context.Background(), store.RuntimeFlag{Key: "mattermost_webhook_url", Value: webhook}); err != nil {
		t.Fatal(err)
	}
	s.client = &http.Client{Transport: modelsRoundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("synthetic transport failure") })}
	w := httptest.NewRecorder()
	s.handleMattermostTest(w, httptest.NewRequest(http.MethodPost, "/admin/notifications/mattermost/test", nil))
	if w.Code != 502 || strings.Contains(w.Body.String(), "fixture.invalid") || strings.Contains(w.Body.String(), "synthetic-private-token") || strings.Contains(w.Body.String(), "synthetic transport") {
		t.Fatalf("transport error leaked URL/detail: %d %s", w.Code, w.Body.String())
	}
}

func TestMattermostTestUpstreamStatus(t *testing.T) {
	for _, status := range []int{200, 204, 403, 500} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			_, s, db := atomicSettingsServer(t)
			if err := db.SetFlag(t.Context(), store.RuntimeFlag{Key: "mattermost_webhook_url", Value: "https://fixture.invalid/secret-webhook-token"}); err != nil {
				t.Fatal(err)
			}
			s.client = &http.Client{Transport: modelsRoundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/json" {
					t.Errorf("unexpected delivery request: %s %s", r.Method, r.Header.Get("Content-Type"))
				}
				return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader("synthetic-secret-upstream-body")), Header: http.Header{}}, nil
			})}
			w := httptest.NewRecorder()
			s.handleMattermostTest(w, httptest.NewRequest(http.MethodPost, "/admin/notifications/mattermost/test", nil))
			if status < 300 {
				if w.Code != 200 || !strings.Contains(w.Body.String(), `"status":"sent"`) {
					t.Fatalf("successful delivery=%d %s", w.Code, w.Body.String())
				}
			} else if w.Code != 502 || !strings.Contains(w.Body.String(), "webhook_failed") {
				t.Fatalf("failed delivery incorrectly succeeded: %d %s", w.Code, w.Body.String())
			}
			if strings.Contains(w.Body.String(), "fixture.invalid") || strings.Contains(w.Body.String(), "secret-") {
				t.Fatalf("delivery response exposed upstream URL/body: %s", w.Body.String())
			}
		})
	}
}

func TestKeycloakAdminEnvSnapshotAndUndecryptableSecret(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	s := &Server{db: db, cfg: config.Config{Keycloak: config.KeycloakConfig{ClientID: "environment-client", ClientSecret: "environment-secret"}}}
	cached := config.KeycloakConfig{ClientID: "different-runtime"}
	s.keycloakCfg.Store(&cached)
	read := func() map[string]any {
		t.Helper()
		w := httptest.NewRecorder()
		s.handleKeycloakConfig(w, httptest.NewRequest(http.MethodGet, "/admin/sso/keycloak/config", nil))
		var body map[string]any
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &body) != nil {
			t.Fatalf("config response=%d %s", w.Code, w.Body.String())
		}
		return body
	}
	env := read()
	if env["client_id"] != "environment-client" || env["source"] != "env" || env["version"] != float64(0) || env["client_secret_set"] != true {
		t.Fatalf("env snapshot=%v", env)
	}
	if err := db.SaveSSOProviderConfig(t.Context(), store.SSOProviderConfig{Provider: "keycloak", ClientID: "stored-client", ClientSecretEnc: "invalid-ciphertext"}); err != nil {
		t.Fatal(err)
	}
	stored := read()
	if stored["client_id"] != "stored-client" || stored["source"] != "db" || stored["version"] != float64(1) || stored["client_secret_set"] != true || s.keycloakCfg.Load() != &cached {
		t.Fatalf("stored snapshot must not decrypt/publish: %v", stored)
	}
	encoded, _ := json.Marshal(stored)
	if strings.Contains(string(encoded), "ciphertext") || strings.Contains(string(encoded), "environment-secret") {
		t.Fatal("secret appeared in admin config")
	}
}

func TestKeycloakPersistedReloadFailureIsAudited(t *testing.T) {
	_, s, db := atomicSettingsServer(t)
	if err := db.SaveSSOProviderConfig(t.Context(), store.SSOProviderConfig{Provider: "keycloak", ClientID: "original", ClientSecretEnc: "invalid-ciphertext"}); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	s.handleKeycloakConfigSave(w, httptest.NewRequest(http.MethodPut, "/admin/sso/keycloak/config", strings.NewReader(`{"enabled":false,"client_id":"saved-client","issuer_url":"https://private-issuer.invalid/token-secret","expected_version":1}`)))
	if w.Code != 500 || !strings.Contains(w.Body.String(), "sso_reload_failed") {
		t.Fatalf("pending SSO response=%d %s", w.Code, w.Body.String())
	}
	current, found, err := db.GetSSOProviderConfig(t.Context(), "keycloak")
	if err != nil || !found || current.Version != 2 || current.ClientID != "saved-client" {
		t.Fatalf("SSO config was not persisted: %+v found=%v err=%v", current, found, err)
	}
	audits, err := db.ListAuditEvents(t.Context(), 20)
	if err != nil || len(audits) != 1 || audits[0].EventType != "sso_config_updated" || !strings.Contains(audits[0].Detail, "reload_pending=true") {
		t.Fatalf("persisted SSO audit=%v err=%v", audits, err)
	}
	if strings.Contains(audits[0].Detail+w.Body.String(), "token-secret") || strings.Contains(audits[0].Detail+w.Body.String(), "ciphertext") {
		t.Fatal("SSO pending response/audit exposed issuer or ciphertext")
	}
	stale := httptest.NewRecorder()
	s.handleKeycloakConfigSave(stale, httptest.NewRequest(http.MethodPut, "/admin/sso/keycloak/config", strings.NewReader(`{"enabled":false,"expected_version":1}`)))
	audits, err = db.ListAuditEvents(t.Context(), 20)
	if stale.Code != 409 || err != nil || len(audits) != 1 {
		t.Fatalf("failed SSO save added audit: status=%d events=%v err=%v", stale.Code, audits, err)
	}
	recovered := httptest.NewRecorder()
	s.handleKeycloakConfigSave(recovered, httptest.NewRequest(http.MethodPut, "/admin/sso/keycloak/config", strings.NewReader(`{"enabled":false,"client_secret":"","expected_version":2}`)))
	audits, err = db.ListAuditEvents(t.Context(), 20)
	if recovered.Code != 204 || err != nil || len(audits) != 2 {
		t.Fatalf("recovered SSO write not audited exactly once: status=%d events=%v err=%v", recovered.Code, audits, err)
	}
	pendingCount := 0
	for _, event := range audits {
		if strings.Contains(event.Detail, "reload_pending=true") {
			pendingCount++
		}
	}
	if pendingCount != 1 {
		t.Fatalf("recovered save reused pending audit metadata: %+v", audits)
	}
}

func TestKeycloakPersistedAuditSurvivesCanceledRequest(t *testing.T) {
	for _, pending := range []bool{false, true} {
		name := "after-reload"
		if pending {
			name = "before-reload"
		}
		t.Run(name, func(t *testing.T) {
			_, s, db := atomicSettingsServer(t)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			r := httptest.NewRequest(http.MethodPut, "/admin/sso/keycloak/config", nil).WithContext(ctx)
			record := store.SSOProviderConfig{Provider: "keycloak", ClientID: "saved-client", UpdatedBy: "operator@fixture.invalid", IssuerURL: "https://fixture.invalid/secret-issuer-token"}
			if err := db.SaveSSOProviderConfig(ctx, record); err != nil {
				t.Fatal(err)
			}
			if pending {
				cancel()
				if err := s.reloadKeycloakConfig(ctx); !errors.Is(err, context.Canceled) {
					t.Fatalf("canceled reload error=%v", err)
				}
			} else {
				if err := s.reloadKeycloakConfig(ctx); err != nil {
					t.Fatal(err)
				}
				cancel()
			}
			s.auditCommittedKeycloakConfig(r, record, pending)
			events, err := db.ListAuditEvents(t.Context(), 20)
			if err != nil || len(events) != 1 || events[0].EventType != "sso_config_updated" || events[0].ActorUserID != record.UpdatedBy || strings.Contains(events[0].Detail, "reload_pending=true") != pending || strings.Contains(events[0].Detail, "secret-issuer-token") {
				t.Fatalf("committed audit lost/mixed actor or metadata: %+v error=%v", events, err)
			}
		})
	}
}

func TestMattermostPersistedAuditSurvivesCanceledRequest(t *testing.T) {
	_, s, db := atomicSettingsServer(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	r := httptest.NewRequest(http.MethodPost, "/admin/notifications/mattermost", nil).WithContext(ctx)
	r.Header.Set("Authorization", "Bearer synthetic-operator-token")
	if _, err := db.SaveRuntimeFlagBatch(ctx, []store.RuntimeFlag{{Key: "mattermost_enabled", Value: "true"}}, mattermostFlagKeys); err != nil {
		t.Fatal(err)
	}
	cancel()
	detail := auditJSON(map[string]any{"enabled": true, "webhook_changed": false})
	s.auditCommittedSetting(r, "mattermost.config", "", detail)
	events, err := db.ListAdminAudit(t.Context(), 20)
	if err != nil || len(events) != 1 || events[0].Action != "mattermost.config" || events[0].AdminID != adminID(r) || events[0].AfterValue != detail {
		t.Fatalf("committed notification audit missing/changed: %+v error=%v", events, err)
	}
}

func TestMattermostOmittedFieldsClearAndEventFiltering(t *testing.T) {
	_, s, db := atomicSettingsServer(t)
	post := func(body string) map[string]any {
		t.Helper()
		w := httptest.NewRecorder()
		s.handleMattermostConfig(w, httptest.NewRequest(http.MethodPost, "/admin/notifications/mattermost", strings.NewReader(body)))
		var out map[string]any
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil {
			t.Fatalf("save status=%d body=%s", w.Code, w.Body.String())
		}
		return out
	}
	post(`{"enabled":true,"webhook_url":"https://fixture.invalid/private-token","channel":"old","events":[" secret ","invalid","cost","secret"]}`)
	kept := post(`{"channel":"new","events":null}`)
	if kept["enabled"] != true || kept["webhook_url_set"] != true || !reflect.DeepEqual(kept["events"], []any{"cost", "secret"}) {
		t.Fatalf("omitted values/filtering changed: %v", kept)
	}
	raw, _, err := db.GetFlag(t.Context(), "mattermost_webhook_url")
	if err != nil || raw.Value != "https://fixture.invalid/private-token" {
		t.Fatalf("omitted webhook did not remain stored: %v", err)
	}
	cleared := post(`{"webhook_url":"","channel":"","events":[]}`)
	if cleared["webhook_url"] != "" || cleared["webhook_url_set"] != false || cleared["channel"] != "" || !reflect.DeepEqual(cleared["events"], []any{}) {
		t.Fatalf("explicit clear failed: %v", cleared)
	}
	w := httptest.NewRecorder()
	s.handleMattermostConfig(w, httptest.NewRequest(http.MethodGet, "/admin/notifications/mattermost", nil))
	var read map[string]any
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &read) != nil || !reflect.DeepEqual(read, cleared) {
		t.Fatalf("GET/POST masked DTO differ: get=%v post=%v", read, cleared)
	}
}

func TestMattermostCanceledStoreFailureIsNotSuccessOrAudit(t *testing.T) {
	_, s, db := atomicSettingsServer(t)
	if err := db.SetFlag(t.Context(), store.RuntimeFlag{Key: "mattermost_enabled", Value: "false"}); err != nil {
		t.Fatal(err)
	}
	cached := s.mattermostConfig(t.Context())
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	w := httptest.NewRecorder()
	s.handleMattermostConfig(w, httptest.NewRequest(http.MethodPost, "/admin/notifications/mattermost", strings.NewReader(`{"enabled":true,"webhook_url":"https://fixture.invalid/secret-token"}`)).WithContext(ctx))
	if w.Code != 500 || !strings.Contains(w.Body.String(), "mattermost_config_save_failed") || strings.Contains(w.Body.String(), "secret-token") || s.mmCache.Load() != cached {
		t.Fatalf("failed write changed cache or returned success/detail: %d %s", w.Code, w.Body.String())
	}
	flags, err := db.GetRuntimeFlagSnapshot(t.Context(), mattermostFlagKeys)
	audits, auditErr := db.ListAdminAudit(t.Context(), 20)
	if err != nil || auditErr != nil || flags["mattermost_enabled"].Value != "false" || len(flags) != 1 || len(audits) != 0 {
		t.Fatalf("failed write changed state: flags=%v audits=%v err=%v/%v", flags, audits, err, auditErr)
	}
	read := httptest.NewRecorder()
	s.handleMattermostConfig(read, httptest.NewRequest(http.MethodGet, "/admin/notifications/mattermost", nil).WithContext(ctx))
	if read.Code != 503 {
		t.Fatalf("admin GET hid read failure behind cache: %d %s", read.Code, read.Body.String())
	}
}

type mattermostLogSink chan string

func (sink mattermostLogSink) Write(data []byte) (int, error) {
	sink <- string(data)
	return len(data), nil
}

func TestMattermostNotifyLogNeverIncludesWebhookURL(t *testing.T) {
	_, s, db := atomicSettingsServer(t)
	for key, value := range map[string]string{"mattermost_enabled": "true", "mattermost_webhook_url": "https://fixture.invalid/secret-webhook-token"} {
		if err := db.SetFlag(t.Context(), store.RuntimeFlag{Key: key, Value: value}); err != nil {
			t.Fatal(err)
		}
	}
	s.client = &http.Client{Transport: modelsRoundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("raw-sensitive-driver-detail") })}
	logs := make(mattermostLogSink, 8)
	original := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, nil)))
	defer slog.SetDefault(original)
	s.notifyMattermost(t.Context(), "secret", "synthetic event")
	select {
	case line := <-logs:
		if !strings.Contains(line, "mattermost notify failed") || strings.Contains(line, "fixture.invalid") || strings.Contains(line, "secret-webhook-token") || strings.Contains(line, "raw-sensitive-driver-detail") {
			t.Fatalf("notification error leaked details: %s", line)
		}
	case <-time.After(time.Second):
		t.Fatal("expected a bounded generic notification failure log")
	}
}
