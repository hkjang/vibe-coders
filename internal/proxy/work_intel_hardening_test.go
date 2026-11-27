package proxy

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
	"vibe-coders/internal/workintel"
)

// The work title, tags and technologies summarise the prompt; a caller who
// may not see raw prompts gets none of them, in any list or file.
func TestWorkIntelPromptTextWithheld(t *testing.T) {
	f := newWorkAPIFixture(t)
	var requests workRequestsResponse
	f.get(t, f.full, "/requests?"+f.period, &requests)
	titled := 0
	for _, row := range requests.Rows {
		if row.WorkTitle != "" && len(row.Technologies)+len(row.Tags) > 0 {
			titled++
		}
	}
	if titled == 0 {
		t.Fatalf("the fixture has no titled request for a full administrator: %+v", requests.Rows)
	}
	for _, token := range []string{f.viewer, f.alphaAdmin} {
		f.get(t, token, "/requests?"+f.period, &requests)
		var detail workSessionDetailResponse
		f.get(t, token, "/sessions/sess-a1", &detail)
		var review workReviewResponse
		f.get(t, token, "/review", &review)
		rows := append(append(append([]workRequestView{}, requests.Rows...), detail.Requests...), review.Rows...)
		if len(rows) == 0 || len(review.Rows) == 0 {
			t.Fatalf("no rows to check: requests %d review %d", len(requests.Rows), len(review.Rows))
		}
		for _, row := range rows {
			if row.WorkTitle != "" || len(row.Tags) != 0 || len(row.Technologies) != 0 || row.Tags == nil || row.Technologies == nil {
				t.Errorf("request %s carries prompt-derived text: %q %v %v", row.RequestID, row.WorkTitle, row.Tags, row.Technologies)
			}
		}
		if review.Summary.NewCategoryHints == nil || len(review.Summary.NewCategoryHints) != 0 {
			t.Errorf("review hints for an unprivileged caller = %v", review.Summary.NewCategoryHints)
		}
		status, body := f.call(t, token, http.MethodGet, "/export.csv?view=requests&"+f.period, nil)
		records, err := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(body, []byte{0xEF, 0xBB, 0xBF}))).ReadAll()
		if status != http.StatusOK || err != nil || records[0][13] != "work_title" {
			t.Fatalf("requests export = %d %v %v", status, err, records)
		}
		for _, record := range records[1:] {
			if record[13] != "" || record[14] != "" || record[15] != "" {
				t.Errorf("requests export carries prompt-derived text: %v", record)
			}
		}
	}
}

func workTestPseudonym(key, userKey string) string {
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte("work-intel-user-v1\x00"))
	mac.Write([]byte(userKey))
	return workIntelUserPrefix + hex.EncodeToString(mac.Sum(nil))[:10]
}

