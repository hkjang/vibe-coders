package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
	"vibe-coders/internal/store"
)

func resetRedTeamEmergencyTest(t *testing.T) {
	t.Helper()
	reset := func() {
		redteamEmergency.Lock()
		defer redteamEmergency.Unlock()
		redteamEmergency.token = ""
		redteamEmergency.instance = ""
		redteamKillSwitch.Store(false)
	}
	reset()
	t.Cleanup(reset)
}

func redTeamEmergencyRequest(s *Server, method, body string, ctx context.Context) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	s.handleRedTeamKillSwitch(w, httptest.NewRequest(method, "/admin/redteam/kill-switch", strings.NewReader(body)).WithContext(ctx))
	return w
}

func readRedTeamEmergency(t *testing.T, s *Server) redTeamEmergencyState {
	t.Helper()
	w := redTeamEmergencyRequest(s, http.MethodGet, "", t.Context())
	var state redTeamEmergencyState
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &state) != nil {
		t.Fatal("emergency state read failed")
	}
	if w.Header().Get("Cache-Control") != "no-store" || state.Scope != "responding_process" || len(state.ReviewToken) != 32 || state.ObservedAt == "" {
		t.Fatal("incomplete emergency review snapshot")
	}
	return state
}

func reviewedRedTeamBody(enabled bool, token, reason string) string {
	encoded, _ := json.Marshal(map[string]any{"enabled": enabled, "expected_review_token": token, "reason": reason})
	return string(encoded)
}

func TestRedTeamEmergencyReviewAuditAndReplay(t *testing.T) {
	resetRedTeamEmergencyTest(t)
	db := openTestStore(t)
	defer db.Close()
	s := &Server{db: db, instanceID: "synthetic-instance-a"}
	before := readRedTeamEmergency(t, s)
	if before.Enabled {
		t.Fatal("missing runtime state must not invent enabled configuration")
	}
	body := reviewedRedTeamBody(true, before.ReviewToken, "  public synthetic stop  ")
	w := redTeamEmergencyRequest(s, http.MethodPost, body, t.Context())
	var ack redTeamEmergencyState
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &ack) != nil || !ack.Enabled || ack.Reason != "public synthetic stop" || ack.ReviewToken == before.ReviewToken {
		t.Fatal("reviewed change acknowledgment did not match the applied change")
	}
	if w = redTeamEmergencyRequest(s, http.MethodPost, body, t.Context()); w.Code != 409 {
		t.Fatal("a previously consumed review was replayed")
	}
	audits, err := db.ListAdminAudit(t.Context(), 10)
	if err != nil || len(audits) != 1 || audits[0].Action != "redteam.kill_switch" || !strings.Contains(audits[0].AfterValue, "public synthetic stop") || !strings.Contains(audits[0].BeforeValue, `"enabled":false`) {
		t.Fatal("exactly one actor/reason/state audit must accompany the accepted change")
	}
	if strings.Contains(audits[0].AfterValue, before.ReviewToken) || strings.Contains(audits[0].AfterValue, "synthetic-instance-a") {
		t.Fatal("review token or raw process identity leaked into audit")
	}
	w = redTeamEmergencyRequest(s, http.MethodPost, reviewedRedTeamBody(false, ack.ReviewToken, "public synthetic resume"), t.Context())
	if w.Code != 200 || redteamKillSwitch.Load() {
		t.Fatal("explicit reviewed resume failed")
	}
}

