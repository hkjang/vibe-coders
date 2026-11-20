package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"vibe-coders/internal/store"
)

func redTeamJobCall(t *testing.T, s *Server, method, path, actor string, body any) *httptest.ResponseRecorder {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(encoded))
	r.Header.Set("Authorization", "Bearer "+actor)
	w := httptest.NewRecorder()
	s.Routes().ServeHTTP(w, r)
	return w
}
func decodeRedTeamJob(t *testing.T, w *httptest.ResponseRecorder) store.RedTeamJob {
	t.Helper()
	var job store.RedTeamJob
	if w.Code != 200 && w.Code != 202 {
		t.Fatalf("job HTTP %d: %s", w.Code, w.Body.String())
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("job may be cached")
	}
	if err := json.Unmarshal(w.Body.Bytes(), &job); err != nil {
		t.Fatal(err)
	}
	return job
}
func awaitRedTeamJob(t *testing.T, s *Server, path, id string) store.RedTeamJob {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		job := decodeRedTeamJob(t, redTeamJobCall(t, s, "GET", path+"?job_id="+id, "operator", nil))
		if job.Status != "running" {
			return job
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("job did not finish")
	return store.RedTeamJob{}
}

func TestRedTeamJobDetachedAcceptedAndOwned(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	var calls atomic.Int32
	s, db, c := reviewedFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		close(entered)
		select {
		case <-release:
			redTeamAdmissionReply(w)
		case <-r.Context().Done():
		}
	})
	defer unblock()
	s.cfg.Auth.Enabled = false
	s.cfg.Auth.AdminToken = "operator"
	s.cfg.Auth.AdminReadonlyToken = "reader"
	review := issueReviewed(t, s, c, reviewedBody())
	if !validRedTeamJobID(review.JobID) {
		t.Fatal("missing recovery identity before admission")
	}
	path := "/admin/redteam/campaigns/" + c.ID + "/run-reviewed"
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	encoded, _ := json.Marshal(executionBody(review))
	request := httptest.NewRequest("POST", path+"?job=1", bytes.NewReader(encoded)).WithContext(ctx)
	request.Header.Set("Authorization", "Bearer operator")
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { defer close(done); s.Routes().ServeHTTP(response, request) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("submission waited for provider instead of accepting job")
	}
	if response.Code != 202 {
		t.Fatalf("not accepted: %d", response.Code)
	}
	job := decodeRedTeamJob(t, response)
	cancel()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("worker inherited browser cancellation")
	}
	peer := &Server{db: db, cfg: s.cfg}
	read := decodeRedTeamJob(t, redTeamJobCall(t, peer, "GET", path+"?job_id="+job.ID, "operator", nil))
	if read.ID != job.ID || read.Status != "running" {
		t.Fatal("another server cannot read accepted job")
	}
	duplicate := decodeRedTeamJob(t, redTeamJobCall(t, peer, "POST", path+"?job=1", "operator", executionBody(review)))
	if duplicate.ID != job.ID || calls.Load() != 1 {
		t.Fatal("duplicate redispatched")
	}
	if w := redTeamJobCall(t, s, "GET", path+"?job_id="+job.ID, "reader", nil); w.Code != 403 {
		t.Fatal("foreign actor read job", w.Code)
	}
	if w := redTeamJobCall(t, s, "POST", path+"?job=1", "reader", executionBody(review)); w.Code != 401 && w.Code != 403 {
		t.Fatal("reader admitted write", w.Code)
	}
	for _, bad := range []string{"?job_id=bad", "?job_id=" + job.ID + "&job_id=" + job.ID, "?job_id=" + job.ID + "&extra=1"} {
		if w := redTeamJobCall(t, s, "GET", path+bad, "operator", nil); w.Code != 400 {
			t.Fatal("invalid query accepted", w.Code)
		}
	}
	unblock()
	finished := awaitRedTeamJob(t, peer, path, job.ID)
	if finished.Status != "completed" || finished.Progress.LiveCalls != 1 || finished.Progress.CompletedCases != 1 || len(finished.Progress.RunIDs) != 1 {
		t.Fatalf("completion mismatch: %+v", finished.Progress)
	}
	if strings.Contains(string(finished.Outcome), "synthetic-key") || strings.Contains(string(finished.Outcome), "Synthetic safety test") {
		t.Fatal("job leaked execution key or prompt")
	}
	raw := redTeamJobCall(t, peer, "GET", path+"?job_id="+job.ID, "operator", nil).Body.String()
	for _, private := range []string{"worker_token", "lease_until", "\"actor\"", "review_token", "Synthetic safety test", "synthetic-key"} {
		if strings.Contains(raw, private) {
			t.Fatal("private job field exposed", private)
		}
	}
	audits, err := db.ListAdminAudit(t.Context(), 30)
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, a := range audits {
		if strings.HasPrefix(a.Action, "redteam.job.") {
			counts[a.Action]++
			if a.AdminID != adminID(request) {
				t.Fatal("job audit actor mismatch")
			}
			if strings.Contains(a.AfterValue, "synthetic-key") {
				t.Fatal("credential in audit")
			}
		}
	}
	if counts["redteam.job.requested"] != 1 || counts["redteam.job.completed"] != 1 {
		t.Fatal("job audit counts", counts)
	}
	if w := redTeamJobCall(t, peer, "POST", path+"?job=1", "operator", executionBody(review)); w.Code != 200 || calls.Load() != 1 {
		t.Fatal("finished job rerun")
	}
}

