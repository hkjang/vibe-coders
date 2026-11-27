package workintel

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// minimalPolicy is the smallest valid policy: the twelve required top-level
// categories without rules. Tests add exactly the rules they are about, so a
// change to the built-in vocabulary cannot change what they prove.
func minimalPolicy() Policy {
	p := Policy{Thresholds: DefaultThresholds()}
	for _, id := range RequiredTopLevelIDs() {
		p.Categories = append(p.Categories, Category{ID: id, Name: "분류 " + id, Enabled: true})
	}
	return Normalize(p)
}

func withCategory(p Policy, id, keywords string, mutate ...func(*Category)) Policy {
	c := Category{ID: id, Name: "분류 " + id, Enabled: true, Rules: Rules{Keywords: list(keywords)}}
	for _, m := range mutate {
		m(&c)
	}
	p.Categories = append(p.Categories, c)
	return Normalize(p)
}

func setKeywords(p Policy, id, keywords string) Policy {
	for i := range p.Categories {
		if p.Categories[i].ID == id {
			p.Categories[i].Rules.Keywords = list(keywords)
			return Normalize(p)
		}
	}
	panic("no category " + id)
}

func categoryByID(t *testing.T, p *Policy, id string) *Category {
	t.Helper()
	for i := range p.Categories {
		if p.Categories[i].ID == id {
			return &p.Categories[i]
		}
	}
	t.Fatalf("category %q not found", id)
	return nil
}

func hasIssue(issues []Issue, pathPart, messagePart string) bool {
	for _, is := range issues {
		if strings.Contains(is.Path, pathPart) && strings.Contains(is.Message, messagePart) {
			return true
		}
	}
	return false
}

func TestDefaultPolicy(t *testing.T) {
	p := DefaultPolicy()
	if issues := Validate(p); len(issues) != 0 {
		t.Fatalf("built-in policy is invalid: %+v", issues)
	}

	wantNames := map[string]string{
		"dev": "소프트웨어 개발", "infra": "IT 인프라 운영", "itsm": "IT 서비스 운영", "security": "정보보호",
		"data": "데이터 분석", "office": "일반 사무", "planning": "경영 및 기획", "support": "고객 지원",
		"knowledge": "지식 관리", "ai": "AI 개발", "automation": "업무 자동화", "other": "기타 및 미분류",
	}
	children := map[string]int{}
	seenTop := map[string]bool{}
	for _, c := range p.Categories {
		if !c.Enabled {
			t.Errorf("%s is disabled by default", c.ID)
		}
		if c.ParentID == "" {
			seenTop[c.ID] = true
			if wantNames[c.ID] != c.Name {
				t.Errorf("top-level %s is named %q, want %q", c.ID, c.Name, wantNames[c.ID])
			}
			continue
		}
		children[c.ParentID]++
		if levelOfID(c.ID) != 2 {
			t.Errorf("%s: the built-in policy only has two levels", c.ID)
		}
		if c.ParentID != OtherCategoryID && len(c.Rules.Keywords) < 10 {
			t.Errorf("%s has only %d keywords", c.ID, len(c.Rules.Keywords))
		}
		if c.Description == "" {
			t.Errorf("%s has no description", c.ID)
		}
	}
	if len(seenTop) != 12 {
		t.Errorf("got %d top-level categories, want 12", len(seenTop))
	}
	for id := range wantNames {
		if n := children[id]; n < 3 || n > 5 {
			t.Errorf("%s has %d children, want 3 to 5", id, n)
		}
	}
	for _, id := range []string{
		"dev.codegen", "dev.refactor", "dev.review", "dev.test", "dev.debug", "infra.k8s", "infra.server",
		"infra.network", "infra.middleware", "itsm.incident", "itsm.deploy", "itsm.change", "itsm.request",
		"security.vuln", "security.review", "security.compliance", "data.sql", "data.extract", "data.stats",
		"data.viz", "office.report", "office.email", "office.translate", "office.summary", "ai.llm", "ai.rag",
		"ai.mcp", "ai.agent", "ai.prompt", "automation.repeat", "automation.integration",
	} {
		categoryByID(t, &p, id)
	}

	var actions []string
	for _, a := range p.ActionTypes {
		actions = append(actions, a.ID+"="+a.Name)
	}
	if got, want := strings.Join(actions, " "), "read=조회 analyze=분석 create=생성 modify=수정 delete=삭제 verify=검증 plan=계획 automate=자동화"; got != want {
		t.Errorf("action types = %s\nwant %s", got, want)
	}
	if p.Thresholds != (Thresholds{Accept: 0.72, ReviewBelow: 0.5, MinEvidence: 2, MinGroupSize: 3}) {
		t.Errorf("thresholds = %+v", p.Thresholds)
	}
	if !strings.Contains(p.LLM.SystemPrompt, "JSON") || p.LLM.MaxInputChars != 1500 {
		t.Errorf("LLM defaults = %q / %d", clipRunes(p.LLM.SystemPrompt, 30), p.LLM.MaxInputChars)
	}
	if len(p.Baselines) != 0 {
		t.Errorf("the built-in policy must not invent baselines, got %d", len(p.Baselines))
	}
}

