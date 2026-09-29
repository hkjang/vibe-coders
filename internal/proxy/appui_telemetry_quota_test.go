package proxy

import (
	"bytes"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func spendAppUITelemetryQuota(t *testing.T, quota *appUITelemetryCallerQuota, principal string, count int, now time.Time) {
	t.Helper()
	for i := 0; i < count; i++ {
		if !quota.acquire(principal, now) {
			t.Fatalf("caller quota denied event %d before its limit", i+1)
		}
	}
}

func TestAppUITelemetryCallerQuotaBoundsEachPrincipal(t *testing.T) {
	var quota appUITelemetryCallerQuota
	now := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	spendAppUITelemetryQuota(t, &quota, "private-first-user", appUITelemetryCallerDailyLimit, now)
	for range 10 {
		if quota.acquire("private-first-user", now.Add(time.Hour)) {
			t.Fatal("one caller exceeded its 600-event daily budget")
		}
	}
	spendAppUITelemetryQuota(t, &quota, "private-second-user", appUITelemetryCallerDailyLimit, now)
	if len(quota.counts) != 2 {
		t.Fatalf("expected two digest entries, got %d", len(quota.counts))
	}
	if quota.acquire("", now.Add(24*time.Hour)) || len(quota.counts) != 2 {
		t.Fatal("empty identity must fail closed without rotating state")
	}
	if strings.Contains(fmt.Sprintf("%+v", quota.counts), "private") {
		t.Fatal("quota map retained raw identities")
	}
}

func TestAppUITelemetryCallerQuotaRotatesOnlyForwardUTCDays(t *testing.T) {
	entropy := append(bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32)...)
	quota := appUITelemetryCallerQuota{entropy: bytes.NewReader(entropy)}
	now := time.Date(2026, 9, 29, 23, 59, 59, 0, time.UTC)
	spendAppUITelemetryQuota(t, &quota, "private-user", appUITelemetryCallerDailyLimit, now)
	oldSalt := quota.salt
	var oldDigest [32]byte
	for key := range quota.counts {
		oldDigest = key
	}
	// Local midnight is not a new UTC day; neither is a backwards clock step.
	for _, earlier := range []time.Time{now.In(time.FixedZone("KST", 9*60*60)), now.Add(-24 * time.Hour)} {
		if quota.acquire("private-user", earlier) {
			t.Fatal("timezone or backwards clock replenished quota")
		}
	}
	nextDay := now.Add(time.Second)
	spendAppUITelemetryQuota(t, &quota, "private-user", appUITelemetryCallerDailyLimit, nextDay)
	if quota.salt == oldSalt || len(quota.counts) != 1 || quota.counts[oldDigest] != 0 {
		t.Fatal("UTC rollover must replace the salt and remove previous digests")
	}
	if quota.acquire("private-user", now) || quota.acquire("private-user", nextDay) {
		t.Fatal("alternating dates reset an already spent new-day quota")
	}
}

func TestAppUITelemetryCallerQuotaDoesNotEvictAtCapacity(t *testing.T) {
	var quota appUITelemetryCallerQuota
	now := time.Now()
	spendAppUITelemetryQuota(t, &quota, "principal-0", appUITelemetryCallerDailyLimit, now)
	for i := 1; i < appUITelemetryCallerLimit; i++ {
		if !quota.acquire(fmt.Sprintf("principal-%d", i), now) {
			t.Fatalf("caller map filled early at %d", i)
		}
	}
	for range 3 {
		if quota.acquire("new-principal", now) || quota.acquire("principal-0", now) {
			t.Fatal("full caller map must not evict or replenish existing callers")
		}
	}
	if !quota.acquire("principal-1", now) || len(quota.counts) != appUITelemetryCallerLimit {
		t.Fatal("existing callers with budget must continue at map capacity")
	}
	if !quota.acquire("new-principal", now.Add(24*time.Hour)) || len(quota.counts) != 1 {
		t.Fatal("new UTC day did not release the bounded map")
	}
}

