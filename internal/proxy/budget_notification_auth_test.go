package proxy

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestBudgetNotificationRequiresWriteAuthority(t *testing.T) {
	for _, mode := range []string{"legacy", "jwt-reader", "jwt-team-admin", "jwt-writer"} {
		t.Run(mode, func(t *testing.T) {
			s, db, gateway := newAdminModelsTestServer(t, "synthetic-budget-writer")
			s.cfg.Auth.AdminReadonlyToken = "synthetic-budget-reader"
			token := s.cfg.Auth.AdminReadonlyToken
			if mode != "legacy" {
				s.cfg.Auth.Enabled = true
				s.cfg.Auth.JWTSecret = "synthetic-budget-session-secret"
				now := time.Now().UTC()
				if err := db.InsertAuthSession(t.Context(), "budget-session", "budget-user", "127.0.0.1", "fixture", now.Add(time.Hour)); err != nil {
					t.Fatal(err)
				}
				scopes, role := []string{"admin:read"}, "admin"
				if mode == "jwt-team-admin" {
					role = "team_admin"
				}
				if mode == "jwt-writer" {
					scopes = append(scopes, "admin:write")
				}
				var err error
				token, err = s.signAccessToken(accessClaims{Subject: "budget-user", SessionID: "budget-session", Role: role, Scopes: scopes, Type: "access", IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix()})
				if err != nil {
					t.Fatal(err)
				}
			}
			received := make(chan struct{}, 8)
			hook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				received <- struct{}{}
				w.WriteHeader(http.StatusOK)
			}))
			defer hook.Close()
			for key, value := range map[string]string{"mattermost_enabled": "true", "mattermost_webhook_url": hook.URL, "mattermost_events": "cost"} {
				if err := db.SetFlag(t.Context(), store.RuntimeFlag{Key: key, Value: value, UpdatedAt: time.Now().UTC()}); err != nil {
					t.Fatal(err)
				}
			}
			if err := db.UpsertBudget(t.Context(), store.Budget{ID: "budget-fixture", Scope: "global", ScopeValue: "*", MonthlyKRW: 100}); err != nil {
				t.Fatal(err)
			}
			request := func(query, credential string) int {
				t.Helper()
				req, err := http.NewRequest(http.MethodGet, gateway.URL+"/admin/budgets/alerts?all=1&warn=0"+query, nil)
				if err != nil {
					t.Fatal(err)
				}
				req.Header.Set("Authorization", "Bearer "+credential)
				response, err := http.DefaultClient.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				response.Body.Close()
				return response.StatusCode
			}
			for _, query := range []string{"", "&notify=0"} {
				if status := request(query, token); status != http.StatusOK {
					t.Fatalf("read status=%d", status)
				}
			}
			select {
			case <-received:
				t.Fatal("ordinary read sent a notification")
			case <-time.After(100 * time.Millisecond):
			}
			for _, query := range []string{"&notify=1", "&notify=%201%20"} {
				status := request(query, token)
				if mode == "jwt-writer" {
					if status != http.StatusOK {
						t.Fatalf("writer status=%d", status)
					}
					select {
					case <-received:
					case <-time.After(2 * time.Second):
						t.Fatal("writer did not send notification")
					}
				} else {
					if status != http.StatusUnauthorized && status != http.StatusForbidden {
						t.Errorf("read-only notification status=%d", status)
					}
					select {
					case <-received:
						t.Error("read-only authority sent notification")
					case <-time.After(100 * time.Millisecond):
					}
				}
			}
			if mode == "legacy" {
				if status := request("&notify=1", s.cfg.Auth.AdminToken); status != http.StatusOK {
					t.Fatalf("legacy writer status=%d", status)
				}
				select {
				case <-received:
				case <-time.After(2 * time.Second):
					t.Fatal("legacy writer did not send notification")
				}
			}
		})
	}
}
