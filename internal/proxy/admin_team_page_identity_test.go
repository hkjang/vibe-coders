package proxy

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAdminTeamPageAndAccountsDoNotLoseScopeOnRecheckFailure(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "synthetic-page-scope-recheck"
	for _, tc := range []struct {
		name, path string
		handler    http.HandlerFunc
	}{
		{"teams", "/admin/teams?view=registered", s.handleAuthTeamPage},
		{"accounts", "/admin/users?view=accounts", s.handleAuthAccountPage},
	} {
		t.Run(tc.name, func(t *testing.T) {
			token := issueLLMScopedTestToken(t, db, s, "scope-recheck-"+tc.name, "team_admin", "only-this-team", []string{"admin:read"}, time.Now().UTC())
			r := httptest.NewRequest(http.MethodGet, tc.path, nil)
			r.Header.Set("Authorization", "Bearer "+token)
			// Model the real boundary: the outer list handler authorized this
			// session, then logout/revocation happened before scope extraction.
			if !s.authorizeAdmin(r) {
				t.Fatal("outer authorization fixture failed")
			}
			claims, ok := s.currentAccessClaims(r)
			if !ok || claims.Role != "team_admin" {
				t.Fatal("scoped identity fixture failed")
			}
			if err := db.RevokeAuthSession(t.Context(), claims.SessionID); err != nil {
				t.Fatal(err)
			}
			if _, ok := s.currentAccessClaims(r); ok {
				t.Fatal("revoked fixture session remains valid")
			}
			w := httptest.NewRecorder()
			tc.handler(w, r)
			if w.Code != http.StatusUnauthorized || strings.Contains(w.Body.String(), "auth_teams") || strings.Contains(w.Body.String(), "auth_users") {
				t.Fatal("scope recheck failure continued with an unrestricted metadata query")
			}
		})
	}
}
