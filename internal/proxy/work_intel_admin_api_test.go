package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
	"vibe-coders/internal/workintel"
)

type workAPIPolicy struct {
	Config           workintel.Policy `json:"config"`
	Revision         int              `json:"revision"`
	UpdatedBy        string           `json:"updated_by"`
	UpdatedAt        string           `json:"updated_at"`
	PublishedVersion int              `json:"published_version"`
	PublishedAt      string           `json:"published_at"`
	Dirty            bool             `json:"dirty"`
	Defaults         struct {
		ActionTypes []workintel.ActionType `json:"action_types"`
		Thresholds  workintel.Thresholds   `json:"thresholds"`
	} `json:"defaults"`
}

type workAPIPublished struct {
	Version     int    `json:"version"`
	PublishedAt string `json:"published_at"`
	Impact      struct {
		CategoriesRemoved int   `json:"categories_removed"`
		AffectedRequests  int64 `json:"affected_requests"`
	} `json:"impact"`
}

// savePolicy loads the draft, lets edit change it, and saves it.
func (e *workAPIEnv) savePolicy(t *testing.T, edit func(*workintel.Policy)) workAPIPolicy {
	t.Helper()
	var policy workAPIPolicy
	e.get(t, e.full, "/policy", &policy)
	edit(&policy.Config)
	var saved workAPIPolicy
	e.do(t, e.full, http.MethodPut, "/policy", map[string]any{"config": policy.Config, "expected_revision": policy.Revision, "reason": "테스트 변경"}, &saved)
	return saved
}

func (e *workAPIEnv) publish(t *testing.T, revision int, note string) workAPIPublished {
	t.Helper()
	var out workAPIPublished
	e.do(t, e.full, http.MethodPost, "/policy/publish", map[string]any{"expected_revision": revision, "note": note}, &out)
	return out
}

func workAPICategory(policy *workintel.Policy, id string) *workintel.Category {
	for i := range policy.Categories {
		if policy.Categories[i].ID == id {
			return &policy.Categories[i]
		}
	}
	return nil
}

func workAPIAuditActions(t *testing.T, db *store.SQLStore) map[string]int {
	t.Helper()
	audits, err := db.ListAdminAudit(context.Background(), 200)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]int{}
	for _, audit := range audits {
		out[audit.Action]++
	}
	return out
}

