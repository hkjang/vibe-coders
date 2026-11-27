package proxy

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/dlp"
	"vibe-coders/internal/store"
	"vibe-coders/internal/workintel"
)

// workIntelFake is the provider behind the test gateway. It answers ordinary
// chat requests, and plays the classification model for the requests the
// worker sends: those carry the category list in their system message.
type workIntelFake struct {
	mu     sync.Mutex
	answer func(body string) (content string, delay time.Duration)
	calls  int
	bodies []string
}

const workIntelFakeChatReply = `{"id":"c1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}`

func (f *workIntelFake) handle(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	body := string(raw)
	if !strings.Contains(body, "등록된 업무 분류") {
		writeJSONBody(w, http.StatusOK, workIntelFakeChatReply)
		return
	}
	f.mu.Lock()
	f.calls++
	f.bodies = append(f.bodies, body)
	answer := f.answer
	f.mu.Unlock()
	content, delay := "", time.Duration(0)
	if answer != nil {
		content, delay = answer(body)
	}
	if delay > 0 {
		select {
		case <-time.After(delay):
		case <-r.Context().Done():
			return
		}
	}
	reply, _ := json.Marshal(map[string]any{
		"choices": []map[string]any{{"index": 0, "message": map[string]string{"role": "assistant", "content": content}, "finish_reason": "stop"}},
		"usage":   map[string]int{"prompt_tokens": 120, "completion_tokens": 30, "total_tokens": 150},
	})
	writeJSONBody(w, http.StatusOK, string(reply))
}

func (f *workIntelFake) set(answer func(body string) (string, time.Duration)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.answer = answer
}

func (f *workIntelFake) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func (f *workIntelFake) lastBody() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.bodies) == 0 {
		return ""
	}
	return f.bodies[len(f.bodies)-1]
}

// workIntelAnswer builds a classification response the way the policy prompt
// asks for it.
func workIntelAnswer(primary, secondary, title string, tags []string, confidence float64) string {
	encoded, _ := json.Marshal(map[string]any{
		"primary_category": primary, "secondary_category": secondary, "detail_category": "",
		"work_title": title, "work_intent": "의도", "action_type": "create", "target_system": "",
		"technologies": []string{}, "tags": tags, "confidence": confidence, "classification_version": "1",
	})
	return string(encoded)
}

type workIntelEnv struct {
	*captureEnv
	// raw is a second handle on the same isolated test database, for reading
	// the aggregate tables the way a dashboard query would.
	raw    *sql.DB
	fake   *workIntelFake
	worker *WorkIntelWorker
	sent   int
}

// workIntelStores opens the test database and a raw handle on it. PostgreSQL
// uses the per-test schema the store was opened on.
func workIntelStores(tb testing.TB) (*store.SQLStore, *sql.DB) {
	tb.Helper()
	if t, ok := tb.(*testing.T); ok {
		if dsn := os.Getenv("TEST_POSTGRES_DSN"); dsn != "" {
			db := openPostgresTestStore(t, dsn)
			schema := "t" + strings.ToLower(regexp.MustCompile(`[^A-Za-z0-9]`).ReplaceAllString(t.Name(), "_"))
			if len(schema) > 55 {
				schema = schema[:55]
			}
			parsed, err := url.Parse(dsn)
			if err != nil {
				t.Fatal(err)
			}
			query := parsed.Query()
			query.Set("search_path", schema)
			parsed.RawQuery = query.Encode()
			raw, err := sql.Open("pgx", parsed.String())
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = raw.Close() })
			return db, raw
		}
	}
	path := filepath.Join(tb.TempDir(), "gateway.db")
	db, err := store.Open(context.Background(), config.DatabaseConfig{Driver: "sqlite", DSN: path})
	if err != nil {
		tb.Fatal(err)
	}
	if err := db.Migrate(context.Background()); err != nil {
		tb.Fatal(err)
	}
	raw, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(10000)")
	if err != nil {
		tb.Fatal(err)
	}
	tb.Cleanup(func() { _ = raw.Close() })
	return db, raw
}

// The two callers of the tests: one key per team.
const (
	workIntelAlphaKey = "alpha-team-test-key"
	workIntelBetaKey  = "beta-team-test-key"
)

// isolateWorkIntelLogs gives a test its own process-wide logger for as long
// as it runs. The worker logs by design (a failing model, a policy that does
// not compile), and the default logger is shared by every test of the
// package: TestMattermostNotifyLogNeverIncludesWebhookURL leaves the standard
// log output pointing at an eight-slot channel nobody reads any more, so the
// ninth line logged after it blocks its caller forever.
func isolateWorkIntelLogs(t *testing.T) {
	t.Helper()
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
}

func newWorkIntelEnv(t *testing.T) *workIntelEnv {
	t.Helper()
	isolateWorkIntelLogs(t)
	fake := &workIntelFake{}
	upstream := httptest.NewServer(http.HandlerFunc(fake.handle))
	t.Cleanup(upstream.Close)
	db, raw := workIntelStores(t)
	logger := store.NewAsyncLogger(db, 64, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()); db.Close() })
	server, err := NewServer(testConfig(upstream.URL, "s"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	gateway := httptest.NewServer(server.Routes())
	t.Cleanup(gateway.Close)
	env := &workIntelEnv{captureEnv: &captureEnv{url: gateway.URL, db: db, server: server}, raw: raw, fake: fake}
	for _, key := range []store.APIKeyRecord{
		{ID: "key-alpha", Name: "alpha", KeyHash: hashProxyKey(workIntelAlphaKey), Team: "alpha", UserID: "user-a", Status: "active"},
		{ID: "key-beta", Name: "beta", KeyHash: hashProxyKey(workIntelBetaKey), Team: "beta", UserID: "user-b", Status: "active"},
	} {
		if err := env.db.UpsertAPIKey(context.Background(), key); err != nil {
			t.Fatal(err)
		}
	}
	env.worker = NewWorkIntelWorker(env.server)
	t.Cleanup(env.worker.Stop)
	return env
}

// ask sends one chat request through the gateway and waits until it is logged,
// so the next request is ingested after it.
func (e *workIntelEnv) ask(t *testing.T, key, session, prompt string) {
	t.Helper()
	resp, body := e.post(t, "/v1/chat/completions", map[string]any{
		"model":    "test-model",
		"messages": []map[string]string{{"role": "user", "content": prompt}},
	}, "Authorization", "Bearer "+key, "X-Session-ID", session, "User-Agent", "claude-cli/2.1")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("chat request = %d %s", resp.StatusCode, body)
	}
	e.sent++
	e.waitLogged(t, e.sent)
}

func (e *workIntelEnv) waitLogged(t *testing.T, n int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		rows, err := e.db.RecentRequests(context.Background(), store.RequestFilter{Limit: n + 5})
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) >= n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d of %d requests were logged", len(rows), n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (e *workIntelEnv) run(t *testing.T) WorkIntelRunStats {
	t.Helper()
	stats, err := e.worker.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	return stats
}

// useLLM turns the model step on for the test, without the settings API (it
// would refuse a sub-second timeout).
func (e *workIntelEnv) useLLM(mutate func(*workIntelConfig)) {
	conf := e.server.workIntelConf()
	conf.LLMEnabled, conf.LLMModel = true, "judge-model"
	if mutate != nil {
		mutate(&conf)
	}
	e.server.workIntelRuntime.Store(&conf)
}

// facts returns the stored classifications in the order the requests were sent.
func (e *workIntelEnv) facts(t *testing.T) []store.WorkClassification {
	t.Helper()
	rows, err := e.db.RecentRequests(context.Background(), store.RequestFilter{Limit: 500})
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, len(rows))
	for i := len(rows) - 1; i >= 0; i-- {
		ids = append(ids, rows[i].ID)
	}
	facts, err := e.db.WorkClassificationsByID(context.Background(), ids)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]store.WorkClassification{}
	for _, f := range facts {
		byID[f.RequestID] = f
	}
	out := make([]store.WorkClassification, 0, len(facts))
	for _, id := range ids {
		if f, ok := byID[id]; ok {
			out = append(out, f)
		}
	}
	return out
}

