package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestTeamsRegistrationReadFailureIsNotAnEmptyCatalog(t *testing.T) {
	path := filepath.Join(t.TempDir(), "team-catalog.db")
	db := openSQLiteTestStore(t, path)
	server, err := NewServer(testConfig("http://unused.invalid", "secret"), db, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	read := func() *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		server.handleTeams(response, httptest.NewRequest(http.MethodGet, "/admin/teams", nil))
		return response
	}
	initial := read()
	if initial.Code != http.StatusOK || !strings.Contains(initial.Body.String(), `"auth_teams":[]`) {
		t.Fatalf("healthy empty catalog: status=%d", initial.Code)
	}
	// Only this test's isolated database is changed; usage reads remain available.
	raw := fixtureRawDB(t, path)
	if _, err := raw.ExecContext(t.Context(), "DROP TABLE teams"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ListTeams(t.Context()); err != nil {
		t.Fatalf("usage control failed: %v", err)
	}
	response := read()
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("catalog failure status=%d", response.Code)
	}
	var result struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Error.Code != "auth_teams_failed" {
		t.Fatalf("error code=%s", result.Error.Code)
	}
	if strings.Contains(response.Body.String(), "no such table") || strings.Contains(response.Body.String(), "SQL") {
		t.Fatal("database error leaked into public response")
	}
}
