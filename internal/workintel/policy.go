package workintel

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

// OtherCategoryID is the fallback top-level category. It must always exist and
// stay enabled, because every lookup that cannot be resolved lands on it.
const OtherCategoryID = "other"

// UnknownAction is the fallback action type id. It is never listed in a policy.
const UnknownAction = "unknown"

// Limits enforced by Validate. They bound both the stored document and the
// size of the compiled matcher.
const (
	MaxCategories          = 400
	MaxKeywordsPerCategory = 200
	MaxKeywordBytes        = 80
	// MaxPolicyKeywordBytes bounds all keywords of a policy together. The
	// per-category limits alone would still allow megabytes of keywords,
	// and the matcher is built from every one of them on each compile.
	MaxPolicyKeywordBytes = 256 << 10
	MaxHintsPerList       = 50
	MaxActionTypes        = 30
	MaxExamples           = 20
	MaxNameRunes          = 80
	MaxDescriptionRunes   = 500
	MaxSystemPromptBytes  = 8000
	MinInputChars         = 200
	MaxInputChars         = 8000
	MaxMinGroupSize       = 50
	MaxMinEvidence        = 10
	MaxRuleWeight         = 10.0
	maxCategoryDepth      = 3
)

// Policy is the classification policy document stored as config_json.
type Policy struct {
	Categories  []Category   `json:"categories"`
	ActionTypes []ActionType `json:"action_types"`
	Thresholds  Thresholds   `json:"thresholds"`
	LLM         LLMConfig    `json:"llm"`
	Baselines   []Baseline   `json:"baselines"`
}

