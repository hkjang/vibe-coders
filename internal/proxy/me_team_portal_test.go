package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func TestTeamPortalAggregates(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	}))
	defer upstream.Close()

	db := openTestStore(t)
	defer db.Close()
	ctx := context.Background()

	// A team budget the portal should surface.
	if err := db.UpsertBudget(ctx, store.Budget{ID: "b_team1", Scope: "team", ScopeValue: "team-alpha", MonthlyKRW: 100000, Note: "alpha monthly"}); err != nil {
		t.Fatal(err)
	}

	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fb.ndjson"))
	logger.Start()
	defer logger.Stop(ctx)

	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	// Auth disabled in testConfig → team is taken from ?team=.
	resp, err := http.Get(proxy.URL + "/team/portal?team=team-alpha")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, body)
	}

	var out struct {
		TeamID  string `json:"team_id"`
		Budgets []struct {
			MonthlyKRW float64 `json:"monthly_krw"`
		} `json:"budgets"`
		APIKeys []any  `json:"api_keys"`
		Note    string `json:"note"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("unmarshal: %v (%s)", err, body)
	}
	if out.TeamID != "team-alpha" {
		t.Fatalf("team_id = %q", out.TeamID)
	}
	if len(out.Budgets) != 1 || out.Budgets[0].MonthlyKRW != 100000 {
		t.Fatalf("expected the team budget surfaced, got %+v", out.Budgets)
	}
	if out.Note == "" {
		t.Fatal("expected a note")
	}
	// The portal must never leak a raw API key secret.
	if strings.Contains(string(body), "\"secret\"") || strings.Contains(string(body), "secret_key") {
		t.Fatalf("portal response leaked a secret field: %s", body)
	}
}

func TestTeamPortalRequiresTeam(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer upstream.Close()
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fb.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	defer proxy.Close()

	// No ?team= and auth disabled → no team resolvable → 400.
	resp, err := http.Get(proxy.URL + "/team/portal")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 without a team, got %d", resp.StatusCode)
	}
}
