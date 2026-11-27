package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/store"
	"vibe-coders/internal/workintel"
)

// The classification console's side of the API: the policy draft and its
// published versions, the test and evaluation of a policy, manual correction
// and the rebuild of aggregates. These routes work whether or not analytics
// is switched on.
//
// The policy is one document for the whole organisation, so changing it (and
// rebuilding whole days) is refused to a team-scoped administrator.

const (
	// workIntelTestTextLimit bounds the sample text of a policy test.
	workIntelTestTextLimit = 8 << 10
	// workIntelEvaluateMinSample is the number of usable corrections below which
	// an accuracy would be noise.
	workIntelEvaluateMinSample = 20
	workIntelEvaluateDefault   = 500
	workIntelEvaluateMax       = 5000
	workIntelMaxCorrections    = 500
	workIntelMaxConfusions     = 20
	// workIntelImpactDays is how far back a publication counts the requests in
	// the categories it removes, merges or disables.
	workIntelImpactDays = 90
	// workIntelRebuildMaxDays bounds one rebuild call.
	workIntelRebuildMaxDays = 92
	workIntelVersionList    = 100
)

func workIntelParsePolicy(raw string) (workintel.Policy, error) {
	var policy workintel.Policy
	if err := json.Unmarshal([]byte(raw), &policy); err != nil {
		return policy, err
	}
	return workintel.Normalize(policy), nil
}

func workIntelPolicyRejected(w http.ResponseWriter, issues []workintel.Issue) {
	writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
		"error":  map[string]any{"message": "the classification policy has errors", "type": "invalid_request_error", "param": nil, "code": "work_policy_invalid"},
		"issues": issues,
	})
}

func (s *Server) handleWorkIntelPolicyGet(w http.ResponseWriter, r *http.Request, _ string) {
	ctx := r.Context()
	draft, err := s.db.GetWorkPolicyDraft(ctx)
	if err != nil {
		workIntelFailed(w, r, "reading the policy draft", err)
		return
	}
	latest, err := s.db.LatestWorkPolicyVersion(ctx)
	if err != nil {
		workIntelFailed(w, r, "reading the published policy", err)
		return
	}
	config, err := workIntelParsePolicy(draft.ConfigJSON)
	if err != nil {
		workIntelFailed(w, r, "reading the policy draft", err)
		return
	}
	// The draft is dirty when publishing it would change the policy in force.
	dirty := true
	if published, err := workIntelParsePolicy(latest.ConfigJSON); err == nil {
		a, _ := json.Marshal(config)
		b, _ := json.Marshal(published)
		dirty = string(a) != string(b)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"config": config, "revision": draft.Revision, "updated_by": draft.UpdatedBy, "updated_at": draft.UpdatedAt,
		"published_version": latest.Version, "published_at": latest.PublishedAt, "dirty": dirty,
		"defaults": map[string]any{"action_types": workintel.DefaultActionTypes(), "thresholds": workintel.DefaultThresholds()},
	})
}

func (s *Server) handleWorkIntelPolicyPut(w http.ResponseWriter, r *http.Request, _ string) {
	caller, ok := s.workIntelCallerOf(w, r)
	if !ok || !caller.requireGlobal(w) {
		return
	}
	var payload struct {
		Config           *workintel.Policy `json:"config"`
		ExpectedRevision *int              `json:"expected_revision"`
		Reason           string            `json:"reason"`
	}
	if !workIntelDecode(w, r, &payload) {
		return
	}
	if payload.Config == nil {
		workIntelError(w, http.StatusBadRequest, "work_intel_invalid_body", "config is required")
		return
	}
	if payload.ExpectedRevision == nil || *payload.ExpectedRevision < 1 {
		workIntelError(w, http.StatusBadRequest, "work_policy_revision_missing", "expected_revision is required: the revision the edit started from")
		return
	}
	reason, fits := workIntelClip(payload.Reason, 1000)
	if !fits {
		workIntelError(w, http.StatusBadRequest, "work_intel_invalid_body", "reason must be at most 1,000 characters")
		return
	}
	config := workintel.Normalize(*payload.Config)
	if issues := workintel.Validate(config); len(issues) > 0 {
		workIntelPolicyRejected(w, issues)
		return
	}
	ctx := r.Context()
	before, err := s.db.GetWorkPolicyDraft(ctx)
	if err != nil {
		workIntelFailed(w, r, "reading the policy draft", err)
		return
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		workIntelFailed(w, r, "encoding the policy", err)
		return
	}
	saved, err := s.db.SaveWorkPolicyDraft(ctx, string(encoded), *payload.ExpectedRevision, caller.actor)
	if errors.Is(err, store.ErrWorkPolicyConflict) {
		workIntelError(w, http.StatusConflict, "work_policy_conflict", "the policy draft changed since it was loaded; reload it and apply the change again")
		return
	}
	if err != nil {
		workIntelFailed(w, r, "saving the policy draft", err)
		return
	}
	beforeCategories := 0
	if previous, err := workIntelParsePolicy(before.ConfigJSON); err == nil {
		beforeCategories = len(previous.Categories)
	}
	s.auditAdmin(r, "work_intel.policy.save",
		auditJSON(map[string]any{"revision": before.Revision, "categories": beforeCategories}),
		auditJSON(map[string]any{"revision": saved.Revision, "categories": len(config.Categories), "reason": reason}))
	writeJSON(w, http.StatusOK, map[string]any{"config": config, "revision": saved.Revision, "updated_by": saved.UpdatedBy, "updated_at": saved.UpdatedAt})
}