func TestRedTeamEmergencyProcessLifetimeAndLegacyInvalidateReview(t *testing.T) {
	resetRedTeamEmergencyTest(t)
	db := openTestStore(t)
	defer db.Close()
	a, b := &Server{db: db}, &Server{db: db}
	first := readRedTeamEmergency(t, a)
	second := readRedTeamEmergency(t, b)
	if first.InstanceRef != second.InstanceRef || first.ReviewToken != second.ReviewToken {
		t.Fatal("Servers in the same process must share the runner flag lifetime")
	}
	body := reviewedRedTeamBody(true, first.ReviewToken, "public synthetic change")
	for _, value := range []string{`{"enabled":true}`, `{"enabled":false}`} {
		if w := redTeamEmergencyRequest(b, http.MethodPost, value, t.Context()); w.Code != 200 {
			t.Fatal("legacy change failed")
		}
	}
	if w := redTeamEmergencyRequest(a, http.MethodPost, body, t.Context()); w.Code != 409 || redteamKillSwitch.Load() {
		t.Fatal("legacy A-B-A revived stale review")
	}
	current := readRedTeamEmergency(t, a)
	redteamEmergency.Lock()
	redteamEmergency.token = ""
	redteamEmergency.instance = ""
	redteamKillSwitch.Store(false)
	redteamEmergency.Unlock()
	restarted := readRedTeamEmergency(t, a)
	if current.InstanceRef == restarted.InstanceRef || current.ReviewToken == restarted.ReviewToken {
		t.Fatal("fresh process lifetime reused identity")
	}
	if w := redTeamEmergencyRequest(a, http.MethodPost, reviewedRedTeamBody(true, current.ReviewToken, "public old process"), t.Context()); w.Code != 409 {
		t.Fatal("another process accepted review")
	}
}

func TestRedTeamEmergencyConcurrentReviewAppliesOnce(t *testing.T) {
	resetRedTeamEmergencyTest(t)
	db := openTestStore(t)
	defer db.Close()
	s := &Server{db: db}
	state := readRedTeamEmergency(t, s)
	body := reviewedRedTeamBody(true, state.ReviewToken, "public concurrent stop")
	statuses := make(chan int, 8)
	var workers sync.WaitGroup
	for range 8 {
		workers.Go(func() { statuses <- redTeamEmergencyRequest(s, http.MethodPost, body, t.Context()).Code })
	}
	workers.Wait()
	close(statuses)
	accepted, conflicted := 0, 0
	for status := range statuses {
		switch status {
		case 200:
			accepted++
		case 409:
			conflicted++
		default:
			t.Fatalf("unexpected concurrent change status: %d", status)
		}
	}
	if accepted != 1 || conflicted != 7 {
		t.Fatal("concurrent requests reused one consent")
	}
	audits, err := db.ListAdminAudit(t.Context(), 10)
	if err != nil || len(audits) != 1 {
		t.Fatal("concurrent review produced unexpected audit count")
	}
}

func TestRedTeamEmergencyLegacyAndReviewValidation(t *testing.T) {
	resetRedTeamEmergencyTest(t)
	db := openTestStore(t)
	defer db.Close()
	s := &Server{db: db}
	for _, body := range []string{`{"enabled":true}`, `{}`, `null`, `{"enabled":null}`} {
		if w := redTeamEmergencyRequest(s, http.MethodPost, body, t.Context()); w.Code != 200 {
			t.Fatal("legacy request contract changed")
		}
	}
	if redteamKillSwitch.Load() {
		t.Fatal("legacy omitted/null state no longer defaults false")
	}
	for _, body := range []string{
		`{"enabled":true,"expected_review_token":""}`,
		`{"enabled":true,"expected_review_token":"01234567890123456789012345678901","reason":"  "}`,
		`{"expected_review_token":"01234567890123456789012345678901","reason":"public"}`,
		`{"enabled":"true"}`,
		`{"enabled":true} {}`,
		`{"enabled":true} trailing`,
		`{`,
		"",
		reviewedRedTeamBody(true, strings.Repeat("a", 32), strings.Repeat("가", 1001)),
	} {
		if w := redTeamEmergencyRequest(s, http.MethodPost, body, t.Context()); w.Code != 400 || redteamKillSwitch.Load() {
			t.Fatal("invalid reviewed request changed emergency state")
		}
	}
}

