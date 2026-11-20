package proxy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"vibe-coders/internal/store"
)

type dwRetryFixture struct {
	db          *store.SQLStore
	server      *Server
	peer        http.Handler
	routes      http.Handler
	calls       atomic.Int64
	accepted    atomic.Int64
	failAfter   atomic.Int64
	release     chan struct{}
	releaseOnce sync.Once
	day         string
}

func newDwRetryFixture(t *testing.T, rows int, block bool) *dwRetryFixture {
	t.Helper()
	f := &dwRetryFixture{db: openTestStore(t), release: make(chan struct{})}
	if !block {
		f.releaseOnce.Do(func() { close(f.release) })
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := f.calls.Add(1)
		select {
		case <-f.release:
		case <-r.Context().Done():
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(500)
			return
		}
		if after := f.failAfter.Load(); after > 0 && call > after {
			w.WriteHeader(503)
			return
		}
		raw := strings.TrimSpace(string(body))
		if raw != "" {
			f.accepted.Add(int64(len(strings.Split(raw, "\n"))))
		}
		w.WriteHeader(200)
	}))
	t.Cleanup(func() { f.releaseOnce.Do(func() { close(f.release) }); upstream.Close() })
	cfg := testConfig("http://fixture.invalid", "synthetic")
	cfg.Auth.AdminToken = "dw-admin-fixture"
	cfg.Auth.AdminReadonlyToken = "dw-reader-fixture"
	cfg.ClickHouse.URL = upstream.URL
	cfg.ClickHouse.Table = "daily_rollups"
	cfg.ClickHouse.Password = "private-test-password"
	var err error
	f.server, err = NewServer(cfg, f.db, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.routes = f.server.Routes()
	peer, err := NewServer(cfg, f.db, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.peer = peer.Routes()
	at := time.Now().UTC().Add(-time.Hour)
	f.day = at.In(time.FixedZone("KST", 9*3600)).Format("2006-01-02")
	for i := 0; i < rows; i++ {
		f.seed(t, fmt.Sprintf("row-%05d", i), at)
	}
	if err := f.db.RollupDay(t.Context(), f.day); err != nil {
		t.Fatal(err)
	}
	if err := f.db.RecordClickHouseSinkFailure(t.Context(), "model", f.day, "fixture"); err != nil {
		t.Fatal(err)
	}
	return f
}
func (f *dwRetryFixture) seed(t *testing.T, id string, at time.Time) {
	t.Helper()
	if err := f.db.InsertLogRecord(t.Context(), store.LogRecord{Request: store.RequestLog{ID: id, Model: id, CreatedAt: at, StatusCode: 200}}); err != nil {
		t.Fatal(err)
	}
}
func dwRetryCall(t *testing.T, h http.Handler, method, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var raw []byte
	if text, ok := body.(string); ok {
		raw = []byte(text)
	} else if body != nil {
		var err error
		raw, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	r := httptest.NewRequest(method, "/admin/dw/sink-retry"+path, bytes.NewReader(raw))
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}
func (f *dwRetryFixture) review(t *testing.T) dwRetryReview {
	t.Helper()
	w := dwRetryCall(t, f.routes, "GET", "", "dw-admin-fixture", nil)
	var review dwRetryReview
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &review) != nil {
		t.Fatalf("review status=%d body=%s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "private-test-password") || strings.Contains(w.Body.String(), "worker_token") {
		t.Fatal("private configuration leaked")
	}
	return review
}
func dwRetryInput(review dwRetryReview) map[string]any {
	return map[string]any{"revision": review.Revision, "reviewed_at": review.ReviewedAt, "all": review.All, "reason": "합성 데이터 재처리 검증"}
}
func (f *dwRetryFixture) run(t *testing.T, review dwRetryReview) store.ClickHouseSinkRun {
	t.Helper()
	w := dwRetryCall(t, f.routes, "POST", "?reviewed=1", "dw-admin-fixture", dwRetryInput(review))
	var run store.ClickHouseSinkRun
	if w.Code != 202 || json.Unmarshal(w.Body.Bytes(), &run) != nil {
		t.Fatalf("start status=%d body=%s", w.Code, w.Body.String())
	}
	return run
}
func (f *dwRetryFixture) wait(t *testing.T, id string) store.ClickHouseSinkRun {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		w := dwRetryCall(t, f.peer, "GET", "?job_id="+id, "dw-admin-fixture", nil)
		var run store.ClickHouseSinkRun
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &run) != nil {
			t.Fatalf("poll status=%d body=%s", w.Code, w.Body.String())
		}
		if run.Status != "running" {
			return run
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("job did not finish")
	return store.ClickHouseSinkRun{}
}
func TestClickHouseRetryReviewJobDurableAndIdempotent(t *testing.T) {
	f := newDwRetryFixture(t, 1, true)
	review := f.review(t)
	if review.EstimatedRows != 1 || review.EligibleDimensions != 1 || len(review.Dimensions) != 1 || review.Dimensions[0].Since != f.day {
		t.Fatalf("incorrect review %+v", review)
	}
	audits, err := f.db.ListAdminAudit(t.Context(), 10)
	if err != nil || len(audits) != 0 || f.calls.Load() != 0 {
		t.Fatal("review performed writes or delivery")
	}
	readonly := dwRetryCall(t, f.routes, "GET", "", "dw-reader-fixture", nil)
	if readonly.Code != 200 {
		t.Fatalf("read-only review status=%d", readonly.Code)
	}
	run := f.run(t, review)
	duplicate := dwRetryCall(t, f.peer, "POST", "?reviewed=1", "dw-admin-fixture", dwRetryInput(review))
	var repeated store.ClickHouseSinkRun
	if duplicate.Code != 200 || json.Unmarshal(duplicate.Body.Bytes(), &repeated) != nil || repeated.ID != run.ID {
		t.Fatal("another server did not recover existing operation")
	}
	// A new review is a different id, but cannot overlap the running retry.
	next := f.review(t)
	conflict := dwRetryCall(t, f.peer, "POST", "?reviewed=1", "dw-admin-fixture", dwRetryInput(next))
	if conflict.Code != 409 || !strings.Contains(conflict.Body.String(), "sink_run_active") {
		t.Fatalf("overlapping dispatch accepted: %d %s", conflict.Code, conflict.Body.String())
	}
	if w := dwRetryCall(t, f.routes, "POST", "?reviewed=1", "dw-reader-fixture", dwRetryInput(review)); w.Code != 401 {
		t.Fatalf("read-only write status=%d", w.Code)
	}
	if w := dwRetryCall(t, f.peer, "GET", "?job_id="+run.ID, "dw-reader-fixture", nil); w.Code != 403 {
		t.Fatalf("other actor read status=%d", w.Code)
	}
	f.releaseOnce.Do(func() { close(f.release) })
	completed := f.wait(t, run.ID)
	if completed.Status != "succeeded" || completed.Progress.SentRows != 1 || completed.Progress.FinishedDimensions != 1 || f.calls.Load() != 1 || f.accepted.Load() != 1 {
		t.Fatalf("incorrect committed result %+v calls%d", completed, f.calls.Load())
	}
	after := dwRetryCall(t, f.peer, "POST", "?reviewed=1", "dw-admin-fixture", dwRetryInput(review))
	if after.Code != 200 || f.calls.Load() != 1 {
		t.Fatal("completed review dispatched twice")
	}
	queue, err := f.db.ListClickHouseSinkRetries(t.Context())
	if err != nil || len(queue) != 0 {
		t.Fatal("completed queue not acknowledged")
	}
	audits, err = f.db.ListAdminAudit(t.Context(), 10)
	if err != nil || len(audits) != 2 {
		t.Fatalf("admission/completion audit count=%d err=%v", len(audits), err)
	}
	for _, audit := range audits {
		if !strings.Contains(audit.AfterValue, "합성 데이터 재처리 검증") || strings.Contains(audit.AfterValue, "private-test-password") {
			t.Fatal("invalid audit contents")
		}
	}
}
func TestClickHouseRetryReviewRejectsChangedEvidence(t *testing.T) {
	for _, change := range []string{"queue", "config", "count", "expired", "future", "reason", "duplicate", "null", "unknown"} {
		t.Run(change, func(t *testing.T) {
			f := newDwRetryFixture(t, 1, false)
			review := f.review(t)
			input := dwRetryInput(review)
			var body any = input
			switch change {
			case "queue":
				if err := f.db.RecordClickHouseSinkFailure(t.Context(), "model", f.day, "new failure"); err != nil {
					t.Fatal(err)
				}
			case "config":
				cfg := f.server.chConf()
				cfg.Table = "changed_destination"
				f.server.chRuntime.Store(&cfg)
			case "count":
				f.seed(t, "new-source", time.Now().UTC().Add(-time.Hour))
				if err := f.db.RollupDay(t.Context(), f.day); err != nil {
					t.Fatal(err)
				}
			case "expired":
				input["reviewed_at"] = time.Now().Add(-6 * time.Minute).UTC().Format(dwRetryTimeLayout)
			case "future":
				input["reviewed_at"] = time.Now().Add(time.Minute).UTC().Format(dwRetryTimeLayout)
			case "reason":
				input["reason"] = strings.Repeat("가", 1025)
			case "duplicate":
				raw, _ := json.Marshal(input)
				body = strings.TrimSuffix(string(raw), "}") + `,"all":false}`
			case "null":
				input["all"] = nil
			case "unknown":
				input["unexpected"] = true
			}
			w := dwRetryCall(t, f.routes, "POST", "?reviewed=1", "dw-admin-fixture", body)
			if w.Code != 400 && w.Code != 409 {
				t.Fatalf("changed %s accepted: %d %s", change, w.Code, w.Body.String())
			}
			if _, found, err := f.db.ClickHouseSinkRun(t.Context(), review.RunID); err != nil || found {
				t.Fatal("invalid review admitted")
			}
			audits, err := f.db.ListAdminAudit(t.Context(), 10)
			if err != nil || len(audits) != 0 || f.calls.Load() != 0 {
				t.Fatal("invalid review changed audit or sent rows")
			}
		})
	}
}
func TestClickHouseRetryReviewReportsPartialDelivery(t *testing.T) {
	f := newDwRetryFixture(t, 1001, false)
	f.failAfter.Store(1)
	run := f.run(t, f.review(t))
	done := f.wait(t, run.ID)
	if done.Status != "partial_failed" || done.Progress.EstimatedRows != 1001 || done.Progress.SentRows != 1000 || f.accepted.Load() != 1000 || f.calls.Load() != 2 {
		t.Fatalf("partial outcome %+v actual%d calls%d", done, f.accepted.Load(), f.calls.Load())
	}
	queue, err := f.db.ListClickHouseSinkRetries(t.Context())
	if err != nil || len(queue) != 1 || queue[0].Attempts != 2 {
		t.Fatalf("failed interval disappeared %+v %v", queue, err)
	}
	f.failAfter.Store(0)
	recovery := f.run(t, f.review(t))
	done = f.wait(t, recovery.ID)
	if done.Status != "succeeded" || done.Progress.SentRows != 1001 || f.accepted.Load() != 2001 {
		t.Fatal("newly reviewed recovery did not finish whole interval")
	}
}
func TestClickHouseRetryReviewBlockedFactRetainsQueue(t *testing.T) {
	f := newDwRetryFixture(t, 1, false)
	if err := f.db.RecordClickHouseSinkFailure(t.Context(), "text2sql_fact", f.day, "missing fact configuration"); err != nil {
		t.Fatal(err)
	}
	review := f.review(t)
	if len(review.Dimensions) != 2 || review.EligibleDimensions != 1 || review.Dimensions[1].Issue != "fact_not_configured" {
		t.Fatalf("missing destination not explained %+v", review)
	}
	done := f.wait(t, f.run(t, review).ID)
	queue, err := f.db.ListClickHouseSinkRetries(t.Context())
	if done.Status != "partial_failed" || done.Progress.SentRows != 1 || err != nil || len(queue) != 1 || queue[0].Dimension != "text2sql_fact" {
		t.Fatal("blocked work falsely acknowledged")
	}
	blocked := f.review(t)
	w := dwRetryCall(t, f.routes, "POST", "?reviewed=1", "dw-admin-fixture", dwRetryInput(blocked))
	if w.Code != 409 || f.calls.Load() != 1 {
		t.Fatal("all-blocked review admitted")
	}
}

// Simulate a worker that disappeared after admission. A peer must preserve the
// last confirmed counts, expose interruption and never redispatch that review.
func TestClickHouseRetryReviewExpiredWorkerRequiresFreshReview(t *testing.T) {
	f := newDwRetryFixture(t, 1, false)
	review := f.review(t)
	pending, err := f.db.ListClickHouseSinkRetries(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	actorRequest := httptest.NewRequest("GET", "/admin/dw/sink-retry", nil)
	actorRequest.Header.Set("Authorization", "Bearer dw-admin-fixture")
	actor := f.server.adminKeyActor(actorRequest)
	stale := time.Now().UTC().Add(-2 * time.Minute)
	run := store.ClickHouseSinkRun{ID: review.RunID, Actor: actor, WorkerToken: "vanished-worker", Status: "running", ReviewedAt: review.ReviewedAt, CreatedAt: stale.Format(dwRetryTimeLayout), UpdatedAt: stale.Format(dwRetryTimeLayout), LeaseUntil: stale.Add(time.Second).Format(dwRetryTimeLayout), Progress: store.ClickHouseSinkRunProgress{EstimatedRows: review.EstimatedRows, Dimensions: review.Dimensions}}
	audit := store.AdminAuditLog{ID: run.ID + "_requested", AdminID: actor, Action: "dw.clickhouse.retry.requested", AfterValue: "fixture interrupted worker"}
	if ok, err := f.db.AdmitClickHouseSinkRun(t.Context(), run, pending, audit); !ok || err != nil {
		t.Fatal("fixture admission", err)
	}
	for _, method := range []string{"GET", "POST"} {
		path := "?job_id=" + run.ID
		var body any
		if method == "POST" {
			path = "?reviewed=1"
			body = dwRetryInput(review)
		}
		w := dwRetryCall(t, f.peer, method, path, "dw-admin-fixture", body)
		var result store.ClickHouseSinkRun
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Status != "interrupted" || result.Progress.SentRows != 0 || result.FinishedAt != "" || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("lost interrupted state: %d %s", w.Code, w.Body.String())
		}
		for _, private := range []string{"vanished-worker", "worker_token", "lease_until", "actor"} {
			if strings.Contains(w.Body.String(), private) {
				t.Fatal("private worker metadata leaked")
			}
		}
	}
	recorded, found, err := f.db.ClickHouseSinkRun(t.Context(), run.ID)
	if err != nil || !found || recorded.Status != "running" || f.calls.Load() != 0 {
		t.Fatal("read or duplicate silently resumed interrupted work")
	}
	queue, err := f.db.ListClickHouseSinkRetries(t.Context())
	if err != nil || !reflect.DeepEqual(queue, pending) {
		t.Fatal("interrupted work acknowledged pending queue")
	}
	audits, err := f.db.ListAdminAudit(t.Context(), 10)
	if err != nil || len(audits) != 1 {
		t.Fatal("invented completion audit")
	}
	// Only an explicit new review can start a fresh operation after interruption.
	fresh := f.review(t)
	if fresh.RunID == run.ID {
		t.Fatal("fresh review reused expired operation")
	}
	started := f.run(t, fresh)
	completed := f.wait(t, started.ID)
	if completed.Status != "succeeded" || completed.Progress.SentRows != 1 || f.calls.Load() != 1 || f.accepted.Load() != 1 {
		t.Fatal("explicit reviewed recovery did not deliver exactly one fixture row")
	}
}
