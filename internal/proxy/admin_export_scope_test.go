package proxy

import (
	"context"
	"encoding/csv"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestPromptExportCSVScopeMaskingAndFormulaContract(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	ctx := t.Context()
	now := time.Now().UTC().Add(-time.Minute)
	for _, team := range []store.AuthTeam{{ID: "csv-alpha", Name: "csv-alpha-name"}, {ID: "csv-beta", Name: "csv-beta-name"}} {
		if err := db.UpsertAuthTeam(ctx, team); err != nil {
			t.Fatal(err)
		}
	}
	for _, key := range []store.APIKeyRecord{
		{ID: "csv-alpha-key", Name: "alpha", KeyHash: "csv-alpha-hash", Team: "csv-alpha-name", Status: "active"},
		{ID: "csv-beta-key", Name: "beta", KeyHash: "csv-beta-hash", Team: "csv-beta", Status: "active"},
	} {
		if err := db.UpsertAPIKey(ctx, key); err != nil {
			t.Fatal(err)
		}
	}
	const credential = "vc_sk_abcdefghijklmnopqrstuvwxyzABCDEF"
	for _, row := range []struct{ id, key, word string }{{"csv-own", "csv-alpha-key", "alpha"}, {"csv-other", "csv-beta-key", "beta"}} {
		if err := db.InsertLogRecord(ctx, store.LogRecord{
			Request: store.RequestLog{ID: row.id, TraceID: row.id + "-trace", APIKeyID: row.key,
				Endpoint: "/v1/chat/completions", Model: "=1+1", Provider: "\u00a0@SUM(1)",
				Error: "공개 테스트, 오류\n" + credential, StatusCode: 502, LatencyMS: 12, CreatedAt: now},
			Prompts: []store.PromptLog{{ID: row.id + "-prompt", RequestID: row.id, Role: "user",
				ContentText: "private-" + row.word, RedactedText: "safe-" + row.word, CreatedAt: now}},
			Usage: &store.TokenUsage{ID: row.id + "-usage", RequestID: row.id, TotalTokens: 7, EstimatedCost: 12.5, Currency: "KRW", CreatedAt: now},
		}); err != nil {
			t.Fatal(err)
		}
	}
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "csv.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	cfg := testConfig("http://unused.invalid", "secret")
	cfg.Auth.Enabled, cfg.Auth.JWTSecret, cfg.Auth.AccessTokenTTL = true, "csv-fixture-jwt", time.Hour
	cfg.Auth.APIKeyPrefix = "vc_sk_"
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	team := issueLLMScopedTestToken(t, db, server, "csv-team-user", "team_admin", "csv-alpha", []string{"admin:read"}, now)
	emptyTeam := issueLLMScopedTestToken(t, db, server, "csv-empty-user", "team_admin", "", []string{"admin:read"}, now)
	admin := issueLLMScopedTestToken(t, db, server, "csv-admin", "super_admin", "", []string{"admin:read", "admin:write"}, now)
	viewer := issueLLMScopedTestToken(t, db, server, "csv-viewer", "readonly_admin", "", []string{"admin:read"}, now)
	routes := server.Routes()
	for _, tc := range []struct {
		name, token, query string
		count              int
		raw                bool
	}{
		{"own team", team, "", 1, false},
		{"own redacted search", team, "?q=safe-alpha", 1, false},
		{"raw search denied", team, "?q=private-alpha", 0, false},
		{"other team search denied", team, "?q=safe-beta", 0, false},
		{"other key filter denied", team, "?api_key_id=csv-beta-key", 0, false},
		{"empty team denied", emptyTeam, "", 0, false},
		{"viewer redacted global", viewer, "", 2, false},
		{"admin raw search preserved", admin, "?q=private-alpha", 1, true},
		{"admin global preserved", admin, "", 2, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/admin/export.csv"+tc.query, nil)
			r.Header.Set("Authorization", "Bearer "+tc.token)
			w := httptest.NewRecorder()
			routes.ServeHTTP(w, r)
			if w.Code != http.StatusOK {
				t.Fatalf("status = %d", w.Code)
			}
			rows, err := csv.NewReader(strings.NewReader(strings.TrimPrefix(w.Body.String(), "\ufeff"))).ReadAll()
			if err != nil || len(rows) != tc.count+1 {
				t.Fatalf("CSV row count mismatch: got %d, want %d", len(rows)-1, tc.count)
			}
			if len(rows[0]) != 21 || rows[0][0] != "created_at" || rows[0][20] != "error" {
				t.Fatal("legacy CSV columns changed")
			}
			if !tc.raw && strings.Contains(w.Body.String(), credential) {
				t.Fatal("masked export exposed fixture credential")
			}
			for _, row := range rows[1:] {
				for _, column := range []int{0, 1, 2, 3, 4, 5, 6, 7, 17, 19, 20} {
					cell := strings.TrimSpace(row[column])
					if cell != "" && strings.ContainsRune("=+-@", rune(cell[0])) {
						t.Fatal("spreadsheet formula not neutralized")
					}
				}
				if tc.raw && (row[5] != "'=1+1" || row[4] != "'\u00a0@SUM(1)") {
					t.Fatal("privileged formula text was not preserved as a literal")
				}
				if row[8] != "502" || row[15] != "7" || row[16] != "12.50" {
					t.Fatal("numeric export changed")
				}
				if tc.raw && !strings.Contains(row[20], credential) {
					t.Fatal("privileged metadata compatibility changed")
				}
			}
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("CSV response is cacheable")
			}
		})
	}
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		r := httptest.NewRequest(method, "/admin/export.csv", nil)
		r.Header.Set("Authorization", "Bearer "+admin)
		w := httptest.NewRecorder()
		routes.ServeHTTP(w, r)
		if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != http.MethodGet {
			t.Fatalf("method %s not rejected", method)
		}
	}
	w := httptest.NewRecorder()
	routes.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/admin/export.csv", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d", w.Code)
	}
}