func TestPolicyJSONRoundTrip(t *testing.T) {
	p := DefaultPolicy()
	p.Baselines = []Baseline{{CategoryID: "dev", ManualMinutes: 60, AIMinutes: 15, HourlyCostKRW: 50000, Note: "가정"}}
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{
		`"categories"`, `"parent_id"`, `"merged_into"`, `"mcp_servers"`, `"mcp_tools"`, `"task_types"`, `"action_types"`,
		`"review_below"`, `"min_evidence"`, `"min_group_size"`, `"system_prompt"`, `"max_input_chars"`,
		`"manual_minutes"`, `"ai_minutes"`, `"hourly_cost_krw"`, `"category_id"`,
	} {
		if !strings.Contains(string(raw), key) {
			t.Errorf("serialised policy lacks %s", key)
		}
	}
	var back Policy
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(Normalize(back), Normalize(p)) {
		t.Error("policy changed across a JSON round trip")
	}
	// Normalising twice must not change anything, or every save would
	// produce a spurious diff.
	if !reflect.DeepEqual(Normalize(Normalize(p)), Normalize(p)) {
		t.Error("Normalize is not idempotent")
	}
}

func TestNormalize(t *testing.T) {
	p := Normalize(Policy{
		Categories: []Category{{
			ID: "  Dev.CodeGen ", Name: "  코드   생성 ", Enabled: true,
			Examples: []string{" 예시 ", "", "예시"},
			Rules: Rules{
				Keywords:  []string{" Kubernetes ", "kubernetes", "", "단위   테스트"},
				Languages: []string{"Go", "GO"},
				Clients:   []string{"Claude Code", "claude code"},
			},
		}},
		Baselines: []Baseline{{CategoryID: " DEV ", ManualMinutes: 10, AIMinutes: 1}},
	})
	c := p.Categories[0]
	if c.ID != "dev.codegen" || c.ParentID != "dev" || c.Name != "코드 생성" {
		t.Errorf("category = %+v", c)
	}
	if got := strings.Join(c.Rules.Keywords, "|"); got != "kubernetes|단위 테스트" {
		t.Errorf("keywords = %q", got)
	}
	if got := strings.Join(c.Rules.Languages, "|"); got != "go" {
		t.Errorf("languages = %q", got)
	}
	// Client labels keep their capitalisation: they are shown as evidence.
	if got := strings.Join(c.Rules.Clients, "|"); got != "Claude Code" {
		t.Errorf("clients = %q", got)
	}
	if got := strings.Join(c.Examples, "|"); got != "예시" {
		t.Errorf("examples = %q", got)
	}
	if c.Rules.Weight != 1 {
		t.Errorf("weight = %v, want 1", c.Rules.Weight)
	}
	if c.Rules.MCPServers == nil || c.Rules.MCPTools == nil || c.Rules.TaskTypes == nil {
		t.Error("nil rule lists would serialise as null")
	}
	if p.Thresholds != DefaultThresholds() {
		t.Errorf("thresholds = %+v", p.Thresholds)
	}
	if len(p.ActionTypes) != 8 || p.LLM.MaxInputChars != 1500 || p.LLM.SystemPrompt == "" {
		t.Errorf("defaults not applied: %d actions, %d chars", len(p.ActionTypes), p.LLM.MaxInputChars)
	}
	if p.Baselines[0].CategoryID != "dev" {
		t.Errorf("baseline category = %q", p.Baselines[0].CategoryID)
	}

	// A deliberate review_below of 0 survives; the other zeros are "not set".
	q := Normalize(Policy{Thresholds: Thresholds{Accept: 0.9}})
	if q.Thresholds != (Thresholds{Accept: 0.9, ReviewBelow: 0, MinEvidence: 2, MinGroupSize: 3}) {
		t.Errorf("partial thresholds = %+v", q.Thresholds)
	}
}