// A pseudonym is keyed with a secret of this deployment: the gateway secret,
// else the JWT secret. The public development default is no secret, and
// without a real one no pseudonym is made at all.
func TestWorkIntelPseudonymKey(t *testing.T) {
	for _, c := range []struct {
		name, gateway, jwt, want string
	}{
		{"gateway secret", "a-real-gateway-secret", "a-real-jwt-secret", workTestPseudonym("a-real-gateway-secret", "ub1")},
		{"default gateway secret, JWT secret", config.DefaultGatewaySecret, "a-real-jwt-secret", workTestPseudonym("a-real-jwt-secret", "ub1")},
		{"no gateway secret, JWT secret", "", "a-real-jwt-secret", workTestPseudonym("a-real-jwt-secret", "ub1")},
		{"default gateway secret only", config.DefaultGatewaySecret, "", ""},
		{"both the default", config.DefaultGatewaySecret, config.DefaultGatewaySecret, ""},
		{"none", "", "", ""},
	} {
		s := &Server{}
		s.cfg.Secret.GatewaySecret, s.cfg.Auth.JWTSecret = c.gateway, c.jwt
		got := s.workIntelPseudonym("ub1")
		if got != c.want {
			t.Errorf("%s: pseudonym = %q, want %q", c.name, got, c.want)
		}
		if got == workTestPseudonym(config.DefaultGatewaySecret, "ub1") {
			t.Errorf("%s: the pseudonym can be recomputed with the public default secret", c.name)
		}
		if label := s.workIntelUserLabel(workIntelCaller{}, "ub1"); label != c.want {
			t.Errorf("%s: label for an unprivileged caller = %q", c.name, label)
		}
		if label := s.workIntelUserLabel(workIntelCaller{privileged: true}, "ub1"); label != "ub1" {
			t.Errorf("%s: label for a privileged caller = %q", c.name, label)
		}
		if c.want == "" {
			// Nothing was shown, so no pseudonym names anyone.
			q := &workIntelReadQuery{s: s}
			if key, err := q.resolveUser(context.Background(), workIntelUserPrefix+"0123456789"); err != nil || key != workIntelNoUser {
				t.Errorf("%s: resolving a pseudonym = %q %v", c.name, key, err)
			}
		}
	}

	// Through the API: with the default gateway secret the lists are keyed with
	// the JWT secret of the deployment.
	f := newWorkAPIFixture(t)
	f.admin.cfg.Secret.GatewaySecret = config.DefaultGatewaySecret
	var sessions workSessionsResponse
	f.get(t, f.viewer, "/sessions?"+f.period, &sessions)
	want := workTestPseudonym(f.admin.cfg.Auth.JWTSecret, "ua1")
	found := false
	for _, row := range sessions.Rows {
		if row.User == workTestPseudonym(config.DefaultGatewaySecret, "ua1") {
			t.Errorf("session %s is labelled with the default-secret pseudonym", row.SessionID)
		}
		found = found || (row.SessionID == "sess-a1" && row.User == want)
	}
	if !found {
		t.Errorf("sess-a1 is not labelled %q: %+v", want, sessions.Rows)
	}
	f.get(t, f.viewer, "/sessions?"+f.period+"&user="+want, &sessions)
	if len(sessions.Rows) != 1 || sessions.Rows[0].SessionID != "sess-a1" {
		t.Errorf("filtering by the pseudonym = %+v", sessions.Rows)
	}
}

// ServeMux cleans "a/../b" and "a//b" into a redirect to another path; a
// session id must reach the handler exactly as the client encoded it.
func TestWorkIntelSessionPathIsNotCleaned(t *testing.T) {
	env := newWorkAPIEnv(t)
	env.send(t, "key-a1", "sess-a1", workAPIModel, workIntelPromptCode)
	env.send(t, "key-a1", "team/one", workAPIModel, workIntelPromptCode)
	env.run(t)
	get := func(path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, workIntelAdminPath+"/sessions/"+path, nil)
		r.Header.Set("Authorization", "Bearer "+env.full)
		w := httptest.NewRecorder()
		env.routes.ServeHTTP(w, r)
		return w
	}
	for _, path := range []string{"a//b", "a/../sess-a1", "x/./sess-a1", "a%2F..%2Fsess-a1", "sess-a1/..", "sess-a1/", "./sess-a1", "%2E%2E/sess-a1", "team/one/.."} {
		w := get(path)
		if w.Code != http.StatusNotFound || w.Header().Get("Location") != "" || workAPIErrorCode(w.Body.Bytes()) != "work_session_not_found" {
			t.Errorf("GET sessions/%s = %d Location=%q %s", path, w.Code, w.Header().Get("Location"), w.Body.String())
		}
	}
	for path, want := range map[string]string{"sess-a1": "sess-a1", "team%2Fone": "team/one", "team/one": "team/one"} {
		w := get(path)
		var detail workSessionDetailResponse
		if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &detail) != nil || detail.Session.SessionID != want {
			t.Errorf("GET sessions/%s = %d %s", path, w.Code, w.Body.String())
		}
	}
}

// A list's count stops at store.WorkCountCap, so no page starts beyond it.
func TestWorkIntelOffsetCap(t *testing.T) {
	f := newWorkAPIFixture(t)
	for _, path := range []string{"/requests?offset=100001", "/sessions?offset=100001", "/review?offset=100001", "/automation?offset=100001",
		"/export.csv?view=requests&offset=100001", "/requests?offset=9999999999"} {
		status, body := f.call(t, f.full, http.MethodGet, path, nil)
		want := "work_intel_offset_too_large"
		if strings.HasSuffix(path, "9999999999") {
			want = "work_intel_invalid_query"
		}
		if status != http.StatusBadRequest || workAPIErrorCode(body) != want {
			t.Errorf("%s = %d %s", path, status, body)
		}
	}
	var requests workRequestsResponse
	f.get(t, f.full, "/requests?offset=100000", &requests)
	if len(requests.Rows) != 0 || requests.Count != 12 || requests.Offset != store.WorkCountCap {
		t.Errorf("the last allowed offset = %+v", requests)
	}
}