func (s *Server) handleWorkIntelPolicyVersions(w http.ResponseWriter, r *http.Request, _ string) {
	// One more than is shown, so the oldest row shown still has a predecessor
	// to be compared with.
	versions, err := s.db.ListWorkPolicyVersions(r.Context(), workIntelVersionList+1)
	if err != nil {
		workIntelFailed(w, r, "listing the policy versions", err)
		return
	}
	policies := make([]workintel.Policy, len(versions))
	for i, version := range versions {
		policies[i], _ = workIntelParsePolicy(version.ConfigJSON)
	}
	type row struct {
		Version     int               `json:"version"`
		Note        string            `json:"note"`
		PublishedBy string            `json:"published_by"`
		PublishedAt string            `json:"published_at"`
		Categories  int               `json:"categories"`
		Changes     workintel.Changes `json:"changes"`
	}
	rows := []row{}
	for i, version := range versions {
		if i >= workIntelVersionList {
			break
		}
		// The first version has nothing before it: listing every category as
		// added would say nothing.
		changes := workintel.Diff(policies[i], policies[i])
		if i+1 < len(versions) {
			changes = workintel.Diff(policies[i+1], policies[i])
		}
		rows = append(rows, row{Version: version.Version, Note: version.Note, PublishedBy: version.PublishedBy, PublishedAt: version.PublishedAt,
			Categories: len(policies[i].Categories), Changes: changes})
	}
	writeJSON(w, http.StatusOK, map[string]any{"versions": rows})
}

func (s *Server) handleWorkIntelPolicyVersion(w http.ResponseWriter, r *http.Request, param string) {
	number, err := strconv.Atoi(param)
	if err != nil || number < 1 {
		workIntelError(w, http.StatusBadRequest, "work_intel_invalid_query", "version must be a positive integer")
		return
	}
	version, found, err := s.db.GetWorkPolicyVersion(r.Context(), number)
	if err != nil {
		workIntelFailed(w, r, "reading the policy version", err)
		return
	}
	if !found {
		workIntelError(w, http.StatusNotFound, "work_policy_version_not_found", "no such policy version")
		return
	}
	config, err := workIntelParsePolicy(version.ConfigJSON)
	if err != nil {
		workIntelFailed(w, r, "reading the policy version", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"version": version.Version, "config": config, "note": version.Note,
		"published_by": version.PublishedBy, "published_at": version.PublishedAt})
}

// workIntelRetiredCategories lists the categories a new policy takes out of
// use compared with the one before it: removed, newly merged into another, or
// switched off. Requests classified into them are reported elsewhere from now on.
func workIntelRetiredCategories(previous, next workintel.Policy) (removed, retired []string) {
	before := map[string]workintel.Category{}
	for _, category := range previous.Categories {
		before[category.ID] = category
	}
	after := map[string]bool{}
	seen := map[string]bool{}
	for _, category := range next.Categories {
		after[category.ID] = true
		old, existed := before[category.ID]
		if !existed {
			continue
		}
		if (category.MergedInto != "" && category.MergedInto != old.MergedInto) || (old.Enabled && !category.Enabled) {
			if !seen[category.ID] {
				seen[category.ID] = true
				retired = append(retired, category.ID)
			}
		}
	}
	for id := range before {
		if !after[id] {
			removed = append(removed, id)
			retired = append(retired, id)
		}
	}
	sort.Strings(removed)
	sort.Strings(retired)
	return removed, retired
}

