package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func personalAccessSession(t *testing.T, db *store.SQLStore, id, user string) {
	t.Helper()
	expires := time.Now().UTC().Add(time.Hour)
	if err := db.InsertAuthSession(t.Context(), id, user, "192.0.2.10", "Public fixture browser", expires); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertRefreshToken(t.Context(), store.RefreshTokenRecord{ID: id + "-refresh", UserID: user, SessionID: id, TokenHash: id + "-fixture-hash", ExpiresAt: expires}); err != nil {
		t.Fatal(err)
	}
}

func TestPersonalAccessSessionsOwnershipAndRefreshRevocation(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	server, token := personalConsoleFixture(t, db)
	for _, user := range []string{"personal-own", "personal-other"} {
		personalAccessSession(t, db, user+"-device", user)
	}
	personalAccessSession(t, db, "personal-own-extra", "personal-own")
	routes := server.Routes()
	response := teamConsoleRequest(t, routes, "GET", "/me/sessions", token, "")
	var list struct {
		Current  string `json:"current_session_id"`
		Sessions []struct {
			ID      string `json:"id"`
			Current bool   `json:"current"`
		} `json:"sessions"`
	}
	if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store" || json.Unmarshal(response.Body.Bytes(), &list) != nil || list.Current != "personal-own-session" || len(list.Sessions) != 3 {
		t.Fatalf("session list contract status=%d", response.Code)
	}
	for _, row := range list.Sessions {
		if !strings.HasPrefix(row.ID, "personal-own-") || row.Current != (row.ID == list.Current) {
			t.Fatal("session ownership/current flag mismatch")
		}
	}
	for _, tc := range []struct {
		method, path string
		status       int
	}{
		{"DELETE", "/me/sessions/personal-other-device", 404},
		{"DELETE", "/me/sessions/personal-own-device", 200},
		{"DELETE", "/me/sessions/personal-own-device", 404},
		{"POST", "/me/sessions/revoke-others", 200},
		{"GET", "/me/sessions/revoke-others", 405},
	} {
		r := teamConsoleRequest(t, routes, tc.method, tc.path, token, "")
		if r.Code != tc.status || r.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("session action status=%d want=%d", r.Code, tc.status)
		}
		if tc.status == 200 {
			var ack struct {
				Status  string
				Session string `json:"session_id"`
				Count   int    `json:"revoked_count"`
			}
			if json.Unmarshal(r.Body.Bytes(), &ack) != nil || ack.Status != "revoked" || (tc.method == "DELETE" && ack.Session != "personal-own-device") || (tc.method == "POST" && ack.Count != 1) {
				t.Fatal("revocation acknowledgment mismatch")
			}
		}
	}
	for _, id := range []string{"personal-own-device", "personal-own-extra", "personal-other-device"} {
		own := strings.HasPrefix(id, "personal-own-")
		active, err := db.AuthSessionActive(t.Context(), id)
		refresh, found, refreshErr := db.RefreshTokenByHash(t.Context(), id+"-fixture-hash")
		if err != nil || refreshErr != nil || !found || active == own || refresh.RevokedAt.IsZero() == own {
			t.Fatal("session and refresh revocation did not preserve ownership")
		}
	}
	if active, err := db.AuthSessionActive(t.Context(), list.Current); err != nil || !active {
		t.Fatal("bulk revoke removed current session")
	}
	// The pre-existing API still permits an explicit self revoke. The React UI protects it.
	if r := teamConsoleRequest(t, routes, "DELETE", "/me/sessions/"+list.Current, token, ""); r.Code != 200 {
		t.Fatalf("legacy self revoke status=%d", r.Code)
	}
}

func TestPersonalAccessSessionRefreshFailureRollsBack(t *testing.T) {
	for _, bulk := range []bool{false, true} {
		t.Run(map[bool]string{false: "single", true: "others"}[bulk], func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "sessions.db")
			db := openSQLiteTestStore(t, path)
			server, token := personalConsoleFixture(t, db)
			personalAccessSession(t, db, "public-device", "personal-own")
			if _, err := fixtureRawDB(t, path).ExecContext(t.Context(), "ALTER TABLE refresh_tokens RENAME TO private_unavailable_refresh"); err != nil {
				t.Fatal(err)
			}
			method, route := "DELETE", "/me/sessions/public-device"
			if bulk {
				method, route = "POST", "/me/sessions/revoke-others"
			}
			response := teamConsoleRequest(t, server.Routes(), method, route, token, "")
			if response.Code != 500 || strings.Contains(response.Body.String(), "refresh_tokens") || strings.Contains(response.Body.String(), "private_unavailable") || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("private DB failure response status=%d", response.Code)
			}
			if active, err := db.AuthSessionActive(t.Context(), "public-device"); err != nil || !active {
				t.Fatal("failed refresh revocation did not roll back session")
			}
		})
	}
}

type personalDoctorResponse struct {
	Client  string        `json:"client"`
	Overall string        `json:"overall"`
	Mode    string        `json:"auth_mode"`
	Checks  []doctorCheck `json:"checks"`
}

func personalDoctor(t *testing.T, handler http.Handler, token, client string) personalDoctorResponse {
	t.Helper()
	r := teamConsoleRequest(t, handler, "POST", "/me/connection-doctor", token, `{"client":"`+client+`"}`)
	var out personalDoctorResponse
	if r.Code != 200 || r.Header().Get("Cache-Control") != "no-store" || json.Unmarshal(r.Body.Bytes(), &out) != nil || out.Client != client {
		t.Fatalf("doctor response status=%d", r.Code)
	}
	return out
}
func personalCheck(t *testing.T, response personalDoctorResponse, name, status string) {
	t.Helper()
	for _, check := range response.Checks {
		if check.Name == name {
			if check.Status != status {
				t.Fatalf("check %s=%s want=%s", name, check.Status, status)
			}
			return
		}
	}
	t.Fatalf("missing diagnostic check %s", name)
}