func TestWorkIntelAPIPolicyLifecycle(t *testing.T) {
	f := newWorkAPIFixture(t)

	var policy workAPIPolicy
	f.get(t, f.full, "/policy", &policy)
	if policy.Revision != 1 || policy.PublishedVersion != 1 || policy.Dirty || policy.PublishedAt == "" || len(policy.Config.Categories) < 12 ||
		len(policy.Defaults.ActionTypes) == 0 || policy.Defaults.Thresholds.MinGroupSize != 3 || policy.Config.Thresholds.Accept != 0.72 {
		t.Fatalf("initial policy: revision=%d version=%d dirty=%v categories=%d defaults=%+v", policy.Revision, policy.PublishedVersion, policy.Dirty,
			len(policy.Config.Categories), policy.Defaults.Thresholds)
	}

	// A save states the revision it started from.
	if status, body := f.call(t, f.full, http.MethodPut, "/policy", map[string]any{"config": policy.Config, "reason": "x"}); status != http.StatusBadRequest || workAPIErrorCode(body) != "work_policy_revision_missing" {
		t.Errorf("save without a revision = %d %s", status, body)
	}
	// An invalid policy is rejected with the path of each problem.
	broken := policy.Config
	broken.Categories = append([]workintel.Category(nil), broken.Categories...)
	*workAPICategory(&broken, "dev.codegen") = workintel.Category{ID: "dev.codegen", ParentID: "dev", Name: "", Enabled: true, MergedInto: "dev.codegen", Rules: workintel.Rules{Weight: 1}}
	status, body := f.call(t, f.full, http.MethodPut, "/policy", map[string]any{"config": broken, "expected_revision": 1, "reason": "x"})
	var rejection struct {
		Issues []workintel.Issue `json:"issues"`
	}
	_ = json.Unmarshal(body, &rejection)
	paths := map[string]bool{}
	for _, issue := range rejection.Issues {
		paths[issue.Path[strings.LastIndex(issue.Path, ".")+1:]] = issue.Message != ""
	}
	if status != http.StatusUnprocessableEntity || workAPIErrorCode(body) != "work_policy_invalid" || !paths["name"] || !paths["merged_into"] {
		t.Errorf("invalid policy = %d %s", status, body)
	}

	// The change under test: a category merged into one of another parent, one
	// removed, one renamed, and a savings baseline.
	saved := f.savePolicy(t, func(p *workintel.Policy) {
		workAPICategory(p, "infra.k8s").MergedInto = "dev.codegen"
		workAPICategory(p, "data.sql").Name = "SQL 작성"
		kept := p.Categories[:0]
		for _, category := range p.Categories {
			if category.ID != "other.chat" {
				kept = append(kept, category)
			}
		}
		p.Categories = kept
		p.Baselines = []workintel.Baseline{{CategoryID: "dev", ManualMinutes: 60, AIMinutes: 15, HourlyCostKRW: 60000, Note: "테스트 기준값"}}
	})
	if saved.Revision != 2 || saved.UpdatedBy != "wi-full-admin" || saved.UpdatedAt == "" || workAPICategory(&saved.Config, "other.chat") != nil {
		t.Fatalf("saved draft = revision %d by %q", saved.Revision, saved.UpdatedBy)
	}
	f.get(t, f.full, "/policy", &policy)
	if policy.Revision != 2 || !policy.Dirty || policy.PublishedVersion != 1 {
		t.Errorf("after the save: revision=%d dirty=%v version=%d", policy.Revision, policy.Dirty, policy.PublishedVersion)
	}
	// A second editor who loaded revision 1 is refused; nothing is written.
	if status, body := f.call(t, f.full, http.MethodPut, "/policy", map[string]any{"config": policy.Config, "expected_revision": 1, "reason": "x"}); status != http.StatusConflict || workAPIErrorCode(body) != "work_policy_conflict" {
		t.Errorf("stale save = %d %s", status, body)
	}
	// Saving changes nothing that is classified or shown.
	var categories workCategoriesResponse
	f.get(t, f.full, "/categories?"+f.period, &categories)
	if categories.Scope.PolicyVersion != 1 || len(categories.Rows) != 4 {
		t.Errorf("a saved draft changed the reads: %+v", categories.Scope)
	}

	// Publishing needs the reviewed revision.
	if status, body := f.call(t, f.full, http.MethodPost, "/policy/publish", map[string]any{"note": "x"}); status != http.StatusBadRequest || workAPIErrorCode(body) != "work_policy_revision_missing" {
		t.Errorf("publish without a revision = %d %s", status, body)
	}
	if status, body := f.call(t, f.full, http.MethodPost, "/policy/publish", map[string]any{"expected_revision": 1, "note": "x"}); status != http.StatusConflict || workAPIErrorCode(body) != "work_policy_conflict" {
		t.Errorf("publish of a stale revision = %d %s", status, body)
	}
	// One category is removed; r3 (infra.k8s) and r9 (other.chat) are the two
	// requests of the last 90 days in categories that go out of use.
	published := f.publish(t, 2, "병합과 삭제")
	if published.Version != 2 || published.PublishedAt == "" || published.Impact.CategoriesRemoved != 1 || published.Impact.AffectedRequests != 2 {
		t.Fatalf("publication = %+v", published)
	}
	f.get(t, f.full, "/policy", &policy)
	if policy.Dirty || policy.PublishedVersion != 2 || policy.Revision != 2 {
		t.Errorf("after the publication: dirty=%v version=%d revision=%d", policy.Dirty, policy.PublishedVersion, policy.Revision)
	}

	// Stored rows keep their ids; the reads fold them into what stands for them now.
	f.get(t, f.full, "/categories?"+f.period, &categories)
	rows := map[string]workMetrics{}
	for _, row := range categories.Rows {
		rows[row.Category.ID] = row.Current
	}
	if categories.Scope.PolicyVersion != 2 || len(rows) != 3 || rows["dev"].Requests != 7 || rows["dev"].Sessions != 4 || rows["data"].Requests != 1 ||
		rows["other"].Requests != 1 || categories.Unclassified.Requests != 1 || categories.Total.Requests != 10 {
		t.Errorf("categories after the merge = %+v unclassified=%+v", rows, categories.Unclassified)
	}
	f.get(t, f.full, "/categories?"+f.period+"&parent=data", &categories)
	if len(categories.Rows) != 1 || categories.Rows[0].Category.ID != "data.sql" || categories.Rows[0].Category.Name != "SQL 작성" {
		t.Errorf("the renamed category is not shown by its new name: %+v", categories.Rows)
	}
	f.get(t, f.full, "/categories?"+f.period+"&parent=dev", &categories)
	if len(categories.Rows) != 1 || categories.Rows[0].Category.ID != "dev.codegen" || categories.Rows[0].Current.Requests != 7 {
		t.Errorf("children of dev after the merge = %+v", categories.Rows)
	}
	// The removed category's request is now directly under its parent, which the
	// row says, and the unclassified request stays apart.
	f.get(t, f.full, "/categories?"+f.period+"&parent=other", &categories)
	if len(categories.Rows) != 1 || categories.Rows[0].Category.ID != "other" || !strings.Contains(categories.Rows[0].Category.Name, "세부 분류 없음") ||
		categories.Rows[0].HasChildren || categories.Rows[0].Current.Requests != 1 || categories.Unclassified.Requests != 1 {
		t.Errorf("children of other after the removal = %+v unclassified=%+v", categories.Rows, categories.Unclassified)
	}
	// A filter on the merged category selects what it was merged into.
	var requests workRequestsResponse
	f.get(t, f.full, "/requests?"+f.period+"&category=infra.k8s", &requests)
	if requests.Count != 7 {
		t.Errorf("requests of the merged category = %d, want 7", requests.Count)
	}
	for _, row := range requests.Rows {
		if row.Category.ID != "dev.codegen" {
			t.Errorf("request %s is shown as %s", row.RequestID, row.Category.ID)
		}
	}
	f.get(t, f.full, "/requests?"+f.period+"&category=infra", &requests)
	if requests.Count != 0 {
		t.Errorf("infra still has %d requests", requests.Count)
	}
	var detail workSessionDetailResponse
	f.get(t, f.full, "/sessions/sess-a1", &detail)
	if detail.Session.Primary.ID != "dev.codegen" || len(detail.Session.Secondary) != 0 || len(detail.Segments) != 1 || detail.Segments[0].Requests != 3 {
		t.Errorf("sess-a1 after the merge = primary %s secondary %v segments %+v", detail.Session.Primary.ID, detail.Session.Secondary, detail.Segments)
	}
	// The baseline turns the one confirmed dev session into an estimate:
	// (60 - 15) minutes, at 60,000 KRW an hour.
	var productivity workProductivityResponse
	f.get(t, f.full, "/productivity?"+f.period, &productivity)
	dev := productivity.Rows[0]
	if dev.Category.ID != "dev" || dev.Sessions != 4 || dev.ConfirmedSessions != 1 || dev.Baseline == nil || dev.Baseline.ManualMinutes != 60 ||
		dev.EstMinutesSaved == nil || *dev.EstMinutesSaved != 45 || dev.EstCostSavedKRW == nil || *dev.EstCostSavedKRW != 45000 || !strings.Contains(dev.Reason, "1건") {
		t.Errorf("dev productivity with a baseline = %+v", dev)
	}
	// data has the baseline of no ancestor; other has no confirmed session.
	for _, row := range productivity.Rows[1:] {
		if row.Baseline != nil || row.EstMinutesSaved != nil || row.EstCostSavedKRW != nil || row.Reason == "" {
			t.Errorf("%s productivity = %+v", row.Category.ID, row)
		}
	}

	type versionRow struct {
		Version     int               `json:"version"`
		Note        string            `json:"note"`
		PublishedBy string            `json:"published_by"`
		Categories  int               `json:"categories"`
		Changes     workintel.Changes `json:"changes"`
	}
	var versions struct {
		Versions []versionRow `json:"versions"`
	}
	f.get(t, f.full, "/policy/versions", &versions)
	empty := workintel.Changes{Added: []string{}, Removed: []string{}, Renamed: []string{}, Merged: []string{}, RulesChanged: []string{}}
	wantV2 := workintel.Changes{Added: []string{}, Removed: []string{"other.chat"}, Renamed: []string{"data.sql"}, Merged: []string{"infra.k8s"}, RulesChanged: []string{}}
	if len(versions.Versions) != 2 || versions.Versions[0].Version != 2 || versions.Versions[0].Note != "병합과 삭제" || versions.Versions[0].PublishedBy != "wi-full-admin" ||
		!reflect.DeepEqual(versions.Versions[0].Changes, wantV2) || versions.Versions[0].Categories != versions.Versions[1].Categories-1 ||
		!reflect.DeepEqual(versions.Versions[1].Changes, empty) {
		t.Errorf("versions = %+v", versions.Versions)
	}
	var version struct {
		Version int              `json:"version"`
		Config  workintel.Policy `json:"config"`
		Note    string           `json:"note"`
	}
	f.get(t, f.full, "/policy/versions/1", &version)
	if version.Version != 1 || workAPICategory(&version.Config, "other.chat") == nil || workAPICategory(&version.Config, "infra.k8s").MergedInto != "" {
		t.Errorf("version 1 = %+v", version.Note)
	}
	if status, body := f.call(t, f.full, http.MethodGet, "/policy/versions/99", nil); status != http.StatusNotFound || workAPIErrorCode(body) != "work_policy_version_not_found" {
		t.Errorf("unknown version = %d %s", status, body)
	}

	// A rollback publishes the old content as a new version and puts it in the draft.
	var rolled workAPIPublished
	f.do(t, f.full, http.MethodPost, "/policy/rollback", map[string]any{"version": 1, "note": ""}, &rolled)
	f.get(t, f.full, "/policy", &policy)
	if rolled.Version != 3 || policy.PublishedVersion != 3 || policy.Dirty || policy.Revision != 3 || workAPICategory(&policy.Config, "other.chat") == nil ||
		len(policy.Config.Baselines) != 0 {
		t.Errorf("after the rollback: %+v draft revision=%d dirty=%v", rolled, policy.Revision, policy.Dirty)
	}
	f.get(t, f.full, "/policy/versions", &versions)
	wantV3 := workintel.Changes{Added: []string{"other.chat"}, Removed: []string{}, Renamed: []string{"data.sql"}, Merged: []string{}, RulesChanged: []string{"infra.k8s"}}
	if len(versions.Versions) != 3 || !reflect.DeepEqual(versions.Versions[0].Changes, wantV3) || !strings.Contains(versions.Versions[0].Note, "1") {
		t.Errorf("version 3 = %+v", versions.Versions[0])
	}
	f.get(t, f.full, "/categories?"+f.period, &categories)
	if len(categories.Rows) != 4 || categories.Scope.PolicyVersion != 3 {
		t.Errorf("categories after the rollback: %d rows, version %d", len(categories.Rows), categories.Scope.PolicyVersion)
	}
	if status, body := f.call(t, f.full, http.MethodPost, "/policy/rollback", map[string]any{"version": 42, "note": "x"}); status != http.StatusNotFound {
		t.Errorf("rollback to an unknown version = %d %s", status, body)
	}
	actions := workAPIAuditActions(t, f.db)
	if actions["work_intel.policy.save"] != 1 || actions["work_intel.policy.publish"] != 1 || actions["work_intel.policy.rollback"] != 1 {
		t.Errorf("audit actions = %v", actions)
	}
}