// workIntelTables reads the aggregates as text for before/after comparisons.
func (e *workIntelEnv) tables(t *testing.T) string {
	t.Helper()
	ctx := context.Background()
	var b strings.Builder
	facts := e.facts(t)
	ids := make([]string, len(facts))
	for i, f := range facts {
		ids[i] = fmt.Sprintf("%s:%s:%s:%s", f.RequestID, f.CategoryID, f.Method, f.Status)
	}
	fmt.Fprintf(&b, "facts %v\n", ids)
	state, err := e.db.GetWorkIntelState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(&b, "cursor %+v\n", state.Cursor)
	return b.String()
}

const (
	workIntelPromptCode    = "Go로 REST API 핸들러 함수를 구현해줘. 사용자 목록을 반환하는 엔드포인트 코드를 작성해줘"
	workIntelPromptK8s     = "쿠버네티스 파드가 CrashLoopBackOff 상태야. kubectl 로그 보고 원인 분석해줘"
	workIntelPromptSQL     = "지난달 매출 데이터를 SQL로 집계해서 월별 추이를 분석해줘"
	workIntelPromptChat    = "안녕"
	workIntelPromptUnclear = "저번에 얘기한 그거 다시 한번 정리해서 알려줄 수 있을까요"
	workIntelPromptMail    = "고객 kim@example.com 에게 보낼 배송 지연 사과 이메일 초안을 작성해줘"
)

