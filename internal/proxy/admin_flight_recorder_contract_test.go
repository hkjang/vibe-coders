package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// These are existing HTTP contracts, not a new privacy boundary or a browser
// integration test. In particular, session_id is a projected display value.
func TestSessionFlightRecorderMaskedIdentityCompatibility(t *testing.T) {
	const sessionID = "flight-reader@example.com"
	for _, tc := range []struct {
		name, auth string
		masked     bool
		status     int
	}{
		{"readonly_jwt", "readonly_jwt", true, http.StatusOK},
		{"legacy_readonly", "legacy_readonly", true, http.StatusOK},
		{"privileged_jwt", "privileged_jwt", false, http.StatusOK},
		{"open", "open", false, http.StatusOK},
		{"jwt_without_admin_read", "no_admin_read", false, http.StatusUnauthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFlightRecorderContractFixture(t, tc.auth)
			f.seed(t, "flight-request-one", sessionID, time.Now().UTC().Add(-time.Minute), "", "contact "+sessionID)
			status, body := f.get(t, "/admin/sessions/"+url.PathEscape(sessionID)+"/flight-recorder")
			if status != tc.status {
				t.Fatalf("flight recorder status = %d, want %d", status, tc.status)
			}
			if status != http.StatusOK {
				var denied map[string]json.RawMessage
				if err := json.Unmarshal(body, &denied); err != nil {
					t.Fatal("authorization error is not JSON")
				}
				if _, exists := denied["events"]; exists {
					t.Fatal("scope denial unexpectedly returned events")
				}
				return
			}
			result := decodeFlightRecorderContract(t, body)
			wantID, wantPreview := sessionID, "contact "+sessionID
			if tc.masked {
				wantID, wantPreview = "[REDACTED_EMAIL]", "contact [REDACTED_EMAIL]"
			}
			if result.SessionID != wantID {
				t.Fatal("response session display does not match the current role projection")
			}
			if tc.masked && result.SessionID == sessionID {
				t.Fatal("masked display unexpectedly equals the raw request target")
			}
			if len(result.Events) != 1 || result.Rollup.Requests != 1 || result.Events[0].RequestID != "flight-request-one" {
				t.Fatal("authorized raw-target lookup did not return its one recorded request")
			}
			if result.Events[0].LastMessage != wantPreview {
				t.Fatal("existing redacted prompt preview projection changed")
			}
			if strings.Contains(string(body), "raw-only-synthetic-prompt") {
				t.Fatal("the original prompt was used instead of the recorded preview")
			}
		})
	}
}

func TestSessionFlightRecorderBoundedWindowContract(t *testing.T) {
	t.Run("list_period_and_error_counts_are_not_detail_period_or_counts", func(t *testing.T) {
		f := newFlightRecorderContractFixture(t, "open")
		const sessionID = "flight-window"
		now := time.Now().UTC().Truncate(time.Second)
		old, recent := now.AddDate(0, 0, -8), now.Add(-time.Hour)
		f.seed(t, "flight-window-old", sessionID, old, "", "old preview")
		// HTTP status is 200, but the stored Error still counts in the detail.
		f.seed(t, "flight-window-current", sessionID, recent, "synthetic stored error", "current preview")
		listed := f.list(t, sessionID)
		if listed.Requests != 1 || listed.Errors != 0 || listed.TotalTokens != 100 || listed.CostKRW != 5 || listed.LastMessage != "current preview" {
			t.Fatal("7-day list must aggregate only the recent row, with status-based errors")
		}
		result := f.detail(t, sessionID)
		if len(result.Events) != 2 || result.Rollup.Requests != 2 || result.Rollup.Errors != 1 || result.Rollup.TotalTokens != 200 || result.Rollup.TotalCost != 10 {
			t.Fatal("detail must aggregate both returned rows, including the stored error")
		}
		if result.Events[0].RequestID != "flight-window-old" || result.Events[1].RequestID != "flight-window-current" || result.Events[0].IsError || !result.Events[1].IsError {
			t.Fatal("detail chronology or existing error classification changed")
		}
		if result.Rollup.StartedAt != old.Format(time.RFC3339Nano) || result.Rollup.EndedAt != recent.Format(time.RFC3339Nano) {
			t.Fatal("detail bounds must describe the returned record timestamps")
		}
	})
	t.Run("handler_500_request_is_clamped_to_200_store_rows", func(t *testing.T) {
		f := newFlightRecorderContractFixture(t, "open")
		const sessionID = "flight-cap"
		start := time.Now().UTC().Truncate(time.Second).Add(-time.Hour)
		// One usage and one prompt per request: no join multiplication in this
		// fixture. This is not a universal distinct-request or query-work bound.
		for i := range 201 {
			f.seed(t, fmt.Sprintf("flight-cap-%03d", i), sessionID, start.Add(time.Duration(i)*time.Second), "", "bounded preview")
		}
		if listed := f.list(t, sessionID); listed.Requests != 201 || listed.TotalTokens != 20100 || listed.CostKRW != 1005 {
			t.Fatal("session list must still count all 201 in-period records")
		}
		result := f.detail(t, sessionID)
		if len(result.Events) != 200 || result.Rollup.Requests != 200 || result.Rollup.TotalTokens != 20000 || result.Rollup.TotalCost != 1000 {
			t.Fatal("detail must contain and aggregate only the newest 200 returned rows")
		}
		for i, event := range result.Events {
			if event.RequestID != fmt.Sprintf("flight-cap-%03d", i+1) {
				t.Fatalf("unexpected bounded chronological record at index %d", i)
			}
		}
		if result.Rollup.StartedAt != start.Add(time.Second).Format(time.RFC3339Nano) || result.Rollup.EndedAt != start.Add(200*time.Second).Format(time.RFC3339Nano) {
			t.Fatal("rollup time bounds unexpectedly include an excluded record")
		}
	})
}