func TestValidate(t *testing.T) {
	long := strings.Repeat("가", 30) // 90 bytes
	manyKeywords := make([]string, MaxKeywordsPerCategory+1)
	for i := range manyKeywords {
		manyKeywords[i] = fmt.Sprintf("kw%d", i)
	}
	tests := []struct {
		name    string
		mutate  func(p *Policy)
		path    string
		message string
	}{
		{"bad id characters", func(p *Policy) {
			p.Categories = append(p.Categories, Category{ID: "dev.Code Gen", ParentID: "dev", Name: "x", Enabled: true, Rules: Rules{Weight: 1}})
		}, ".id", "형식"},
		{"id starting with a dot", func(p *Policy) {
			p.Categories = append(p.Categories, Category{ID: ".x", Name: "x", Enabled: true, Rules: Rules{Weight: 1}})
		}, ".id", "형식"},
		{"four levels", func(p *Policy) {
			p.Categories = append(p.Categories, Category{ID: "dev.a.b.c", ParentID: "dev.a.b", Name: "x", Enabled: true, Rules: Rules{Weight: 1}})
		}, ".id", "최대 3단계"},
		{"empty id", func(p *Policy) {
			p.Categories = append(p.Categories, Category{Name: "x", Enabled: true, Rules: Rules{Weight: 1}})
		}, ".id", "비어"},
		{"duplicate id", func(p *Policy) {
			p.Categories = append(p.Categories, Category{ID: "dev", Name: "x", Enabled: true, Rules: Rules{Weight: 1}})
		}, ".id", "중복"},
		{"child not under its parent", func(p *Policy) {
			p.Categories = append(p.Categories, Category{ID: "dev.x", ParentID: "infra", Name: "x", Enabled: true, Rules: Rules{Weight: 1}})
		}, ".id", "infra."},
		{"skipped level", func(p *Policy) {
			p.Categories = append(p.Categories, Category{ID: "dev.a.b", ParentID: "dev", Name: "x", Enabled: true, Rules: Rules{Weight: 1}})
		}, ".parent_id", "건너뛸"},
		{"missing parent", func(p *Policy) {
			p.Categories = append(p.Categories, Category{ID: "dev.a.b", ParentID: "dev.a", Name: "x", Enabled: true, Rules: Rules{Weight: 1}})
		}, ".parent_id", "없습니다"},
		{"parent on a top-level", func(p *Policy) { p.Categories[0].ParentID = "infra" }, ".parent_id", "대분류"},
		{"empty name", func(p *Policy) { p.Categories[0].Name = "" }, ".name", "비어"},
		{"required top-level removed", func(p *Policy) { p.Categories = p.Categories[1:] }, "categories", "필수 대분류 'dev'"},
		{"other disabled", func(p *Policy) { categoryByID(t, p, "other").Enabled = false }, ".enabled", "끌 수 없습니다"},
		{"other merged", func(p *Policy) { categoryByID(t, p, "other").MergedInto = "dev" }, ".merged_into", "병합할 수 없습니다"},
		{"merge into itself", func(p *Policy) { categoryByID(t, p, "dev").MergedInto = "dev" }, ".merged_into", "자기 자신"},
		{"merge into a missing category", func(p *Policy) { categoryByID(t, p, "dev").MergedInto = "nope" }, ".merged_into", "없습니다"},
		{"merge across levels", func(p *Policy) {
			p.Categories = append(p.Categories, Category{ID: "dev.a", ParentID: "dev", Name: "x", Enabled: true, MergedInto: "infra", Rules: Rules{Weight: 1}})
		}, ".merged_into", "같은 단계"},
		{"merge cycle", func(p *Policy) {
			categoryByID(t, p, "dev").MergedInto = "infra"
			categoryByID(t, p, "infra").MergedInto = "itsm"
			categoryByID(t, p, "itsm").MergedInto = "dev"
		}, ".merged_into", "순환"},
		{"too many keywords", func(p *Policy) { p.Categories[0].Rules.Keywords = manyKeywords }, ".rules.keywords", "최대 200개"},
		{"keyword too long", func(p *Policy) { p.Categories[0].Rules.Keywords = []string{long} }, ".rules.keywords[0]", "80바이트"},
		{"hint too long", func(p *Policy) { p.Categories[0].Rules.MCPTools = []string{strings.Repeat("a", 81)} }, ".rules.mcp_tools[0]", "80바이트"},
		{"negative weight", func(p *Policy) { p.Categories[0].Rules.Weight = -1 }, ".rules.weight", "가중치"},
		{"too many categories", func(p *Policy) {
			for i := 0; i <= MaxCategories; i++ {
				p.Categories = append(p.Categories, Category{ID: fmt.Sprintf("dev.c%d", i), ParentID: "dev", Name: "x", Enabled: true, Rules: Rules{Weight: 1}})
			}
		}, "categories", "최대 400개"},
		{"too many keyword bytes in total", func(p *Policy) {
			// Each category stays within its own limits; only the sum is too large.
			for i := 0; i < 40; i++ {
				c := Category{ID: fmt.Sprintf("dev.bulk%d", i), ParentID: "dev", Name: "x", Enabled: true, Rules: Rules{Weight: 1}}
				for j := 0; j < MaxKeywordsPerCategory; j++ {
					c.Rules.Keywords = append(c.Rules.Keywords, fmt.Sprintf("%02d-%03d-%s", i, j, strings.Repeat("k", 60)))
				}
				p.Categories = append(p.Categories, c)
			}
		}, "categories", "전체 키워드"},
		{"accept above one", func(p *Policy) { p.Thresholds.Accept = 1.2 }, "thresholds.accept", "0과 1"},
		{"review_below negative", func(p *Policy) { p.Thresholds.ReviewBelow = -0.1 }, "thresholds.review_below", "0과 1"},
		{"accept below review_below", func(p *Policy) { p.Thresholds.Accept, p.Thresholds.ReviewBelow = 0.4, 0.6 }, "thresholds.accept", "낮을 수 없습니다"},
		{"min_group_size too large", func(p *Policy) { p.Thresholds.MinGroupSize = 51 }, "thresholds.min_group_size", "50"},
		{"min_group_size negative", func(p *Policy) { p.Thresholds.MinGroupSize = -1 }, "thresholds.min_group_size", "1 이상"},
		{"min_evidence negative", func(p *Policy) { p.Thresholds.MinEvidence = -1 }, "thresholds.min_evidence", "1 이상"},
		{"llm input too small", func(p *Policy) { p.LLM.MaxInputChars = 10 }, "llm.max_input_chars", "200"},
		{"reserved action id", func(p *Policy) { p.ActionTypes = append(p.ActionTypes, ActionType{ID: "unknown", Name: "모름"}) }, "action_types[8].id", "예약"},
		{"duplicate action id", func(p *Policy) { p.ActionTypes = append(p.ActionTypes, ActionType{ID: "read", Name: "조회"}) }, "action_types[8].id", "중복"},
		{"action without name", func(p *Policy) { p.ActionTypes[0].Name = "" }, "action_types[0].name", "비어"},
		{"baseline for a missing category", func(p *Policy) { p.Baselines = []Baseline{{CategoryID: "nope", ManualMinutes: 10, AIMinutes: 1}} }, "baselines[0].category_id", "없습니다"},
		{"baseline without manual minutes", func(p *Policy) { p.Baselines = []Baseline{{CategoryID: "dev", AIMinutes: 1}} }, "baselines[0].manual_minutes", "0보다"},
		{"baseline without ai minutes", func(p *Policy) { p.Baselines = []Baseline{{CategoryID: "dev", ManualMinutes: 10}} }, "baselines[0].ai_minutes", "0보다"},
		{"baseline with negative cost", func(p *Policy) {
			p.Baselines = []Baseline{{CategoryID: "dev", ManualMinutes: 10, AIMinutes: 1, HourlyCostKRW: -5}}
		}, "baselines[0].hourly_cost_krw", "0 이상"},
		{"duplicate baseline", func(p *Policy) {
			p.Baselines = []Baseline{{CategoryID: "dev", ManualMinutes: 10, AIMinutes: 1}, {CategoryID: "dev", ManualMinutes: 10, AIMinutes: 1}}
		}, "baselines[1].category_id", "중복"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := minimalPolicy()
			tt.mutate(&p)
			issues := Validate(p)
			if !hasIssue(issues, tt.path, tt.message) {
				t.Errorf("want an issue at %q mentioning %q, got %+v", tt.path, tt.message, issues)
			}
			if e, _ := Compile(p); e != nil && len(Validate(Normalize(p))) > 0 {
				t.Error("Compile returned an engine for an invalid policy")
			}
		})
	}

	t.Run("valid extensions pass", func(t *testing.T) {
		p := minimalPolicy()
		p = withCategory(p, "dev.api", "api")
		p = withCategory(p, "dev.api.rest", "rest api")
		p = withCategory(p, "dev.old", "legacy", func(c *Category) { c.MergedInto = "dev.api" })
		categoryByID(t, &p, "infra").Enabled = false
		p.Baselines = []Baseline{{CategoryID: "dev.api", ManualMinutes: 30, AIMinutes: 5, HourlyCostKRW: 40000}}
		if issues := Validate(p); len(issues) != 0 {
			t.Errorf("unexpected issues: %+v", issues)
		}
	})

	t.Run("issues serialise with path and message", func(t *testing.T) {
		raw, _ := json.Marshal(Issue{Path: "thresholds.accept", Message: "x"})
		if string(raw) != `{"path":"thresholds.accept","message":"x"}` {
			t.Errorf("issue JSON = %s", raw)
		}
	})
}