func (s *Server) handleWorkIntelPolicyPublish(w http.ResponseWriter, r *http.Request, _ string) {
	caller, ok := s.workIntelCallerOf(w, r)
	if !ok || !caller.requireGlobal(w) {
		return
	}
	var payload struct {
		ExpectedRevision *int   `json:"expected_revision"`
		Note             string `json:"note"`
	}
	if !workIntelDecode(w, r, &payload) {
		return
	}
	if payload.ExpectedRevision == nil || *payload.ExpectedRevision < 1 {
		workIntelError(w, http.StatusBadRequest, "work_policy_revision_missing", "expected_revision is required: the revision of the draft that was reviewed")
		return
	}
	note, fits := workIntelClip(payload.Note, 1000)
	if !fits {
		workIntelError(w, http.StatusBadRequest, "work_intel_invalid_body", "note must be at most 1,000 characters")
		return
	}
	ctx := r.Context()
	draft, err := s.db.GetWorkPolicyDraft(ctx)
	if err != nil {
		workIntelFailed(w, r, "reading the policy draft", err)
		return
	}
	if draft.Revision != *payload.ExpectedRevision {
		workIntelError(w, http.StatusConflict, "work_policy_conflict", "the policy draft changed since it was reviewed; reload it before publishing")
		return
	}
	next, err := workIntelParsePolicy(draft.ConfigJSON)
	if err != nil {
		workIntelPolicyRejected(w, []workintel.Issue{{Path: "", Message: "저장된 초안을 읽을 수 없습니다."}})
		return
	}
	if _, issues := workintel.Compile(next); len(issues) > 0 {
		workIntelPolicyRejected(w, issues)
		return
	}
	latest, err := s.db.LatestWorkPolicyVersion(ctx)
	if err != nil {
		workIntelFailed(w, r, "reading the published policy", err)
		return
	}
	previous, _ := workIntelParsePolicy(latest.ConfigJSON)
	removed, retired := workIntelRetiredCategories(previous, next)
	var affected int64
	if len(retired) > 0 {
		today := store.WorkIntelDay(time.Now())
		summary, err := s.db.WorkFactSummary(ctx, store.WorkFilter{From: workIntelShiftDay(today, -(workIntelImpactDays - 1)), To: today, Categories: retired})
		if err != nil {
			workIntelFailed(w, r, "measuring the impact of the publication", err)
			return
		}
		affected = summary.Total
	}
	encoded, err := json.Marshal(next)
	if err != nil {
		workIntelFailed(w, r, "encoding the policy", err)
		return
	}
	version, err := s.db.PublishWorkPolicyChecked(ctx, store.WorkPolicyPublish{ConfigJSON: string(encoded), Note: note, Actor: caller.actor,
		ExpectedDraftRevision: *payload.ExpectedRevision})
	if errors.Is(err, store.ErrWorkPolicyConflict) {
		workIntelError(w, http.StatusConflict, "work_policy_conflict", "the policy draft changed since it was reviewed; reload it before publishing")
		return
	}
	if err != nil {
		workIntelFailed(w, r, "publishing the policy", err)
		return
	}
	// This instance classifies and presents with the new version from now on;
	// the others notice within their cache age.
	_, _ = s.workIntelActiveEngine(ctx, 0)
	s.auditAdmin(r, "work_intel.policy.publish",
		auditJSON(map[string]any{"version": latest.Version, "categories": len(previous.Categories)}),
		auditJSON(map[string]any{"version": version.Version, "draft_revision": draft.Revision, "categories": len(next.Categories),
			"categories_removed": len(removed), "affected_requests": affected, "note": note}))
	writeJSON(w, http.StatusOK, map[string]any{"version": version.Version, "published_at": version.PublishedAt,
		"impact": map[string]any{"categories_removed": len(removed), "affected_requests": affected}})
}