// The worker keeps classifying while a reclassification preview is open: a
// request the rules left waiting for the model is retried once the model is
// on, which rewrites it after the reviewed instant. That is normal work, and
// the confirmation goes through; the job reports what it counted against what
// the preview counted.
func TestWorkIntelAPIReclassifyConfirmsAfterWorkerRetry(t *testing.T) {
	fastWorkIntelJobs(t)
	env := newWorkAPIEnv(t)
	for i := 0; i < 3; i++ {
		env.send(t, "key-a1", "s-unclear", workAPIModel, workIntelPromptUnclear)
	}
	env.send(t, "key-a1", "s-code", workAPIModel, workIntelPromptCode)
	env.run(t)
	pending, err := env.db.WorkIntelPendingLLM(context.Background(), 50, 3, 0)
	if err != nil || len(pending) == 0 {
		t.Fatalf("no request waits for the model after a cycle with the model off: %d %v", len(pending), err)
	}

	env.useLLM(nil)
	env.worker.retryBackoff = 0
	env.fake.set(func(string) (string, time.Duration) {
		return workIntelAnswer("office", "office.email", "메일", []string{"일정"}, 0.9), 0
	})
	day := workAPIToday()
	var preview workReclassifyPreview
	env.get(t, env.full, "/reclassify?from="+day+"&to="+day, &preview)
	if preview.Total != 4 {
		t.Fatalf("preview = %+v", preview)
	}
	time.Sleep(5 * time.Millisecond)
	if stats := env.run(t); stats.RetrySucceeded == 0 {
		t.Fatalf("the worker retried nothing: %+v", stats)
	}

	status, body := env.call(t, env.full, http.MethodPost, "/reclassify?reviewed=1", map[string]any{
		"revision": preview.Revision, "reviewed_at": preview.ReviewedAt, "reason": "모델을 켠 뒤 반영"})
	var job workJobView
	if err := json.Unmarshal(body, &job); status != http.StatusAccepted || err != nil {
		t.Fatalf("confirmation after the worker's retry = %d %s", status, body)
	}
	// The retried requests were classified after the review with the current
	// policy; the job leaves them out and says so.
	if job.Progress.Previewed != 4 || job.Progress.Total >= 4 || job.Progress.Total < 1 {
		t.Errorf("job progress = %+v", job.Progress)
	}
	if done := env.waitJob(t, env.full, job.ID); done.Status != store.WorkJobSucceeded || done.Progress.Previewed != 4 {
		t.Errorf("finished job = %+v", done)
	}
	// Caller binding and the signature still hold: the started job is not
	// another administrator's to confirm, and an altered revision is refused.
	if status, body := env.call(t, env.alphaAdmin, http.MethodPost, "/reclassify?reviewed=1", map[string]any{
		"revision": preview.Revision, "reviewed_at": preview.ReviewedAt, "reason": "x"}); status != http.StatusForbidden || workAPIErrorCode(body) != "work_job_denied" {
		t.Errorf("another caller confirming = %d %s", status, body)
	}
	tampered := strings.Replace(preview.Revision, ".", ".0", 1)[:len(preview.Revision)]
	if status, _ := env.call(t, env.full, http.MethodPost, "/reclassify?reviewed=1", map[string]any{
		"revision": tampered, "reviewed_at": preview.ReviewedAt, "reason": "x"}); status != http.StatusConflict && status != http.StatusBadRequest {
		t.Errorf("a tampered revision = %d", status)
	}
}