type flightRecorderContractResponse struct {
	SessionID string `json:"session_id"`
	Events    []struct {
		RequestID   string `json:"request_id"`
		LastMessage string `json:"last_message"`
		IsError     bool   `json:"is_error"`
	} `json:"events"`
	Rollup struct {
		Requests    int     `json:"requests"`
		Errors      int     `json:"errors"`
		TotalTokens int     `json:"total_tokens"`
		TotalCost   float64 `json:"total_cost"`
		StartedAt   string  `json:"started_at"`
		EndedAt     string  `json:"ended_at"`
	} `json:"rollup"`
}

type flightRecorderContractFixture struct {
	db      *store.SQLStore
	gateway *httptest.Server
	token   string
}

func newFlightRecorderContractFixture(t *testing.T, auth string) flightRecorderContractFixture {
	t.Helper()
	// Explicit SQLite, independent of TEST_POSTGRES_DSN or any operator database.
	db := openSQLiteTestStore(t, filepath.Join(t.TempDir(), "flight.db"))
	logger := store.NewAsyncLogger(db, 16, filepath.Join(t.TempDir(), "synthetic-flight.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	cfg := testConfig("http://unused.invalid", "")
	role, scopes, token := "readonly_admin", []string{"admin:read"}, ""
	switch auth {
	case "readonly_jwt", "privileged_jwt", "no_admin_read":
		cfg.Auth.Enabled = true
		cfg.Auth.JWTSecret = "public-synthetic-flight-contract-secret"
		if auth == "privileged_jwt" {
			role = "super_admin"
		}
		if auth == "no_admin_read" {
			scopes = []string{"models:read"}
		}
	case "legacy_readonly":
		cfg.Auth.AdminToken = "synthetic-full-token"
		cfg.Auth.AdminReadonlyToken = "synthetic-readonly-token"
		token = cfg.Auth.AdminReadonlyToken
	case "open":
	default:
		t.Fatal("unknown synthetic auth mode")
	}
	server, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Auth.Enabled {
		// Actual signed JWT and active DB session; no login/refresh is simulated.
		token = issueLLMScopedTestToken(t, db, server, "flight-contract-"+auth, role, "", scopes, time.Now().UTC())
	}
	gateway := httptest.NewServer(server.Routes())
	t.Cleanup(gateway.Close)
	return flightRecorderContractFixture{db: db, gateway: gateway, token: token}
}

func (f flightRecorderContractFixture) seed(t *testing.T, id, sessionID string, when time.Time, storedError, preview string) {
	t.Helper()
	err := f.db.InsertLogRecord(t.Context(), store.LogRecord{
		Request: store.RequestLog{ID: id, SessionID: sessionID, Endpoint: "/v1/chat/completions", Model: "test-model", StatusCode: 200, Error: storedError, CreatedAt: when},
		Usage:   &store.TokenUsage{ID: id + "-usage", RequestID: id, TotalTokens: 100, EstimatedCost: 5, Currency: "KRW", CreatedAt: when},
		Prompts: []store.PromptLog{{ID: id + "-prompt", RequestID: id, Role: "user", ContentText: "raw-only-synthetic-prompt", RedactedText: preview, CreatedAt: when}},
	})
	if err != nil {
		t.Fatal(err)
	}
}

func (f flightRecorderContractFixture) get(t *testing.T, path string) (int, []byte) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, f.gateway.URL+path, nil)
	if err != nil {
		t.Fatal("failed to construct local fixture request")
	}
	if f.token != "" {
		req.Header.Set("Authorization", "Bearer "+f.token)
	}
	resp, err := f.gateway.Client().Do(req)
	if err != nil {
		t.Fatal("local fixture request failed")
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		t.Fatal("local fixture body read failed")
	}
	return resp.StatusCode, body
}

func decodeFlightRecorderContract(t *testing.T, body []byte) flightRecorderContractResponse {
	t.Helper()
	var result flightRecorderContractResponse
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatal("flight recorder response is not valid contract JSON")
	}
	return result
}

func (f flightRecorderContractFixture) detail(t *testing.T, sessionID string) flightRecorderContractResponse {
	t.Helper()
	status, body := f.get(t, "/admin/sessions/"+url.PathEscape(sessionID)+"/flight-recorder")
	if status != http.StatusOK {
		t.Fatalf("detail status = %d, want 200", status)
	}
	return decodeFlightRecorderContract(t, body)
}

func (f flightRecorderContractFixture) list(t *testing.T, sessionID string) store.SessionSummary {
	t.Helper()
	status, body := f.get(t, "/admin/sessions?days=7")
	if status != http.StatusOK {
		t.Fatalf("list status = %d, want 200", status)
	}
	var result struct {
		Days     int                    `json:"days"`
		Sessions []store.SessionSummary `json:"sessions"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatal("session list response is not valid contract JSON")
	}
	if result.Days != 7 || len(result.Sessions) != 1 || result.Sessions[0].SessionID != sessionID {
		t.Fatal("expected exactly the seeded session in the 7-day list")
	}
	return result.Sessions[0]
}