func TestAppUITelemetryCallerQuotaEntropyFailureIsAtomic(t *testing.T) {
	quota := appUITelemetryCallerQuota{entropy: bytes.NewReader(make([]byte, 31))}
	now := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	if quota.acquire("private-user", now) || quota.counts != nil || !quota.day.IsZero() || quota.salt != [32]byte{} {
		t.Fatal("partial entropy must not initialize quota state")
	}
	quota.entropy = bytes.NewReader(bytes.Repeat([]byte{1}, 32))
	spendAppUITelemetryQuota(t, &quota, "private-user", appUITelemetryCallerDailyLimit, now)
	oldSalt, oldDay := quota.salt, quota.day
	if quota.acquire("private-user", now.Add(24*time.Hour)) || quota.day != oldDay || quota.salt != oldSalt || len(quota.counts) != 1 {
		t.Fatal("failed rollover changed previously admitted quota state")
	}
	if quota.acquire("private-user", now) {
		t.Fatal("failed rollover replenished old quota")
	}
	quota.entropy = bytes.NewReader(bytes.Repeat([]byte{2}, 32))
	if !quota.acquire("private-user", now.Add(24*time.Hour)) || quota.salt == oldSalt {
		t.Fatal("secure entropy recovery must permit an atomic forward rollover")
	}
}

func TestAppUITelemetryCallerQuotaConcurrentRollover(t *testing.T) {
	quota := appUITelemetryCallerQuota{entropy: bytes.NewReader(bytes.Repeat([]byte{1}, 64))}
	now := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	spendAppUITelemetryQuota(t, &quota, "private-user", appUITelemetryCallerDailyLimit, now)
	var admitted atomic.Int64
	var wg sync.WaitGroup
	for range 40 {
		wg.Go(func() {
			for range 30 {
				if quota.acquire("private-user", now.Add(24*time.Hour)) {
					admitted.Add(1)
				}
			}
		})
	}
	wg.Wait()
	if admitted.Load() != appUITelemetryCallerDailyLimit || len(quota.counts) != 1 {
		t.Fatalf("concurrent rollover admitted %d instead of 600", admitted.Load())
	}
}