func (s *Server) handleWorkIntelPolicyRollback(w http.ResponseWriter, r *http.Request, _ string) {
	caller, ok := s.workIntelCallerOf(w, r)
	if !ok || !caller.requireGlobal(w) {
		return
	}
	var payload struct {
		Version *int   `json:"version"`
		Note    string `json:"note"`
	}
	if !workIntelDecode(w, r, &payload) {
		return
	}
	note, fits := workIntelClip(payload.Note, 1000)
	if payload.Version == nil || *payload.Version < 1 || !fits {
		workIntelError(w, http.StatusBadRequest, "work_intel_invalid_body", "version must be a published version and note at most 1,000 characters")
		return
	}
	ctx := r.Context()
	target, found, err := s.db.GetWorkPolicyVersion(ctx, *payload.Version)
	if err != nil {
		workIntelFailed(w, r, "reading the policy version", err)
		return
	}
	if !found {
		workIntelError(w, http.StatusNotFound, "work_policy_version_not_found", "no such policy version")
		return
	}
	policy, err := workIntelParsePolicy(target.ConfigJSON)
	if err != nil {
		workIntelPolicyRejected(w, []workintel.Issue{{Path: "", Message: "그 버전의 정책을 읽을 수 없습니다."}})
		return
	}
	// An old version may no longer satisfy today's rules; it is not put back in
	// force without being checked.
	if _, issues := workintel.Compile(policy); len(issues) > 0 {
		workIntelPolicyRejected(w, issues)
		return
	}
	latest, err := s.db.LatestWorkPolicyVersion(ctx)
	if err != nil {
		workIntelFailed(w, r, "reading the published policy", err)
		return
	}
	if note == "" {
		note = fmt.Sprintf("버전 %d의 내용으로 되돌림", target.Version)
	}
	encoded, err := json.Marshal(policy)
	if err != nil {
		workIntelFailed(w, r, "encoding the policy", err)
		return
	}
	version, err := s.db.PublishWorkPolicyChecked(ctx, store.WorkPolicyPublish{ConfigJSON: string(encoded), Note: note, Actor: caller.actor, ReplaceDraft: true})
	if err != nil {
		workIntelFailed(w, r, "publishing the policy", err)
		return
	}
	_, _ = s.workIntelActiveEngine(ctx, 0)
	s.auditAdmin(r, "work_intel.policy.rollback",
		auditJSON(map[string]any{"version": latest.Version}),
		auditJSON(map[string]any{"version": version.Version, "restored_version": target.Version, "note": note}))
	writeJSON(w, http.StatusOK, map[string]any{"version": version.Version, "published_at": version.PublishedAt})
}

// workIntelEngineFor returns the engine of the saved draft or of the
// published policy. A draft that does not compile is reported with its issues.
func (s *Server) workIntelEngineFor(ctx context.Context, useDraft bool) (*workintel.Engine, int, []workintel.Issue, error) {
	if !useDraft {
		snap, err := s.workIntelActiveEngine(ctx, 0)
		if err != nil {
			return nil, 0, nil, err
		}
		return snap.engine, snap.version, nil, nil
	}
	draft, err := s.db.GetWorkPolicyDraft(ctx)
	if err != nil {
		return nil, 0, nil, err
	}
	policy, err := workIntelParsePolicy(draft.ConfigJSON)
	if err != nil {
		return nil, 0, []workintel.Issue{{Path: "", Message: "저장된 초안을 읽을 수 없습니다."}}, nil
	}
	engine, issues := workintel.Compile(policy)
	return engine, 0, issues, nil
}

type workClassificationView struct {
	Category        workintel.CategoryRef `json:"category"`
	CategoryID      string                `json:"category_id"`
	ActionType      string                `json:"action_type"`
	Confidence      float64               `json:"confidence"`
	Method          string                `json:"method"`
	Status          string                `json:"status"`
	Tags            []string              `json:"tags"`
	Technologies    []string              `json:"technologies"`
	WorkTitle       string                `json:"work_title"`
	TargetSystem    string                `json:"target_system"`
	NewCategoryHint string                `json:"new_category_hint"`
	Difficulty      string                `json:"difficulty"`
}

type workCandidateView struct {
	Category workintel.CategoryRef `json:"category"`
	Score    float64               `json:"score"`
	Evidence []string              `json:"evidence"`
}

func workIntelList(items []string) []string {
	if items == nil {
		return []string{}
	}
	return items
}