func TestWorkIntelAPIPolicyTest(t *testing.T) {
	f := newWorkAPIFixture(t)
	type testResult struct {
		Result     workClassificationView `json:"result"`
		Candidates []workCandidateView    `json:"candidates"`
		LLM        struct {
			Used  bool   `json:"used"`
			Error string `json:"error"`
		} `json:"llm"`
	}
	var out testResult
	f.do(t, f.full, http.MethodPost, "/policy/test", map[string]any{"text": workIntelPromptCode, "use_draft": false, "use_llm": false}, &out)
	if out.Result.CategoryID != "dev.codegen" || out.Result.Category.ID != "dev.codegen" || out.Result.Category.TopID != "dev" || out.Result.Method != "rule" ||
		out.Result.Status != "classified" || out.Result.ActionType != "create" || out.Result.Confidence < 0.9 || out.Result.WorkTitle == "" ||
		out.Result.Difficulty == "" || out.Result.Tags == nil || out.Result.Technologies == nil || out.LLM.Used || out.LLM.Error != "" ||
		len(out.Candidates) == 0 || out.Candidates[0].Category.ID == "" || out.Candidates[0].Score <= 0 || len(out.Candidates[0].Evidence) == 0 {
		t.Errorf("rule test = %+v candidates=%+v", out.Result, out.Candidates)
	}
	// The other features of a request count as well.
	f.do(t, f.full, http.MethodPost, "/policy/test", map[string]any{"text": "이거 처리해줘", "task_type": "generate", "languages": []string{"Go"},
		"mcp_tools": []string{"kubectl_get"}, "client": "Claude Code", "model": workAPIModel, "use_draft": false, "use_llm": false}, &out)
	if out.Result.CategoryID == "" || out.Result.Category.ID == "" {
		t.Errorf("test with features = %+v", out.Result)
	}
	// The model step is only used when it is asked for, enabled and allowed.
	f.do(t, f.full, http.MethodPost, "/policy/test", map[string]any{"text": workIntelPromptUnclear, "use_draft": false, "use_llm": true}, &out)
	if out.LLM.Used || !strings.Contains(out.LLM.Error, "work_intel.llm_enabled") || out.Result.Status != "unclassified" || f.fake.count() != 0 {
		t.Errorf("use_llm while the model step is off = %+v %+v", out.Result, out.LLM)
	}
	conf := f.admin.workIntelConf()
	conf.LLMEnabled = true
	f.admin.workIntelRuntime.Store(&conf)
	f.do(t, f.full, http.MethodPost, "/policy/test", map[string]any{"text": workIntelPromptUnclear, "use_draft": false, "use_llm": true}, &out)
	if out.LLM.Used || !strings.Contains(out.LLM.Error, "work_intel.llm_model") {
		t.Errorf("use_llm without a model = %+v", out.LLM)
	}
	conf.LLMModel = "judge-model"
	f.admin.workIntelRuntime.Store(&conf)
	f.fake.set(func(string) (string, time.Duration) {
		return workIntelAnswer("infra", "infra.k8s", "kim@example.com 의 파드 장애 분석", []string{"장애"}, 0.9), 0
	})
	f.do(t, f.full, http.MethodPost, "/policy/test", map[string]any{"text": workIntelPromptUnclear, "use_draft": false, "use_llm": true}, &out)
	// What the model wrote is redacted like any stored label.
	if !out.LLM.Used || out.LLM.Error != "" || out.Result.CategoryID != "infra.k8s" || out.Result.Method != "llm" || out.Result.Status != "classified" ||
		strings.Contains(out.Result.WorkTitle, "kim@example.com") || f.fake.count() != 1 {
		t.Errorf("use_llm = %+v %+v (calls %d)", out.Result, out.LLM, f.fake.count())
	}
	f.fake.set(func(string) (string, time.Duration) { return "this is not json", 0 })
	f.do(t, f.full, http.MethodPost, "/policy/test", map[string]any{"text": workIntelPromptUnclear, "use_draft": false, "use_llm": true}, &out)
	if out.LLM.Used || out.LLM.Error == "" || out.Result.Method != "rule" {
		t.Errorf("a failing model = %+v %+v", out.Result, out.LLM)
	}

	// use_draft tests the saved draft, not the published policy.
	f.savePolicy(t, func(p *workintel.Policy) {
		p.Categories = append(p.Categories, workintel.Category{ID: "office.quux", ParentID: "office", Name: "쿽스 처리", Enabled: true,
			Rules: workintel.Rules{Keywords: []string{"quuxfrobnicate", "blarghify", "zorpation"}, Weight: 3}})
	})
	sample := "quuxfrobnicate blarghify zorpation 작업을 처리해줘 quuxfrobnicate blarghify zorpation"
	f.do(t, f.full, http.MethodPost, "/policy/test", map[string]any{"text": sample, "use_draft": true, "use_llm": false}, &out)
	if out.Result.CategoryID != "office.quux" || out.Result.Category.Name != "쿽스 처리" {
		t.Errorf("draft test = %+v", out.Result)
	}
	f.do(t, f.full, http.MethodPost, "/policy/test", map[string]any{"text": sample, "use_draft": false, "use_llm": false}, &out)
	if out.Result.CategoryID == "office.quux" {
		t.Errorf("the published policy already knows the draft's category: %+v", out.Result)
	}

	for _, body := range []map[string]any{
		{"text": "", "use_draft": false, "use_llm": false},
		{"text": strings.Repeat("가", 3000), "use_draft": false, "use_llm": false},
	} {
		if status, raw := f.call(t, f.full, http.MethodPost, "/policy/test", body); status != http.StatusBadRequest || workAPIErrorCode(raw) != "work_policy_test_text_invalid" {
			t.Errorf("test with a bad text = %d %s", status, raw)
		}
	}
	// A test is a computation: it logs no request and stores no text.
	rows, err := f.db.RecentRequests(context.Background(), store.RequestFilter{Limit: 100})
	if err != nil || len(rows) != 12 {
		t.Errorf("%d requests are logged after the tests, want the fixture's 12 (%v)", len(rows), err)
	}
	if got := workIntelQuery(t, f.workIntelEnv, `SELECT COUNT(*) FROM prompt_logs WHERE redacted_text LIKE '%quuxfrobnicate%' OR content_text LIKE '%quuxfrobnicate%'`); !reflect.DeepEqual(got, []string{"0"}) {
		t.Errorf("the test text was stored: %v", got)
	}
}