func TestRedTeamEmergencyAuditFailureDoesNotApply(t *testing.T) {
	resetRedTeamEmergencyTest(t)
	db := openTestStore(t)
	s := &Server{db: db}
	state := readRedTeamEmergency(t, s)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	body := reviewedRedTeamBody(true, state.ReviewToken, "public audit failure")
	if w := redTeamEmergencyRequest(s, http.MethodPost, body, ctx); w.Code != 500 || redteamKillSwitch.Load() {
		t.Fatal("cancelled audit was acknowledged or applied")
	}
	db.Close()
	w := redTeamEmergencyRequest(s, http.MethodPost, body, t.Context())
	if w.Code != 500 || redteamKillSwitch.Load() || strings.Contains(w.Body.String(), "sql:") || strings.Contains(w.Body.String(), "database is closed") {
		t.Fatal("unavailable audit changed state or exposed storage internals")
	}
	if readRedTeamEmergency(t, s).ReviewToken != state.ReviewToken {
		t.Fatal("failed audit consumed the current state revision")
	}
}

func TestRedTeamEmergencyMethodsAndActor(t *testing.T) {
	resetRedTeamEmergencyTest(t)
	db := openTestStore(t)
	defer db.Close()
	s := &Server{db: db}
	w := redTeamEmergencyRequest(s, http.MethodPut, `{"enabled":true}`, t.Context())
	if w.Code != 405 || w.Header().Get("Allow") != "GET, POST" || redteamKillSwitch.Load() {
		t.Fatal("unsupported method changed state")
	}
	before := readRedTeamEmergency(t, s)
	r := httptest.NewRequest(http.MethodPost, "/admin/redteam/kill-switch", strings.NewReader(reviewedRedTeamBody(true, before.ReviewToken, "공개 운영 점검")))
	r.Header.Set("Authorization", "Bearer synthetic-operator")
	w = httptest.NewRecorder()
	s.handleRedTeamKillSwitch(w, r)
	logs, err := db.ListAdminAudit(t.Context(), 10)
	if w.Code != 200 || err != nil || len(logs) != 1 || logs[0].AdminID != adminID(r) {
		t.Fatal("operator audit did not match")
	}
	if readRedTeamEmergency(t, s).Reason != "" {
		t.Fatal("GET exposed historical reason")
	}
	if _, err := s.runRedTeamCampaign(httptest.NewRequest(http.MethodPost, "/", nil), store.RedTeamCampaign{}, ""); err == nil {
		t.Fatal("runner admitted a new campaign while stopped")
	}
}

func TestRedTeamEmergencyJWTReadWritePermissions(t *testing.T) {
	resetRedTeamEmergencyTest(t)
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.Enabled = true
	s.cfg.Auth.JWTSecret = "public-redteam-emergency-fixture"
	for _, tc := range []struct {
		role        string
		scopes      []string
		read, write bool
	}{
		{"admin", []string{"admin:read", "admin:write"}, true, true},
		{"readonly_admin", []string{"admin:read"}, true, false},
		{"user", []string{"models:read"}, false, false},
	} {
		token := issueLLMScopedTestToken(t, db, s, "emergency-"+tc.role, tc.role, "", tc.scopes, time.Now().UTC())
		for _, method := range []string{"GET", "POST"} {
			state := readRedTeamEmergency(t, &Server{db: db})
			r := httptest.NewRequest(method, "/admin/redteam/kill-switch", strings.NewReader(reviewedRedTeamBody(true, state.ReviewToken, "public scoped change")))
			r.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			s.Routes().ServeHTTP(w, r)
			want := tc.read
			if method == "POST" {
				want = tc.write
			}
			if (w.Code == 200) != want {
				t.Fatal("scope mismatch", tc.role, method, w.Code)
			}
			if !want && w.Code != 401 && w.Code != 403 {
				t.Fatal("permission rejection changed", w.Code)
			}
		}
	}
	audits, err := db.ListAdminAudit(t.Context(), 10)
	if err != nil || len(audits) != 1 || audits[0].Action != "redteam.kill_switch" {
		t.Fatal("unauthorized request applied or audited")
	}
}
