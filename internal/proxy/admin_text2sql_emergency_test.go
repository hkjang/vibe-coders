package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func text2SQLEmergencyRequest(s *Server, method, body string, ctx context.Context) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	s.handleText2SQLKillSwitch(w, httptest.NewRequest(method, "/admin/text2sql/kill-switch", strings.NewReader(body)).WithContext(ctx))
	return w
}

func readText2SQLEmergency(t *testing.T, s *Server) text2SQLEmergencyState {
	t.Helper()
	w := text2SQLEmergencyRequest(s, http.MethodGet, "", t.Context())
	var state text2SQLEmergencyState
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &state) != nil {
		t.Fatal("emergency state read failed")
	}
	if w.Header().Get("Cache-Control") != "no-store" || state.Scope != "responding_process" || len(state.ReviewToken) != 32 || state.ObservedAt == "" {
		t.Fatal("incomplete emergency review snapshot")
	}
	return state
}

func reviewedText2SQLBody(disabled bool, token, reason string) string {
	encoded, _ := json.Marshal(map[string]any{"disabled": disabled, "expected_review_token": token, "reason": reason})
	return string(encoded)
}

func TestText2SQLEmergencyReviewAuditAndReplay(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	s := &Server{db: db, instanceID: "synthetic-instance-a"}
	before := readText2SQLEmergency(t, s)
	if before.Disabled || before.ConfigEnabled {
		t.Fatal("missing runtime state must not invent enabled configuration")
	}
	body := reviewedText2SQLBody(true, before.ReviewToken, "  public synthetic stop  ")
	w := text2SQLEmergencyRequest(s, http.MethodPost, body, t.Context())
	var ack text2SQLEmergencyState
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &ack) != nil || !ack.Disabled || ack.Reason != "public synthetic stop" || ack.ReviewToken == before.ReviewToken {
		t.Fatal("reviewed change acknowledgment did not match the applied change")
	}
	if w = text2SQLEmergencyRequest(s, http.MethodPost, body, t.Context()); w.Code != 409 {
		t.Fatal("a previously consumed review was replayed")
	}
	audits, err := db.ListAdminAudit(t.Context(), 10)
	if err != nil || len(audits) != 1 || audits[0].Action != "text2sql.kill_switch" || !strings.Contains(audits[0].AfterValue, "public synthetic stop") || !strings.Contains(audits[0].BeforeValue, `"disabled":false`) {
		t.Fatal("exactly one actor/reason/state audit must accompany the accepted change")
	}
	if strings.Contains(audits[0].AfterValue, before.ReviewToken) || strings.Contains(audits[0].AfterValue, "synthetic-instance-a") {
		t.Fatal("review token or raw process identity leaked into audit")
	}
	w = text2SQLEmergencyRequest(s, http.MethodPost, reviewedText2SQLBody(false, ack.ReviewToken, "public synthetic resume"), t.Context())
	if w.Code != 200 || s.t2sKilled.Load() {
		t.Fatal("explicit reviewed resume failed")
	}
}

func TestText2SQLEmergencyCrossProcessAndRemediationInvalidateReview(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	a, b := &Server{db: db}, &Server{db: db}
	first := readText2SQLEmergency(t, a)
	body := reviewedText2SQLBody(true, first.ReviewToken, "public synthetic change")
	if w := text2SQLEmergencyRequest(b, http.MethodPost, body, t.Context()); w.Code != 409 || b.t2sKilled.Load() {
		t.Fatal("another process accepted the original process review")
	}
	a.setText2SQLKilled(true)
	a.setText2SQLKilled(false)
	if w := text2SQLEmergencyRequest(a, http.MethodPost, body, t.Context()); w.Code != 409 || a.t2sKilled.Load() {
		t.Fatal("A-B-A remediation revived a stale review")
	}
}

func TestText2SQLEmergencyConcurrentReviewAppliesOnce(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	s := &Server{db: db}
	state := readText2SQLEmergency(t, s)
	body := reviewedText2SQLBody(true, state.ReviewToken, "public concurrent stop")
	statuses := make(chan int, 8)
	var workers sync.WaitGroup
	for range 8 {
		workers.Go(func() { statuses <- text2SQLEmergencyRequest(s, http.MethodPost, body, t.Context()).Code })
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

func TestText2SQLEmergencyLegacyAndReviewValidation(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	s := &Server{db: db}
	for _, body := range []string{`{"disabled":true}`, `{}`, `null`, `{"disabled":null}`} {
		if w := text2SQLEmergencyRequest(s, http.MethodPost, body, t.Context()); w.Code != 200 {
			t.Fatal("legacy request contract changed")
		}
	}
	if s.t2sKilled.Load() {
		t.Fatal("legacy omitted/null state no longer defaults false")
	}
	for _, body := range []string{
		`{"disabled":true,"expected_review_token":""}`,
		`{"disabled":true,"expected_review_token":"01234567890123456789012345678901","reason":"  "}`,
		`{"expected_review_token":"01234567890123456789012345678901","reason":"public"}`,
		`{"disabled":"true"}`,
	} {
		if w := text2SQLEmergencyRequest(s, http.MethodPost, body, t.Context()); w.Code != 400 || s.t2sKilled.Load() {
			t.Fatal("invalid reviewed request changed emergency state")
		}
	}
}

func TestText2SQLEmergencyAuditFailureDoesNotApply(t *testing.T) {
	db := openTestStore(t)
	s := &Server{db: db}
	state := readText2SQLEmergency(t, s)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	body := reviewedText2SQLBody(true, state.ReviewToken, "public audit failure")
	if w := text2SQLEmergencyRequest(s, http.MethodPost, body, ctx); w.Code != 500 || s.t2sKilled.Load() {
		t.Fatal("cancelled audit was acknowledged or applied")
	}
	db.Close()
	w := text2SQLEmergencyRequest(s, http.MethodPost, body, t.Context())
	if w.Code != 500 || s.t2sKilled.Load() || strings.Contains(w.Body.String(), "sql:") || strings.Contains(w.Body.String(), "database is closed") {
		t.Fatal("unavailable audit changed state or exposed storage internals")
	}
	if readText2SQLEmergency(t, s).ReviewToken != state.ReviewToken {
		t.Fatal("failed audit consumed the current state revision")
	}
}
