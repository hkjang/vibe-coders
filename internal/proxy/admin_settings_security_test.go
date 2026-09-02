package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func changeSetPayload(t *testing.T, key, value string) string {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"title": "unsafe setting",
		"items": []map[string]string{{"kind": "setting", "key": key, "value": value}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(payload)
}

func assertChangeSetResponseDoesNotContain(t *testing.T, out map[string]any, forbidden ...string) {
	t.Helper()
	encoded, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range forbidden {
		if strings.Contains(string(encoded), value) {
			t.Fatalf("change-set response exposed %q: %s", value, encoded)
		}
	}
}

func TestChangeSetsRejectUnsafeSettingsAndRedactLegacyRows(t *testing.T) {
	ts, _, db := atomicSettingsServer(t)
	ctx := context.Background()

	for _, tc := range []struct {
		name, key, value string
	}{
		{name: "secret", key: "text2sql.exec_dsn", value: "postgres://create-secret@example/db"},
		{name: "read-only", key: "env.listen_addr", value: ":9999"},
	} {
		t.Run("create rejects "+tc.name, func(t *testing.T) {
			resp, out := req(t, http.MethodPost, ts.URL+"/admin/change-sets", changeSetPayload(t, tc.key, tc.value))
			if resp.StatusCode != http.StatusUnprocessableEntity {
				t.Fatalf("create status=%d body=%+v, want 422", resp.StatusCode, out)
			}
			assertChangeSetResponseDoesNotContain(t, out, tc.value)
		})
	}
	if rows, err := db.ListChangeSets(ctx); err != nil || len(rows) != 0 {
		t.Fatalf("unsafe create persisted rows=%d err=%v", len(rows), err)
	}

	currentSecret := "postgres://current-secret@example/db"
	resp, out := req(t, http.MethodPut, ts.URL+"/admin/settings/by-key/text2sql.exec_dsn", `{"value":"`+currentSecret+`"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("seed current secret status=%d body=%+v", resp.StatusCode, out)
	}
	proposedSecret := "postgres://proposed-secret@example/db"
	priorSecret := "postgres://prior-secret@example/db"
	legacySecret := store.ChangeSet{
		ID: "cs-legacy-secret", Title: "legacy secret", Status: "approved",
		Items: []store.ChangeSetItem{{Kind: "setting", Key: "text2sql.exec_dsn", Value: proposedSecret}},
		Prior: []store.ChangeSetItem{{Kind: "setting", Key: "text2sql.exec_dsn", Value: priorSecret}},
	}
	if err := db.CreateChangeSet(ctx, legacySecret); err != nil {
		t.Fatal(err)
	}

	for _, endpoint := range []string{"/admin/change-sets", "/admin/change-sets/" + legacySecret.ID} {
		resp, out = req(t, http.MethodGet, ts.URL+endpoint, "")
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s status=%d body=%+v", endpoint, resp.StatusCode, out)
		}
		assertChangeSetResponseDoesNotContain(t, out, proposedSecret, priorSecret, currentSecret)
		encoded, _ := json.Marshal(out)
		if !strings.Contains(string(encoded), redactedChangeSetValue) {
			t.Fatalf("GET %s did not redact legacy secret fields: %s", endpoint, encoded)
		}
	}

	for _, action := range []struct {
		method, suffix string
	}{
		{method: http.MethodGet, suffix: "/dryrun"},
		{method: http.MethodPost, suffix: "/apply"},
	} {
		resp, out = req(t, action.method, ts.URL+"/admin/change-sets/"+legacySecret.ID+action.suffix, "")
		if resp.StatusCode != http.StatusUnprocessableEntity {
			t.Fatalf("%s status=%d body=%+v, want 422", action.suffix, resp.StatusCode, out)
		}
		assertChangeSetResponseDoesNotContain(t, out, proposedSecret, priorSecret, currentSecret)
	}
	legacySecret.Status = "applied"
	if err := db.UpdateChangeSet(ctx, legacySecret); err != nil {
		t.Fatal(err)
	}
	resp, out = req(t, http.MethodPost, ts.URL+"/admin/change-sets/"+legacySecret.ID+"/rollback", "")
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("secret rollback status=%d body=%+v, want 422", resp.StatusCode, out)
	}
	assertChangeSetResponseDoesNotContain(t, out, proposedSecret, priorSecret, currentSecret)

	legacyReadOnly := store.ChangeSet{
		ID: "cs-legacy-readonly", Title: "legacy read-only", Status: "approved",
		Items: []store.ChangeSetItem{{Kind: "setting", Key: "env.listen_addr", Value: ":9999"}},
		Prior: []store.ChangeSetItem{{Kind: "setting", Key: "env.listen_addr", Value: ":8080"}},
	}
	if err := db.CreateChangeSet(ctx, legacyReadOnly); err != nil {
		t.Fatal(err)
	}
	for _, action := range []struct {
		method, suffix string
	}{
		{method: http.MethodGet, suffix: "/dryrun"},
		{method: http.MethodPost, suffix: "/apply"},
	} {
		resp, out = req(t, action.method, ts.URL+"/admin/change-sets/"+legacyReadOnly.ID+action.suffix, "")
		if resp.StatusCode != http.StatusUnprocessableEntity {
			t.Fatalf("read-only %s status=%d body=%+v, want 422", action.suffix, resp.StatusCode, out)
		}
	}
	legacyReadOnly.Status = "applied"
	if err := db.UpdateChangeSet(ctx, legacyReadOnly); err != nil {
		t.Fatal(err)
	}
	resp, out = req(t, http.MethodPost, ts.URL+"/admin/change-sets/"+legacyReadOnly.ID+"/rollback", "")
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("read-only rollback status=%d body=%+v, want 422", resp.StatusCode, out)
	}
}

func legacySettingsSecurityServer(t *testing.T, upstreamURL string) (*httptest.Server, *Server, *store.SQLStore) {
	t.Helper()
	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	cfg := testConfig(upstreamURL, "secret")
	cfg.Auth.AdminToken = "rw-secret"
	cfg.Auth.AdminReadonlyToken = "ro-secret"
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		logger.Stop(context.Background())
		t.Fatal(err)
	}
	ts := httptest.NewServer(server.Routes())
	t.Cleanup(func() {
		ts.Close()
		logger.Stop(context.Background())
	})
	return ts, server, db
}

func doLegacySettingsRequest(t *testing.T, method, url, body, token string) (int, []byte) {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		t.Fatal(err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp.StatusCode, payload
}

func TestSettingsMutationMethodsAndLegacyReadonlyRoleFailClosed(t *testing.T) {
	var outboundHits atomic.Int32
	outbound := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		outboundHits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer outbound.Close()
	ts, server, db := legacySettingsSecurityServer(t, outbound.URL)

	for _, value := range []string{"true", "false"} {
		status, body := doLegacySettingsRequest(t, http.MethodPut,
			ts.URL+"/admin/settings/by-key/cache.chat_enabled", `{"value":"`+value+`"}`, "rw-secret")
		if status != http.StatusOK {
			t.Fatalf("seed setting %s status=%d body=%s", value, status, body)
		}
	}
	before, found, err := db.GetAdminSetting(context.Background(), "cache.chat_enabled")
	if err != nil || !found {
		t.Fatalf("seed setting not found: found=%v err=%v", found, err)
	}

	wrongMethod := []struct {
		path, body string
	}{
		{path: "/admin/settings/bulk", body: `{"settings":[]}`},
		{path: "/admin/settings/import", body: `{"settings":[]}`},
		{path: "/admin/settings/validate", body: `{"key":"cache.chat_enabled","value":"true"}`},
		{path: "/admin/settings/test/clickhouse", body: `{"url":"` + outbound.URL + `"}`},
		{path: "/admin/settings/test/text2sql-exec", body: `{"dsn":"file::memory:?cache=shared","driver":"sqlite"}`},
		{path: "/admin/settings/test/text2sql-twin", body: `{"dsn":"file::memory:?cache=shared","driver":"sqlite"}`},
		{path: "/admin/settings/rollback", body: `{"key":"cache.chat_enabled","reason":"must not run"}`},
		{path: "/admin/sso/keycloak/test", body: `{}`},
	}
	for _, tc := range wrongMethod {
		t.Run("GET "+tc.path, func(t *testing.T) {
			status, body := doLegacySettingsRequest(t, http.MethodGet, ts.URL+tc.path, tc.body, "ro-secret")
			if status != http.StatusMethodNotAllowed {
				t.Fatalf("status=%d body=%s, want 405", status, body)
			}
		})
	}
	if got := outboundHits.Load(); got != 0 {
		t.Fatalf("wrong-method connection test made %d outbound request(s)", got)
	}
	after, found, err := db.GetAdminSetting(context.Background(), "cache.chat_enabled")
	if err != nil || !found {
		t.Fatalf("setting disappeared after GET rollback: found=%v err=%v", found, err)
	}
	if after.Version != before.Version || after.ValueJSON != before.ValueJSON {
		t.Fatalf("GET rollback mutated setting: before=%+v after=%+v", before, after)
	}

	for _, path := range []string{
		"/admin/settings/test/clickhouse",
		"/admin/settings/test/text2sql-exec",
		"/admin/settings/test/text2sql-twin",
		"/admin/sso/keycloak/test",
	} {
		status, body := doLegacySettingsRequest(t, http.MethodPost, ts.URL+path, `{}`, "ro-secret")
		if status != http.StatusUnauthorized {
			t.Fatalf("readonly POST %s status=%d body=%s, want 401", path, status, body)
		}
	}
	if got := outboundHits.Load(); got != 0 {
		t.Fatalf("readonly connection test made %d outbound request(s)", got)
	}

	readOnlyRequest := httptest.NewRequest(http.MethodPut, "/admin/settings/by-key/cache.chat_enabled", nil)
	readOnlyRequest.Header.Set("Authorization", "Bearer ro-secret")
	if got := server.callerSettingsRole(readOnlyRequest); got != "legacy_readonly" {
		t.Fatalf("callerSettingsRole(readonly)=%q, want legacy_readonly", got)
	}
	def, _ := settingDefByKey("cache.chat_enabled")
	if server.canWriteSetting(readOnlyRequest, def) {
		t.Fatal("legacy readonly token may write a setting")
	}
	adminRequest := httptest.NewRequest(http.MethodPut, "/admin/settings/by-key/cache.chat_enabled", nil)
	adminRequest.Header.Set("Authorization", "Bearer rw-secret")
	if got := server.callerSettingsRole(adminRequest); got != "legacy_admin" {
		t.Fatalf("callerSettingsRole(admin)=%q, want legacy_admin", got)
	}
}

func scopedSettingsSecurityServer(t *testing.T, upstreamURL string) (*httptest.Server, *Server, *store.SQLStore) {
	t.Helper()
	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	cfg := testConfig(upstreamURL, "secret")
	cfg.Auth.Enabled = true
	cfg.Auth.JWTSecret = "settings-scope-secret"
	cfg.Auth.AccessTokenTTL = time.Hour
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		logger.Stop(context.Background())
		t.Fatal(err)
	}
	ts := httptest.NewServer(server.Routes())
	t.Cleanup(func() {
		ts.Close()
		logger.Stop(context.Background())
	})
	return ts, server, db
}

func scopedSettingsToken(t *testing.T, server *Server, db *store.SQLStore, role string) string {
	t.Helper()
	now := time.Now().UTC()
	sessionID := "settings-scope-" + role
	if err := db.InsertAuthSession(t.Context(), sessionID, "user-"+role, "127.0.0.1", "test", now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	token, err := server.signAccessToken(accessClaims{
		Subject: "user-" + role, Role: role, Scopes: append([]string(nil), roleScopes[role]...),
		SessionID: sessionID, Type: "access", IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func TestSettingsConnectionTestsEnforceScopedAdminCategory(t *testing.T) {
	var outboundHits atomic.Int32
	outbound := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		outboundHits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer outbound.Close()
	ts, server, db := scopedSettingsSecurityServer(t, outbound.URL)
	opsToken := scopedSettingsToken(t, server, db, "ops_admin")
	securityToken := scopedSettingsToken(t, server, db, "security_admin")

	status, body := doLegacySettingsRequest(t, http.MethodPost, ts.URL+"/admin/settings/test/clickhouse",
		`{"url":"`+outbound.URL+`"}`, securityToken)
	if status != http.StatusForbidden {
		t.Fatalf("security_admin ClickHouse test status=%d body=%s, want 403", status, body)
	}
	if got := outboundHits.Load(); got != 0 {
		t.Fatalf("denied ClickHouse test made %d outbound request(s)", got)
	}

	status, body = doLegacySettingsRequest(t, http.MethodPost, ts.URL+"/admin/settings/test/clickhouse",
		`{"url":"`+outbound.URL+`"}`, opsToken)
	if status != http.StatusOK {
		t.Fatalf("ops_admin ClickHouse test status=%d body=%s, want 200", status, body)
	}
	if got := outboundHits.Load(); got != 1 {
		t.Fatalf("allowed ClickHouse test made %d outbound request(s), want 1", got)
	}

	status, body = doLegacySettingsRequest(t, http.MethodPost, ts.URL+"/admin/settings/test/text2sql-exec",
		`{"dsn":"file::memory:?cache=shared","driver":"sqlite"}`, opsToken)
	if status != http.StatusForbidden {
		t.Fatalf("ops_admin Text2SQL test status=%d body=%s, want 403", status, body)
	}
	status, body = doLegacySettingsRequest(t, http.MethodPost, ts.URL+"/admin/settings/test/text2sql-exec",
		`{"dsn":"file::memory:?cache=shared","driver":"sqlite"}`, securityToken)
	if status != http.StatusOK {
		t.Fatalf("security_admin Text2SQL test status=%d body=%s, want 200", status, body)
	}
}