// handleWorkIntelPolicyTest classifies a sample text. The text is redacted the
// way a stored prompt is before anything looks at it, and it is neither
// stored nor logged.
func (s *Server) handleWorkIntelPolicyTest(w http.ResponseWriter, r *http.Request, _ string) {
	var payload struct {
		Text      string   `json:"text"`
		TaskType  string   `json:"task_type"`
		Languages []string `json:"languages"`
		MCPTools  []string `json:"mcp_tools"`
		Client    string   `json:"client"`
		Model     string   `json:"model"`
		UseDraft  bool     `json:"use_draft"`
		UseLLM    bool     `json:"use_llm"`
	}
	if !workIntelDecode(w, r, &payload) {
		return
	}
	if strings.TrimSpace(payload.Text) == "" || len(payload.Text) > workIntelTestTextLimit {
		workIntelError(w, http.StatusBadRequest, "work_policy_test_text_invalid", "text must be 1 byte to 8 KB")
		return
	}
	if len(payload.Languages) > 20 || len(payload.MCPTools) > 50 || len(payload.TaskType) > 64 || len(payload.Client) > 128 || len(payload.Model) > 160 {
		workIntelError(w, http.StatusBadRequest, "work_intel_invalid_body", "too many languages or tools, or a field is too long")
		return
	}
	ctx := r.Context()
	engine, _, issues, err := s.workIntelEngineFor(ctx, payload.UseDraft)
	if err != nil {
		workIntelFailed(w, r, "loading the policy", err)
		return
	}
	if len(issues) > 0 {
		workIntelPolicyRejected(w, issues)
		return
	}
	features := workintel.Features{
		Text: s.workIntelRedactor(ctx)(payload.Text), TaskType: strings.TrimSpace(payload.TaskType), Languages: workIntelList(payload.Languages),
		MCPServers: []string{}, MCPTools: workIntelList(payload.MCPTools), Client: strings.TrimSpace(payload.Client),
		Model: strings.TrimSpace(payload.Model), Endpoint: "/v1/chat/completions", PolicyFlags: []string{},
	}
	rule := engine.Classify(features)
	final := rule
	llm := map[string]any{"used": false, "error": "", "code": ""}
	if payload.UseLLM {
		conf := s.workIntelConf()
		switch target, block := s.workIntelLLMTargetFor(ctx, conf); {
		case !conf.LLMEnabled:
			llm["error"] = "LLM 분류가 꺼져 있어(work_intel.llm_enabled) 규칙 결과만 보여 줍니다."
		case block != nil:
			llm["error"] = block.Reason
		case !s.workIntel.llmBudget.take(time.Now(), conf.LLMMaxPerMinute):
			// The test screen draws on the worker's per-minute budget, so it cannot
			// be used to call the model faster than the worker may.
			llm["error"] = fmt.Sprintf("분류 모델 호출 한도(분당 %d건, work_intel.llm_max_per_minute)를 지금 모두 쓰고 있어 규칙 결과만 보여 줍니다. 잠시 뒤 다시 시도하세요.",
				conf.LLMMaxPerMinute)
			llm["code"] = workIntelLLMBlockedBudget
		default:
			call, err := s.workIntelLLMClassify(ctx, engine, target, features, conf.LLMTimeout)
			if err != nil {
				llm["error"] = "분류 모델 호출에 실패했습니다: " + boundedWorkIntelError(err)
				break
			}
			accuracy, _ := s.db.WorkMethodAccuracy(ctx, time.Now().Add(-workIntelAccuracyWindow))
			semantic := s.redactWorkIntelResult(ctx, engine.ApplyCalibration(call.Result, accuracy))
			final = workintel.MergeLLM(rule, semantic)
			llm["used"] = true
		}
	}
	candidates := []workCandidateView{}
	for _, candidate := range rule.Candidates {
		candidates = append(candidates, workCandidateView{Category: engine.Ref(candidate.CategoryID), Score: candidate.Score, Evidence: workIntelList(candidate.Evidence)})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"result": workClassificationView{
			Category: engine.Ref(engine.Canonical(final.CategoryID)), CategoryID: final.CategoryID, ActionType: final.ActionType,
			Confidence: final.Confidence, Method: final.Method, Status: final.Status, Tags: workIntelList(final.Tags),
			Technologies: workIntelList(final.Technologies), WorkTitle: final.WorkTitle, TargetSystem: final.TargetSystem,
			NewCategoryHint: final.NewCategoryHint, Difficulty: final.Difficulty,
		},
		"candidates": candidates, "llm": llm,
	})
}