func TestPersonalAccessDoctorAndOnboardingAuthModes(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	server, token := personalConsoleFixture(t, db)
	// This fixture also exercises the existing proxy request logger.
	server.logger = store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "requests.ndjson"))
	now := time.Now().UTC()
	for _, tc := range []struct {
		id, user string
		expired  bool
	}{{"public-active", "personal-own", false}, {"public-expired", "personal-own", true}, {"public-other", "personal-other", false}} {
		expires := now.Add(time.Hour)
		if tc.expired {
			expires = now.Add(-time.Hour)
		}
		if err := db.UpsertAPIKey(t.Context(), store.APIKeyRecord{ID: tc.id, Name: tc.id, UserID: tc.user, KeyHash: hashProxyKey(tc.id + "-fixture-key"), Status: "active", Role: "developer", Scopes: []string{"models:read", "mcp:use"}, ExpiresAt: expires, CreatedAt: now}); err != nil {
			t.Fatal(err)
		}
	}
	key, count, found, err := server.newestActiveUserKey(httptest.NewRequest("GET", "/", nil), "personal-own")
	if err != nil || !found || count != 1 || key.ID != "public-active" {
		t.Fatal("doctor selected expired or another user's key")
	}
	routes := server.Routes()
	jwt := personalDoctor(t, routes, token, "cursor")
	if jwt.Mode != "jwt" {
		t.Fatal("browser did not use JWT diagnostics")
	}
	personalCheck(t, jwt, "endpoint_reachability", "skip")
	for _, check := range jwt.Checks {
		if check.Name == "v1_models" || strings.HasPrefix(check.Name, "mcp_") {
			t.Fatal("JWT diagnostics attempted a live endpoint probe")
		}
	}
	anonymous := personalDoctor(t, routes, "", "cursor")
	if anonymous.Mode != "" || anonymous.Overall != "fail" || len(anonymous.Checks) != 1 {
		t.Fatal("anonymous doctor exposed private diagnostics")
	}
	personalCheck(t, anonymous, "authorization", "fail")
	proxy := personalDoctor(t, routes, "public-active-fixture-key", "openai-sdk")
	if proxy.Mode != "proxy_key" {
		t.Fatal("proxy key did not use live diagnostics")
	}
	// The deliberately invalid local upstream must be reported, not falsely healthy.
	personalCheck(t, proxy, "v1_models", "fail")
	for _, credential := range []string{"", "public-active-fixture-key"} {
		if r := teamConsoleRequest(t, routes, "GET", "/me/sessions", credential, ""); r.Code != 401 {
			t.Fatalf("JWT-only sessions status=%d", r.Code)
		}
	}
	for _, client := range []string{"openai-sdk", "cursor", "roo", "cline", "claude-desktop-mcp", "claude", "mcp", "unknown-client"} {
		for _, credential := range []string{token, "public-active-fixture-key"} {
			r := teamConsoleRequest(t, routes, "GET", "/me/onboarding-pack?client="+client, credential, "")
			var pack struct {
				Client string
				Config string
				MCP    map[string]any `json:"mcp_config"`
				Models []string       `json:"available_models"`
			}
			if r.Code != 200 || r.Header().Get("Cache-Control") != "no-store" || json.Unmarshal(r.Body.Bytes(), &pack) != nil || pack.Client != client || pack.Config == "" || pack.MCP == nil || pack.Models == nil || strings.Contains(r.Body.String(), credential) || !strings.Contains(r.Body.String(), "YOUR_API_KEY") {
				t.Fatalf("onboarding contract status=%d", r.Code)
			}
		}
	}
}

func TestPersonalAccessDoctorReportsDatabaseFailures(t *testing.T) {
	for _, table := range []string{"api_keys", "quotas"} {
		t.Run(table, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "doctor.db")
			db := openSQLiteTestStore(t, path)
			server, token := personalConsoleFixture(t, db)
			if err := db.UpsertAPIKey(t.Context(), store.APIKeyRecord{ID: "public-active", Name: "Public", UserID: "personal-own", KeyHash: hashProxyKey("public-fixture"), Status: "active", Scopes: []string{"models:read"}}); err != nil {
				t.Fatal(err)
			}
			if _, err := fixtureRawDB(t, path).ExecContext(t.Context(), "ALTER TABLE "+table+" RENAME TO private_unavailable"); err != nil {
				t.Fatal(err)
			}
			result := personalDoctor(t, server.Routes(), token, "openai-sdk")
			if result.Overall != "fail" {
				t.Fatal("DB failure reported as healthy")
			}
			if table == "api_keys" {
				personalCheck(t, result, "issued_keys", "fail")
				personalCheck(t, result, "scope", "skip")
				personalCheck(t, result, "model_allowlist", "skip")
			} else {
				personalCheck(t, result, "quota", "fail")
			}
			for _, check := range result.Checks {
				if strings.Contains(check.Detail+check.Fix, "private_unavailable") || strings.Contains(check.Detail+check.Fix, "SQL") {
					t.Fatal("doctor exposed private DB failure")
				}
			}
		})
	}
}