func TestAppUITelemetryCallerQuotaSharesSessionsFeaturesAndEventKinds(t *testing.T) {
	s := newAppUITelemetryTestServer(t)
	s.cfg.Auth.Enabled = true
	now := time.Now()
	subject := "private-quota-user"
	token := issueLLMScopedTestToken(t, s.db, s, subject, "viewer", "private-team", scopesForRole("viewer"), now)
	secondSession := "private-second-session"
	if err := s.db.InsertAuthSession(t.Context(), secondSession, subject, "192.0.2.1", "private-second-browser", now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	secondToken, err := s.signAccessToken(accessClaims{
		Subject: subject, Role: "viewer", TeamID: "private-second-team", Scopes: scopesForRole("viewer"),
		SessionID: secondSession, Type: "access", IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	spendAppUITelemetryQuota(t, s.appUITelemetryCallerQuota, subject, appUITelemetryCallerDailyLimit-2, now)
	for _, tc := range []struct{ token, feature, event, visit string }{
		{token, "overview", "visit", telemetryVisitID},
		{secondToken, "overview", "legacy_fallback", telemetryVisitID},
		{token, "me.home", "visit", "11111111111111111111111111111111"},
		{secondToken, "overview", "legacy_fallback", "22222222222222222222222222222222"},
	} {
		body := strings.Replace(appUITelemetryPayload(tc.feature, tc.event), telemetryVisitID, tc.visit, 1)
		w := appUITelemetryRequest(t, s, http.MethodPost, "/admin/ui-telemetry/events", tc.token, body)
		if w.Code != http.StatusNoContent || w.Body.Len() != 0 || w.Header().Get("Retry-After") != "" {
			t.Fatalf("lossy intake returned %d %s", w.Code, w.Body.String())
		}
	}
	counts, err := s.db.AppUITelemetrySummary(t.Context(), now.Add(-time.Hour), time.Now().Add(time.Second))
	if err != nil || len(counts) != 1 || counts[0].Visits != 1 || counts[0].LegacyOpens != 1 {
		t.Fatalf("session/nonce/feature/event changes bypassed quota: %+v %v", counts, err)
	}
	otherToken := issueLLMScopedTestToken(t, s.db, s, "private-other-user", "developer", "private-team", scopesForRole("developer"), now)
	body := strings.Replace(appUITelemetryPayload("me.home", "visit"), telemetryVisitID, "33333333333333333333333333333333", 1)
	w := appUITelemetryRequest(t, s, http.MethodPost, "/admin/ui-telemetry/events", otherToken, body)
	if w.Code != http.StatusNoContent || telemetryStoredCount(t, s) != 2 {
		t.Fatalf("one caller's spent budget blocked another: %d %s", w.Code, w.Body.String())
	}
	audit, err := s.db.ListAuditEvents(t.Context(), 100)
	if err != nil || len(audit) != 0 {
		t.Fatalf("caller quota introduced identity-bearing audit records: %+v %v", audit, err)
	}
}

func TestAppUITelemetryCallerQuotaSharedLegacyAndOpenIdentity(t *testing.T) {
	s := newAppUITelemetryTestServer(t)
	spendAppUITelemetryQuota(t, s.appUITelemetryCallerQuota, "legacy-admin", appUITelemetryCallerDailyLimit, time.Now())
	for _, token := range []string{"", "private-readonly-token"} {
		s.cfg.Auth.AdminReadonlyToken = token
		w := appUITelemetryRequest(t, s, http.MethodPost, "/admin/ui-telemetry/events", token, appUITelemetryPayload("overview", "visit"))
		if w.Code != http.StatusNoContent || telemetryStoredCount(t, s) != 0 || len(s.appUITelemetryCallerQuota.counts) != 1 {
			t.Fatal("open and legacy credentials must share their bootstrap identity budget")
		}
	}
}

func TestAppUITelemetryCallerQuotaSkipsOptedOutAndUnauthenticatedRequests(t *testing.T) {
	s := newAppUITelemetryTestServer(t)
	s.cfg.Auth.Enabled = true
	for _, enabled := range []string{"false", "true"} {
		setAppUITelemetryTestSetting(t, s, appUITelemetryEnabledKey, enabled)
		w := appUITelemetryRequest(t, s, http.MethodPost, "/admin/ui-telemetry/events", "private-invalid-token", appUITelemetryPayload("overview", "visit"))
		want := http.StatusNoContent
		if enabled == "true" {
			want = http.StatusUnauthorized
		}
		if w.Code != want || s.appUITelemetryCallerQuota.counts != nil || !s.appUITelemetryCallerQuota.day.IsZero() {
			t.Fatal("opt-out or failed authentication initialized the caller quota")
		}
	}
}

func TestAppUITelemetryCallerQuotaDropsEntropyFailureAndFullMap(t *testing.T) {
	for _, kind := range []string{"entropy failure", "full map"} {
		t.Run(kind, func(t *testing.T) {
			s := newAppUITelemetryTestServer(t)
			quota := s.appUITelemetryCallerQuota
			if kind == "entropy failure" {
				quota.entropy = bytes.NewReader(nil)
			} else {
				for i := 0; i < appUITelemetryCallerLimit; i++ {
					if !quota.acquire(fmt.Sprintf("private-user-%d", i), time.Now()) {
						t.Fatal("caller map filled before its bound")
					}
				}
			}
			w := appUITelemetryRequest(t, s, http.MethodPost, "/admin/ui-telemetry/events", "", appUITelemetryPayload("overview", "visit"))
			if w.Code != http.StatusNoContent || w.Body.Len() != 0 || telemetryStoredCount(t, s) != 0 {
				t.Fatalf("unavailable caller quota must silently drop: %d %s", w.Code, w.Body.String())
			}
		})
	}
}