// handleWorkIntelPolicyEvaluate replays the rules on requests an
// administrator corrected and compares the result with the correction. Only
// corrections whose prompt text is still stored can be replayed: without the
// text the rules have nothing to read and would look far worse than they are.
func (s *Server) handleWorkIntelPolicyEvaluate(w http.ResponseWriter, r *http.Request, _ string) {
	caller, ok := s.workIntelCallerOf(w, r)
	if !ok {
		return
	}
	var payload struct {
		UseDraft bool `json:"use_draft"`
		Limit    int  `json:"limit"`
	}
	if !workIntelDecode(w, r, &payload) {
		return
	}
	if payload.Limit == 0 {
		payload.Limit = workIntelEvaluateDefault
	}
	if payload.Limit < 1 || payload.Limit > workIntelEvaluateMax {
		workIntelError(w, http.StatusBadRequest, "work_intel_invalid_body", "limit must be 1 to 5000")
		return
	}
	ctx := r.Context()
	engine, _, issues, err := s.workIntelEngineFor(ctx, payload.UseDraft)
	if err != nil {
		workIntelFailed(w, r, "loading the policy", err)
		return
	}
	if len(issues) > 0 {
		workIntelPolicyRejected(w, issues)
		return
	}
	corrections, err := s.db.ListWorkCorrections(ctx, payload.Limit)
	if err != nil {
		workIntelFailed(w, r, "reading the corrections", err)
		return
	}
	// The newest correction of a request is the answer.
	expected := map[string]string{}
	ids := []string{}
	for _, correction := range corrections {
		if _, seen := expected[correction.RequestID]; !seen {
			expected[correction.RequestID] = correction.ToCategoryID
			ids = append(ids, correction.RequestID)
		}
	}
	requests, err := s.db.WorkIntelRequests(ctx, ids, engine.Policy().LLM.MaxInputChars)
	if err != nil {
		workIntelFailed(w, r, "reading the corrected requests", err)
		return
	}
	type tally struct{ total, correct int }
	byCategory := map[string]*tally{}
	confusions := map[[2]string]int{}
	found := map[string]bool{}
	sample, correct, topCorrect, withoutText := 0, 0, 0, 0
	for _, request := range requests {
		if !caller.allows(request.Team) {
			continue
		}
		found[request.RequestID] = true
		if strings.TrimSpace(request.Text) == "" {
			withoutText++
			continue
		}
		want := engine.Canonical(expected[request.RequestID])
		got := engine.Canonical(engine.Classify(request.Features()).CategoryID)
		sample++
		entry := byCategory[want]
		if entry == nil {
			entry = &tally{}
			byCategory[want] = entry
		}
		entry.total++
		if got == want {
			correct++
			entry.correct++
		} else {
			confusions[[2]string{want, got}]++
		}
		if workIntelTopOf(got) == workIntelTopOf(want) {
			topCorrect++
		}
	}
	if !caller.scoped {
		// The request itself is gone (and its prompt with it).
		for _, id := range ids {
			if !found[id] {
				withoutText++
			}
		}
	}
	type categoryRow struct {
		Category workintel.CategoryRef `json:"category"`
		Total    int                   `json:"total"`
		Correct  int                   `json:"correct"`
	}
	type confusionRow struct {
		Expected string `json:"expected"`
		Got      string `json:"got"`
		Count    int    `json:"count"`
	}
	out := struct {
		Sample      int            `json:"sample"`
		Accuracy    *float64       `json:"accuracy"`
		TopAccuracy *float64       `json:"top_accuracy"`
		ByCategory  []categoryRow  `json:"by_category"`
		Confusions  []confusionRow `json:"confusions"`
		Note        string         `json:"note"`
		// SkippedNoText is how many corrections could not be replayed.
		SkippedNoText int `json:"skipped_no_text"`
	}{Sample: sample, ByCategory: []categoryRow{}, Confusions: []confusionRow{}, SkippedNoText: withoutText}
	skipped := ""
	if withoutText > 0 {
		skipped = fmt.Sprintf(" 프롬프트 보존 기간이 지나 본문이 남아 있지 않은 보정 %d건은 다시 분류할 수 없어 제외했습니다.", withoutText)
	}
	if sample < workIntelEvaluateMinSample {
		out.Note = fmt.Sprintf("프롬프트가 남아 있는 보정 이력이 %d건이라 정확도를 계산하지 않았습니다. %d건 이상이어야 합니다.", sample, workIntelEvaluateMinSample) + skipped
		writeJSON(w, http.StatusOK, out)
		return
	}
	accuracy, topAccuracy := workIntelRatio(float64(correct)/float64(sample)), workIntelRatio(float64(topCorrect)/float64(sample))
	out.Accuracy, out.TopAccuracy = &accuracy, &topAccuracy
	for id, entry := range byCategory {
		out.ByCategory = append(out.ByCategory, categoryRow{Category: engine.Ref(id), Total: entry.total, Correct: entry.correct})
	}
	sort.Slice(out.ByCategory, func(i, j int) bool {
		if out.ByCategory[i].Total != out.ByCategory[j].Total {
			return out.ByCategory[i].Total > out.ByCategory[j].Total
		}
		return out.ByCategory[i].Category.ID < out.ByCategory[j].Category.ID
	})
	for pair, count := range confusions {
		out.Confusions = append(out.Confusions, confusionRow{Expected: pair[0], Got: pair[1], Count: count})
	}
	sort.Slice(out.Confusions, func(i, j int) bool {
		a, b := out.Confusions[i], out.Confusions[j]
		if a.Count != b.Count {
			return a.Count > b.Count
		}
		if a.Expected != b.Expected {
			return a.Expected < b.Expected
		}
		return a.Got < b.Got
	})
	if len(out.Confusions) > workIntelMaxConfusions {
		out.Confusions = out.Confusions[:workIntelMaxConfusions]
	}
	out.Note = fmt.Sprintf("보정된 요청 %d건을 규칙만으로 다시 분류해 관리자가 정한 업무와 비교했습니다. LLM 단계는 포함하지 않습니다.", sample) + skipped
	writeJSON(w, http.StatusOK, out)
}