// newWorkIntelLLMServer builds a server whose only provider is at baseURL.
func newWorkIntelLLMServer(t *testing.T, baseURL string) *Server {
	t.Helper()
	db, _ := workIntelStores(t)
	logger := store.NewAsyncLogger(db, 64, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()); db.Close() })
	server, err := NewServer(testConfig(baseURL, "s"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	return server
}

// The classification model was checked to be internal before the call; a
// 307 or 308 from it must not carry the request text to another host.
func TestWorkIntelLLMCallsDoNotFollowRedirects(t *testing.T) {
	isolateWorkIntelLogs(t)
	var elsewhere atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		elsewhere.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		writeJSONBody(w, http.StatusOK, `{"choices":[{"index":0,"message":{"role":"assistant","content":"{}"},"finish_reason":"stop"}]}`)
	}))
	t.Cleanup(other.Close)
	for _, code := range []int{http.StatusTemporaryRedirect, http.StatusPermanentRedirect} {
		redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, other.URL+r.URL.Path, code)
		}))
		t.Cleanup(redirector.Close)
		s := newWorkIntelLLMServer(t, redirector.URL)
		ctx := context.Background()
		conf := s.workIntelConf()
		conf.LLMEnabled, conf.LLMModel = true, "judge-model"
		target, block := s.workIntelLLMTargetFor(ctx, conf)
		if block != nil {
			t.Fatalf("the redirecting provider is not usable: %+v", block)
		}
		engine, issues := workintel.Compile(workintel.DefaultPolicy())
		if len(issues) != 0 {
			t.Fatal(issues)
		}
		elsewhere.Store(0)
		if _, err := s.workIntelLLMClassify(ctx, engine, target, workintel.Features{Text: workIntelPromptMail}, 5*time.Second); err == nil ||
			!strings.Contains(err.Error(), "307") && !strings.Contains(err.Error(), "308") {
			t.Errorf("classification through a %d = %v", code, err)
		}
		if _, err := s.workIntelLLMChat(ctx, target, workIntelInsightLLMMarker, `{"title":"t","body":"b"}`, 5*time.Second); err == nil {
			t.Errorf("insight rewrite through a %d succeeded", code)
		}
		if n := elsewhere.Load(); n != 0 {
			t.Errorf("the request text reached the redirect target %d times after a %d", n, code)
		}
		// The shared client would have followed: that is what the bounded one is for.
		resp, err := s.client.Post(redirector.URL+"/v1/chat/completions", "application/json", strings.NewReader(`{}`))
		if err == nil {
			resp.Body.Close()
		}
		if elsewhere.Load() != 1 {
			t.Errorf("control: the shared client did not follow the %d (%v)", code, err)
		}
	}
}

// The policy test screen calls the model from the same per-minute budget as
// the worker.
func TestWorkIntelPolicyTestUsesLLMBudget(t *testing.T) {
	env := newWorkAPIEnv(t)
	conf := env.admin.workIntelConf()
	conf.LLMEnabled, conf.LLMModel, conf.LLMMaxPerMinute = true, "judge-model", 2
	env.admin.workIntelRuntime.Store(&conf)
	env.fake.set(func(string) (string, time.Duration) {
		return workIntelAnswer("infra", "infra.k8s", "파드 장애 분석", []string{"장애"}, 0.9), 0
	})
	type testResult struct {
		LLM struct {
			Used  bool   `json:"used"`
			Error string `json:"error"`
			Code  string `json:"code"`
		} `json:"llm"`
	}
	test := func() testResult {
		var out testResult
		env.do(t, env.full, http.MethodPost, "/policy/test", map[string]any{"text": workIntelPromptUnclear, "use_draft": false, "use_llm": true}, &out)
		return out
	}
	if out := test(); !out.LLM.Used || out.LLM.Error != "" {
		t.Fatalf("first test = %+v", out.LLM)
	}
	// The worker's calls count against the same minute.
	env.admin.workIntel.llmBudget.record(time.Now())
	if out := test(); out.LLM.Used || out.LLM.Code != workIntelLLMBlockedBudget || !strings.Contains(out.LLM.Error, "llm_max_per_minute") {
		t.Errorf("test over the budget = %+v", out.LLM)
	}
	if calls := env.fake.count(); calls != 1 {
		t.Errorf("the model was called %d times, want 1", calls)
	}
	// And the test's call counts against the worker's.
	step := &workIntelLLMStep{worker: &WorkIntelWorker{server: env.admin}, conf: conf}
	if left := step.allowance(time.Now()); left != 0 {
		t.Errorf("the worker's allowance after the test = %d", left)
	}
	env.admin.workIntel.llmBudget.reset()
	if left := step.allowance(time.Now()); left != 2 {
		t.Errorf("the worker's allowance after a reset = %d", left)
	}
}