// Category is one node of the work category tree. The id is an immutable
// slug whose dots encode the level ("dev", "dev.codegen", "dev.codegen.api").
type Category struct {
	ID          string   `json:"id"`
	ParentID    string   `json:"parent_id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Examples    []string `json:"examples"`
	Enabled     bool     `json:"enabled"`
	// MergedInto folds this category into another one of the same level. Rows
	// classified before the merge keep their id; lookups go through
	// Engine.Canonical.
	MergedInto string `json:"merged_into"`
	Rules      Rules  `json:"rules"`
}

// Rules are the matching hints of a category. See the package documentation
// for how keywords are matched.
type Rules struct {
	Keywords   []string `json:"keywords"`
	MCPServers []string `json:"mcp_servers"`
	MCPTools   []string `json:"mcp_tools"`
	Languages  []string `json:"languages"`
	TaskTypes  []string `json:"task_types"`
	Clients    []string `json:"clients"`
	// Weight scales every piece of evidence of this category. Zero means 1.
	Weight float64 `json:"weight"`
}

// ActionType is what the user asked the model to do with the subject.
type ActionType struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Keywords []string `json:"keywords"`
}

// Thresholds control when a rule result is accepted, sent to review or hidden.
type Thresholds struct {
	// Accept is the confidence from which a rule result is final.
	Accept float64 `json:"accept"`
	// ReviewBelow is the confidence under which a result goes to the review queue.
	ReviewBelow float64 `json:"review_below"`
	// MinEvidence is the number of distinct pieces of evidence a category needs
	// before a rule result can reach Accept.
	MinEvidence int `json:"min_evidence"`
	// MinGroupSize is the smallest number of distinct users an aggregate cell
	// may describe before it is suppressed.
	MinGroupSize int `json:"min_group_size"`
}

// LLMConfig configures the optional semantic classification step.
type LLMConfig struct {
	SystemPrompt  string `json:"system_prompt"`
	MaxInputChars int    `json:"max_input_chars"`
}

// Baseline is the admin-supplied assumption behind a savings estimate.
type Baseline struct {
	CategoryID    string  `json:"category_id"`
	ManualMinutes float64 `json:"manual_minutes"`
	AIMinutes     float64 `json:"ai_minutes"`
	HourlyCostKRW float64 `json:"hourly_cost_krw"`
	Note          string  `json:"note"`
}

// Issue is one validation problem, addressed by a JSON-ish path such as
// "categories[3].rules.keywords[7]".
type Issue struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

// Changes summarises what differs between two policies, by category id.
type Changes struct {
	Added   []string `json:"added"`
	Removed []string `json:"removed"`
	Renamed []string `json:"renamed"`
	// Merged lists categories whose merged_into was set or redirected.
	Merged []string `json:"merged"`
	// RulesChanged lists categories whose matching behaviour changed: rules,
	// the enabled flag, or a merge that was undone.
	RulesChanged []string `json:"rules_changed"`
}

// CategoryRef is the compact category description embedded in API responses.
type CategoryRef struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Level    int    `json:"level"`
	ParentID string `json:"parent_id"`
	TopID    string `json:"top_id"`
	Enabled  bool   `json:"enabled"`
}

var requiredTopLevelIDs = []string{
	"dev", "infra", "itsm", "security", "data", "office",
	"planning", "support", "knowledge", "ai", "automation", OtherCategoryID,
}

// RequiredTopLevelIDs returns the top-level category ids every policy must keep.
// Analytics and stored rows refer to them, so they can be disabled but not removed.
func RequiredTopLevelIDs() []string {
	return append([]string(nil), requiredTopLevelIDs...)
}

// DefaultThresholds returns the thresholds used when a policy does not set them.
func DefaultThresholds() Thresholds {
	return Thresholds{Accept: 0.72, ReviewBelow: 0.5, MinEvidence: 2, MinGroupSize: 3}
}

// DefaultPolicy returns the built-in policy: the twelve top-level categories
// with their second-level children, the eight action types, default
// thresholds and the default LLM prompt. It has no baselines; savings are not
// estimated until an administrator supplies them.
func DefaultPolicy() Policy {
	return Normalize(Policy{
		Categories:  defaultCategories(),
		ActionTypes: DefaultActionTypes(),
		Thresholds:  DefaultThresholds(),
		LLM:         LLMConfig{SystemPrompt: defaultSystemPrompt, MaxInputChars: defaultMaxInputChars},
		Baselines:   []Baseline{},
	})
}

// Normalize returns a cleaned copy of p: ids and keywords are lower-cased and
// trimmed, duplicates and empty entries are dropped, nil lists become empty
// lists and unset settings take their defaults. It never fails; Validate
// reports what is still wrong afterwards.
//
// A zero threshold means "not set": accept, min_evidence and min_group_size
// take their defaults individually. review_below may legitimately be 0 (never
// send anything to review), so it only defaults when the whole thresholds
// object is empty.
func Normalize(p Policy) Policy {
	out := Policy{
		Categories:  make([]Category, 0, len(p.Categories)),
		ActionTypes: make([]ActionType, 0, len(p.ActionTypes)),
		Baselines:   make([]Baseline, 0, len(p.Baselines)),
	}
	for _, c := range p.Categories {
		n := Category{
			ID:          normalizeID(c.ID),
			ParentID:    normalizeID(c.ParentID),
			Name:        collapseSpace(c.Name),
			Description: collapseSpace(c.Description),
			Examples:    cleanList(c.Examples, false),
			Enabled:     c.Enabled,
			MergedInto:  normalizeID(c.MergedInto),
			Rules: Rules{
				Keywords:   cleanList(c.Rules.Keywords, true),
				MCPServers: cleanList(c.Rules.MCPServers, true),
				MCPTools:   cleanList(c.Rules.MCPTools, true),
				Languages:  cleanList(c.Rules.Languages, true),
				TaskTypes:  cleanList(c.Rules.TaskTypes, true),
				Clients:    cleanList(c.Rules.Clients, false),
				Weight:     c.Rules.Weight,
			},
		}
		if n.Rules.Weight == 0 {
			n.Rules.Weight = 1
		}
		// The parent is fully determined by the id, so an omitted parent_id is
		// filled in rather than rejected.
		if n.ParentID == "" {
			n.ParentID = parentOfID(n.ID)
		}
		out.Categories = append(out.Categories, n)
	}

	for _, a := range p.ActionTypes {
		out.ActionTypes = append(out.ActionTypes, ActionType{
			ID:       normalizeID(a.ID),
			Name:     collapseSpace(a.Name),
			Keywords: cleanList(a.Keywords, true),
		})
	}
	if len(out.ActionTypes) == 0 {
		out.ActionTypes = DefaultActionTypes()
	}

	out.Thresholds = p.Thresholds
	if out.Thresholds == (Thresholds{}) {
		out.Thresholds = DefaultThresholds()
	} else {
		def := DefaultThresholds()
		if out.Thresholds.Accept == 0 {
			out.Thresholds.Accept = def.Accept
		}
		if out.Thresholds.MinEvidence == 0 {
			out.Thresholds.MinEvidence = def.MinEvidence
		}
		if out.Thresholds.MinGroupSize == 0 {
			out.Thresholds.MinGroupSize = def.MinGroupSize
		}
	}

	out.LLM = LLMConfig{SystemPrompt: strings.TrimSpace(p.LLM.SystemPrompt), MaxInputChars: p.LLM.MaxInputChars}
	if out.LLM.SystemPrompt == "" {
		out.LLM.SystemPrompt = defaultSystemPrompt
	}
	if out.LLM.MaxInputChars == 0 {
		out.LLM.MaxInputChars = defaultMaxInputChars
	}

	for _, b := range p.Baselines {
		out.Baselines = append(out.Baselines, Baseline{
			CategoryID:    normalizeID(b.CategoryID),
			ManualMinutes: b.ManualMinutes,
			AIMinutes:     b.AIMinutes,
			HourlyCostKRW: b.HourlyCostKRW,
			Note:          collapseSpace(b.Note),
		})
	}
	return out
}

var (
	categoryIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*){0,2}$`)
	actionIDPattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)
)