// handleWorkIntelCorrect sets the category of requests by hand. The
// correction is recorded as evaluation data, and the aggregates of the days
// and sessions it touches are rebuilt before the response, so the dashboards
// agree with it at once.
func (s *Server) handleWorkIntelCorrect(w http.ResponseWriter, r *http.Request, _ string) {
	caller, ok := s.workIntelCallerOf(w, r)
	if !ok {
		return
	}
	var payload struct {
		RequestIDs []string `json:"request_ids"`
		CategoryID string   `json:"category_id"`
		ActionType string   `json:"action_type"`
		Reason     string   `json:"reason"`
	}
	if !workIntelDecode(w, r, &payload) {
		return
	}
	ids := []string{}
	seen := map[string]bool{}
	for _, id := range payload.RequestIDs {
		if id = strings.TrimSpace(id); id == "" || len(id) > 200 {
			workIntelError(w, http.StatusBadRequest, "work_intel_invalid_body", "request_ids holds an empty or oversized id")
			return
		}
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	reason, fits := workIntelClip(payload.Reason, 1000)
	if len(ids) == 0 || len(ids) > workIntelMaxCorrections || reason == "" || !fits {
		workIntelError(w, http.StatusBadRequest, "work_intel_invalid_body", "request_ids must hold 1 to 500 ids and reason 1 to 1,000 characters")
		return
	}
	ctx := r.Context()
	snap, err := s.workIntelActiveEngine(ctx, 0)
	if err != nil {
		workIntelFailed(w, r, "loading the policy", err)
		return
	}
	engine := snap.engine
	category := strings.ToLower(strings.TrimSpace(payload.CategoryID))
	// A correction names a category requests can be in today: registered,
	// enabled and not merged into another.
	if category == "" || !engine.Known(category) || !engine.Ref(category).Enabled || engine.Canonical(category) != category {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": map[string]any{
			"message": "category_id is not an enabled category of the published policy", "type": "invalid_request_error", "param": "category_id", "code": "work_category_unknown"}})
		return
	}
	action := strings.ToLower(strings.TrimSpace(payload.ActionType))
	if action != "" && !engine.KnownAction(action) {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": map[string]any{
			"message": "action_type is not an action type of the published policy", "type": "invalid_request_error", "param": "action_type", "code": "work_action_unknown"}})
		return
	}
	facts, err := s.db.WorkClassificationsByID(ctx, ids)
	if err != nil {
		workIntelFailed(w, r, "reading the requests", err)
		return
	}
	changes := make([]store.WorkClassificationChange, 0, len(facts))
	for _, fact := range facts {
		// A request of another team is left alone and not reported: to this
		// caller it does not exist.
		if !caller.allows(fact.Team) {
			continue
		}
		titleAction := action
		if titleAction == "" {
			titleAction = fact.ActionType
		}
		title := engine.Ref(category).Name
		if name := engine.ActionName(titleAction); name != "" {
			title += " · " + name
		}
		changes = append(changes, store.WorkClassificationChange{
			RequestID: fact.RequestID, Reassign: true, CategoryID: category, TopCategoryID: workIntelTopOf(category), ActionType: action,
			Confidence: 1, Method: workintel.MethodManual, Status: workintel.StatusClassified, PolicyVersion: snap.version,
			// What the rules observed about the request stays; only its place changes.
			Tags: fact.Tags, Technologies: fact.Technologies, TargetSystem: fact.TargetSystem, WorkTitle: title,
			CorrectedBy: caller.actor, Reason: reason,
		})
	}
	result, err := s.db.UpdateWorkClassifications(ctx, changes)
	if err != nil {
		workIntelFailed(w, r, "storing the correction", err)
		return
	}
	rebuilt, err := s.db.RebuildWorkDays(ctx, result.Days)
	if err == nil {
		_, err = s.db.RebuildWorkSessions(ctx, result.SessionIDs)
	}
	s.auditAdmin(r, "work_intel.review.correct", "", auditJSON(map[string]any{
		"category_id": category, "action_type": action, "requested": len(ids), "corrected": result.Reassigned,
		"days": result.Days, "reason": reason}))
	if err != nil {
		// The correction is stored and the stale days are marked, so the worker
		// rebuilds them on its next pass; the caller is told it is not done yet.
		workIntelFailed(w, r, "rebuilding the aggregates after the correction", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"corrected": result.Reassigned, "days_rebuilt": workIntelList(rebuilt.Days),
		"skipped": len(ids) - result.Reassigned})
}