func TestWorkIntelAPIEvaluate(t *testing.T) {
	env := newWorkAPIEnv(t)
	type evaluation struct {
		Sample      int      `json:"sample"`
		Accuracy    *float64 `json:"accuracy"`
		TopAccuracy *float64 `json:"top_accuracy"`
		ByCategory  []struct {
			Category workintel.CategoryRef `json:"category"`
			Total    int                   `json:"total"`
			Correct  int                   `json:"correct"`
		} `json:"by_category"`
		Confusions []struct {
			Expected string `json:"expected"`
			Got      string `json:"got"`
			Count    int    `json:"count"`
		} `json:"confusions"`
		Note string `json:"note"`
	}
	var code, sql []string
	for i := 0; i < 12; i++ {
		code = append(code, env.send(t, "key-a1", fmt.Sprintf("sess-c%d", i), workAPIModel, workIntelPromptCode))
	}
	for i := 0; i < 10; i++ {
		sql = append(sql, env.send(t, "key-a2", fmt.Sprintf("sess-s%d", i), workAPIModel, workIntelPromptSQL))
	}
	env.run(t)

	var out evaluation
	env.do(t, env.full, http.MethodPost, "/policy/evaluate", map[string]any{"use_draft": false, "limit": 500}, &out)
	if out.Sample != 0 || out.Accuracy != nil || out.TopAccuracy != nil || len(out.ByCategory) != 0 || len(out.Confusions) != 0 || !strings.Contains(out.Note, "20건") {
		t.Errorf("evaluation without corrections = %+v", out)
	}
	// An administrator says all 22 are code generation: right for the code
	// requests, a correction for the SQL ones.
	var corrected struct {
		Corrected int `json:"corrected"`
	}
	env.do(t, env.full, http.MethodPost, "/review/correct", map[string]any{"request_ids": append(append([]string{}, code...), sql...),
		"category_id": "dev.codegen", "reason": "평가용 정답"}, &corrected)
	if corrected.Corrected != 22 {
		t.Fatalf("corrected %d of 22", corrected.Corrected)
	}
	env.do(t, env.full, http.MethodPost, "/policy/evaluate", map[string]any{"use_draft": false, "limit": 500}, &out)
	// The rules still say data.sql for the ten SQL prompts: 12 of 22 agree, and
	// "data" is not "dev" at the top level either.
	if out.Sample != 22 || out.Accuracy == nil || *out.Accuracy != 0.5455 || out.TopAccuracy == nil || *out.TopAccuracy != 0.5455 ||
		len(out.ByCategory) != 1 || out.ByCategory[0].Category.ID != "dev.codegen" || out.ByCategory[0].Total != 22 || out.ByCategory[0].Correct != 12 ||
		len(out.Confusions) != 1 || out.Confusions[0].Expected != "dev.codegen" || out.Confusions[0].Got != "data.sql" || out.Confusions[0].Count != 10 ||
		strings.Contains(out.Note, "제외") {
		t.Errorf("evaluation = %+v", out)
	}
	// A draft is evaluated the same way. One that folds code generation into SQL
	// work reads every correction as "data.sql": the ten SQL prompts now agree
	// and the twelve code prompts, which the rules no longer place there, do not.
	env.savePolicy(t, func(p *workintel.Policy) {
		workAPICategory(p, "dev.codegen").MergedInto = "data.sql"
	})
	env.do(t, env.full, http.MethodPost, "/policy/evaluate", map[string]any{"use_draft": true, "limit": 500}, &out)
	if out.Sample != 22 || *out.Accuracy != 0.4545 || len(out.ByCategory) != 1 || out.ByCategory[0].Category.ID != "data.sql" || out.ByCategory[0].Correct != 10 ||
		len(out.Confusions) != 1 || out.Confusions[0].Expected != "data.sql" || out.Confusions[0].Count != 12 {
		t.Errorf("evaluation of the draft = %+v", out)
	}
	// Corrections whose prompt is gone cannot be replayed; they are left out and
	// the note says how many.
	env.exec(t, `DELETE FROM prompt_logs WHERE request_id IN (?, ?)`, sql[0], sql[1])
	env.do(t, env.full, http.MethodPost, "/policy/evaluate", map[string]any{"use_draft": false, "limit": 500}, &out)
	if out.Sample != 20 || *out.Accuracy != 0.6 || out.Confusions[0].Count != 8 || !strings.Contains(out.Note, "2건은") || !strings.Contains(out.Note, "제외") {
		t.Errorf("evaluation after two prompts were purged = %+v", out)
	}
	env.exec(t, `DELETE FROM prompt_logs WHERE request_id = ?`, sql[2])
	env.do(t, env.full, http.MethodPost, "/policy/evaluate", map[string]any{"use_draft": false, "limit": 500}, &out)
	if out.Sample != 19 || out.Accuracy != nil || !strings.Contains(out.Note, "19건") || !strings.Contains(out.Note, "3건은") {
		t.Errorf("evaluation below the minimum sample = %+v", out)
	}
	// A team-scoped administrator evaluates on their own team's corrections:
	// the beta team has none.
	env.do(t, env.betaAdmin, http.MethodPost, "/policy/evaluate", map[string]any{"use_draft": false, "limit": 500}, &out)
	if out.Sample != 0 || out.Accuracy != nil {
		t.Errorf("evaluation as the beta team = %+v", out)
	}
	if status, body := env.call(t, env.full, http.MethodPost, "/policy/evaluate", map[string]any{"use_draft": false, "limit": 999999}); status != http.StatusBadRequest {
		t.Errorf("evaluation with a huge limit = %d %s", status, body)
	}
}