// Validate checks a policy and returns every problem found, in document
// order. An empty result means the policy can be compiled. Callers should
// Normalize first; Compile does both.
func Validate(p Policy) []Issue {
	var issues []Issue
	add := func(path, format string, args ...any) {
		issues = append(issues, Issue{Path: path, Message: fmt.Sprintf(format, args...)})
	}

	if len(p.Categories) > MaxCategories {
		add("categories", "카테고리는 최대 %d개까지 등록할 수 있습니다. (현재 %d개)", MaxCategories, len(p.Categories))
	}

	byID := make(map[string]int, len(p.Categories))
	for i, c := range p.Categories {
		if _, dup := byID[c.ID]; !dup {
			byID[c.ID] = i
		}
	}

	seen := make(map[string]bool, len(p.Categories))
	for i, c := range p.Categories {
		path := fmt.Sprintf("categories[%d]", i)
		validID := categoryIDPattern.MatchString(c.ID)
		switch {
		case c.ID == "":
			add(path+".id", "카테고리 ID가 비어 있습니다.")
		case !validID:
			add(path+".id", "카테고리 ID '%s' 형식이 올바르지 않습니다. 영문 소문자·숫자·'-'·'_'만 쓰고 단계는 점으로 구분하며 최대 %d단계입니다.", c.ID, maxCategoryDepth)
		case seen[c.ID]:
			add(path+".id", "카테고리 ID '%s'가 중복되었습니다.", c.ID)
		}
		seen[c.ID] = true

		if validID {
			want := parentOfID(c.ID)
			switch {
			case want == "" && c.ParentID != "":
				add(path+".parent_id", "대분류 '%s'에는 상위 카테고리를 지정할 수 없습니다.", c.ID)
			case want != "" && c.ParentID == "":
				add(path+".parent_id", "카테고리 '%s'의 상위 카테고리가 비어 있습니다.", c.ID)
			case want != "" && !strings.HasPrefix(c.ID, c.ParentID+"."):
				add(path+".id", "하위 카테고리 ID는 상위 ID '%s.'로 시작해야 합니다.", c.ParentID)
			case want != "" && c.ParentID != want:
				add(path+".parent_id", "카테고리 '%s'의 상위 카테고리는 '%s'여야 합니다. 단계를 건너뛸 수 없습니다.", c.ID, want)
			}
			if c.ParentID != "" {
				if _, ok := byID[c.ParentID]; !ok {
					add(path+".parent_id", "상위 카테고리 '%s'가 없습니다.", c.ParentID)
				}
			}
		}

		if c.Name == "" {
			add(path+".name", "카테고리 이름이 비어 있습니다.")
		} else if utf8.RuneCountInString(c.Name) > MaxNameRunes {
			add(path+".name", "카테고리 이름은 %d자 이하여야 합니다.", MaxNameRunes)
		}
		if utf8.RuneCountInString(c.Description) > MaxDescriptionRunes {
			add(path+".description", "설명은 %d자 이하여야 합니다.", MaxDescriptionRunes)
		}
		if len(c.Examples) > MaxExamples {
			add(path+".examples", "예시는 최대 %d개까지 등록할 수 있습니다.", MaxExamples)
		}

		if c.ID == OtherCategoryID {
			if !c.Enabled {
				add(path+".enabled", "'%s' 카테고리는 분류되지 않은 요청이 모이는 곳이라 끌 수 없습니다.", OtherCategoryID)
			}
			if c.MergedInto != "" {
				add(path+".merged_into", "'%s' 카테고리는 다른 카테고리로 병합할 수 없습니다.", OtherCategoryID)
			}
		}

		if c.MergedInto != "" {
			target, ok := byID[c.MergedInto]
			switch {
			case c.MergedInto == c.ID:
				add(path+".merged_into", "카테고리를 자기 자신으로 병합할 수 없습니다.")
			case !ok:
				add(path+".merged_into", "병합 대상 카테고리 '%s'가 없습니다.", c.MergedInto)
			case levelOfID(p.Categories[target].ID) != levelOfID(c.ID):
				add(path+".merged_into", "같은 단계의 카테고리로만 병합할 수 있습니다.")
			case mergeCycle(p.Categories, byID, c.ID):
				add(path+".merged_into", "병합 관계가 순환합니다. ('%s'에서 시작해 다시 돌아옵니다.)", c.ID)
			}
		}

		validateList(add, path+".rules.keywords", "키워드", c.Rules.Keywords, MaxKeywordsPerCategory)
		validateList(add, path+".rules.mcp_servers", "MCP 서버", c.Rules.MCPServers, MaxHintsPerList)
		validateList(add, path+".rules.mcp_tools", "MCP 도구", c.Rules.MCPTools, MaxHintsPerList)
		validateList(add, path+".rules.languages", "언어", c.Rules.Languages, MaxHintsPerList)
		validateList(add, path+".rules.task_types", "작업 유형", c.Rules.TaskTypes, MaxHintsPerList)
		validateList(add, path+".rules.clients", "클라이언트", c.Rules.Clients, MaxHintsPerList)
		if c.Rules.Weight <= 0 || c.Rules.Weight > MaxRuleWeight {
			add(path+".rules.weight", "가중치는 0보다 크고 %g 이하여야 합니다.", MaxRuleWeight)
		}
	}

	keywordBytes := 0
	for _, c := range p.Categories {
		for _, kw := range c.Rules.Keywords {
			keywordBytes += len(kw)
		}
	}
	if keywordBytes > MaxPolicyKeywordBytes {
		add("categories", "전체 키워드의 합이 %dKB를 넘습니다. (현재 %dKB) 쓰지 않는 키워드를 정리해 주세요.", MaxPolicyKeywordBytes>>10, keywordBytes>>10)
	}

	for _, id := range requiredTopLevelIDs {
		if _, ok := byID[id]; !ok {
			add("categories", "필수 대분류 '%s'가 없습니다. 사용하지 않으려면 삭제하지 말고 꺼 두세요.", id)
		}
	}

	if len(p.ActionTypes) > MaxActionTypes {
		add("action_types", "작업 유형은 최대 %d개까지 등록할 수 있습니다.", MaxActionTypes)
	}
	seenAction := make(map[string]bool, len(p.ActionTypes))
	for i, a := range p.ActionTypes {
		path := fmt.Sprintf("action_types[%d]", i)
		switch {
		case a.ID == "":
			add(path+".id", "작업 유형 ID가 비어 있습니다.")
		case !actionIDPattern.MatchString(a.ID):
			add(path+".id", "작업 유형 ID '%s' 형식이 올바르지 않습니다. 영문 소문자·숫자·'-'·'_'만 쓸 수 있습니다.", a.ID)
		case a.ID == UnknownAction:
			add(path+".id", "'%s'는 판단할 수 없을 때 쓰는 예약된 ID라 등록할 수 없습니다.", UnknownAction)
		case seenAction[a.ID]:
			add(path+".id", "작업 유형 ID '%s'가 중복되었습니다.", a.ID)
		}
		seenAction[a.ID] = true
		if a.Name == "" {
			add(path+".name", "작업 유형 이름이 비어 있습니다.")
		} else if utf8.RuneCountInString(a.Name) > MaxNameRunes {
			add(path+".name", "작업 유형 이름은 %d자 이하여야 합니다.", MaxNameRunes)
		}
		validateList(add, path+".keywords", "키워드", a.Keywords, MaxKeywordsPerCategory)
	}

	t := p.Thresholds
	if t.Accept < 0 || t.Accept > 1 {
		add("thresholds.accept", "확정 기준은 0과 1 사이여야 합니다.")
	}
	if t.ReviewBelow < 0 || t.ReviewBelow > 1 {
		add("thresholds.review_below", "검토 기준은 0과 1 사이여야 합니다.")
	}
	if t.Accept < t.ReviewBelow {
		add("thresholds.accept", "확정 기준(%g)은 검토 기준(%g)보다 낮을 수 없습니다.", t.Accept, t.ReviewBelow)
	}
	if t.MinEvidence < 1 || t.MinEvidence > MaxMinEvidence {
		add("thresholds.min_evidence", "최소 근거 수는 1 이상 %d 이하여야 합니다.", MaxMinEvidence)
	}
	if t.MinGroupSize < 1 || t.MinGroupSize > MaxMinGroupSize {
		add("thresholds.min_group_size", "최소 그룹 크기는 1 이상 %d 이하여야 합니다.", MaxMinGroupSize)
	}

	if p.LLM.MaxInputChars < MinInputChars || p.LLM.MaxInputChars > MaxInputChars {
		add("llm.max_input_chars", "분류 모델에 보내는 글자 수는 %d 이상 %d 이하여야 합니다.", MinInputChars, MaxInputChars)
	}
	if len(p.LLM.SystemPrompt) > MaxSystemPromptBytes {
		add("llm.system_prompt", "시스템 프롬프트는 %d바이트 이하여야 합니다.", MaxSystemPromptBytes)
	}

	seenBaseline := make(map[string]bool, len(p.Baselines))
	for i, b := range p.Baselines {
		path := fmt.Sprintf("baselines[%d]", i)
		switch {
		case b.CategoryID == "":
			add(path+".category_id", "기준값의 카테고리 ID가 비어 있습니다.")
		case seenBaseline[b.CategoryID]:
			add(path+".category_id", "카테고리 '%s'의 기준값이 중복되었습니다.", b.CategoryID)
		default:
			if _, ok := byID[b.CategoryID]; !ok {
				add(path+".category_id", "기준값의 카테고리 '%s'가 없습니다.", b.CategoryID)
			}
		}
		seenBaseline[b.CategoryID] = true
		if b.ManualMinutes <= 0 {
			add(path+".manual_minutes", "수작업 소요 시간(분)은 0보다 커야 합니다.")
		}
		if b.AIMinutes <= 0 {
			add(path+".ai_minutes", "AI 활용 소요 시간(분)은 0보다 커야 합니다.")
		}
		if b.HourlyCostKRW < 0 {
			add(path+".hourly_cost_krw", "시간당 비용은 0 이상이어야 합니다.")
		}
	}
	return issues
}

