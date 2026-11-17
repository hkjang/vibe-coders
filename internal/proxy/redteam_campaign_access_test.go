package proxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRedTeamCampaignAppPermissionDenialKeepsValidSessionDistinct(t *testing.T) {
	s, db, campaign := reviewedFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("denied operation reached provider") })
	s.cfg.Auth.Enabled = true
	s.cfg.Auth.JWTSecret = "public-browser-permission-fixture"
	valid := issueLLMScopedTestToken(t, db, s, "permission-viewer", "readonly_admin", "", []string{"admin:read"}, time.Now().UTC())
	for _, action := range []string{"run-review", "run-reviewed"} {
		for _, scenario := range []struct {
			name, token, marker string
			cancelled           bool
			want                int
		}{
			{"authenticated app", valid, "app", false, 403},
			{"legacy request", valid, "", false, 401},
			{"invalid app", "invalid", "app", false, 401},
			{"missing app", "", "app", false, 401},
			{"cancelled authority", valid, "app", true, 503},
		} {
			t.Run(action+"/"+scenario.name, func(t *testing.T) {
				r := httptest.NewRequest(http.MethodPost, "/admin/redteam/campaigns/"+campaign.ID+"/"+action, strings.NewReader(`{}`))
				r.Header.Set("Authorization", "Bearer "+scenario.token)
				r.Header.Set("X-Vibe-UI", scenario.marker)
				if scenario.cancelled {
					ctx, cancel := context.WithCancel(r.Context())
					cancel()
					r = r.WithContext(ctx)
				}
				w := httptest.NewRecorder()
				s.Routes().ServeHTTP(w, r)
				if w.Code != scenario.want {
					t.Fatalf("denial classification: got %d want %d", w.Code, scenario.want)
				}
				if w.Code == 403 && !strings.Contains(w.Body.String(), "redteam_permission_denied") {
					t.Fatal("permission denial code missing")
				}
			})
		}
	}
}

func TestRedTeamCampaignAppPermissionDenialWithLegacyReadonlyToken(t *testing.T) {
	s, _, campaign := reviewedFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("denied operation reached provider") })
	s.cfg.Auth.Enabled = false
	s.cfg.Auth.AdminReadonlyToken = "public-readonly-permission-fixture"
	for _, marker := range []string{"app", ""} {
		r := httptest.NewRequest(http.MethodPost, "/admin/redteam/campaigns/"+campaign.ID+"/run-review", strings.NewReader(`{}`))
		r.Header.Set("Authorization", "Bearer "+s.cfg.Auth.AdminReadonlyToken)
		r.Header.Set("X-Vibe-UI", marker)
		w := httptest.NewRecorder()
		s.Routes().ServeHTTP(w, r)
		want := http.StatusUnauthorized
		if marker == "app" {
			want = http.StatusForbidden
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("permission denial must not be cached")
			}
		}
		if w.Code != want {
			t.Fatalf("readonly token denial: got %d want %d", w.Code, want)
		}
	}
}