func TestDiff(t *testing.T) {
	old := minimalPolicy()
	old = withCategory(old, "dev.codegen", "구현, 코드 작성")
	old = withCategory(old, "dev.legacy", "legacy")
	old = withCategory(old, "dev.gone", "gone")
	old = withCategory(old, "dev.merged", "x", func(c *Category) { c.MergedInto = "dev.codegen" })
	old = withCategory(old, "dev.same", "b, a")

	next := minimalPolicy()
	next = withCategory(next, "dev.codegen", "구현, 코드 작성, scaffold")                                       // rules changed
	next = withCategory(next, "dev.legacy", "legacy", func(c *Category) { c.MergedInto = "dev.codegen" }) // merged
	next = withCategory(next, "dev.merged", "x")                                                          // merge undone
	next = withCategory(next, "dev.same", "a, b")                                                         // only the order differs
	next = withCategory(next, "dev.new", "new")                                                           // added
	categoryByID(t, &next, "infra").Name = "인프라"                                                          // renamed
	categoryByID(t, &next, "itsm").Enabled = false                                                        // disabled

	got := Diff(old, next)
	want := Changes{
		Added:        []string{"dev.new"},
		Removed:      []string{"dev.gone"},
		Renamed:      []string{"infra"},
		Merged:       []string{"dev.legacy"},
		RulesChanged: []string{"dev.codegen", "dev.merged", "itsm"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Diff = %+v\nwant   %+v", got, want)
	}

	same := Diff(old, old)
	raw, _ := json.Marshal(same)
	if string(raw) != `{"added":[],"removed":[],"renamed":[],"merged":[],"rules_changed":[]}` {
		t.Errorf("empty diff serialises as %s", raw)
	}
}