func TestRedTeamJobSimulationAndIndependentReviews(t *testing.T) {
	s, db, c := reviewedFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("simulation called provider") })
	s.cfg.Auth.Enabled = false
	s.cfg.Auth.AdminToken = "operator"
	body := reviewedBody()
	body.Kind = "simulation"
	path := "/admin/redteam/campaigns/" + c.ID + "/run-reviewed"
	for range 2 {
		var found bool
		var err error
		c, found, err = db.GetRedTeamCampaign(t.Context(), c.ID)
		if err != nil || !found {
			t.Fatal("current campaign unavailable", err)
		}
		review := issueReviewed(t, s, c, body)
		job := decodeRedTeamJob(t, redTeamJobCall(t, s, "POST", path+"?job=1", "operator", map[string]string{"review_token": review.ReviewToken}))
		final := awaitRedTeamJob(t, s, path, job.ID)
		if final.Status != "completed" || final.Progress.LiveCalls != 0 || final.Progress.CompletedCases != 1 {
			t.Fatal("simulation outcome mismatch")
		}
	}
}

func TestRedTeamJobRecordingFailureKeepsActualCallCount(t *testing.T) {
	var calls atomic.Int32
	s, _, raw, campaign := reviewedRecordingFixture(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		redTeamAdmissionReply(w)
	})
	s.cfg.Auth.Enabled = false
	s.cfg.Auth.AdminToken = "operator"
	body := reviewedBody()
	body.Models = []string{"test-model", "second-model"}
	body.Limits.MaxCalls = 2
	review := issueReviewed(t, s, campaign, body)
	statements := []string{`CREATE TRIGGER reject_job_case BEFORE INSERT ON redteam_case_results BEGIN SELECT RAISE(ABORT, 'synthetic-job-case-fault'); END`}
	if os.Getenv("TEST_POSTGRES_DSN") != "" {
		statements = []string{`CREATE FUNCTION reject_job_case() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic-job-case-fault'; END $$`, `CREATE TRIGGER reject_job_case BEFORE INSERT ON redteam_case_results FOR EACH ROW EXECUTE FUNCTION reject_job_case()`}
	}
	for _, statement := range statements {
		if _, err := raw.ExecContext(t.Context(), statement); err != nil {
			t.Fatal(err)
		}
	}
	path := "/admin/redteam/campaigns/" + campaign.ID + "/run-reviewed"
	job := decodeRedTeamJob(t, redTeamJobCall(t, s, "POST", path+"?job=1", "operator", executionBody(review)))
	final := awaitRedTeamJob(t, s, path, job.ID)
	if calls.Load() != 1 || final.Status != "unknown" || final.Progress.LiveCalls != 1 || final.Progress.CompletedCases != 0 {
		t.Fatalf("unconfirmed recording must retain one actual call, no recorded case: calls=%d status=%s progress=%+v", calls.Load(), final.Status, final.Progress)
	}
}
