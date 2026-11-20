//go:build linux

package proxy

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
	"vibe-coders/internal/store"
)

// This wrapper is never registered in production. It only controls the two named
// synthetic IdP users in the isolated product test and requires a private secret.
// Expiry is signed by the real server; refresh still uses its actual HTTP route.
func keycloakGrantFixture(t *testing.T, s *Server, db *store.SQLStore, secret string, next http.Handler) http.Handler {
	t.Helper()
	var mu sync.Mutex
	type original struct {
		user store.AuthUser
		team string
	}
	saved := map[string]original{}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/__fixture/grants" {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodPost || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Fixture-Control")), []byte(secret)) != 1 {
			http.Error(w, "unavailable", http.StatusNotFound)
			return
		}
		var body struct {
			Operation string `json:"operation"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 512)).Decode(&body) != nil {
			http.Error(w, "invalid", 400)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if body.Operation == "restore" {
			for _, before := range saved {
				if db.CreateAuthUser(r.Context(), before.user) != nil || db.SetUserTeam(r.Context(), before.user.ID, before.team, "member") != nil {
					http.Error(w, "restore failed", 500)
					return
				}
			}
			if db.DeleteCustomRole(r.Context(), "admin") != nil {
				http.Error(w, "restore failed", 500)
				return
			}
			saved = map[string]original{}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		claims, ok := s.verifyAccessToken(r.Context(), strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if !ok || (claims.Email != "new@example.invalid" && claims.Email != "routing-reader@example.invalid") {
			http.Error(w, "unavailable", 403)
			return
		}
		user, found, err := db.AuthUserByID(r.Context(), claims.Subject)
		if err != nil || !found {
			http.Error(w, "unavailable", 500)
			return
		}
		if _, ok := saved[user.ID]; !ok {
			team, err := db.PrimaryTeamForUser(r.Context(), user.ID)
			if err != nil {
				http.Error(w, "unavailable", 500)
				return
			}
			saved[user.ID] = original{user, team}
		}
		switch body.Operation {
		case "role":
			user.Role = "readonly_admin"
			err = db.CreateAuthUser(r.Context(), user)
		case "team":
			err = db.SetUserTeam(r.Context(), user.ID, "other-access-id", "member")
		case "scopes":
			err = db.UpsertCustomRole(r.Context(), store.CustomRole{Role: "admin", Scopes: []string{"chat:write"}})
		case "same":
		default:
			http.Error(w, "invalid", 400)
			return
		}
		if err != nil {
			http.Error(w, "unavailable", 500)
			return
		}
		claims.ExpiresAt = time.Now().Add(-time.Minute).Unix()
		expired, err := s.signAccessToken(claims)
		if err != nil {
			http.Error(w, "unavailable", 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"expired_access": expired})
	})
}