// Diff reports what changed between two policies, by category id. Every list
// is sorted and non-nil so it serialises as [] rather than null.
func Diff(old, new Policy) Changes {
	ch := Changes{Added: []string{}, Removed: []string{}, Renamed: []string{}, Merged: []string{}, RulesChanged: []string{}}
	before := make(map[string]Category, len(old.Categories))
	for _, c := range old.Categories {
		before[c.ID] = c
	}
	after := make(map[string]bool, len(new.Categories))
	for _, c := range new.Categories {
		if after[c.ID] {
			continue
		}
		after[c.ID] = true
		prev, existed := before[c.ID]
		if !existed {
			ch.Added = append(ch.Added, c.ID)
			continue
		}
		if prev.Name != c.Name {
			ch.Renamed = append(ch.Renamed, c.ID)
		}
		mergeChanged := prev.MergedInto != c.MergedInto
		if mergeChanged && c.MergedInto != "" {
			ch.Merged = append(ch.Merged, c.ID)
		}
		if !rulesEqual(prev.Rules, c.Rules) || prev.Enabled != c.Enabled || (mergeChanged && c.MergedInto == "") {
			ch.RulesChanged = append(ch.RulesChanged, c.ID)
		}
	}
	for id := range before {
		if !after[id] {
			ch.Removed = append(ch.Removed, id)
		}
	}
	sort.Strings(ch.Added)
	sort.Strings(ch.Removed)
	sort.Strings(ch.Renamed)
	sort.Strings(ch.Merged)
	sort.Strings(ch.RulesChanged)
	return ch
}