func TestWorkIntelWorkerClassifiesMixedPromptsByRule(t *testing.T) {
	env := newWorkIntelEnv(t)
	ctx := context.Background()
	env.ask(t, workIntelAlphaKey, "sess-a1", workIntelPromptCode)
	env.ask(t, workIntelAlphaKey, "sess-a1", workIntelPromptK8s)
	env.ask(t, workIntelAlphaKey, "sess-a2", workIntelPromptSQL)
	env.ask(t, workIntelBetaKey, "sess-b1", workIntelPromptChat)
	env.ask(t, workIntelBetaKey, "sess-b1", workIntelPromptCode)
	env.ask(t, workIntelBetaKey, "sess-b1", workIntelPromptUnclear)

	stats := env.run(t)
	if stats.Skipped != "" || stats.Read != 6 || stats.Classified != 6 || stats.ByMethod[workintel.MethodRule] != 6 || stats.PolicyVersion != 1 {
		t.Fatalf("first cycle = %+v", stats)
	}
	// The unclear request waits for a model that is not enabled.
	if stats.Pending != 1 || stats.LLMCalls != 0 || env.fake.count() != 0 {
		t.Fatalf("pending=%d llm calls=%d (provider saw %d)", stats.Pending, stats.LLMCalls, env.fake.count())
	}

	facts := env.facts(t)
	if len(facts) != 6 {
		t.Fatalf("%d facts", len(facts))
	}
	want := []struct{ category, top, team, user, status string }{
		{"dev.codegen", "dev", "alpha", "user-a", workintel.StatusClassified},
		{"infra.k8s", "infra", "alpha", "user-a", workintel.StatusClassified},
		{"data.sql", "data", "alpha", "user-a", workintel.StatusClassified},
		{"other.chat", "other", "beta", "user-b", workintel.StatusClassified},
		{"dev.codegen", "dev", "beta", "user-b", workintel.StatusClassified},
		{"other", "other", "beta", "user-b", workintel.StatusUnclassified},
	}
	for i, w := range want {
		f := facts[i]
		if f.CategoryID != w.category || f.TopCategoryID != w.top || f.Team != w.team || f.UserKey != w.user || f.Status != w.status {
			t.Errorf("request %d: category=%s top=%s team=%s user=%s status=%s, want %+v", i, f.CategoryID, f.TopCategoryID, f.Team, f.UserKey, f.Status, w)
		}
		if f.Method != workintel.MethodRule || f.PolicyVersion != 1 || f.Client != "Claude Code" || f.Model != "test-model" ||
			f.SessionKind != workintel.SessionExplicit || f.TokensIn != 11 || f.TokensOut != 7 || f.IsError || f.Day != store.WorkIntelDay(time.Now()) {
			t.Errorf("request %d: %+v", i, f)
		}
		// The title is built from registered names, never from the prompt.
		if f.WorkTitle == "" || strings.Contains(f.WorkTitle, "REST") || strings.Contains(f.WorkTitle, "kubectl") {
			t.Errorf("request %d title = %q", i, f.WorkTitle)
		}
	}
	if !facts[5].NeedsLLM || facts[5].LLMAttempts != 0 || facts[0].NeedsLLM {
		t.Errorf("needs_llm flags: unclear=%v/%d code=%v", facts[5].NeedsLLM, facts[5].LLMAttempts, facts[0].NeedsLLM)
	}

	// The aggregates say the same thing as the facts.
	day := store.WorkIntelDay(time.Now())
	daily := workIntelQuery(t, env, `SELECT team, top_category_id, SUM(requests), SUM(tokens_in), SUM(m_rule), SUM(s_unclassified)
		FROM work_daily WHERE day = '`+day+`' GROUP BY team, top_category_id ORDER BY team, top_category_id`)
	wantDaily := []string{"alpha|data|1|11|1|0", "alpha|dev|1|11|1|0", "alpha|infra|1|11|1|0", "beta|dev|1|11|1|0", "beta|other|2|22|2|1"}
	if !reflect.DeepEqual(daily, wantDaily) {
		t.Errorf("work_daily = %v, want %v", daily, wantDaily)
	}
	sessions := workIntelQuery(t, env, `SELECT session_id, team, requests, category_counts, completion FROM work_sessions ORDER BY session_id`)
	wantSessions := []string{
		`sess-a1|alpha|2|{"dev.codegen":1,"infra.k8s":1}|unknown`,
		`sess-a2|alpha|1|{"data.sql":1}|unknown`,
		`sess-b1|beta|3|{"dev.codegen":1,"other":1,"other.chat":1}|unknown`,
	}
	if !reflect.DeepEqual(sessions, wantSessions) {
		t.Errorf("work_sessions = %v, want %v", sessions, wantSessions)
	}
	if n := workIntelQuery(t, env, `SELECT COUNT(DISTINCT session_id) FROM work_session_segments WHERE top_category_id = 'dev'`); !reflect.DeepEqual(n, []string{"2"}) {
		t.Errorf("work sessions of dev = %v, want 2", n)
	}
	if users := workIntelQuery(t, env, `SELECT COUNT(*) FROM work_daily_users`); !reflect.DeepEqual(users, []string{"6"}) {
		t.Errorf("daily user rows = %v", users)
	}

	// A second cycle finds nothing to do and changes nothing.
	before := env.tables(t) + strings.Join(daily, ";") + strings.Join(sessions, ";")
	again := env.run(t)
	if again.Skipped != "" || again.Read != 0 || again.Classified != 0 || again.Backlog != 0 {
		t.Fatalf("second cycle = %+v", again)
	}
	after := env.tables(t) + strings.Join(workIntelQuery(t, env, `SELECT team, top_category_id, SUM(requests), SUM(tokens_in), SUM(m_rule), SUM(s_unclassified)
		FROM work_daily WHERE day = '`+day+`' GROUP BY team, top_category_id ORDER BY team, top_category_id`), ";") +
		strings.Join(workIntelQuery(t, env, `SELECT session_id, team, requests, category_counts, completion FROM work_sessions ORDER BY session_id`), ";")
	if before != after {
		t.Fatalf("an idle cycle changed the state\nbefore: %s\nafter:  %s", before, after)
	}

	// New requests are picked up from where the cursor stopped.
	env.ask(t, workIntelAlphaKey, "sess-a1", workIntelPromptSQL)
	if third := env.run(t); third.Read != 1 || third.Classified != 1 {
		t.Fatalf("third cycle = %+v", third)
	}
	if got := workIntelQuery(t, env, `SELECT requests, model_switches FROM work_sessions WHERE session_id = 'sess-a1'`); !reflect.DeepEqual(got, []string{"3|0"}) {
		t.Errorf("sess-a1 after the third request = %v", got)
	}

	status, err := env.server.workIntelStatus(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !status.ClassifyEnabled || status.LLMEnabled || !status.WorkerActive || status.PolicyVersion != 1 || status.ProcessedTotal != 7 ||
		status.Processed24h != 7 || status.ByMethod[workintel.MethodRule] != 7 || status.Backlog != 0 || status.LastRunAt == "" ||
		status.CursorAt == "" || status.LastError != "" || status.LastBatchSize != 1 {
		t.Fatalf("status = %+v", status)
	}
}

// workIntelQuery runs a read on the raw handle and returns each row as its
// values joined by "|".
func workIntelQuery(t *testing.T, env *workIntelEnv, query string) []string {
	t.Helper()
	rows, err := env.raw.QueryContext(context.Background(), query)
	if err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	out := []string{}
	for rows.Next() {
		values := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range values {
			ptrs[i] = &values[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			t.Fatal(err)
		}
		parts := make([]string, len(cols))
		for i, v := range values {
			if raw, ok := v.([]byte); ok {
				parts[i] = string(raw)
			} else {
				parts[i] = fmt.Sprint(v)
			}
		}
		out = append(out, strings.Join(parts, "|"))
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestWorkIntelWorkerDisabledBySettingDoesNothing(t *testing.T) {
	env := newWorkIntelEnv(t)
	ctx := context.Background()
	env.ask(t, workIntelAlphaKey, "s1", workIntelPromptCode)

	// The setting is changed the way an administrator changes it, and applies
	// without a restart.
	putSetting(t, env.url, workIntelClassifyEnabledKey, "false")
	stats := env.run(t)
	if stats.Skipped != workIntelSkipDisabled || stats.Read != 0 {
		t.Fatalf("disabled cycle = %+v", stats)
	}
	if facts := env.facts(t); len(facts) != 0 {
		t.Fatalf("%d facts were written while disabled", len(facts))
	}
	state, err := env.db.GetWorkIntelState(ctx)
	if err != nil || state.Cursor.IngestedAt != "" || state.WorkerToken != "" {
		t.Fatalf("state while disabled = %+v, %v", state, err)
	}
	if status, _ := env.server.workIntelStatus(ctx); status.ClassifyEnabled || status.WorkerActive {
		t.Fatalf("status while disabled = %+v", status)
	}

	putSetting(t, env.url, workIntelClassifyEnabledKey, "true")
	if stats := env.run(t); stats.Classified != 1 {
		t.Fatalf("after enabling = %+v", stats)
	}
}

// The request path must not know work intelligence exists: a request is
// answered and logged without one work-intel row being read or written.
func TestWorkIntelStaysOffTheRequestPath(t *testing.T) {
	env := newWorkIntelEnv(t)
	for i := 0; i < 5; i++ {
		env.ask(t, workIntelAlphaKey, "s1", workIntelPromptCode)
	}
	for _, table := range []string{"work_classifications", "work_daily", "work_daily_users", "work_sessions", "work_session_segments",
		"work_class_cache", "work_intel_state", "work_intel_policy", "work_intel_policy_versions", "work_intel_dirty"} {
		if n := workIntelQuery(t, env, `SELECT COUNT(*) FROM `+table); !reflect.DeepEqual(n, []string{"0"}) {
			t.Errorf("%s has %v rows after requests alone; the request path wrote to it", table, n)
		}
	}
	if stats := env.run(t); stats.Classified != 5 {
		t.Fatalf("cycle = %+v", stats)
	}

	// And statically: outside the work-intel files, nothing in the proxy
	// calls the work-intel store API or imports the engine.
	storeCall := regexp.MustCompile(`\.db\.\w*Work(Intel|Polic|Class|Days|Session|MethodAccuracy|Correction)\w*\(`)
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") || strings.HasPrefix(file, "work_intel") {
			continue
		}
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		checked++
		if loc := storeCall.Find(raw); loc != nil {
			t.Errorf("%s calls the work-intel store (%s); only work_intel*.go may", file, loc)
		}
		if bytes.Contains(raw, []byte(`"vibe-coders/internal/workintel"`)) {
			t.Errorf("%s imports the classification engine; only work_intel*.go may", file)
		}
	}
	if checked < 100 {
		t.Fatalf("only %d source files were checked", checked)
	}
}

func TestWorkIntelWorkerLLMClassifiesRedactsAndCaches(t *testing.T) {
	env := newWorkIntelEnv(t)
	ctx := context.Background()
	env.useLLM(nil)
	// The model copies an address and a phone number out of the prompt.
	env.fake.set(func(string) (string, time.Duration) {
		return workIntelAnswer("office", "office.email", "kim@example.com 고객 사과 메일 작성", []string{"배송 지연", "010-1234-5678"}, 0.9), 0
	})

	env.ask(t, workIntelAlphaKey, "s1", workIntelPromptMail)
	stats := env.run(t)
	if stats.LLMCalls != 1 || stats.LLMFailures != 0 || stats.ByMethod[workintel.MethodLLM] != 1 || stats.Pending != 0 || stats.LLMTokens != 150 {
		t.Fatalf("cycle = %+v", stats)
	}
	// What was sent is the stored, redacted prompt.
	if sent := env.fake.lastBody(); !strings.Contains(sent, "[REDACTED_EMAIL]") || strings.Contains(sent, "kim@example.com") || !strings.Contains(sent, "office.email") {
		t.Fatalf("classification request = %s", sent)
	}
	fact := env.facts(t)[0]
	if fact.Method != workintel.MethodLLM || fact.CategoryID != "office.email" || fact.TopCategoryID != "office" || fact.ClassifierModel != "judge-model" ||
		fact.Confidence != 0.9 || fact.Status != workintel.StatusClassified || fact.NeedsLLM || fact.ActionType != "create" {
		t.Fatalf("fact = %+v", fact)
	}
	// What the model wrote is redacted again before it is stored.
	if fact.WorkTitle != "[REDACTED_EMAIL] 고객 사과 메일 작성" {
		t.Errorf("title = %q", fact.WorkTitle)
	}
	stored := strings.Join(fact.Tags, ",") + fact.WorkTitle
	if strings.Contains(stored, "kim@example.com") || strings.Contains(stored, "010-1234-5678") || !strings.Contains(stored, "[REDACTED_PHONE_KR]") || !strings.Contains(stored, "배송 지연") {
		t.Errorf("stored labels = %q", stored)
	}

	// The same prompt from the same team is answered from the cache.
	env.ask(t, workIntelAlphaKey, "s2", workIntelPromptMail)
	stats = env.run(t)
	if stats.LLMCalls != 0 || stats.CacheHits != 1 || stats.ByMethod[workintel.MethodCache] != 1 || env.fake.count() != 1 {
		t.Fatalf("cached cycle = %+v (provider calls %d)", stats, env.fake.count())
	}
	cached := env.facts(t)[1]
	if cached.Method != workintel.MethodCache || cached.CategoryID != "office.email" || cached.WorkTitle != fact.WorkTitle || cached.ClassifierModel != "judge-model" || cached.NeedsLLM {
		t.Fatalf("cached fact = %+v", cached)
	}
	// Another team's identical prompt is not: the cache is per team.
	env.ask(t, workIntelBetaKey, "s3", workIntelPromptMail)
	stats = env.run(t)
	if stats.LLMCalls != 1 || stats.CacheHits != 0 || env.fake.count() != 2 {
		t.Fatalf("other team's cycle = %+v (provider calls %d)", stats, env.fake.count())
	}
	// Two identical requests in one batch cost one call.
	env.ask(t, workIntelBetaKey, "s4", workIntelPromptUnclear)
	env.ask(t, workIntelBetaKey, "s4", workIntelPromptUnclear)
	stats = env.run(t)
	if stats.Read != 2 || stats.LLMCalls != 1 || stats.ByMethod[workintel.MethodLLM] != 2 || env.fake.count() != 3 {
		t.Fatalf("duplicate prompts in one batch = %+v (provider calls %d)", stats, env.fake.count())
	}

	entries := workIntelQuery(t, env, `SELECT team, policy_version, category_id, hits, classifier_model FROM work_class_cache ORDER BY team, category_id, hits`)
	if !reflect.DeepEqual(entries, []string{"alpha|1|office.email|1|judge-model", "beta|1|office.email|0|judge-model", "beta|1|office.email|0|judge-model"}) {
		t.Errorf("cache entries = %v", entries)
	}
	// Three calls classified four requests; one more came from the cache.
	if got := workIntelQuery(t, env, `SELECT SUM(m_llm), SUM(m_cache), SUM(m_rule) FROM work_daily`); !reflect.DeepEqual(got, []string{"4|1|0"}) {
		t.Errorf("method counters = %v", got)
	}
	status, err := env.server.workIntelStatus(ctx)
	if err != nil || status.LLMCalls24h != 3 || status.CacheHits24h != 1 || status.LLMTokens24h != 450 || status.Failures24h != 0 || !status.LLMEnabled || status.LLMModel != "judge-model" {
		t.Fatalf("status = %+v, %v", status, err)
	}
	metrics := env.server.workIntelMetrics()
	for _, want := range []string{
		`proxy_work_intel_processed_total{method="llm"} 4`, `proxy_work_intel_processed_total{method="cache"} 1`,
		"proxy_work_intel_llm_calls_total 3", "proxy_work_intel_cache_hits_total 1", "proxy_work_intel_failures_total 0",
		"proxy_work_intel_backlog 0", "proxy_work_intel_batch_seconds_count 4",
	} {
		if !strings.Contains(metrics, want) {
			t.Errorf("metrics miss %q in:\n%s", want, metrics)
		}
	}
}

// A model that answers badly, or not at all, costs nothing but the semantic
// result: the cycle succeeds, the request keeps its rule result, the attempt
// is counted, and a later cycle tries again.
func TestWorkIntelWorkerLLMFailuresFallBackAndRetry(t *testing.T) {
	env := newWorkIntelEnv(t)
	ctx := context.Background()
	env.useLLM(func(c *workIntelConfig) { c.LLMTimeout = 150 * time.Millisecond })
	// No pause between attempts, so three cycles show all of them.
	env.worker.retryBackoff = 0

	// 1. Not JSON.
	env.fake.set(func(string) (string, time.Duration) { return "죄송하지만 분류할 수 없습니다.", 0 })
	env.ask(t, workIntelAlphaKey, "s1", workIntelPromptUnclear)
	stats := env.run(t)
	if stats.LLMCalls != 1 || stats.LLMFailures != 1 || stats.Classified != 1 || stats.ByMethod[workintel.MethodRule] != 1 || stats.Pending != 1 {
		t.Fatalf("invalid answer cycle = %+v", stats)
	}
	fact := env.facts(t)[0]
	if fact.Method != workintel.MethodRule || fact.CategoryID != "other" || fact.Status != workintel.StatusUnclassified || !fact.NeedsLLM || fact.LLMAttempts != 1 {
		t.Fatalf("fact after an invalid answer = %+v", fact)
	}

	// 2. The model does not answer in time. The retry of the first request
	// and the new request both time out; the cycle is bounded and succeeds.
	env.fake.set(func(string) (string, time.Duration) { return "", 5 * time.Second })
	env.ask(t, workIntelAlphaKey, "s1", workIntelPromptMail)
	started := time.Now()
	stats = env.run(t)
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("a slow model stalled the cycle for %s", elapsed)
	}
	if stats.Classified != 1 || stats.LLMFailures != 2 || stats.Retried != 1 || stats.RetrySucceeded != 0 {
		t.Fatalf("timeout cycle = %+v", stats)
	}
	facts := env.facts(t)
	if facts[0].LLMAttempts != 2 || !facts[0].NeedsLLM || facts[1].LLMAttempts != 1 || !facts[1].NeedsLLM || facts[1].Method != workintel.MethodRule || facts[1].CategoryID != "office.email" {
		t.Fatalf("facts after timeouts = %+v", facts)
	}
	status, err := env.server.workIntelStatus(ctx)
	if err != nil || status.Failures24h != 3 || !strings.Contains(status.LastError, governanceRunErrTimeout) || status.ProcessedTotal != 2 {
		t.Fatalf("status = %+v, %v", status, err)
	}

	// 3. The model recovers. The next cycle retries both and reassigns them;
	// the aggregates follow at the rebuild.
	env.fake.set(func(body string) (string, time.Duration) {
		if strings.Contains(body, "사과 이메일") {
			return workIntelAnswer("office", "office.email", "사과 메일 작성", nil, 0.92), 0
		}
		// A category nobody registered: kept as a hint, not as a category.
		return workIntelAnswer("finance", "finance.tax", "세무 문의", nil, 0.95), 0
	})
	env.worker.rebuiltAt = time.Time{}
	stats = env.run(t)
	if stats.Read != 0 || stats.Retried != 2 || stats.RetrySucceeded != 2 || stats.LLMFailures != 0 || stats.LLMCalls != 2 || stats.RebuiltDays != 1 {
		t.Fatalf("recovery cycle = %+v", stats)
	}
	facts = env.facts(t)
	if f := facts[1]; f.Method != workintel.MethodLLM || f.CategoryID != "office.email" || f.NeedsLLM || f.WorkTitle != "사과 메일 작성" || f.LLMAttempts != 1 {
		t.Fatalf("mail fact after recovery = %+v", f)
	}
	if f := facts[0]; f.Method != workintel.MethodLLM || f.CategoryID != "other" || f.NewCategoryHint != "finance.tax" || f.Status != workintel.StatusReview || f.NeedsLLM {
		t.Fatalf("unregistered-category fact = %+v", f)
	}
	day := store.WorkIntelDay(time.Now())
	if got := workIntelQuery(t, env, `SELECT category_id, requests, m_rule, m_llm, s_review, s_unclassified FROM work_daily WHERE day = '`+day+`' ORDER BY category_id`); !reflect.DeepEqual(got, []string{"office.email|1|0|1|0|0", "other|1|0|1|1|0"}) {
		t.Errorf("work_daily after the retry = %v", got)
	}
	if dirtyDays, dirtySessions, _ := env.db.WorkIntelDirty(ctx, 10); len(dirtyDays)+len(dirtySessions) != 0 {
		t.Errorf("stale marks left: %v %v", dirtyDays, dirtySessions)
	}
	// Nothing is left to retry.
	if stats = env.run(t); stats.Retried != 0 || stats.LLMCalls != 0 {
		t.Fatalf("idle cycle after recovery = %+v", stats)
	}
}

// A request that keeps failing is given up after three attempts, and the
// per-minute cap leaves what it cannot serve pending without counting it as
// a failure.
func TestWorkIntelWorkerLLMLimits(t *testing.T) {
	env := newWorkIntelEnv(t)
	env.useLLM(func(c *workIntelConfig) { c.LLMMaxPerMinute = 2 })
	env.fake.set(func(string) (string, time.Duration) { return "{not json", 0 })

	env.ask(t, workIntelAlphaKey, "s1", workIntelPromptUnclear)
	env.ask(t, workIntelAlphaKey, "s2", workIntelPromptMail)
	env.ask(t, workIntelAlphaKey, "s3", "우리 팀 분기 목표를 어떻게 잡으면 좋을지 같이 고민해 보자")
	stats := env.run(t)
	// Two calls are allowed this minute; the third request is not asked.
	if stats.LLMCalls != 2 || stats.LLMFailures != 2 || stats.Pending != 3 || env.fake.count() != 2 {
		t.Fatalf("capped cycle = %+v (provider calls %d)", stats, env.fake.count())
	}
	facts := env.facts(t)
	if facts[0].LLMAttempts != 1 || facts[1].LLMAttempts != 1 || facts[2].LLMAttempts != 0 || !facts[2].NeedsLLM {
		t.Fatalf("attempts = %d %d %d", facts[0].LLMAttempts, facts[1].LLMAttempts, facts[2].LLMAttempts)
	}
	// With the minute's allowance used up, the next cycle calls nothing.
	if stats = env.run(t); stats.LLMCalls != 0 || env.fake.count() != 2 {
		t.Fatalf("cycle over the cap = %+v", stats)
	}

	// A failed request waits before its next attempt.
	env.useLLM(func(c *workIntelConfig) { c.LLMMaxPerMinute = 1000 })
	env.server.workIntel.llmBudget.reset()
	if stats = env.run(t); stats.Retried != 1 || env.fake.count() != 3 {
		t.Fatalf("inside the backoff only the untried request is retried: %+v (provider calls %d)", stats, env.fake.count())
	}
	// Without the pause, and without the breaker that would stop the calls
	// after five failures in a row, every request stops at three attempts.
	env.worker.retryBackoff, env.worker.breakerAfter = 0, 0
	for i := 0; i < 5; i++ {
		env.run(t)
	}
	for i, f := range env.facts(t) {
		if f.LLMAttempts != workIntelMaxLLMAttempts || !f.NeedsLLM || f.Method != workintel.MethodRule {
			t.Errorf("request %d after repeated failures: attempts=%d needs_llm=%v method=%s", i, f.LLMAttempts, f.NeedsLLM, f.Method)
		}
	}
	calls := env.fake.count()
	if stats = env.run(t); stats.Retried != 0 || env.fake.count() != calls {
		t.Fatalf("a request was retried after its last attempt: %+v", stats)
	}
}

// A model that fails call after call is left alone for a while, and the
// requests of that time keep all their attempts.
func TestWorkIntelWorkerPausesAFailingModel(t *testing.T) {
	env := newWorkIntelEnv(t)
	ctx := context.Background()
	env.useLLM(func(c *workIntelConfig) { c.LLMConcurrency = 1 })
	env.fake.set(func(string) (string, time.Duration) { return "nonsense", 0 })
	prompts := []string{workIntelPromptUnclear, workIntelPromptMail, "우리 팀 분기 목표를 어떻게 잡으면 좋을지 같이 고민해 보자",
		"블루그린 방식으로 넘어가는 절차를 순서대로 알려줘", "이 문서 내용을 세 줄로 요약해줘"}
	for i, prompt := range prompts {
		env.ask(t, workIntelAlphaKey, fmt.Sprintf("s%d", i), prompt)
	}
	stats := env.run(t)
	if stats.LLMCalls != workIntelLLMBreakerFailures || stats.LLMFailures != workIntelLLMBreakerFailures {
		t.Fatalf("failing cycle = %+v", stats)
	}
	// The next requests are not sent to the model at all.
	env.ask(t, workIntelAlphaKey, "s9", "저번 회의에서 나온 그 얘기 다시 한번 풀어서 설명해 줄 수 있을까요")
	stats = env.run(t)
	if stats.LLMBlocked != workIntelLLMBlockedPaused || stats.LLMCalls != 0 || stats.Classified != 1 || env.fake.count() != workIntelLLMBreakerFailures {
		t.Fatalf("paused cycle = %+v (provider calls %d)", stats, env.fake.count())
	}
	facts := env.facts(t)
	if last := facts[len(facts)-1]; !last.NeedsLLM || last.LLMAttempts != 0 || last.Method != workintel.MethodRule {
		t.Fatalf("a request stored during the pause = %+v", last)
	}
	if status, err := env.server.workIntelStatus(ctx); err != nil || status.LLMBlockedCode != workIntelLLMBlockedPaused || status.LLMBlockedReason == "" {
		t.Fatalf("status during the pause = %+v, %v", status, err)
	}
	// When the pause is over and the model answers, the waiting request is classified.
	env.worker.llmPaused = time.Time{}
	env.fake.set(func(string) (string, time.Duration) {
		return workIntelAnswer("knowledge", "", "회의 내용 설명", nil, 0.9), 0
	})
	stats = env.run(t)
	if stats.LLMBlocked != "" || stats.RetrySucceeded != 1 {
		t.Fatalf("cycle after the pause = %+v", stats)
	}
	facts = env.facts(t)
	if last := facts[len(facts)-1]; last.Method != workintel.MethodLLM || last.CategoryID != "knowledge" || last.NeedsLLM {
		t.Fatalf("the waiting request after the pause = %+v", last)
	}
}

// What the model wrote also goes through the DLP profiles of the enabled
// policies, and its confidence is scaled by how often the method was right
// when administrators checked.
func TestWorkIntelWorkerAppliesDLPRedactionAndCalibration(t *testing.T) {
	env := newWorkIntelEnv(t)
	ctx := context.Background()
	cfg := dlp.DefaultConfig()
	cfg.Enabled = true
	cfg.CustomProfiles = []dlp.CustomProfile{{
		ID: "project-codenames", Name: "프로젝트 코드명", MinConfidence: "low",
		Entries: []dlp.CustomEntry{{ID: "codename", Name: "코드명", Type: "keywords", Keywords: []string{"오로라 프로젝트"}}},
	}}
	// A response-side policy: the prompt itself is not touched, so only the
	// re-check of the model's labels can hide the codename.
	cfg.Policies = []dlp.Policy{{ID: "flag-codenames", Enabled: true, Action: dlp.ActionFlag, Profiles: []string{"project-codenames"}, Check: []dlp.Check{dlp.CheckResponse}}}
	encoded, _ := json.Marshal(cfg)
	if _, err := env.db.SaveDLPSettings(ctx, string(encoded), 0, "admin"); err != nil {
		t.Fatal(err)
	}
	// Forty checked results of the model, half of them right.
	corrections := make([]store.WorkCorrection, 0, 40)
	for i := 0; i < 40; i++ {
		to := "office.email"
		if i%2 == 0 {
			to = "support"
		}
		corrections = append(corrections, store.WorkCorrection{RequestID: fmt.Sprintf("checked-%d", i), FromCategoryID: "office.email", ToCategoryID: to, FromMethod: workintel.MethodLLM, Actor: "admin"})
	}
	if err := env.db.InsertWorkCorrections(ctx, corrections); err != nil {
		t.Fatal(err)
	}
	env.useLLM(nil)
	env.fake.set(func(string) (string, time.Duration) {
		return workIntelAnswer("office", "office.email", "오로라 프로젝트 일정 안내 메일", []string{"오로라 프로젝트", "일정"}, 0.9), 0
	})

	env.ask(t, workIntelAlphaKey, "s1", workIntelPromptMail)
	if stats := env.run(t); stats.LLMCalls != 1 || stats.ByMethod[workintel.MethodLLM] != 1 {
		t.Fatalf("cycle = %+v", stats)
	}
	fact := env.facts(t)[0]
	labels := fact.WorkTitle + "," + strings.Join(fact.Tags, ",")
	if strings.Contains(labels, "오로라") || !strings.Contains(labels, "일정") || fact.WorkTitle == "" {
		t.Errorf("labels after DLP redaction = %q", labels)
	}
	// 0.9 as reported, times 20 right out of 40: below the review threshold.
	if fact.Confidence != 0.45 || fact.Status != workintel.StatusReview || fact.Method != workintel.MethodLLM || fact.CategoryID != "office.email" {
		t.Errorf("calibrated fact: confidence=%v status=%s method=%s category=%s", fact.Confidence, fact.Status, fact.Method, fact.CategoryID)
	}
	if got := workIntelQuery(t, env, `SELECT conf_b0, s_review, m_llm FROM work_daily`); !reflect.DeepEqual(got, []string{"1|1|1"}) {
		t.Errorf("work_daily = %v", got)
	}
}

type workIntelRewriteTransport struct {
	host   string
	target *url.URL
	base   http.RoundTripper
	seen   *int
}

func (rt workIntelRewriteTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Host == rt.host {
		*rt.seen++
		clone := r.Clone(r.Context())
		clone.URL.Scheme, clone.URL.Host, clone.Host = rt.target.Scheme, rt.target.Host, rt.target.Host
		return rt.base.RoundTrip(clone)
	}
	return rt.base.RoundTrip(r)
}

func TestWorkIntelWorkerRefusesExternalProviderUnlessAllowed(t *testing.T) {
	env := newWorkIntelEnv(t)
	ctx := context.Background()
	encrypted, err := env.server.secrets.Load().Encrypt("external-provider-credential")
	if err != nil {
		t.Fatal(err)
	}
	if err := env.db.UpsertProvider(ctx, store.ProviderConfig{Name: "outside", BaseURL: "https://llm.vendor.example.com", EncryptedAPIKey: encrypted, Enabled: true}); err != nil {
		t.Fatal(err)
	}
	// Anything addressed to the external host is counted and served by the fake.
	target, _ := url.Parse(env.server.cfg.Upstream.BaseURL)
	external := 0
	env.server.client = &http.Client{Transport: workIntelRewriteTransport{host: "llm.vendor.example.com", target: target, base: http.DefaultTransport, seen: &external}}
	env.fake.set(func(string) (string, time.Duration) {
		return workIntelAnswer("office", "office.email", "사과 메일", nil, 0.9), 0
	})
	env.useLLM(func(c *workIntelConfig) { c.LLMProvider = "outside" })

	env.ask(t, workIntelAlphaKey, "s1", workIntelPromptMail)
	stats := env.run(t)
	if stats.LLMBlocked != workIntelLLMBlockedExternal || stats.LLMCalls != 0 || external != 0 || env.fake.count() != 0 || stats.Classified != 1 {
		t.Fatalf("cycle with an external provider = %+v (requests to it: %d)", stats, external)
	}
	fact := env.facts(t)[0]
	if fact.Method != workintel.MethodRule || !fact.NeedsLLM || fact.LLMAttempts != 0 {
		t.Fatalf("fact = %+v", fact)
	}
	status, err := env.server.workIntelStatus(ctx)
	if err != nil || status.LLMBlockedCode != workIntelLLMBlockedExternal || !strings.Contains(status.LLMBlockedReason, "llm.vendor.example.com") ||
		!strings.Contains(status.LLMBlockedReason, "work_intel.llm_allow_external") || status.LLMExternalAllowed {
		t.Fatalf("status = %+v, %v", status, err)
	}

	// Allowed explicitly, the same provider is used, and the waiting request
	// is classified by the retry.
	env.useLLM(func(c *workIntelConfig) { c.LLMProvider, c.LLMAllowExternal = "outside", true })
	stats = env.run(t)
	if stats.LLMBlocked != "" || stats.LLMCalls != 1 || stats.RetrySucceeded != 1 || external != 1 {
		t.Fatalf("cycle after allowing = %+v (requests to it: %d)", stats, external)
	}
	if fact = env.facts(t)[0]; fact.Method != workintel.MethodLLM || fact.CategoryID != "office.email" {
		t.Fatalf("fact after allowing = %+v", fact)
	}
	if status, _ = env.server.workIntelStatus(ctx); status.LLMBlockedCode != "" || status.LLMBlockedReason != "" || !status.LLMExternalAllowed {
		t.Fatalf("status after allowing = %+v", status)
	}

	// Without a model, or with a provider that does not exist, nothing is sent
	// and the reason says so.
	env.useLLM(func(c *workIntelConfig) { c.LLMModel = "" })
	if stats = env.run(t); stats.LLMBlocked != workIntelLLMBlockedModel {
		t.Fatalf("cycle without a model = %+v", stats)
	}
	env.useLLM(func(c *workIntelConfig) { c.LLMProvider = "no-such-provider" })
	if stats = env.run(t); stats.LLMBlocked != workIntelLLMBlockedProvider {
		t.Fatalf("cycle with an unknown provider = %+v", stats)
	}
}

func TestWorkIntelProviderInternal(t *testing.T) {
	for address, want := range map[string]bool{
		"http://127.0.0.1:8000":                   true,
		"http://localhost:11434/v1":               true,
		"http://[::1]:8000":                       true,
		"http://10.20.30.40:8000":                 true,
		"http://172.16.5.4":                       true,
		"http://192.168.0.10:8080":                true,
		"http://169.254.10.10":                    true,
		"http://[fd12:3456::1]:8000":              true,
		"http://vllm:8000":                        true,
		"http://llm.corp.internal":                true,
		"http://gpu01.local:8000":                 true,
		"http://vllm.ai.svc:8000":                 true,
		"http://vllm.ai.svc.cluster.local:8000":   true,
		"https://api.openai.com/v1":               false,
		"https://llm.vendor.example.com":          false,
		"http://8.8.8.8":                          false,
		"http://172.32.0.1":                       false,
		"https://internal.example.com":            false,
		"https://svc.example.com":                 false,
		"https://example.internal.attacker.com":   false,
		"":                                        false,
		"://bad":                                  false,
		"https://[2001:4860:4860::8888]":          false,
		"http://localhost.attacker.com":           false,
		"http://user:pass@10.0.0.1:8000/v1":       true,
		"http://user:pass@api.vendor.example.com": false,
	} {
		if got, host := workIntelProviderInternal(address); got != want {
			t.Errorf("%q (host %q) internal = %v, want %v", address, host, got, want)
		}
	}
}

func TestWorkIntelLeaseAllowsOneWorker(t *testing.T) {
	env := newWorkIntelEnv(t)
	ctx := context.Background()
	second := NewWorkIntelWorker(env.server)
	t.Cleanup(second.Stop)
	env.ask(t, workIntelAlphaKey, "s1", workIntelPromptCode)

	if stats := env.run(t); stats.Classified != 1 {
		t.Fatalf("first worker = %+v", stats)
	}
	env.ask(t, workIntelAlphaKey, "s1", workIntelPromptK8s)
	stats, err := second.RunOnce(ctx)
	if err != nil || stats.Skipped != workIntelSkipLeaseHeld || stats.Read != 0 {
		t.Fatalf("second worker = %+v, %v", stats, err)
	}
	if len(env.facts(t)) != 1 {
		t.Fatal("a worker without the lease classified a request")
	}
	// The backlog is still visible on the instance that is not the worker.
	if stats.Backlog != 1 {
		t.Errorf("backlog seen by the idle worker = %d", stats.Backlog)
	}
	// The first worker stops and hands the lease over.
	env.worker.Stop()
	stats, err = second.RunOnce(ctx)
	if err != nil || stats.Skipped != "" || stats.Classified != 1 {
		t.Fatalf("second worker after the first stopped = %+v, %v", stats, err)
	}
	// It continues the first worker's totals.
	if status, _ := env.server.workIntelStatus(ctx); status.ProcessedTotal != 2 || !status.WorkerActive {
		t.Fatalf("status after the handover = %+v", status)
	}
}

// The first run starts work_intel.backfill_days back, not at the beginning of
// the log, and the loop keeps going on its own from there.
func TestWorkIntelWorkerStartsAtBackfillWindowAndRunsInLoop(t *testing.T) {
	env := newWorkIntelEnv(t)
	ctx := context.Background()
	for _, id := range []string{"old-request", "new-request"} {
		if err := env.db.InsertLogRecord(ctx, store.LogRecord{
			Request: store.RequestLog{ID: id, TraceID: id, APIKeyID: "key-alpha", Model: "m", Provider: "p", Endpoint: "/v1/chat/completions",
				StatusCode: 200, SessionID: "s", CreatedAt: time.Now().UTC()},
			Prompts: []store.PromptLog{{ID: "p-" + id, RequestID: id, Role: "user", RedactedText: workIntelPromptCode, CreatedAt: time.Now().UTC()}},
		}); err != nil {
			t.Fatal(err)
		}
	}
	// One of them was logged a month ago, in the layout the log writer uses.
	monthAgo := time.Now().UTC().AddDate(0, 0, -30).Format("2006-01-02T15:04:05.000000000Z")
	if _, err := env.raw.ExecContext(ctx, `UPDATE request_logs SET ingested_at = '`+monthAgo+`' WHERE id = 'old-request'`); err != nil {
		t.Fatal(err)
	}

	conf := env.server.workIntelConf()
	conf.Interval = 20 * time.Millisecond
	env.server.workIntelRuntime.Store(&conf)
	loopCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	env.worker.Start(loopCtx)
	deadline := time.Now().Add(10 * time.Second)
	for {
		facts, err := env.db.WorkClassificationsByID(ctx, []string{"new-request"})
		if err != nil {
			t.Fatal(err)
		}
		if len(facts) == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the loop did not classify the request")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// A request logged while the loop runs is picked up without anyone asking.
	env.ask(t, workIntelAlphaKey, "s", workIntelPromptK8s)
	for {
		if facts := env.facts(t); len(facts) == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the loop did not pick up a new request")
		}
		time.Sleep(10 * time.Millisecond)
	}
	env.worker.Stop()
	env.worker.Stop() // idempotent

	if facts, _ := env.db.WorkClassificationsByID(ctx, []string{"old-request"}); len(facts) != 0 {
		t.Fatal("a request logged before the backfill window was classified")
	}
	state, err := env.db.GetWorkIntelState(ctx)
	if err != nil || state.WorkerToken != "" || state.Cursor.IngestedAt == "" {
		t.Fatalf("state after stop = %+v, %v", state, err)
	}
	// The periodic step ran and recorded when.
	if state.PeriodicAt == "" {
		t.Error("the periodic step did not record its run")
	}
}

func TestWorkIntelSettingsAreRegisteredAndReloaded(t *testing.T) {
	env := newWorkIntelEnv(t)
	def := defaultWorkIntelConfig()
	if got := env.server.workIntelConf(); got != def {
		t.Fatalf("defaults = %+v, want %+v", got, def)
	}
	if !def.ClassifyEnabled || !def.AnalyticsEnabled || def.LLMEnabled || def.LLMAllowExternal || def.Interval != 15*time.Second || def.BatchSize != 200 ||
		def.BackfillDays != 7 || def.LLMConcurrency != 2 || def.LLMMaxPerMinute != 60 || def.LLMTimeout != 20*time.Second ||
		!def.InsightEnabled || def.InsightInterval != 6*time.Hour || def.InsightLLMEnabled || def.RetentionDays != 400 {
		t.Fatalf("defaults differ from the design: %+v", def)
	}
	keys := 0
	for _, d := range settingRegistry {
		if !strings.HasPrefix(d.Key, "work_intel.") {
			continue
		}
		keys++
		if d.Category != "업무 활용 분석" || d.ReadOnly || d.Secret || d.Restart {
			t.Errorf("%s: %+v", d.Key, d)
		}
		// The environment variable name is in the help text, so a search for
		// WORK_INTEL finds every key.
		if !strings.Contains(settingDescriptions[d.Key], "WORK_INTEL_") {
			t.Errorf("%s: description does not name its environment variable", d.Key)
		}
	}
	if keys != 16 {
		t.Fatalf("%d work_intel settings registered, want 16", keys)
	}

	// Saved through the settings API, the value is in effect at once.
	putSetting(t, env.url, workIntelBatchSizeKey, "50")
	putSetting(t, env.url, workIntelIntervalKey, "30s")
	putSetting(t, env.url, workIntelLLMEnabledKey, "true")
	putSetting(t, env.url, workIntelLLMModelKey, "small-judge")
	putSetting(t, env.url, workIntelRetentionDaysKey, "0")
	got := env.server.workIntelConf()
	if got.BatchSize != 50 || got.Interval != 30*time.Second || !got.LLMEnabled || got.LLMModel != "small-judge" || got.RetentionDays != 0 || got.LLMConcurrency != 2 {
		t.Fatalf("after saving = %+v", got)
	}
	// Out-of-range values are refused.
	for key, value := range map[string]string{
		workIntelBatchSizeKey: "0", workIntelIntervalKey: "10ms", workIntelLLMConcurrencyKey: "99", workIntelLLMTimeoutKey: "1h",
		workIntelBackfillDaysKey: "-1", workIntelClassifyEnabledKey: "maybe", workIntelRetentionDaysKey: "abc",
	} {
		resp, _ := req(t, http.MethodPut, env.url+"/admin/settings/by-key/"+key, `{"value":`+jsonString(value)+`,"reason":"test"}`)
		if resp.StatusCode == http.StatusOK {
			t.Errorf("%s=%q was accepted", key, value)
		}
	}
	if after := env.server.workIntelConf(); after != got {
		t.Fatalf("a refused value changed the runtime: %+v", after)
	}
}

func TestWorkIntelSettingsDefaultFromEnvironment(t *testing.T) {
	t.Setenv("WORK_INTEL_BATCH_SIZE", "77")
	t.Setenv("WORK_INTEL_INTERVAL", "not-a-duration")
	t.Setenv("WORK_INTEL_LLM_ENABLED", "true")
	env := newWorkIntelEnv(t)
	got := env.server.workIntelConf()
	// A usable environment value is the default; an unusable one falls back
	// to the built-in default instead of stopping the worker.
	if got.BatchSize != 77 || got.Interval != 15*time.Second || !got.LLMEnabled {
		t.Fatalf("config from the environment = %+v", got)
	}
	// An administrator's value wins over the environment.
	putSetting(t, env.url, workIntelBatchSizeKey, "20")
	if got = env.server.workIntelConf(); got.BatchSize != 20 {
		t.Fatalf("after an override = %+v", got)
	}
}

func TestWorkIntelMetricsAreExposed(t *testing.T) {
	env := newWorkIntelEnv(t)
	env.ask(t, workIntelAlphaKey, "s1", workIntelPromptCode)
	env.ask(t, workIntelAlphaKey, "s1", workIntelPromptK8s)
	env.run(t)
	resp, err := http.Get(env.url + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	body := string(raw)
	for _, want := range []string{
		"# TYPE proxy_work_intel_processed_total counter", `proxy_work_intel_processed_total{method="rule"} 2`,
		`proxy_work_intel_processed_total{method="llm"} 0`, `proxy_work_intel_processed_total{method="cache"} 0`,
		"proxy_work_intel_failures_total 0", "proxy_work_intel_llm_calls_total 0", "proxy_work_intel_cache_hits_total 0",
		"# TYPE proxy_work_intel_backlog gauge", "proxy_work_intel_backlog 0", "proxy_work_intel_lag_seconds 0",
		"proxy_work_intel_batch_seconds_sum ", "proxy_work_intel_batch_seconds_count 1",
		// The existing series are still there.
		"proxy_requests_total ",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("/metrics misses %q", want)
		}
	}
	// Requests waiting behind the cursor show up as backlog and lag.
	env.ask(t, workIntelAlphaKey, "s1", workIntelPromptSQL)
	env.worker.gaugeAt = time.Time{}
	putSetting(t, env.url, workIntelClassifyEnabledKey, "false")
	if stats := env.run(t); stats.Backlog != 1 {
		t.Fatalf("backlog while disabled = %+v", stats)
	}
	if metrics := env.server.workIntelMetrics(); !strings.Contains(metrics, "proxy_work_intel_backlog 1") || strings.Contains(metrics, "proxy_work_intel_lag_seconds 0\n") {
		t.Errorf("gauges with one request waiting:\n%s", metrics)
	}
}

// A policy published while the worker runs is picked up on the next cycle,
// and a stored policy that cannot be compiled does not stop classification.
func TestWorkIntelWorkerFollowsPublishedPolicy(t *testing.T) {
	env := newWorkIntelEnv(t)
	ctx := context.Background()
	env.ask(t, workIntelAlphaKey, "s1", workIntelPromptCode)
	if stats := env.run(t); stats.PolicyVersion != 1 {
		t.Fatalf("first cycle = %+v", stats)
	}
	first, err := env.server.workIntelActiveEngine(ctx, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	// The same version is not compiled again.
	if again, _ := env.server.workIntelActiveEngine(ctx, 0); again.engine != first.engine {
		t.Fatal("the engine was recompiled without a new version")
	}

	// Version 2 moves the "REST API" vocabulary under a new child of "dev".
	policy := workintel.DefaultPolicy()
	policy.Categories = append(policy.Categories, workintel.Category{ID: "dev.restapi", ParentID: "dev", Name: "REST API 개발", Enabled: true,
		Rules: workintel.Rules{Keywords: []string{"rest api 핸들러", "엔드포인트 코드", "사용자 목록을 반환"}, Weight: 3}})
	encoded, _ := json.Marshal(policy)
	if _, err := env.db.PublishWorkPolicy(ctx, string(encoded), "REST API 분리", "admin"); err != nil {
		t.Fatal(err)
	}
	env.ask(t, workIntelAlphaKey, "s1", workIntelPromptCode)
	stats := env.run(t)
	facts := env.facts(t)
	if stats.PolicyVersion != 2 || facts[1].PolicyVersion != 2 || facts[1].CategoryID != "dev.restapi" || facts[0].CategoryID != "dev.codegen" || facts[0].PolicyVersion != 1 {
		t.Fatalf("after publishing: stats=%+v facts=%s/%d %s/%d", stats, facts[0].CategoryID, facts[0].PolicyVersion, facts[1].CategoryID, facts[1].PolicyVersion)
	}

	// Version 3 is not a policy at all.
	if _, err := env.db.PublishWorkPolicy(ctx, `{"categories":[]}`, "broken", "admin"); err != nil {
		t.Fatal(err)
	}
	env.ask(t, workIntelAlphaKey, "s1", workIntelPromptK8s)
	stats = env.run(t)
	facts = env.facts(t)
	if stats.Classified != 1 || stats.PolicyVersion != 3 || facts[2].CategoryID != "infra.k8s" {
		t.Fatalf("with a broken policy: stats=%+v fact=%+v", stats, facts[2])
	}
	if status, _ := env.server.workIntelStatus(ctx); !status.PolicyFallback || status.PolicyVersion != 3 {
		t.Fatalf("status with a broken policy = %+v", status)
	}
}

// seedWorkIntelRequests writes n logged requests with varied prompts straight
// into the store, the way the log writer does.
func seedWorkIntelRequests(tb testing.TB, db *store.SQLStore, prefix string, n int) {
	tb.Helper()
	prompts := []string{workIntelPromptCode, workIntelPromptK8s, workIntelPromptSQL, workIntelPromptChat, workIntelPromptUnclear, workIntelPromptMail,
		"이 함수 단위 테스트 코드를 작성해줘 pytest로", "사내 규정에서 출장비 정산 기준이 어떻게 되는지 알려줘"}
	now := time.Now().UTC()
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("%s-%04d", prefix, i)
		key := "key-alpha"
		if i%3 == 0 {
			key = "key-beta"
		}
		record := store.LogRecord{
			Request: store.RequestLog{ID: id, TraceID: id, APIKeyID: key, UserAgent: "claude-cli/2.1", Model: fmt.Sprintf("model-%d", i%3), Provider: "p",
				Endpoint: "/v1/chat/completions", StatusCode: 200, LatencyMS: int64(100 + i*37), SessionID: fmt.Sprintf("%s-session-%d", prefix, i%20),
				Complexity: i % 100, TaskType: "generate", PromptFingerprint: fmt.Sprintf("fp-%d", i%8), CreatedAt: now},
			Prompts: []store.PromptLog{
				{ID: id + "-s", RequestID: id, Role: "system", RedactedText: "당신은 유능한 조수입니다.", CreatedAt: now},
				{ID: id + "-u", RequestID: id, Role: "user", RedactedText: prompts[i%len(prompts)], CreatedAt: now},
			},
			Usage:     &store.TokenUsage{ID: id + "-t", RequestID: id, PromptTokens: 100 + i, CompletionTokens: 40, TotalTokens: 140 + i, EstimatedCost: 1.5, Currency: "KRW", Source: "usage"},
			Languages: []store.LanguageStat{{ID: id + "-l", RequestID: id, Language: "Go", Confidence: 0.95}},
			Tools:     []store.ToolInvocation{{ID: id + "-c", RequestID: id, TraceID: id, ServerLabel: "github", ToolName: "create_issue", Source: "call", IsMCP: true}},
		}
		if err := db.InsertLogRecord(context.Background(), record); err != nil {
			tb.Fatal(err)
		}
	}
}

// How fast one cycle is with rules only: read 200 requests with their child
// rows, classify them and apply the batch in one transaction.
func TestWorkIntelRunOnceThroughput(t *testing.T) {
	env := newWorkIntelEnv(t)
	const batch = 200
	// The first cycle also compiles the policy; it is not what is measured.
	seedWorkIntelRequests(t, env.db, "warm", 10)
	env.run(t)

	var total time.Duration
	const rounds = 5
	for round := 0; round < rounds; round++ {
		seedWorkIntelRequests(t, env.db, fmt.Sprintf("round%d", round), batch)
		started := time.Now()
		stats := env.run(t)
		total += time.Since(started)
		if stats.Read != batch || stats.Classified != batch {
			t.Fatalf("round %d = %+v", round, stats)
		}
	}
	perBatch := total / rounds
	t.Logf("RunOnce, rule-only, %d requests per batch: %s per batch, %.0f requests/s", batch, perBatch.Round(time.Millisecond), float64(batch)/perBatch.Seconds())
	// A generous bound: the default cycle is 15 seconds, and a batch that took
	// longer than a second would not keep up with a busy gateway.
	if perBatch > 2*time.Second {
		t.Fatalf("a batch of %d took %s", batch, perBatch)
	}
	if got := workIntelQuery(t, env, `SELECT SUM(requests) FROM work_daily`); !reflect.DeepEqual(got, []string{fmt.Sprint(10 + rounds*batch)}) {
		t.Fatalf("work_daily counts %v requests", got)
	}
}

func BenchmarkWorkIntelRunOnce(b *testing.B) {
	db, _ := workIntelStores(b)
	logger := store.NewAsyncLogger(db, 64, filepath.Join(b.TempDir(), "fallback.ndjson"))
	logger.Start()
	b.Cleanup(func() { logger.Stop(context.Background()); db.Close() })
	server, err := NewServer(testConfig("http://127.0.0.1:1", "s"), db, logger, nil)
	if err != nil {
		b.Fatal(err)
	}
	worker := NewWorkIntelWorker(server)
	defer worker.Stop()
	const batch = 200
	seedWorkIntelRequests(b, db, "warm", 10)
	if _, err := worker.RunOnce(context.Background()); err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		b.StopTimer()
		seedWorkIntelRequests(b, db, fmt.Sprintf("b%d", i), batch)
		b.StartTimer()
		stats, err := worker.RunOnce(context.Background())
		if err != nil || stats.Classified != batch {
			b.Fatalf("RunOnce = %+v, %v", stats, err)
		}
	}
	b.ReportMetric(float64(batch*b.N)/b.Elapsed().Seconds(), "requests/s")
}
