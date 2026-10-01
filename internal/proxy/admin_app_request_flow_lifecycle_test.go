package proxy

import (
	"context"
	"errors"
	"net/http/httptest"
	"testing"
	"time"

	"vibe-coders/internal/secret"
	"vibe-coders/internal/store"
)

// Controlled orchestration tests delegate every query to the real temporary
// store. The after-read action schedules a change at a deterministic boundary;
// it is not evidence of an atomic authorization snapshot or an HTTP race.
type appFlowAfterRead struct {
	*store.SQLStore
	after func()
}

func (r appFlowAfterRead) AppRequestFlowText2SQL(ctx context.Context, scope store.AppRequestFlowScope) ([]store.AppRequestFlowText2SQL, bool, error) {
	rows, truncated, err := r.SQLStore.AppRequestFlowText2SQL(ctx, scope)
	if err == nil {
		r.after()
	}
	return rows, truncated, err
}

func TestAppRequestFlowFinalReadRechecks(t *testing.T) {
	for _, change := range []string{"none", "secret", "session", "team"} {
		t.Run(change, func(t *testing.T) {
			f := newAppFlowHTTPFixture(t)
			if err := f.db.UpsertAuthTeam(t.Context(), store.AuthTeam{ID: "flow-lifecycle-team", Name: "Team A"}); err != nil {
				t.Fatal(err)
			}
			key := store.APIKeyRecord{ID: "flow-lifecycle-key", Name: "key", KeyHash: "public-flow-hash", Team: "Team A", Status: "active"}
			if err := f.db.UpsertAPIKey(t.Context(), key); err != nil {
				t.Fatal(err)
			}
			f.seed(t, "flow-lifecycle", key.ID, f.at, nil)
			token := f.token(t, "flow-lifecycle-user", "team_admin", "flow-lifecycle-team", "admin:read")
			r := httptest.NewRequest("GET", f.path("flow-lifecycle", f.at), nil)
			r.Header.Set("Authorization", "Bearer "+token)
			if !f.server.authorizeAdmin(r) {
				t.Fatal("fixture initial authorization denied")
			}
			cipher := f.server.secrets.Load()
			reader := appFlowAfterRead{f.db, func() {
				switch change {
				case "secret":
					rotated, err := secret.New("public-flow-rotated")
					if err != nil {
						t.Fatal(err)
					}
					f.server.secrets.Store(rotated)
				case "session":
					if err := f.db.RevokeAuthSession(t.Context(), "flow-lifecycle-user-session"); err != nil {
						t.Fatal(err)
					}
				case "team":
					key.Team = "Team B"
					if err := f.db.UpsertAPIKey(t.Context(), key); err != nil {
						t.Fatal(err)
					}
				}
			}}
			result, err := f.server.readAppRequestFlow(r, appRequestFlowReference(cipher, "flow-lifecycle"), f.at, cipher, reader)
			if change == "none" {
				if err != nil || len(result.Spans) != 1 {
					t.Fatalf("control result=%+v err=%v", result, err)
				}
			} else if !errors.Is(err, errAppRequestFlowUnavailable) && !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("change=%s err=%v", change, err)
			}
			if change != "none" && len(result.Spans) != 0 {
				t.Fatal("late sensitive metadata published")
			}
		})
	}
}

func TestAppRequestFlowHTTPDatabaseErrorIsSafe(t *testing.T) {
	// Legacy admin auth avoids a failed DB session check masking the read error.
	s, db, gateway := newAdminModelsTestServer(t, "public-flow-admin")
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	f := appFlowHTTPFixture{s, db, gateway.URL, at}
	path := f.path("private-db-record", at)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	status, body := f.get(t, "public-flow-admin", "GET", path)
	if status != 500 {
		t.Fatalf("status=%d body=%s", status, body)
	}
	assertLLMExternalBody(t, body, "database is closed", "SELECT", "request_logs", "private-db-record")
}

func TestAppRequestFlowLegacyReadonlyGET(t *testing.T) {
	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 1, "")
	cfg := testConfig("http://unused.invalid", "")
	cfg.Auth.AdminReadonlyToken = "public-flow-readonly"
	s, err := NewServer(cfg, db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	gateway := httptest.NewServer(s.Routes())
	t.Cleanup(gateway.Close)
	f := appFlowHTTPFixture{s, db, gateway.URL, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	f.seed(t, "readonly-flow", "", f.at, nil)
	status, body := f.get(t, "public-flow-readonly", "GET", f.path("readonly-flow", f.at))
	if status != 200 {
		t.Fatalf("legacy readonly GET=%d %s", status, body)
	}
}