func validateList(add func(path, format string, args ...any), path, label string, items []string, limit int) {
	if len(items) > limit {
		add(path, "%s는 카테고리마다 최대 %d개까지 등록할 수 있습니다. (현재 %d개)", label, limit, len(items))
	}
	for i, it := range items {
		switch {
		case strings.TrimSpace(it) == "":
			add(fmt.Sprintf("%s[%d]", path, i), "%s가 비어 있습니다.", label)
		case len(it) > MaxKeywordBytes:
			add(fmt.Sprintf("%s[%d]", path, i), "%s는 %d바이트 이하여야 합니다.", label, MaxKeywordBytes)
		}
	}
}

// mergeCycle reports whether following merged_into from start comes back to it.
func mergeCycle(cats []Category, byID map[string]int, start string) bool {
	cur := start
	for steps := 0; steps <= len(cats); steps++ {
		i, ok := byID[cur]
		if !ok {
			return false
		}
		next := cats[i].MergedInto
		if next == "" {
			return false
		}
		if next == start {
			return true
		}
		cur = next
	}
	// A chain longer than the number of categories can only be a loop that
	// does not pass through start; the categories on it report it themselves.
	return false
}

func rulesEqual(a, b Rules) bool {
	wa, wb := a.Weight, b.Weight
	if wa == 0 {
		wa = 1
	}
	if wb == 0 {
		wb = 1
	}
	return wa == wb &&
		sameSet(a.Keywords, b.Keywords) &&
		sameSet(a.MCPServers, b.MCPServers) &&
		sameSet(a.MCPTools, b.MCPTools) &&
		sameSet(a.Languages, b.Languages) &&
		sameSet(a.TaskTypes, b.TaskTypes) &&
		sameSet(a.Clients, b.Clients)
}