// handleWorkIntelRebuild regenerates the aggregates of a period from the
// classification facts. It changes no classification; it is the repair for
// aggregates that no longer match their facts.
func (s *Server) handleWorkIntelRebuild(w http.ResponseWriter, r *http.Request, _ string) {
	caller, ok := s.workIntelCallerOf(w, r)
	if !ok || !caller.requireGlobal(w) {
		return
	}
	var payload struct {
		From   string `json:"from"`
		To     string `json:"to"`
		Reason string `json:"reason"`
	}
	if !workIntelDecode(w, r, &payload) {
		return
	}
	from, okFrom := workIntelParseDay(strings.TrimSpace(payload.From))
	to, okTo := workIntelParseDay(strings.TrimSpace(payload.To))
	reason, fits := workIntelClip(payload.Reason, 1000)
	if !okFrom || !okTo || from.After(to) || workIntelDaysBetween(from, to) > workIntelRebuildMaxDays || reason == "" || !fits {
		workIntelError(w, http.StatusBadRequest, "work_intel_invalid_body",
			fmt.Sprintf("from and to must be days (YYYY-MM-DD) at most %d days apart, and reason 1 to 1,000 characters", workIntelRebuildMaxDays))
		return
	}
	ctx := r.Context()
	days := workIntelDayList(workIntelFormatDay(from), workIntelFormatDay(to))
	rebuilt, err := s.db.RebuildWorkDays(ctx, days)
	if err != nil {
		workIntelFailed(w, r, "rebuilding the daily aggregates", err)
		return
	}
	sessions, err := s.db.RebuildWorkSessionsOfDays(ctx, rebuilt.Days)
	if err != nil {
		workIntelFailed(w, r, "rebuilding the sessions", err)
		return
	}
	s.auditAdmin(r, "work_intel.rebuild", "", auditJSON(map[string]any{
		"from": days[0], "to": days[len(days)-1], "days_rebuilt": len(rebuilt.Days), "skipped": len(rebuilt.SkippedDays),
		"sessions_rebuilt": sessions.Sessions, "reason": reason}))
	writeJSON(w, http.StatusOK, map[string]any{"days_rebuilt": workIntelList(rebuilt.Days), "skipped": workIntelList(rebuilt.SkippedDays),
		"sessions_rebuilt": sessions.Sessions})
}
