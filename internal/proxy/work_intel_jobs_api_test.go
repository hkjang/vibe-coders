package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
	"vibe-coders/internal/workintel"
)

// fastWorkIntelJobs removes the pause between the chunks of a job for a test.
func fastWorkIntelJobs(t *testing.T) {
	t.Helper()
	previous := workIntelReclassifyPause
	workIntelReclassifyPause = time.Millisecond
	t.Cleanup(func() { workIntelReclassifyPause = previous })
}

// publishRESTPolicy publishes a policy that gives code generation a child for
// REST handlers, which is where the fixture's code prompt then belongs. It
// returns the category the new policy assigns to that prompt.
func (e *workAPIEnv) publishRESTPolicy(t *testing.T) string {
	t.Helper()
	saved := e.savePolicy(t, func(p *workintel.Policy) {
		p.Categories = append(p.Categories, workintel.Category{ID: "dev.codegen.rest", ParentID: "dev.codegen", Name: "REST API 구현", Enabled: true,
			Rules: workintel.Rules{Keywords: []string{"rest api", "핸들러", "엔드포인트"}, Weight: 3}})
	})
	e.publish(t, saved.Revision, "REST 세분류 추가")
	var out struct {
		Result workClassificationView `json:"result"`
	}
	e.do(t, e.full, http.MethodPost, "/policy/test", map[string]any{"text": workIntelPromptCode, "use_draft": false, "use_llm": false}, &out)
	if out.Result.CategoryID != "dev.codegen.rest" {
		t.Fatalf("the new policy classifies the code prompt as %q; the test needs a category other than dev.codegen", out.Result.CategoryID)
	}
	return out.Result.CategoryID
}

// startReclassify previews a selection and confirms it.
func (e *workAPIEnv) startReclassify(t *testing.T, token, query string) (workReclassifyPreview, workJobView) {
	t.Helper()
	var preview workReclassifyPreview
	e.get(t, token, "/reclassify?"+query, &preview)
	status, body := e.call(t, token, http.MethodPost, "/reclassify?reviewed=1", map[string]any{
		"revision": preview.Revision, "reviewed_at": preview.ReviewedAt, "reason": "정책 변경 반영"})
	if status != http.StatusAccepted {
		t.Fatalf("starting the job = %d %s\npreview: %+v", status, body, preview)
	}
	var job workJobView
	if err := json.Unmarshal(body, &job); err != nil {
		t.Fatal(err)
	}
	return preview, job
}

