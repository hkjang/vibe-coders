package proxy

import (
	"encoding/json"
	"slices"
	"testing"
	"time"
	"vibe-coders/internal/store"
)

func TestAuthTokenResponseGrantsMatchSignedClaims(t *testing.T) {
	for _, change := range []string{"unchanged", "role", "team", "scopes", "empty-scopes"} {
		t.Run(change, func(t *testing.T) {
			s, db, _ := newAdminModelsTestServer(t, "")
			s.cfg.Auth.Enabled = true
			s.cfg.Auth.JWTSecret = "isolated-grant-test-secret"
			s.cfg.Auth.AccessTokenTTL = time.Minute
			s.cfg.Auth.RefreshTokenTTL = time.Hour
			user := store.AuthUser{ID: "grant-user", Email: "grant@example.invalid", Name: "Grant", Role: "admin", Status: "active", PasswordHash: "disabled"}
			if err := db.CreateAuthUser(t.Context(), user); err != nil {
				t.Fatal(err)
			}
			if err := db.SetUserTeam(t.Context(), user.ID, "old-team", "member"); err != nil {
				t.Fatal(err)
			}
			check := func(pair map[string]any, role, team string, scopes []string) {
				t.Helper()
				access, ok := pair["access_token"].(string)
				if !ok {
					t.Fatal("missing signed token")
				}
				claims, ok := s.verifyAccessToken(t.Context(), access)
				if !ok {
					t.Fatal("issued token did not verify")
				}
				encoded, err := json.Marshal(pair["user"])
				if err != nil {
					t.Fatal("invalid user response")
				}
				var got struct {
					ID     string   `json:"id"`
					Role   string   `json:"role"`
					Team   string   `json:"team_id"`
					Roles  []string `json:"roles"`
					Scopes []string `json:"scopes"`
				}
				if json.Unmarshal(encoded, &got) != nil || got.ID != claims.Subject || got.Role != claims.Role || got.Team != claims.TeamID || !slices.Equal(got.Scopes, claims.Scopes) {
					t.Fatal("response grants differ from verified signed claims")
				}
				if got.ID != user.ID || got.Role != role || got.Team != team || got.Scopes == nil || !slices.Equal(got.Scopes, scopes) || !slices.Equal(got.Roles, []string{role}) {
					t.Fatal("response grants differ from current stored grant")
				}
			}
			pair, err := s.issueTokenPair(t.Context(), user, "old-team", "", "")
			if err != nil {
				t.Fatal(err)
			}
			check(pair, "admin", "old-team", scopesForRole("admin"))
			team := "old-team"
			scopes := scopesForRole("admin")
			switch change {
			case "role":
				user.Role = "readonly_admin"
				scopes = scopesForRole(user.Role)
				if err := db.CreateAuthUser(t.Context(), user); err != nil {
					t.Fatal(err)
				}
			case "team":
				team = "new-team"
				if err := db.SetUserTeam(t.Context(), user.ID, team, "member"); err != nil {
					t.Fatal(err)
				}
			case "scopes", "empty-scopes":
				scopes = []string{"admin:read"}
				if change == "empty-scopes" {
					scopes = []string{}
				}
				if err := db.UpsertCustomRole(t.Context(), store.CustomRole{Role: user.Role, Scopes: scopes}); err != nil {
					t.Fatal(err)
				}
			}
			refresh := pair["refresh_token"].(string)
			rotated, err := s.rotateRefreshToken(t.Context(), refresh, "", "")
			if err != nil {
				t.Fatal(err)
			}
			check(rotated, user.Role, team, scopes)
			if _, err := s.rotateRefreshToken(t.Context(), refresh, "", ""); err == nil {
				t.Fatal("consumed refresh token was accepted")
			}
		})
	}
}