func TestWorkIntelAPICorrectionAndRebuild(t *testing.T) {
	f := newWorkAPIFixture(t)
	ctx := context.Background()
	requestsOf := func(parent string) map[string]int64 {
		t.Helper()
		var categories workCategoriesResponse
		f.get(t, f.full, "/categories?"+f.period+"&metric=requests&parent="+parent, &categories)
		out := map[string]int64{"(unclassified)": categories.Unclassified.Requests, "(total)": categories.Total.Requests}
		for _, row := range categories.Rows {
			out[row.Category.ID] = row.Current.Requests
		}
		return out
	}
	if got := requestsOf(""); !reflect.DeepEqual(got, map[string]int64{"dev": 6, "data": 1, "infra": 1, "other": 1, "(unclassified)": 1, "(total)": 10}) {
		t.Fatalf("before the correction = %v", got)
	}

	type correction struct {
		Corrected   int      `json:"corrected"`
		DaysRebuilt []string `json:"days_rebuilt"`
		Skipped     int      `json:"skipped"`
	}
	// r5 is the SQL request and r7 the unclassified one; both become code review.
	var out correction
	f.do(t, f.full, http.MethodPost, "/review/correct", map[string]any{"request_ids": []string{f.ids[4], f.ids[6], "req_does_not_exist"},
		"category_id": "dev.review", "action_type": "verify", "reason": "리뷰 요청이었음"}, &out)
	if out.Corrected != 2 || !reflect.DeepEqual(out.DaysRebuilt, []string{f.today}) || out.Skipped != 1 {
		t.Fatalf("correction = %+v", out)
	}
	// The old categories lose the two requests and the new one gains them, in
	// the same response cycle.
	// data stays listed at zero: it had a request in the previous period.
	if got := requestsOf(""); !reflect.DeepEqual(got, map[string]int64{"dev": 8, "data": 0, "infra": 1, "other": 1, "(unclassified)": 0, "(total)": 10}) {
		t.Errorf("after the correction = %v", got)
	}
	if got := requestsOf("dev"); !reflect.DeepEqual(got, map[string]int64{"dev.codegen": 6, "dev.review": 2, "(unclassified)": 0, "(total)": 8}) {
		t.Errorf("children of dev after the correction = %v", got)
	}
	var overview workOverviewResponse
	f.get(t, f.full, "/overview?"+f.period, &overview)
	if !reflect.DeepEqual(overview.Methods, []workMethodCount{{"rule", 8}, {"llm", 0}, {"cache", 0}, {"manual", 2}}) ||
		!reflect.DeepEqual(overview.Statuses, []workStatusCount{{"classified", 10}, {"review", 0}, {"unclassified", 0}, {"failed", 0}}) ||
		overview.Current.ClassifiedRate != 1 || overview.Current.Requests != 10 || overview.Current.Sessions != 4 {
		t.Errorf("overview after the correction = methods %+v statuses %+v", overview.Methods, overview.Statuses)
	}
	var requests workRequestsResponse
	f.get(t, f.full, "/requests?"+f.period+"&method=manual", &requests)
	if requests.Count != 2 || requests.Rows[0].RequestID != f.ids[6] || requests.Rows[0].Category.ID != "dev.review" || requests.Rows[0].ActionType != "verify" ||
		requests.Rows[0].Confidence != 1 || requests.Rows[0].Status != "classified" || !strings.Contains(requests.Rows[0].WorkTitle, "코드 리뷰") {
		t.Errorf("corrected requests = %+v", requests.Rows)
	}
	var review workReviewResponse
	f.get(t, f.full, "/review", &review)
	if review.Count != 0 || review.Summary.Unclassified != 0 {
		t.Errorf("review queue after the correction = %+v", review)
	}
	var detail workSessionDetailResponse
	f.get(t, f.full, "/sessions/sess-a3", &detail)
	if detail.Session.Primary.ID != "dev.codegen" || len(detail.Session.Secondary) != 1 || detail.Session.Secondary[0].ID != "dev.review" || len(detail.Segments) != 2 {
		t.Errorf("sess-a3 after the correction = %+v", detail.Session)
	}
	// The correction is kept as evaluation data.
	corrections, err := f.db.ListWorkCorrections(ctx, 10)
	if err != nil || len(corrections) != 2 {
		t.Fatalf("corrections = %+v, %v", corrections, err)
	}
	byRequest := map[string]store.WorkCorrection{}
	for _, c := range corrections {
		byRequest[c.RequestID] = c
	}
	if c := byRequest[f.ids[4]]; c.FromCategoryID != "data.sql" || c.ToCategoryID != "dev.review" || c.ToAction != "verify" || c.FromMethod != "rule" ||
		c.Actor != "wi-full-admin" || c.Reason != "리뷰 요청이었음" || c.PolicyVersion != 1 {
		t.Errorf("correction of r5 = %+v", c)
	}
	if c := byRequest[f.ids[6]]; c.FromCategoryID != "other" || c.FromConfidence != 0 {
		t.Errorf("correction of r7 = %+v", c)
	}
	// Correcting to the same category again changes no aggregate.
	f.do(t, f.full, http.MethodPost, "/review/correct", map[string]any{"request_ids": []string{f.ids[4]}, "category_id": "dev.review", "action_type": "verify", "reason": "다시"}, &out)
	if out.Corrected != 1 || len(out.DaysRebuilt) != 0 {
		t.Errorf("repeated correction = %+v", out)
	}

	for name, c := range map[string]struct {
		body map[string]any
		code string
		want int
	}{
		"unknown category":  {map[string]any{"request_ids": []string{f.ids[0]}, "category_id": "dev.nope", "reason": "x"}, "work_category_unknown", 422},
		"unknown action":    {map[string]any{"request_ids": []string{f.ids[0]}, "category_id": "dev.review", "action_type": "juggle", "reason": "x"}, "work_action_unknown", 422},
		"no reason":         {map[string]any{"request_ids": []string{f.ids[0]}, "category_id": "dev.review", "reason": " "}, "work_intel_invalid_body", 400},
		"no ids":            {map[string]any{"request_ids": []string{}, "category_id": "dev.review", "reason": "x"}, "work_intel_invalid_body", 400},
		"too many ids":      {map[string]any{"request_ids": make([]string, 0), "category_id": "dev.review", "reason": "x", "many": true}, "work_intel_invalid_body", 400},
		"not a json object": {nil, "work_intel_invalid_body", 400},
	} {
		if c.body != nil && c.body["many"] == true {
			ids := make([]string, 501)
			for i := range ids {
				ids[i] = fmt.Sprintf("req_%d", i)
			}
			c.body = map[string]any{"request_ids": ids, "category_id": "dev.review", "reason": "x"}
		}
		var body any = c.body
		if c.body == nil {
			body = "nope"
		}
		if status, raw := f.call(t, f.full, http.MethodPost, "/review/correct", body); status != c.want || workAPIErrorCode(raw) != c.code {
			t.Errorf("%s = %d %s", name, status, raw)
		}
	}
	// A category that is switched off cannot be corrected into.
	saved := f.savePolicy(t, func(p *workintel.Policy) { workAPICategory(p, "dev.test").Enabled = false })
	f.publish(t, saved.Revision, "테스트 분류 끔")
	if status, raw := f.call(t, f.full, http.MethodPost, "/review/correct", map[string]any{"request_ids": []string{f.ids[0]}, "category_id": "dev.test", "reason": "x"}); status != 422 || workAPIErrorCode(raw) != "work_category_unknown" {
		t.Errorf("correction into a disabled category = %d %s", status, raw)
	}

	// A team-scoped administrator changes their own team's rows only: r8 is beta's.
	f.do(t, f.alphaAdmin, http.MethodPost, "/review/correct", map[string]any{"request_ids": []string{f.ids[7], f.ids[0]}, "category_id": "dev.debug", "reason": "디버깅이었음"}, &out)
	if out.Corrected != 1 || out.Skipped != 1 {
		t.Errorf("correction by the alpha team = %+v", out)
	}
	facts, err := f.db.WorkClassificationsByID(ctx, []string{f.ids[7], f.ids[0]})
	if err != nil || len(facts) != 2 {
		t.Fatal(err)
	}
	for _, fact := range facts {
		switch fact.RequestID {
		case f.ids[7]:
			if fact.CategoryID != "dev.codegen" || fact.Method != "rule" || fact.CorrectedBy != "" {
				t.Errorf("the beta team's request was changed: %+v", fact)
			}
		case f.ids[0]:
			if fact.CategoryID != "dev.debug" || fact.Method != "manual" || fact.CorrectedBy != "wi-alpha-admin" || fact.ActionType != "create" || fact.PolicyVersion != 2 {
				t.Errorf("the alpha team's request = %+v", fact)
			}
		}
	}
	if got := requestsOf("dev"); !reflect.DeepEqual(got, map[string]int64{"dev.codegen": 5, "dev.review": 2, "dev.debug": 1, "(unclassified)": 0, "(total)": 8}) {
		t.Errorf("children of dev after the team's correction = %v", got)
	}

	// Rebuild: an aggregate that drifted from its facts is regenerated from them.
	f.exec(t, `UPDATE work_daily SET requests = requests + 5 WHERE day = ? AND category_id = ?`, f.today, "dev.codegen")
	f.exec(t, `DELETE FROM work_session_segments WHERE session_id = ?`, "sess-b1")
	if got := requestsOf(""); got["(total)"] == 10 {
		t.Fatalf("the aggregate was not disturbed: %v", got)
	}
	var rebuilt struct {
		DaysRebuilt     []string `json:"days_rebuilt"`
		Skipped         []string `json:"skipped"`
		SessionsRebuilt int      `json:"sessions_rebuilt"`
	}
	f.do(t, f.full, http.MethodPost, "/rebuild", map[string]any{"from": f.prev, "to": f.today, "reason": "집계 불일치 복구"}, &rebuilt)
	if !reflect.DeepEqual(rebuilt.DaysRebuilt, []string{f.prev, f.today}) || len(rebuilt.Skipped) != 0 || rebuilt.SessionsRebuilt != 6 {
		t.Errorf("rebuild = %+v", rebuilt)
	}
	if got := requestsOf(""); !reflect.DeepEqual(got, map[string]int64{"dev": 8, "data": 0, "infra": 1, "other": 1, "(unclassified)": 0, "(total)": 10}) {
		t.Errorf("after the rebuild = %v", got)
	}
	f.get(t, f.full, "/overview?"+f.period, &overview)
	if overview.Current.Sessions != 4 {
		t.Errorf("sessions after the rebuild = %d", overview.Current.Sessions)
	}
	for name, body := range map[string]map[string]any{
		"too long":  {"from": workAPIDay(-100), "to": f.today, "reason": "x"},
		"reversed":  {"from": f.today, "to": f.prev, "reason": "x"},
		"no reason": {"from": f.today, "to": f.today, "reason": ""},
		"bad day":   {"from": "today", "to": f.today, "reason": "x"},
	} {
		if status, raw := f.call(t, f.full, http.MethodPost, "/rebuild", body); status != http.StatusBadRequest || workAPIErrorCode(raw) != "work_intel_invalid_body" {
			t.Errorf("rebuild %s = %d %s", name, status, raw)
		}
	}
	actions := workAPIAuditActions(t, f.db)
	if actions["work_intel.review.correct"] != 3 || actions["work_intel.rebuild"] != 1 {
		t.Errorf("audit actions = %v", actions)
	}
}