func (e *workAPIEnv) waitJob(t *testing.T, token, id string) workJobView {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		var job workJobView
		e.get(t, token, "/reclassify/jobs/"+id, &job)
		if job.Status != store.WorkJobRunning && job.Status != store.WorkJobQueued {
			return job
		}
		if time.Now().After(deadline) {
			t.Fatalf("job %s is still %s: %+v", id, job.Status, job.Progress)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// workAPIAggregates reads the aggregate tables as text, to compare two states.
func (e *workAPIEnv) aggregates(t *testing.T) map[string][]string {
	t.Helper()
	return map[string][]string{
		"work_daily": workIntelQuery(t, e.workIntelEnv, `SELECT day, category_id, action_type, team, model, provider, client, top_category_id, requests,
			tokens_in, tokens_out, mcp_calls, errors, retries, latency_ms, m_rule, m_llm, m_cache, m_manual, s_review, s_unclassified, s_failed,
			conf_b0, conf_b1, conf_b2, conf_b3, conf_b4 FROM work_daily ORDER BY day, category_id, action_type, team, model, provider, client`),
		"work_daily_users": workIntelQuery(t, e.workIntelEnv, `SELECT day, category_id, team, user_key, top_category_id FROM work_daily_users
			ORDER BY day, category_id, team, user_key`),
		"work_sessions": workIntelQuery(t, e.workIntelEnv, `SELECT session_id, team, requests, errors, retries, models, model_switches, completion,
			category_counts, primary_category_id, primary_top_category_id FROM work_sessions ORDER BY session_id, team`),
		"work_session_segments": workIntelQuery(t, e.workIntelEnv, `SELECT session_id, team, category_id, day, top_category_id, requests, tokens_in,
			tokens_out, errors FROM work_session_segments ORDER BY session_id, team, category_id, day`),
	}
}

func TestWorkIntelAPIReclassify(t *testing.T) {
	fastWorkIntelJobs(t)
	f := newWorkAPIFixture(t)
	ctx := context.Background()
	twoDays := "from=" + f.prev + "&to=" + f.today

	var preview workReclassifyPreview
	f.get(t, f.full, "/reclassify?"+twoDays, &preview)
	reviewed, err1 := time.Parse(workIntelReclassifyLayout, preview.ReviewedAt)
	expires, err2 := time.Parse(workIntelReclassifyLayout, preview.ExpiresAt)
	if preview.Total != 12 || !reflect.DeepEqual(preview.ByStatus, map[string]int64{"classified": 11, "unclassified": 1}) ||
		!reflect.DeepEqual(preview.ByMethod, map[string]int64{"rule": 12}) || preview.ManualKept != 0 || preview.NoTextKept != 0 ||
		preview.EstLLMCalls != 0 || preview.Days != 2 || preview.ActiveJob != nil || err1 != nil || err2 != nil || expires.Sub(reviewed) != 5*time.Minute {
		t.Fatalf("preview = %+v", preview)
	}
	if _, signature, ok := workIntelRevisionSelection(preview.Revision); !ok || len(signature) != 64 {
		t.Fatalf("revision = %q", preview.Revision)
	}
	// The filters narrow the selection.
	var narrow workReclassifyPreview
	for query, want := range map[string]int64{twoDays + "&status=unclassified": 1, twoDays + "&category=dev": 7, twoDays + "&method=manual": 0,
		"from=" + f.today + "&to=" + f.today + "&category=data": 1} {
		if f.get(t, f.full, "/reclassify?"+query, &narrow); narrow.Total != want {
			t.Errorf("preview %s = %d, want %d", query, narrow.Total, want)
		}
	}
	for _, query := range []string{"status=done", "method=guess", "from=x", "from=" + f.today + "&to=" + f.prev} {
		if status, body := f.call(t, f.full, http.MethodGet, "/reclassify?"+query, nil); status != http.StatusBadRequest || workAPIErrorCode(body) != "work_intel_invalid_query" {
			t.Errorf("preview %s = %d %s", query, status, body)
		}
	}

	// One request is corrected by hand; a job must leave it alone.
	f.do(t, f.full, http.MethodPost, "/review/correct", map[string]any{"request_ids": []string{f.ids[4]}, "category_id": "dev.review", "reason": "수동 보정"}, nil)
	wantCode := f.publishRESTPolicy(t)

	confirm := func(token string, p workReclassifyPreview, query string) (int, []byte) {
		return f.call(t, token, http.MethodPost, "/reclassify?"+query, map[string]any{"revision": p.Revision, "reviewed_at": p.ReviewedAt, "reason": "정책 변경 반영"})
	}
	// What was previewed under the policy that has since been replaced cannot be
	// confirmed: the job would run a policy nobody reviewed it with.
	if status, body := confirm(f.full, preview, "reviewed=1"); status != http.StatusConflict || workAPIErrorCode(body) != "work_reclassify_conflict" {
		t.Errorf("confirming a stale preview = %d %s", status, body)
	}
	f.get(t, f.full, "/reclassify?"+twoDays, &preview)
	if preview.Total != 12 || preview.ManualKept != 1 || !reflect.DeepEqual(preview.ByMethod, map[string]int64{"rule": 11, "manual": 1}) {
		t.Fatalf("preview after the correction = %+v", preview)
	}
	// The confirmation must say it was reviewed, come from the same caller, be
	// unaltered and be in time.
	if status, body := confirm(f.full, preview, "reviewed=0"); status != http.StatusBadRequest || workAPIErrorCode(body) != "work_reclassify_review_required" {
		t.Errorf("unreviewed confirmation = %d %s", status, body)
	}
	if status, body := confirm(f.alphaAdmin, preview, "reviewed=1"); status != http.StatusConflict || workAPIErrorCode(body) != "work_reclassify_conflict" {
		t.Errorf("another caller confirming the preview = %d %s", status, body)
	}
	old := preview
	old.ReviewedAt = time.Now().Add(-6 * time.Minute).UTC().Format(workIntelReclassifyLayout)
	if status, body := confirm(f.full, old, "reviewed=1"); status != http.StatusConflict || workAPIErrorCode(body) != "work_reclassify_expired" {
		t.Errorf("expired confirmation = %d %s", status, body)
	}
	forged := preview
	forged.Revision = strings.Replace(preview.Revision, preview.Revision[:8], "AAAAAAAA", 1)
	if status, _ := confirm(f.full, forged, "reviewed=1"); status != http.StatusBadRequest && status != http.StatusConflict {
		t.Errorf("forged revision = %d", status)
	}
	if status, body := f.call(t, f.full, http.MethodPost, "/reclassify?reviewed=1", map[string]any{"revision": preview.Revision, "reviewed_at": preview.ReviewedAt, "reason": ""}); status != http.StatusBadRequest {
		t.Errorf("confirmation without a reason = %d %s", status, body)
	}

	// While another job is running, a second one is refused and named.
	busy := store.WorkIntelJob{ID: "wir_busy", Kind: workIntelReclassifyKind, Actor: "someone-else", WorkerToken: "busy-token", Progress: store.WorkIntelJobProgress{Total: 99}}
	if admitted, err := f.db.AdmitWorkIntelJob(ctx, busy, store.AdminAuditLog{ID: "wir_busy_requested", AdminID: "someone-else", Action: "work_intel.reclassify.requested"}); err != nil || !admitted {
		t.Fatalf("admitting the busy job: %v %v", admitted, err)
	}
	f.get(t, f.full, "/reclassify?"+twoDays, &preview)
	if preview.ActiveJob == nil || preview.ActiveJob.ID != "wir_busy" || preview.ActiveJob.Progress.Total != 99 {
		t.Errorf("preview while a job runs = %+v", preview.ActiveJob)
	}
	status, body := confirm(f.full, preview, "reviewed=1")
	var refusal struct {
		ActiveJob *workJobView `json:"active_job"`
	}
	_ = json.Unmarshal(body, &refusal)
	if status != http.StatusConflict || workAPIErrorCode(body) != "work_job_active" || refusal.ActiveJob == nil || refusal.ActiveJob.ID != "wir_busy" || refusal.ActiveJob.Status != store.WorkJobRunning {
		t.Errorf("second job = %d %s", status, body)
	}
	// A caller who may not read the running job learns only that there is one.
	var hidden workReclassifyPreview
	f.get(t, f.alphaAdmin, "/reclassify?"+twoDays, &hidden)
	if hidden.ActiveJob == nil || hidden.ActiveJob.ID != "" || hidden.ActiveJob.Actor != "" || hidden.ActiveJob.Progress.Total != 0 || hidden.ActiveJob.Status != store.WorkJobRunning {
		t.Errorf("the running job as another team sees it = %+v", hidden.ActiveJob)
	}
	if err := f.db.FinishWorkIntelJob(ctx, busy.ID, busy.WorkerToken, store.WorkJobSucceeded, busy.Progress, ""); err != nil {
		t.Fatal(err)
	}

	// The job itself.
	preview, started := f.startReclassify(t, f.full, twoDays)
	if started.Status != store.WorkJobRunning || started.Actor != "wi-full-admin" || started.Progress.Total != 12 || !strings.HasPrefix(started.ID, "wir_") {
		t.Fatalf("started job = %+v", started)
	}
	done := f.waitJob(t, f.full, started.ID)
	// Seven requests carry the code prompt (r1, r2, r4, r6, r8, r10, r11) and
	// move to the new child; the manual one is kept; nothing else changes.
	if done.Status != store.WorkJobSucceeded || done.Error != "" || done.Progress.Total != 12 || done.Progress.Done != 12 || done.Progress.Changed != 7 ||
		done.Progress.Failed != 0 || done.Progress.DaysRebuilt != 2 || done.Progress.KeptNoText != 0 || !strings.HasPrefix(done.Progress.Cursor, f.today+"|") {
		t.Fatalf("finished job = %+v", done)
	}
	facts, err := f.db.WorkClassificationsByID(ctx, f.ids)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]store.WorkClassification{}
	for _, fact := range facts {
		byID[fact.RequestID] = fact
	}
	for i, id := range f.ids {
		fact := byID[id]
		switch i + 1 {
		case 1, 2, 4, 6, 8, 10, 11:
			if fact.CategoryID != wantCode || fact.PolicyVersion != 2 || fact.Method != "rule" {
				t.Errorf("request %d = %s (policy %d, %s)", i+1, fact.CategoryID, fact.PolicyVersion, fact.Method)
			}
		case 5:
			if fact.CategoryID != "dev.review" || fact.Method != "manual" || fact.CorrectedBy != "wi-full-admin" || fact.PolicyVersion != 1 {
				t.Errorf("the manual correction was not kept: %+v", fact)
			}
		default:
			if fact.PolicyVersion != 2 || fact.Method != "rule" {
				t.Errorf("request %d was not classified again: %+v", i+1, fact)
			}
		}
	}
	// The aggregates the job left are what a rebuild from the facts gives.
	after := f.aggregates(t)
	if _, err := f.db.RebuildWorkDays(ctx, []string{f.prev, f.today}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.RebuildWorkSessionsOfDays(ctx, []string{f.prev, f.today}); err != nil {
		t.Fatal(err)
	}
	fresh := f.aggregates(t)
	for table, rows := range fresh {
		if !reflect.DeepEqual(rows, after[table]) {
			t.Errorf("%s after the job differs from a fresh rebuild\n job:   %v\n fresh: %v", table, after[table], rows)
		}
	}
	var categories workCategoriesResponse
	f.get(t, f.full, "/categories?"+f.period+"&metric=requests&parent=dev.codegen", &categories)
	if len(categories.Rows) != 1 || categories.Rows[0].Category.ID != "dev.codegen.rest" || categories.Rows[0].Current.Requests != 6 {
		t.Errorf("children of dev.codegen after the job = %+v", categories.Rows)
	}
	if days, sessions, err := f.db.WorkIntelDirty(ctx, 10); err != nil || len(days)+len(sessions) != 0 {
		t.Errorf("stale marks left: days=%v sessions=%v (%v)", days, sessions, err)
	}

	// Confirming the same preview again returns the job; it does not run twice.
	status, body = confirm(f.full, preview, "reviewed=1")
	var again workJobView
	_ = json.Unmarshal(body, &again)
	if status != http.StatusOK || again.ID != started.ID || again.Status != store.WorkJobSucceeded {
		t.Errorf("repeated confirmation = %d %s", status, body)
	}
	// A job is its owner's; a full administrator may read any.
	for name, token := range map[string]string{"another team": f.alphaAdmin, "a viewer": f.viewer} {
		if status, body := f.call(t, token, http.MethodGet, "/reclassify/jobs/"+started.ID, nil); status != http.StatusForbidden || workAPIErrorCode(body) != "work_job_denied" {
			t.Errorf("job read by %s = %d %s", name, status, body)
		}
	}
	if status, body := f.call(t, f.full, http.MethodGet, "/reclassify/jobs/wir_none", nil); status != http.StatusNotFound || workAPIErrorCode(body) != "work_job_not_found" {
		t.Errorf("unknown job = %d %s", status, body)
	}
	// Everything now carries the current policy: a second preview finds the
	// same twelve, and a team-scoped job touches its own team's only.
	_, teamJob := f.startReclassify(t, f.alphaAdmin, twoDays)
	if finished := f.waitJob(t, f.alphaAdmin, teamJob.ID); finished.Status != store.WorkJobSucceeded || finished.Progress.Total != 8 || finished.Progress.Done != 8 || finished.Progress.Changed != 0 {
		t.Errorf("the alpha team's job = %+v", finished)
	}
	if status, _ := f.call(t, f.full, http.MethodGet, "/reclassify/jobs/"+teamJob.ID, nil); status != http.StatusOK {
		t.Errorf("a full administrator reading the team's job = %d", status)
	}
	actions := workAPIAuditActions(t, f.db)
	if actions["work_intel.reclassify.requested"] != 3 || actions["work_intel.reclassify.completed"] != 2 {
		t.Errorf("audit actions = %v", actions)
	}
}

// Prompts are purged earlier than requests. A request whose text is gone keeps
// the classification it has, because the rules cannot read what is not there.
func TestWorkIntelAPIReclassifyKeepsRowsWithoutText(t *testing.T) {
	fastWorkIntelJobs(t)
	env := newWorkAPIEnv(t)
	ctx := context.Background()
	var code, unclear []string
	for i := 0; i < 4; i++ {
		code = append(code, env.send(t, "key-a1", fmt.Sprintf("sess-k%d", i), workAPIModel, workIntelPromptCode))
	}
	for i := 0; i < 2; i++ {
		unclear = append(unclear, env.send(t, "key-a2", fmt.Sprintf("sess-u%d", i), workAPIModel, workIntelPromptUnclear))
	}
	env.run(t)
	all := append(append([]string{}, code...), unclear...)
	load := func() map[string]store.WorkClassification {
		t.Helper()
		facts, err := env.db.WorkClassificationsByID(ctx, all)
		if err != nil || len(facts) != len(all) {
			t.Fatalf("facts: %d, %v", len(facts), err)
		}
		out := map[string]store.WorkClassification{}
		for _, fact := range facts {
			out[fact.RequestID] = fact
		}
		return out
	}
	before := load()
	// The prompts of half the code requests and of one unclear request are gone.
	env.exec(t, `DELETE FROM prompt_logs WHERE request_id IN (?, ?, ?)`, code[0], code[1], unclear[0])
	wantCode := env.publishRESTPolicy(t)
	period := "from=" + workAPIToday() + "&to=" + workAPIToday()

	preview, job := env.startReclassify(t, env.full, period)
	// Two classified rows cannot be read again. The unclassified one without
	// text is not counted: trying it on its metadata cannot make it worse.
	if preview.Total != 6 || preview.NoTextKept != 2 || preview.ManualKept != 0 {
		t.Fatalf("preview = %+v", preview)
	}
	done := env.waitJob(t, env.full, job.ID)
	if done.Status != store.WorkJobSucceeded || done.Progress.Done != 6 || done.Progress.KeptNoText != preview.NoTextKept || done.Progress.Changed != 2 || done.Progress.Failed != 0 {
		t.Fatalf("job = %+v", done)
	}
	after := load()
	for _, id := range code[:2] {
		was, is := before[id], after[id]
		if is.CategoryID != was.CategoryID || is.Status != was.Status || is.Confidence != was.Confidence || is.Method != was.Method ||
			is.PolicyVersion != was.PolicyVersion || is.UpdatedAt != was.UpdatedAt || is.CategoryID != "dev.codegen" {
			t.Errorf("a request without text was reclassified:\n was %+v\n is  %+v", was, is)
		}
	}
	for _, id := range code[2:] {
		if is := after[id]; is.CategoryID != wantCode || is.PolicyVersion != 2 || is.Status != "classified" {
			t.Errorf("a request with text was not re-evaluated: %+v", is)
		}
	}
	for _, id := range unclear {
		if is := after[id]; is.CategoryID != "other" || is.Status != "unclassified" || is.PolicyVersion != 2 {
			t.Errorf("an unclassified request = %+v", is)
		}
	}
	// The aggregates say what the facts say.
	var categories workCategoriesResponse
	env.get(t, env.full, "/categories?"+period+"&metric=requests&parent=dev.codegen", &categories)
	rows := map[string]int64{}
	for _, row := range categories.Rows {
		rows[row.Category.ID] = row.Current.Requests
	}
	if !reflect.DeepEqual(rows, map[string]int64{"dev.codegen": 2, "dev.codegen.rest": 2}) {
		t.Errorf("children of dev.codegen = %v", rows)
	}

	// With the model step on, a request the rules cannot settle is asked about
	// if its text is there, and only then.
	conf := env.admin.workIntelConf()
	conf.LLMEnabled, conf.LLMModel = true, "judge-model"
	env.admin.workIntelRuntime.Store(&conf)
	env.fake.set(func(string) (string, time.Duration) {
		return workIntelAnswer("infra", "infra.k8s", "파드 장애 분석", []string{"장애"}, 0.9), 0
	})
	preview, job = env.startReclassify(t, env.full, period)
	// One request still waits for the model: the unclear one whose text is there.
	if preview.EstLLMCalls != 1 || preview.NoTextKept != 2 {
		t.Errorf("preview with the model step on = %+v", preview)
	}
	done = env.waitJob(t, env.full, job.ID)
	after = load()
	if done.Status != store.WorkJobSucceeded || done.Progress.Changed != 1 || done.Progress.KeptNoText != 2 || env.fake.count() != 1 {
		t.Errorf("job with the model step = %+v (model calls %d)", done, env.fake.count())
	}
	if is := after[unclear[1]]; is.CategoryID != "infra.k8s" || is.Method != "llm" || is.Status != "classified" || is.ClassifierModel != "judge-model" {
		t.Errorf("the request the model was asked about = %+v", is)
	}
	if is := after[unclear[0]]; is.CategoryID != "other" || is.Status != "unclassified" || is.Method != "rule" {
		t.Errorf("the request without text went to the model: %+v", is)
	}
	// With the model step off the cache still knows the model's answer for this
	// policy version: nothing changes and the row stays the model's.
	conf.LLMEnabled = false
	env.admin.workIntelRuntime.Store(&conf)
	_, job = env.startReclassify(t, env.full, period)
	done = env.waitJob(t, env.full, job.ID)
	if is := load()[unclear[1]]; done.Status != store.WorkJobSucceeded || done.Progress.Changed != 0 || is.CategoryID != "infra.k8s" || is.Method != "llm" || env.fake.count() != 1 {
		t.Errorf("job after the model step was switched off = %+v, the request = %+v", done, is)
	}
	// A new policy version empties the cache. The rules alone cannot settle the
	// request and the model cannot be asked, so the model's earlier answer is
	// kept rather than replaced by "unclassified".
	saved := env.savePolicy(t, func(p *workintel.Policy) { workAPICategory(p, "data.sql").Name = "SQL 작성" })
	env.publish(t, saved.Revision, "이름 변경")
	_, job = env.startReclassify(t, env.full, period)
	done = env.waitJob(t, env.full, job.ID)
	if is := load()[unclear[1]]; done.Status != store.WorkJobSucceeded || done.Progress.Changed != 0 || is.CategoryID != "infra.k8s" || is.Method != "llm" ||
		is.Status != "classified" || is.PolicyVersion != 2 || env.fake.count() != 1 {
		t.Errorf("job under a new policy without the model = %+v, the request = %+v", done, is)
	}
	if is := load()[code[2]]; is.PolicyVersion != 3 {
		t.Errorf("a request the rules settle was not classified under the new policy: %+v", is)
	}
}

func TestWorkIntelAPIInsightsAndAutomation(t *testing.T) {
	env := newWorkAPIEnv(t)
	// 24 code requests in 24 sessions by three users of one team, all on one
	// model, and two SQL requests of another team.
	for i := 0; i < 24; i++ {
		env.send(t, []string{"key-a1", "key-a2", "key-a3"}[i%3], fmt.Sprintf("sess-g%02d", i), workAPIModel, workIntelPromptCode)
	}
	env.send(t, "key-b1", "sess-gb", workAPIModel, workIntelPromptSQL)
	env.send(t, "key-b1", "sess-gb", workAPIModel, workIntelPromptSQL)
	// The worker's first cycle classifies and, its periodic step being due, generates.
	if stats := env.run(t); stats.Classified != 26 {
		t.Fatalf("classified %d of 26", stats.Classified)
	}
	today := workAPIToday()

	var automation workAutomationResponse
	env.get(t, env.full, "/automation", &automation)
	if automation.Count != 1 || len(automation.Rows) != 1 {
		t.Fatalf("automation = %+v", automation)
	}
	candidate := automation.Rows[0]
	// One fingerprint, 24 repeats by 3 users: half the weight on volume
	// (log10(25)/2), a fifth on breadth (3 of 5 users), the rest on consistency.
	if candidate.Title != "코드 생성 · 생성 반복 요청" || candidate.Category.ID != "dev.codegen" || !reflect.DeepEqual(candidate.Teams, []string{"alpha"}) ||
		candidate.Repeats != 24 || candidate.Users == nil || *candidate.Users != 3 || candidate.Sessions != 24 || !workNear(candidate.CostKRW, 600) ||
		candidate.Recommended != workintel.AutomationPromptTemplate || candidate.Feasibility != 0.71 || candidate.Risk != workintel.RiskLow ||
		candidate.NeedsApproval || len(candidate.MCPTools) != 0 || candidate.ReviewStatus != store.WorkReviewNew || candidate.ComputedAt == "" ||
		candidate.Effect.EstMinutesSaved != nil || !strings.Contains(candidate.Effect.Basis, "기준값") || !strings.HasPrefix(candidate.ID, "auto_") {
		t.Errorf("candidate = %+v", candidate)
	}
	// The title never comes from the prompt.
	for _, word := range []string{"REST", "핸들러", "엔드포인트"} {
		if strings.Contains(candidate.Title, word) {
			t.Errorf("the title %q quotes the prompt", candidate.Title)
		}
	}

	type insightsBody = workInsightsResponse
	var insights insightsBody
	env.get(t, env.full, "/insights", &insights)
	byKind := map[string]workInsightView{}
	kinds := []string{}
	for _, row := range insights.Rows {
		byKind[row.Kind] = row
		kinds = append(kinds, row.Kind)
	}
	sort.Strings(kinds)
	period := workIntelShiftDay(today, -29) + "~" + today
	compare := workIntelShiftDay(today, -59) + "~" + workIntelShiftDay(today, -30)
	if !reflect.DeepEqual(kinds, []string{"automation_candidate", "model_dependence", "new"}) || insights.GeneratedAt == "" || insights.LLMUsed {
		t.Fatalf("insights = %v generated_at=%q llm_used=%v", kinds, insights.GeneratedAt, insights.LLMUsed)
	}
	// Every number in a sentence is in its evidence.
	if in := byKind["new"]; in.Evidence.Period != period || in.Evidence.Compare != compare || in.Evidence.Sample != 24 ||
		in.Evidence.Metrics["current"] != 24 || in.Evidence.Metrics["previous"] != 0 || !strings.Contains(in.Body, "24건") ||
		!strings.Contains(in.Title, "코드 생성") || in.Link["category"] != "dev.codegen" || in.Severity != workintel.SeverityNotice {
		t.Errorf("new-category insight = %+v", in)
	}
	if in := byKind["model_dependence"]; in.Evidence.Metrics["share"] != 1 || in.Evidence.Metrics["sample"] != 24 || in.Evidence.Metrics["current"] != 24 ||
		in.Link["model"] != workAPIModel || !strings.Contains(in.Body, "100%") || !strings.Contains(in.Body, workAPIModel) {
		t.Errorf("model-dependence insight = %+v", in)
	}
	if in := byKind["automation_candidate"]; in.Evidence.Metrics["repeats"] != 24 || in.Evidence.Metrics["users"] != 3 || in.Evidence.Metrics["feasibility"] != 0.71 ||
		in.Link["candidate"] != candidate.ID || !strings.Contains(in.Body, "3명이 24회") {
		t.Errorf("automation insight = %+v", in)
	}
	for _, row := range insights.Rows {
		grounded := map[string]bool{}
		for _, text := range []string{row.Evidence.Period, row.Evidence.Compare, fmt.Sprint(row.Evidence.Sample)} {
			for _, n := range workIntelNumbers(text) {
				grounded[n] = true
			}
		}
		for _, value := range row.Evidence.Metrics {
			for _, v := range []float64{value, math.Round(value), math.Round(value * 100)} {
				for _, n := range workIntelNumbers(strconv.FormatFloat(v, 'f', -1, 64)) {
					grounded[n] = true
				}
			}
		}
		for _, n := range workIntelNumbers(row.Title + " " + row.Body) {
			if !grounded[n] {
				t.Errorf("insight %s states %s, which its evidence does not hold: %+v", row.Kind, n, row)
			}
		}
		if row.ID == "" || row.CreatedAt == "" {
			t.Errorf("insight %s is malformed: %+v", row.Kind, row)
		}
	}

	var trends workTrendsResponse
	env.get(t, env.full, "/trends", &trends)
	signals := map[string]workSignalView{}
	for _, signal := range trends.Signals {
		signals[signal.Kind+"/"+signal.Category.ID] = signal
	}
	if trends.Thresholds != workintel.DefaultSignalThresholds() || len(trends.Signals) != 2 {
		t.Fatalf("trends = %+v", trends)
	}
	if s := signals["new/dev.codegen"]; s.Current != 24 || s.Previous != 0 || s.ChangeAbs != 24 || s.ChangeRate != nil || s.UsersCurrent == nil ||
		*s.UsersCurrent != 3 || s.UsersPrevious == nil || *s.UsersPrevious != 0 || s.Sample != 24 || s.Note == "" {
		t.Errorf("new signal = %+v", s)
	}
	if s := signals["model_dependence/dev.codegen"]; s.Model != workAPIModel || s.Current != 24 || s.Sample != 24 {
		t.Errorf("model-dependence signal = %+v", s)
	}
	// By requests the numbers are the same here; by cost they are amounts.
	env.get(t, env.full, "/trends?metric=cost", &trends)
	if got := trends.Signals[0]; got.Kind != "new" || !workNear(got.Current, 600) {
		t.Errorf("new signal by cost = %+v", got)
	}
	// The other team has two requests: nothing to report, and nothing of alpha's.
	env.get(t, env.betaAdmin, "/trends", &trends)
	if len(trends.Signals) != 0 {
		t.Errorf("beta trends = %+v", trends.Signals)
	}
	env.get(t, env.betaAdmin, "/insights", &insights)
	if len(insights.Rows) != 0 || insights.GeneratedAt == "" {
		t.Errorf("beta insights = %+v", insights.Rows)
	}
	// A team-scoped administrator gets the insights of their own team, computed
	// when asked; the three users are exactly the minimum group.
	env.get(t, env.alphaAdmin, "/insights", &insights)
	if len(insights.Rows) != 3 {
		t.Errorf("alpha insights = %+v", insights.Rows)
	}

	// A category filter narrows all three to that category's own numbers.
	for path, want := range map[string]int{"/insights?category=dev": 3, "/insights?category=data": 0, "/insights?team=beta": 0, "/insights?team=alpha": 3} {
		if env.get(t, env.full, path, &insights); len(insights.Rows) != want {
			t.Errorf("%s = %d insights, want %d", path, len(insights.Rows), want)
		}
	}
	for path, want := range map[string]int{"/automation?category=dev": 1, "/automation?category=data": 0, "/automation?team=beta": 0, "/automation?limit=1&offset=1": 1} {
		if env.get(t, env.full, path, &automation); automation.Count != want {
			t.Errorf("%s = %d candidates, want %d", path, automation.Count, want)
		}
	}
	if env.get(t, env.full, "/automation?limit=1&offset=1", &automation); len(automation.Rows) != 0 {
		t.Errorf("a page past the end holds %d rows", len(automation.Rows))
	}
	if env.get(t, env.full, "/trends?category=data", &trends); len(trends.Signals) != 0 {
		t.Errorf("trends of data = %+v", trends.Signals)
	}

	// Review: the decision is recorded and nothing else happens.
	var reviewed workAutomationView
	env.do(t, env.full, http.MethodPost, "/automation/"+candidate.ID+"/review", map[string]any{"review_status": "accepted", "note": "템플릿으로 만들기로 함"}, &reviewed)
	if reviewed.ID != candidate.ID || reviewed.ReviewStatus != store.WorkReviewAccepted || reviewed.Repeats != 24 {
		t.Errorf("reviewed candidate = %+v", reviewed)
	}
	for status, want := range map[string]int{"accepted": 1, "new": 0, "": 1} {
		if env.get(t, env.full, "/automation?status="+status, &automation); automation.Count != want {
			t.Errorf("automation?status=%s = %d, want %d", status, automation.Count, want)
		}
	}
	if status, body := env.call(t, env.full, http.MethodPost, "/automation/"+candidate.ID+"/review", map[string]any{"review_status": "run-it", "note": ""}); status != http.StatusBadRequest {
		t.Errorf("review with an unknown status = %d %s", status, body)
	}
	if status, body := env.call(t, env.full, http.MethodPost, "/automation/auto_nope/review", map[string]any{"review_status": "accepted", "note": ""}); status != http.StatusNotFound || workAPIErrorCode(body) != "work_automation_not_found" {
		t.Errorf("review of an unknown candidate = %d %s", status, body)
	}
	// A candidate of another team does not exist for a team-scoped administrator.
	if status, _ := env.call(t, env.betaAdmin, http.MethodPost, "/automation/"+candidate.ID+"/review", map[string]any{"review_status": "dismissed", "note": ""}); status != http.StatusNotFound {
		t.Errorf("the beta team reviewing alpha's candidate = %d", status)
	}

	// Generating again keeps the review of a candidate that is still there.
	var run struct {
		Generated   int    `json:"generated"`
		GeneratedAt string `json:"generated_at"`
		Candidates  int    `json:"candidates"`
	}
	env.do(t, env.full, http.MethodPost, "/insights/run", map[string]any{}, &run)
	env.get(t, env.full, "/automation", &automation)
	if run.Generated != 3 || run.Candidates != 1 || run.GeneratedAt == "" || automation.Rows[0].ReviewStatus != store.WorkReviewAccepted || automation.Rows[0].ComputedAt != run.GeneratedAt {
		t.Errorf("second generation = %+v, candidate = %+v", run, automation.Rows[0])
	}
	env.get(t, env.full, "/insights", &insights)
	if insights.GeneratedAt != run.GeneratedAt || len(insights.Rows) != 3 {
		t.Errorf("insights after the second generation: generated_at=%q rows=%d", insights.GeneratedAt, len(insights.Rows))
	}
	var overview workOverviewResponse
	env.get(t, env.full, "/overview", &overview)
	if overview.Current.AutomationCandidates != 1 {
		t.Errorf("overview counts %d candidates", overview.Current.AutomationCandidates)
	}
	// A dismissed candidate is no longer turned into an insight or counted.
	env.do(t, env.full, http.MethodPost, "/automation/"+candidate.ID+"/review", map[string]any{"review_status": "dismissed", "note": ""}, nil)
	env.do(t, env.full, http.MethodPost, "/insights/run", map[string]any{}, &run)
	env.get(t, env.full, "/overview", &overview)
	if run.Generated != 2 || overview.Current.AutomationCandidates != 0 {
		t.Errorf("after the dismissal: generated=%d candidates=%d", run.Generated, overview.Current.AutomationCandidates)
	}
	actions := workAPIAuditActions(t, env.db)
	if actions["work_intel.automation.review"] != 2 || actions["work_intel.insights.run"] != 2 {
		t.Errorf("audit actions = %v", actions)
	}

	// Optional rewrite of the sentences by a model. It is given the evidence,
	// never a prompt, and a rewrite that states another number is discarded.
	conf := env.admin.workIntelConf()
	conf.InsightLLMEnabled, conf.LLMModel = true, "judge-model"
	env.admin.workIntelRuntime.Store(&conf)
	var sent []string
	rewrite := func(change func(title, body string) (string, string)) func(string) string {
		return func(request string) string {
			sent = append(sent, request)
			var parsed struct {
				Messages []struct {
					Content string `json:"content"`
				} `json:"messages"`
			}
			var original struct {
				Title string `json:"title"`
				Body  string `json:"body"`
			}
			if json.Unmarshal([]byte(request), &parsed) != nil || len(parsed.Messages) != 2 || json.Unmarshal([]byte(parsed.Messages[1].Content), &original) != nil {
				return ""
			}
			title, body := change(original.Title, original.Body)
			answer, _ := json.Marshal(map[string]string{"title": title, "body": body})
			return "```json\n" + string(answer) + "\n```"
		}
	}
	env.insightAnswer = rewrite(func(title, body string) (string, string) {
		return title, strings.ReplaceAll(strings.ReplaceAll(body, "24", "42"), "100", "90")
	})
	env.get(t, env.full, "/insights", &insights)
	original := map[string]string{}
	for _, row := range insights.Rows {
		original[row.Kind] = row.Body
	}
	env.do(t, env.full, http.MethodPost, "/insights/run", map[string]any{}, &run)
	env.get(t, env.full, "/insights", &insights)
	if insights.LLMUsed || env.insightCalls.Load() != 2 {
		t.Errorf("a rewrite that changed numbers was accepted: llm_used=%v calls=%d", insights.LLMUsed, env.insightCalls.Load())
	}
	for _, row := range insights.Rows {
		if row.Body != original[row.Kind] || strings.Contains(row.Body, "42") {
			t.Errorf("insight %s was rewritten to %q", row.Kind, row.Body)
		}
	}
	for _, request := range sent {
		if strings.Contains(request, "REST") || strings.Contains(request, "핸들러") || !strings.Contains(request, "evidence") || !strings.Contains(request, workIntelInsightLLMMarker) {
			t.Errorf("the rewrite request carries more than the evidence, or not the evidence: %s", request)
		}
	}
	// A rewrite that keeps the numbers is used.
	env.insightAnswer = rewrite(func(title, body string) (string, string) { return title + " (다듬음)", "요약하면, " + body })
	env.do(t, env.full, http.MethodPost, "/insights/run", map[string]any{}, &run)
	env.get(t, env.full, "/insights", &insights)
	if !insights.LLMUsed || len(insights.Rows) != 2 {
		t.Fatalf("an acceptable rewrite was not used: llm_used=%v rows=%d", insights.LLMUsed, len(insights.Rows))
	}
	for _, row := range insights.Rows {
		if !strings.HasSuffix(row.Title, "(다듬음)") || row.Body != "요약하면, "+original[row.Kind] {
			t.Errorf("rewritten insight %s = %q / %q", row.Kind, row.Title, row.Body)
		}
	}
	// A model that answers nonsense changes nothing.
	env.insightAnswer = func(string) string { return "죄송하지만 도와드릴 수 없습니다." }
	env.do(t, env.full, http.MethodPost, "/insights/run", map[string]any{}, &run)
	env.get(t, env.full, "/insights", &insights)
	if insights.LLMUsed || insights.Rows[0].Body != original[insights.Rows[0].Kind] {
		t.Errorf("after a useless answer: llm_used=%v body=%q", insights.LLMUsed, insights.Rows[0].Body)
	}
}

func TestWorkIntelInsightNumberCheck(t *testing.T) {
	insight := workintel.Insight{
		Title: "코드 생성 업무가 늘고 있습니다", Body: "최근 7일 동안 1,200건으로, 이전 7일의 800건보다 50% 늘었습니다.",
		Evidence: workintel.InsightEvidence{Period: "2026-10-29~2026-11-27", Compare: "2026-09-29~2026-10-28", Sample: 1200,
			Metrics: map[string]float64{"current": 1200, "previous": 800, "change_rate": 0.5, "window_days": 7}},
		Link: map[string]string{"model": "gpt-4.1"},
	}
	for body, want := range map[string]bool{
		"최근 7일 1200건, 그 전 7일 800건으로 50% 늘었습니다.":           true,
		"최근 7일 동안 1,200건이 요청되어 이전 7일(800건)보다 50% 증가했습니다.": true,
		"최근 7일 동안 1200.0건으로, 이전 7일의 800건보다 50.00% 늘었습니다.": true,
		// Each number must be the one in the same place of the original.
		"최근 7일 동안 800건으로, 이전 7일의 1,200건보다 50% 늘었습니다.": false,
		"최근 7일 1200건으로, 이전 7일의 800건보다 늘었습니다.":         false,
		"최근 7일 동안 1,300건으로, 이전 7일의 800건보다 50% 늘었습니다.": false,
		"최근 7일 동안 1,200건으로, 이전 7일의 800건보다 60% 늘었습니다.": false,
		"최근 14일 동안 1200건으로, 이전 7일의 800건보다 50% 늘었습니다.": false,
		// A number of the evidence that the sentence did not state is not allowed either.
		"2026-10-29부터 7일 동안 1200건으로, 이전 7일의 800건보다 50% 늘었습니다.": false,
		"gpt-4.1 모델로 최근 7일 1200건, 이전 7일 800건, 50% 증가.":         false,
		"수치 없이도 문장은 통과합니다.":                                    false,
		"": false,
		strings.Repeat("가", workIntelInsightMaxRunes+1): false,
	} {
		if got := workIntelInsightRewriteOK(insight, "코드 생성 업무 증가", body); got != want {
			t.Errorf("rewrite %q accepted=%v, want %v", body, got, want)
		}
	}
	// The title is held to the title's numbers: none here.
	if workIntelInsightRewriteOK(insight, "코드 생성 업무 50% 증가", insight.Body) {
		t.Error("a title that states a number the original title did not was accepted")
	}
	if got := workIntelNumbers("1,200건 12.50% 3,4 0.5"); !reflect.DeepEqual(got, []string{"1200", "12.5", "3,4", "0.5"}) {
		t.Errorf("numbers = %v", got)
	}
}

// The two rewrites the review found accepted: the current and previous figures
// swapped, and a count taken from the year of the period.
func TestWorkIntelInsightRewriteRejectsSwappedAndBorrowedNumbers(t *testing.T) {
	insight := workintel.Insight{
		Kind: workintel.SignalRising7d, Title: "개발 업무가 늘고 있습니다",
		Body: "최근 7일 동안 45건으로, 이전 7일의 30건보다 50% 늘었습니다.",
		Evidence: workintel.InsightEvidence{Period: "2026-10-28~2026-11-26", Compare: "2026-09-28~2026-10-27", Sample: 45,
			Metrics: map[string]float64{"current": 45, "previous": 30, "change_rate": 0.5, "window_days": 7}},
		Link: map[string]string{"tab": "trends", "category": "dev"},
	}
	if !workIntelInsightRewriteOK(insight, insight.Title, "최근 7일에 45건이 요청돼 이전 7일(30건)보다 50% 늘었습니다.") {
		t.Error("a faithful rewrite was rejected")
	}
	if workIntelInsightRewriteOK(insight, insight.Title, "최근 7일 동안 30건으로, 이전 7일의 45건보다 50% 늘었습니다.") {
		t.Error("a rewrite that swaps the current and previous figures was accepted")
	}
	if workIntelInsightRewriteOK(insight, insight.Title, "최근 7일 동안 2026건으로, 이전 7일의 28건보다 11% 늘었습니다.") {
		t.Error("a rewrite that borrows numbers from the dates was accepted")
	}
}

// A cheaper model is only suggested on evidence: enough sessions of the same
// work, and neither more errors nor more negative feedback.
func TestWorkIntelAPIModelSuggestions(t *testing.T) {
	env := newWorkAPIEnv(t)
	var mini []string
	for i := 0; i < 31; i++ {
		env.send(t, "key-a1", fmt.Sprintf("sess-big%02d", i), workAPIModel, workIntelPromptCode)
		mini = append(mini, env.send(t, "key-a2", fmt.Sprintf("sess-mini%02d", i), workAPIMiniModel, workIntelPromptCode))
	}
	env.run(t)
	var models workModelsResponse
	env.get(t, env.full, "/models", &models)
	if len(models.Rows) != 2 || models.Rows[0].LowSample || models.Rows[1].LowSample || models.Rows[0].Sessions != 31 || models.Rows[1].Sessions != 31 {
		t.Fatalf("model rows = %+v", models.Rows)
	}
	// 31 sessions at 25 KRW against 12.5 KRW: half the cost, 387.5 KRW in the period.
	if len(models.Suggestions) != 1 {
		t.Fatalf("suggestions = %+v", models.Suggestions)
	}
	if s := models.Suggestions[0]; s.Category.ID != "dev" || s.FromModel != workAPIModel || s.ToModel != workAPIMiniModel || s.Sample != 31 ||
		!workNear(s.EstSavingKRW, 387.5) || !strings.Contains(s.Basis, "31건") || !strings.Contains(s.Basis, "50%") || !strings.Contains(s.Basis, workAPIMiniModel) {
		t.Errorf("suggestion = %+v", s)
	}
	// Negative feedback on the cheaper model's answers withdraws it.
	env.feedback(t, mini[0], -1)
	env.get(t, env.full, "/models", &models)
	if len(models.Suggestions) != 0 || models.Rows[0].FeedbackNegative+models.Rows[1].FeedbackNegative != 1 {
		t.Errorf("suggestion despite worse feedback = %+v rows=%+v", models.Suggestions, models.Rows)
	}
	// With the same on the dearer model the two are level again.
	rows, err := env.db.RecentRequests(context.Background(), store.RequestFilter{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if row.Model == workAPIModel {
			env.feedback(t, row.ID, -1)
			break
		}
	}
	env.get(t, env.full, "/models", &models)
	if len(models.Suggestions) != 1 || !strings.Contains(models.Suggestions[0].Basis, "부정 피드백 1건") {
		t.Errorf("suggestion with level feedback = %+v", models.Suggestions)
	}
}