// sameSet compares two lists ignoring order, because the order of hints does
// not change how a request is classified.
func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	x := append([]string(nil), a...)
	y := append([]string(nil), b...)
	sort.Strings(x)
	sort.Strings(y)
	for i := range x {
		if x[i] != y[i] {
			return false
		}
	}
	return true
}

func normalizeID(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

// parentOfID returns the id one level up, or "" for a top-level id.
func parentOfID(id string) string {
	if i := strings.LastIndexByte(id, '.'); i > 0 {
		return id[:i]
	}
	return ""
}

func levelOfID(id string) int {
	return strings.Count(id, ".") + 1
}

func topOfID(id string) string {
	if i := strings.IndexByte(id, '.'); i > 0 {
		return id[:i]
	}
	return id
}

// collapseSpace trims s and folds every whitespace run into one space.
func collapseSpace(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// cleanList trims entries, optionally lower-cases them, and drops empty and
// duplicate ones while keeping the original order. Duplicates are detected
// case-insensitively either way. The result is never nil.
func cleanList(items []string, lower bool) []string {
	out := make([]string, 0, len(items))
	seen := make(map[string]bool, len(items))
	for _, it := range items {
		v := collapseSpace(it)
		if v == "" {
			continue
		}
		key := strings.ToLower(v)
		if seen[key] {
			continue
		}
		seen[key] = true
		if lower {
			v = key
		}
		out = append(out, v)
	}
	return out
}

func clonePolicy(p Policy) Policy {
	out := Policy{
		Categories:  make([]Category, len(p.Categories)),
		ActionTypes: make([]ActionType, len(p.ActionTypes)),
		Thresholds:  p.Thresholds,
		LLM:         p.LLM,
		Baselines:   append([]Baseline{}, p.Baselines...),
	}
	for i, c := range p.Categories {
		c.Examples = append([]string{}, c.Examples...)
		c.Rules.Keywords = append([]string{}, c.Rules.Keywords...)
		c.Rules.MCPServers = append([]string{}, c.Rules.MCPServers...)
		c.Rules.MCPTools = append([]string{}, c.Rules.MCPTools...)
		c.Rules.Languages = append([]string{}, c.Rules.Languages...)
		c.Rules.TaskTypes = append([]string{}, c.Rules.TaskTypes...)
		c.Rules.Clients = append([]string{}, c.Rules.Clients...)
		out.Categories[i] = c
	}
	for i, a := range p.ActionTypes {
		a.Keywords = append([]string{}, a.Keywords...)
		out.ActionTypes[i] = a
	}
	return out
}
