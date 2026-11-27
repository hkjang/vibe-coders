package workintel

import (
	"reflect"
	"strings"
	"sync"
	"testing"
)

func mustCompile(t testing.TB, p Policy) *Engine {
	t.Helper()
	e, issues := Compile(p)
	if len(issues) > 0 {
		t.Fatalf("policy does not compile: %+v", issues)
	}
	return e
}

func candidateFor(r Result, id string) *Candidate {
	for i := range r.Candidates {
		if r.Candidates[i].CategoryID == id {
			return &r.Candidates[i]
		}
	}
	return nil
}

func TestCompileRejectsInvalidPolicy(t *testing.T) {
	p := minimalPolicy()
	p.Categories = p.Categories[:5]
	e, issues := Compile(p)
	if e != nil || len(issues) == 0 {
		t.Fatalf("Compile = %v, %d issues; want nil engine and issues", e, len(issues))
	}
	if DefaultEngine() == nil || DefaultEngine() != DefaultEngine() {
		t.Error("DefaultEngine must return one shared engine")
	}
}

func TestEnginePolicyIsACopy(t *testing.T) {
	e := mustCompile(t, withCategory(minimalPolicy(), "dev.api", "api"))
	p := e.Policy()
	p.Categories[0].Name = "changed"
	p.Categories[len(p.Categories)-1].Rules.Keywords[0] = "changed"
	if q := e.Policy(); q.Categories[0].Name == "changed" || q.Categories[len(q.Categories)-1].Rules.Keywords[0] == "changed" {
		t.Error("mutating the returned policy changed the engine")
	}
}

func TestEngineLookups(t *testing.T) {
	p := withCategory(minimalPolicy(), "dev.api", "api")
	p = withCategory(p, "dev.api.rest", "rest api")
	p.Baselines = []Baseline{
		{CategoryID: "dev", ManualMinutes: 60, AIMinutes: 15, HourlyCostKRW: 50000},
		{CategoryID: "dev.api.rest", ManualMinutes: 20, AIMinutes: 5},
	}
	e := mustCompile(t, p)

	// A baseline applies to everything below it until a closer one overrides it.
	for id, want := range map[string]float64{"dev": 60, "dev.api": 60, "dev.api.rest": 20, "dev.api.rest.gone": 20, "dev.unknown": 60} {
		if b := e.BaselineFor(id); b == nil || b.ManualMinutes != want {
			t.Errorf("BaselineFor(%q) = %+v, want %v manual minutes", id, b, want)
		}
	}
	for _, id := range []string{"infra", "infra.k8s", "", "nope"} {
		if b := e.BaselineFor(id); b != nil {
			t.Errorf("BaselineFor(%q) = %+v, want none", id, b)
		}
	}
	// The returned baseline is a copy.
	e.BaselineFor("dev").ManualMinutes = 1
	if e.BaselineFor("dev").ManualMinutes != 60 {
		t.Error("BaselineFor exposes engine state")
	}

	if !e.Known("dev.api") || !e.Known(" DEV.API ") || e.Known("dev.nope") || e.Known("") {
		t.Error("Known is wrong")
	}
	if e.ActionName("create") != "생성" || e.ActionName("unknown") != "" || e.ActionName("nope") != "" {
		t.Errorf("ActionName = %q / %q", e.ActionName("create"), e.ActionName("unknown"))
	}
	if !e.KnownAction("delete") || e.KnownAction(UnknownAction) || e.KnownAction("") {
		t.Error("KnownAction is wrong")
	}
	if e.Thresholds() != DefaultThresholds() {
		t.Errorf("Thresholds = %+v", e.Thresholds())
	}
}

func TestCategoryTree(t *testing.T) {
	p := minimalPolicy()
	p = withCategory(p, "dev.api", "api")
	p = withCategory(p, "dev.api.rest", "rest")
	p = withCategory(p, "dev.api.grpc", "grpc")
	p = withCategory(p, "dev.ui", "ui")
	e := mustCompile(t, p)

	if got := e.Ref("dev.api.rest"); got != (CategoryRef{ID: "dev.api.rest", Name: "분류 dev.api.rest", Level: 3, ParentID: "dev.api", TopID: "dev", Enabled: true}) {
		t.Errorf("Ref(dev.api.rest) = %+v", got)
	}
	if got := e.Ref("dev"); got.Level != 1 || got.ParentID != "" || got.TopID != "dev" {
		t.Errorf("Ref(dev) = %+v", got)
	}
	// An id from an older policy still renders, filed under "other".
	if got := e.Ref("legacy.thing"); got != (CategoryRef{ID: "legacy.thing", Name: "legacy.thing", Level: 2, ParentID: "other", TopID: "other", Enabled: false}) {
		t.Errorf("Ref(unknown) = %+v", got)
	}
	if got := e.Ref(""); got.ID != OtherCategoryID {
		t.Errorf("Ref(\"\") = %+v", got)
	}

	ids := func(refs []CategoryRef) string {
		var out []string
		for _, r := range refs {
			out = append(out, r.ID)
		}
		return strings.Join(out, " ")
	}
	if got := ids(e.Children("")); got != strings.Join(RequiredTopLevelIDs(), " ") {
		t.Errorf("Children(\"\") = %s", got)
	}
	if got := ids(e.Children("dev")); got != "dev.api dev.ui" {
		t.Errorf("Children(dev) = %s", got)
	}
	if got := ids(e.Children("dev.api")); got != "dev.api.rest dev.api.grpc" {
		t.Errorf("Children(dev.api) = %s", got)
	}
	if got := e.Children("nope"); got == nil || len(got) != 0 {
		t.Errorf("Children(unknown) = %v, want an empty list", got)
	}
	if got := len(e.Refs()); got != 16 {
		t.Errorf("Refs() has %d entries, want 16", got)
	}
	if got := strings.Join(e.Descendants("dev"), " "); got != "dev dev.api dev.api.rest dev.api.grpc dev.ui" {
		t.Errorf("Descendants(dev) = %s", got)
	}
	if got := strings.Join(e.Descendants("dev.ui"), " "); got != "dev.ui" {
		t.Errorf("Descendants(dev.ui) = %s", got)
	}
	if got := strings.Join(e.Descendants("gone"), " "); got != "gone" {
		t.Errorf("Descendants(unknown) = %s", got)
	}
	if e.TopOf("dev.api.grpc") != "dev" || e.TopOf("nope.x") != OtherCategoryID {
		t.Errorf("TopOf = %s, %s", e.TopOf("dev.api.grpc"), e.TopOf("nope.x"))
	}
}

func TestCanonical(t *testing.T) {
	p := minimalPolicy()
	p = withCategory(p, "dev.a", "a", func(c *Category) { c.MergedInto = "dev.b" })
	p = withCategory(p, "dev.b", "b", func(c *Category) { c.MergedInto = "dev.c" })
	p = withCategory(p, "dev.c", "c")
	p = withCategory(p, "dev.c.deep", "deep")
	p = withCategory(p, "dev.off", "off", func(c *Category) { c.Enabled = false })
	p = withCategory(p, "dev.off.child", "child")
	p = withCategory(p, "dev.a.child", "child of merged")
	p = withCategory(p, "infra.x", "x")
	p = withCategory(p, "itsm.y", "y")
	categoryByID(t, &p, "infra").Enabled = false
	categoryByID(t, &p, "itsm").MergedInto = "support"
	e := mustCompile(t, p)

	tests := []struct{ id, want string }{
		{"dev.c", "dev.c"},
		{"dev.b", "dev.c"},                 // one merge
		{"dev.a", "dev.c"},                 // a chain of merges
		{"dev.a.child", "dev.c"},           // follows its merged parent
		{"dev.c.deep", "dev.c.deep"},       // untouched leaf
		{"dev.off", "dev"},                 // disabled leaf → parent
		{"dev.off.child", "dev"},           // enabled child of a disabled parent
		{"infra", "other"},                 // disabled top-level
		{"infra.x", "other"},               // and everything under it
		{"itsm", "support"},                // merged top-level
		{"itsm.y", "support"},              // child follows the merged top-level
		{"dev.removed", "dev"},             // unknown id with a known ancestor
		{"dev.c.removed.deeper", "dev.c"},  // however deep
		{"never.existed", "other"},         // unknown everywhere
		{"", "other"},                      // empty
		{"  DEV.B ", "dev.c"},              // tolerated spelling
		{OtherCategoryID, OtherCategoryID}, // the sink itself
	}
	for _, tt := range tests {
		if got := e.Canonical(tt.id); got != tt.want {
			t.Errorf("Canonical(%q) = %q, want %q", tt.id, got, tt.want)
		}
	}
	if e.TopOf("itsm.y") != "support" || e.TopOf("dev.a") != "dev" {
		t.Errorf("TopOf does not follow merges: %s, %s", e.TopOf("itsm.y"), e.TopOf("dev.a"))
	}
	// Filtering by a merge target must also find the rows stored under the
	// ids that were merged into it.
	if got := strings.Join(e.Descendants("dev.c"), " "); got != "dev.c dev.a dev.b dev.c.deep dev.a.child" {
		t.Errorf("Descendants(dev.c) = %s", got)
	}
	if got := strings.Join(e.Descendants("support"), " "); got != "support itsm itsm.y" {
		t.Errorf("Descendants(support) = %s", got)
	}
	if e.Ref("infra.x").Enabled || e.Ref("dev.off.child").Enabled || !e.Ref("dev.c").Enabled {
		t.Error("Ref.Enabled must reflect disabled ancestors")
	}

	// The keywords of a merged category keep detecting its work and credit
	// the category it was merged into; a disabled category detects nothing.
	r := e.Classify(Features{Text: "a and b"})
	if r.CategoryID != "dev.c" {
		t.Errorf("merged keywords classify as %q, want dev.c", r.CategoryID)
	}
	if r := e.Classify(Features{Text: "off off off"}); r.TopCategoryID != OtherCategoryID {
		t.Errorf("a disabled category still matched: %+v", r)
	}
	if r := e.Classify(Features{Text: "x"}); r.TopCategoryID != OtherCategoryID {
		t.Errorf("a category under a disabled top-level still matched: %+v", r)
	}
}

func TestClassifyEvidenceRules(t *testing.T) {
	p := minimalPolicy()
	p = withCategory(p, "infra.k8s", "쿠버네티스, kubectl, 파드", func(c *Category) {
		c.Rules.MCPServers = []string{"kubernetes"}
		c.Rules.MCPTools = []string{"pods", "kubectl"}
	})
	p = withCategory(p, "dev.debug", "버그, 예외", func(c *Category) { c.Rules.TaskTypes = []string{"debug"} })
	p = withCategory(p, "dev.codegen", "구현", func(c *Category) { c.Rules.TaskTypes = []string{"generate"} })
	p = withCategory(p, "data.sql", "쿼리, sql", func(c *Category) {
		c.Rules.Languages = []string{"sql"}
		c.Rules.MCPServers = []string{"postgres"}
		c.Rules.TaskTypes = []string{"text2sql"}
	})
	for i := range p.Categories {
		if p.Categories[i].ID == "dev" {
			p.Categories[i].Rules.Languages = []string{"go", "typescript", "javascript"}
			p.Categories[i].Rules.Clients = []string{"Claude Code"}
		}
	}
	e := mustCompile(t, Normalize(p))
	th := e.Thresholds()

	t.Run("one keyword never confirms", func(t *testing.T) {
		r := e.Classify(Features{Text: "쿠버네티스 알려줘"})
		if r.CategoryID != "infra.k8s" || r.TopCategoryID != "infra" {
			t.Fatalf("category = %s/%s", r.TopCategoryID, r.CategoryID)
		}
		if r.Confidence >= th.Accept || !r.NeedsLLM {
			t.Errorf("confidence %.3f, needs_llm %v: a single keyword must stay unconfirmed", r.Confidence, r.NeedsLLM)
		}
		if r.Status != StatusReview {
			t.Errorf("status = %s, want review", r.Status)
		}
	})

	t.Run("repeating one keyword does not confirm either", func(t *testing.T) {
		r := e.Classify(Features{Text: strings.Repeat("쿠버네티스 ", 40)})
		if r.Confidence >= th.Accept {
			t.Errorf("confidence %.3f from one repeated keyword", r.Confidence)
		}
		once := e.Classify(Features{Text: "쿠버네티스"})
		if c, o := candidateFor(r, "infra.k8s"), candidateFor(once, "infra.k8s"); c.Score > o.Score*1.5+1e-9 {
			t.Errorf("repeats raised the score from %.3f to %.3f; the bonus must be capped", o.Score, c.Score)
		}
	})

	t.Run("two distinct keywords confirm", func(t *testing.T) {
		r := e.Classify(Features{Text: "kubectl로 파드 상태 확인"})
		if r.CategoryID != "infra.k8s" || r.Confidence < th.Accept || r.NeedsLLM || r.Status != StatusClassified {
			t.Errorf("got %s conf %.3f needs_llm %v status %s", r.CategoryID, r.Confidence, r.NeedsLLM, r.Status)
		}
		c := candidateFor(r, "infra.k8s")
		if c == nil || !reflect.DeepEqual(c.Evidence, []string{"키워드: kubectl", "키워드: 파드"}) {
			t.Errorf("evidence = %+v", c)
		}
	})

	t.Run("MCP server and tool are strong evidence", func(t *testing.T) {
		r := e.Classify(Features{MCPServers: []string{"Kubernetes-Prod"}, MCPTools: []string{"mcp__kubernetes__pods_list"}})
		if r.CategoryID != "infra.k8s" || r.Confidence < th.Accept || r.Status != StatusClassified {
			t.Errorf("got %s conf %.3f status %s", r.CategoryID, r.Confidence, r.Status)
		}
		c := candidateFor(r, "infra.k8s")
		if c == nil || !reflect.DeepEqual(c.Evidence, []string{"MCP 서버: kubernetes", "MCP 도구: pods"}) {
			t.Errorf("evidence = %+v", c)
		}
		if r.TargetSystem != "kubernetes" {
			t.Errorf("target system = %q", r.TargetSystem)
		}
	})

	t.Run("a lone MCP server is strong but still one piece of evidence", func(t *testing.T) {
		r := e.Classify(Features{MCPServers: []string{"kubernetes"}})
		if r.CategoryID != "infra.k8s" || r.Confidence >= th.Accept || !r.NeedsLLM || r.Status != StatusClassified {
			t.Errorf("got %s conf %.3f needs_llm %v status %s", r.CategoryID, r.Confidence, r.NeedsLLM, r.Status)
		}
	})

	t.Run("the task type is not an independent piece of evidence", func(t *testing.T) {
		// It is guessed from the same words the keywords match, so it cannot
		// be the second piece that confirms a category.
		r := e.Classify(Features{MCPServers: []string{"postgres"}, TaskType: "text2sql"})
		if r.CategoryID != "data.sql" || r.Confidence >= th.Accept || !r.NeedsLLM {
			t.Errorf("got %s conf %.3f needs_llm %v", r.CategoryID, r.Confidence, r.NeedsLLM)
		}
		// A real second piece does confirm.
		r = e.Classify(Features{MCPServers: []string{"postgres"}, TaskType: "text2sql", Languages: []string{"SQL"}})
		if r.CategoryID != "data.sql" || r.Confidence < th.Accept || r.NeedsLLM {
			t.Errorf("with a language: %s conf %.3f needs_llm %v", r.CategoryID, r.Confidence, r.NeedsLLM)
		}
	})

	t.Run("several tools of one server count once", func(t *testing.T) {
		one := e.Classify(Features{MCPTools: []string{"kubectl_get"}})
		many := e.Classify(Features{MCPTools: []string{"kubectl_get", "kubectl_describe", "pods_list", "pods_log"}})
		if a, b := candidateFor(one, "infra.k8s"), candidateFor(many, "infra.k8s"); a == nil || b == nil || a.Score != b.Score {
			t.Errorf("scores differ: %+v vs %+v", a, b)
		}
	})

	t.Run("MCP hints match whole name segments", func(t *testing.T) {
		// "pods" must not match inside another word.
		if r := e.Classify(Features{MCPTools: []string{"list_tripods"}}); len(r.Candidates) != 0 {
			t.Errorf("unexpected candidates %+v", r.Candidates)
		}
	})

	t.Run("task type picks the child but barely moves the top level", func(t *testing.T) {
		r := e.Classify(Features{Text: "이 예외 좀 봐줘", TaskType: "debug", Languages: []string{"Go"}, Client: "claude code"})
		if r.CategoryID != "dev.debug" || r.Confidence < th.Accept {
			t.Errorf("got %s conf %.3f", r.CategoryID, r.Confidence)
		}
		c := candidateFor(r, "dev.debug")
		if c == nil || !reflect.DeepEqual(c.Evidence, []string{"키워드: 예외", "작업 유형: debug"}) {
			t.Errorf("evidence = %+v", c)
		}
		if d := candidateFor(r, "dev"); d == nil || !reflect.DeepEqual(d.Evidence, []string{"언어: go", "클라이언트: Claude Code"}) {
			t.Errorf("dev evidence = %+v", d)
		}

		// On its own the task type is derived from generic verbs and names nothing.
		alone := e.Classify(Features{Text: "이거 어떻게 생각해?", TaskType: "debug"})
		if alone.TopCategoryID != OtherCategoryID || alone.Status != StatusUnclassified {
			t.Errorf("task type alone gave %s (%s)", alone.CategoryID, alone.Status)
		}
	})

	t.Run("a language counts once per category", func(t *testing.T) {
		one := e.Classify(Features{Languages: []string{"TypeScript"}, Text: "구현"})
		two := e.Classify(Features{Languages: []string{"TypeScript", "JavaScript", "Go"}, Text: "구현"})
		if a, b := candidateFor(one, "dev"), candidateFor(two, "dev"); a == nil || b == nil || a.Score != b.Score {
			t.Errorf("scores differ: %+v vs %+v", a, b)
		}
	})

	t.Run("two close domains are reported as composite work", func(t *testing.T) {
		r := e.Classify(Features{Text: "쿠버네티스 파드 로그를 SQL 쿼리로 분석"})
		if r.TopCategoryID != "infra" || r.Secondary != "data" || !r.NeedsLLM {
			t.Errorf("top %s secondary %q needs_llm %v", r.TopCategoryID, r.Secondary, r.NeedsLLM)
		}
		if r.Confidence >= th.Accept {
			t.Errorf("confidence %.3f for a tie", r.Confidence)
		}
		if !reflect.DeepEqual(r.Tags, []string{"분류 data"}) {
			t.Errorf("tags = %v, want the runner-up category name", r.Tags)
		}
	})

	t.Run("no evidence", func(t *testing.T) {
		r := e.Classify(Features{Text: "이건 아무 규칙에도 걸리지 않는 문장입니다"})
		if r.CategoryID != OtherCategoryID || r.TopCategoryID != OtherCategoryID || r.Status != StatusUnclassified || r.Confidence != 0 {
			t.Errorf("got %+v", r)
		}
		if !r.NeedsLLM {
			t.Error("an unclassified sentence should be offered to the LLM step")
		}
		if e.Classify(Features{Text: "ㅇㅇ"}).NeedsLLM || e.Classify(Features{}).NeedsLLM {
			t.Error("there is nothing in an empty or two-letter text for an LLM to classify")
		}
		empty := e.Classify(Features{})
		if empty.Tags == nil || empty.Technologies == nil || empty.Candidates == nil {
			t.Error("list fields must not be nil; they are serialised")
		}
	})

	t.Run("method and title", func(t *testing.T) {
		r := e.Classify(Features{Text: "kubectl 파드 삭제해줘"})
		if r.Method != MethodRule {
			t.Errorf("method = %s", r.Method)
		}
		if r.ActionType != "delete" || r.WorkTitle != "분류 infra.k8s · 삭제" {
			t.Errorf("action %s title %q", r.ActionType, r.WorkTitle)
		}
	})
}

func TestClassifyKeywordMatching(t *testing.T) {
	p := minimalPolicy()
	p = withCategory(p, "dev.lang", "java, rest, api, pod, hi, deploy, c++")
	p = withCategory(p, "dev.review", "코드 리뷰, unit test")
	p = withCategory(p, "support.voc", "리뷰, 테스트")
	p = withCategory(p, "office.report", "리포트")
	p = withCategory(p, "infra.network", "포트")
	e := mustCompile(t, p)

	matches := func(text, id string) bool {
		return candidateFor(e.Classify(Features{Text: text}), id) != nil
	}
	tests := []struct {
		text, id string
		want     bool
	}{
		{"JAVA 코드", "dev.lang", true},                  // case-insensitive
		{"javascript 코드", "dev.lang", false},           // short word must be whole
		{"restart the server", "dev.lang", false},      // "rest" is not a prefix
		{"call the REST endpoint", "dev.lang", true},   //
		{"three apis", "dev.lang", true},               // plural
		{"apiary", "dev.lang", false},                  //
		{"pods are pending", "dev.lang", true},         //
		{"a podcast", "dev.lang", false},               //
		{"this is fine", "dev.lang", false},            // "hi" inside "this"
		{"his turn", "dev.lang", false},                // two-letter words do not inflect
		{"hi there", "dev.lang", true},                 //
		{"deployment plan", "dev.lang", true},          // long words match as a prefix
		{"redeploy it", "dev.lang", false},             // but only at a word start
		{"API로 호출", "dev.lang", true},                  // Hangul right after an English word
		{"use c++ here", "dev.lang", true},             // punctuation in a keyword
		{"unit   tests\nplease", "dev.review", true},   // whitespace runs and inflection
		{"unit testing", "dev.review", true},           //
		{"코드 리뷰 부탁", "dev.review", true},               // phrase
		{"코드 리뷰 부탁", "support.voc", false},             // the nested generic word does not count
		{"앱 리뷰 분석", "support.voc", true},               // the generic word alone does
		{"재배포테스트해줘", "support.voc", true},              // Korean matches inside a compound
		{"주간 리포트 작성", "infra.network", false},          // "포트" inside "리포트" is covered
		{"주간 리포트 작성", "office.report", true},           //
		{"포트 8080 열기", "infra.network", true},          //
		{"리포트에 포트 번호 추가", "infra.network", true},       // both, at different places
		{"코드 리뷰 말고 고객 리뷰 분석", "support.voc", true},     // nested once, free once
		{"", "dev.lang", false},                        //
		{strings.Repeat(" ", 10), "dev.lang", false},   //
		{"\tJava\n", "dev.lang", true},                 // trimmed
		{"java8 migration", "dev.lang", false},         // a digit continues the word
		{"use java, then deploy", "dev.lang", true},    // punctuation ends the word
		{"my_api_client", "dev.lang", true},            // underscores separate words
		{"자바java", "dev.lang", true},                   // Hangul is a boundary for English
		{"RESTful design", "dev.lang", false},          //
		{"tested apis are deployed", "dev.lang", true}, //
	}
	for _, tt := range tests {
		if got := matches(tt.text, tt.id); got != tt.want {
			t.Errorf("text %q: evidence for %s = %v, want %v", tt.text, tt.id, got, tt.want)
		}
	}
}

// TestMatcherWideAndDeepNodes covers the two trie layouts that the built-in
// vocabulary rarely reaches: a node with many children far from the root,
// which is searched instead of indexed, and long keywords sharing a prefix.
func TestMatcherWideAndDeepNodes(t *testing.T) {
	var keywords []string
	for c := 'a'; c <= 'z'; c++ {
		keywords = append(keywords, "sharedprefix"+string(c)+"tail")
	}
	for _, syllable := range []string{"가", "나", "다", "라", "마", "바", "사", "아", "자", "차", "카", "타", "파", "하"} {
		keywords = append(keywords, "공통접두어"+syllable+"끝")
	}
	e := mustCompile(t, withCategory(minimalPolicy(), "dev.wide", strings.Join(keywords, ", ")))
	for _, kw := range keywords {
		r := e.Classify(Features{Text: "앞 " + strings.ToUpper(kw) + " 뒤"})
		c := candidateFor(r, "dev.wide")
		if c == nil || len(c.Evidence) != 1 || c.Evidence[0] != "키워드: "+kw {
			t.Errorf("keyword %q not matched: %+v", kw, r.Candidates)
		}
	}
	for _, miss := range []string{"sharedprefix", "sharedprefix1tail", "sharedprefixa", "공통접두어", "공통접두어갸끝", "공통접두어가"} {
		if r := e.Classify(Features{Text: miss}); len(r.Candidates) != 0 {
			t.Errorf("%q matched %+v", miss, r.Candidates)
		}
	}
}

func TestClassifySharedAndWeightedEvidence(t *testing.T) {
	p := minimalPolicy()
	p = setKeywords(p, "office", "문서")
	p = setKeywords(p, "knowledge", "문서")
	p = setKeywords(p, "other", "문서")
	p = withCategory(p, "office.report", "보고서")
	p = withCategory(p, "ai.prompt", "프롬프트", func(c *Category) { c.Rules.Weight = 2 })
	e := mustCompile(t, p)

	// A keyword shared by two domains is half as strong for each; "other"
	// neither dilutes nor is diluted.
	r := e.Classify(Features{Text: "문서"})
	for _, id := range []string{"office", "knowledge"} {
		if c := candidateFor(r, id); c == nil || c.Score != 0.5 {
			t.Errorf("%s score = %+v, want 0.5", id, c)
		}
	}
	if c := candidateFor(r, OtherCategoryID); c == nil || c.Score != 1 {
		t.Errorf("other score = %+v, want 1", c)
	}

	// The category weight scales its evidence.
	r = e.Classify(Features{Text: "보고서 프롬프트"})
	if r.TopCategoryID != "ai" || candidateFor(r, "ai.prompt").Score != 2 || candidateFor(r, "office.report").Score != 1 {
		t.Errorf("weights not applied: top %s candidates %+v", r.TopCategoryID, r.Candidates)
	}
}

func TestClassifyOtherNeverOutvotesWork(t *testing.T) {
	e := DefaultEngine()
	th := e.Thresholds()

	for _, text := range []string{"안녕", "hi", "test", "테스트", "ping", "고마워!", "thanks", "ㅋㅋㅋ"} {
		r := e.Classify(Features{Text: text})
		if r.TopCategoryID != OtherCategoryID || r.Status != StatusClassified || r.NeedsLLM {
			t.Errorf("%q → %s (%s, needs_llm %v), want a recognised non-work message", text, r.CategoryID, r.Status, r.NeedsLLM)
		}
		if r.Confidence < th.Accept {
			t.Errorf("%q: confidence %.3f, want confident chit-chat", text, r.Confidence)
		}
	}
	// A ping is a ping even when the proxy labels it with a task type.
	if r := e.Classify(Features{Text: "test", TaskType: "test"}); r.TopCategoryID != OtherCategoryID {
		t.Errorf("\"test\" with a task type → %s", r.CategoryID)
	}

	// A request that called tools is not a ping, however short its text.
	if r := e.Classify(Features{Text: "ok thanks", MCPServers: []string{"kubernetes"}, MCPTools: []string{"pods_list"}}); r.CategoryID != "infra.k8s" {
		t.Errorf("a tool call with a short acknowledgement → %s", r.CategoryID)
	}
	// Not even when the tools are unknown: then the work is simply not known.
	if r := e.Classify(Features{Text: "ok thanks", MCPTools: []string{"acme_frobnicate"}}); r.Status != StatusUnclassified || r.Confidence >= th.Accept {
		t.Errorf("an unknown tool call with a short acknowledgement → %s %s conf %.3f", r.CategoryID, r.Status, r.Confidence)
	}

	// A greeting in front of real work is still real work.
	for text, top := range map[string]string{
		"안녕하세요, 쿠버네티스 파드가 CrashLoopBackOff인데 kubectl로 원인 확인하는 방법 알려주세요": "infra",
		"감사합니다. 그럼 이 SQL 쿼리에 인덱스 타게 고쳐주세요":                              "data",
		"hi, can you write a unit test for this function with pytest":   "dev",
	} {
		if r := e.Classify(Features{Text: text}); r.TopCategoryID != top {
			t.Errorf("%q → %s, want %s", text, r.TopCategoryID, top)
		}
	}
	// Even when the pleasantries outnumber the one word that names the work.
	if r := e.Classify(Features{Text: "안녕하세요 ㅎㅎ 고마워요, 수고 많으십니다. 쿠버네티스 관련해서 여쭤볼 게 하나 있는데 괜찮을까요"}); r.CategoryID != "infra.k8s" {
		t.Errorf("pleasantries outvoted the request: %s", r.CategoryID)
	}

	// "감사" means audit, "감사합니다" means thanks: the longer word wins.
	if r := e.Classify(Features{Text: "감사합니다"}); r.TopCategoryID != OtherCategoryID {
		t.Errorf("thanks classified as %s", r.CategoryID)
	}
	if r := e.Classify(Features{Text: "내부 감사 대응 자료 준비"}); r.TopCategoryID != "security" {
		t.Errorf("audit classified as %s", r.CategoryID)
	}
}

func TestClassifyDerivedFields(t *testing.T) {
	e := DefaultEngine()

	difficulty := map[int]string{0: "simple", 29: "simple", 30: "standard", 59: "standard", 60: "complex", 84: "complex", 85: "reasoning", 100: "reasoning"}
	for score, want := range difficulty {
		if got := e.Classify(Features{Text: "x", Complexity: score}).Difficulty; got != want {
			t.Errorf("complexity %d → %s, want %s", score, got, want)
		}
	}

	for task, want := range map[string]string{
		"generate": "create", "refactor": "modify", "debug": "analyze", "explain": "analyze", "test": "verify",
		"review": "verify", "docs": "create", "translate": "create", "text2sql": "read", "other": UnknownAction, "": UnknownAction,
	} {
		if got := e.Classify(Features{Text: "…", TaskType: task}).ActionType; got != want {
			t.Errorf("task type %q → action %s, want %s", task, got, want)
		}
	}

	actions := []struct{ text, want string }{
		{"오래된 로그 파일 삭제해줘", "delete"},
		{"배포 전 설정값 검증해줘", "verify"},
		{"내년 로드맵 계획 세워줘", "plan"},
		{"이 함수 리팩토링해줘", "modify"},
		{"주간 보고서 작성해줘", "create"},
		{"지난달 가입자 수 조회", "read"},
		{"매일 아침 자동으로 돌게 스케줄 걸어줘", "automate"},
		{"장애 원인 분석해서 보고서 만들어줘", "create"},                  // Korean: the last verb is the request
		{"Create a report analyzing the outage", "create"}, // English: the first verb is
		{"Analyze the outage and write a report", "analyze"},
		{"음", UnknownAction},
	}
	for _, tt := range actions {
		if got := e.Classify(Features{Text: tt.text}).ActionType; got != tt.want {
			t.Errorf("%q → action %s, want %s", tt.text, got, tt.want)
		}
	}

	r := e.Classify(Features{
		Text:      "Spring Boot 서비스에서 PostgreSQL 쿼리가 느린데 Redis 캐시를 붙이고 싶어. 자바스크립트 프론트도 수정 필요",
		Languages: []string{"Java", "java", "SQL"},
	})
	if want := []string{"Java", "SQL", "Spring", "PostgreSQL", "Redis", "JavaScript"}; !reflect.DeepEqual(r.Technologies, want) {
		t.Errorf("technologies = %v, want %v", r.Technologies, want)
	}
	if r.TargetSystem != "postgres" {
		t.Errorf("target system = %q, want the first system named in the text", r.TargetSystem)
	}
	many := e.Classify(Features{Text: "python java kotlin rust php ruby swift docker kubernetes terraform ansible nginx kafka redis"})
	if len(many.Technologies) != 8 {
		t.Errorf("technologies are capped at 8, got %d", len(many.Technologies))
	}

	systems := []struct {
		servers []string
		text    string
		want    string
	}{
		{[]string{"mcp-atlassian", "jira-cloud"}, "", "jira"},
		{[]string{"postgresql-readonly"}, "쿠버네티스", "postgres"}, // what was called beats what was mentioned
		{[]string{"k8s"}, "", "kubernetes"},
		{[]string{"My Internal Tool!"}, "", "my internal tool"},
		{[]string{"whatsapp"}, "", "whatsapp"}, // "sap" is not a segment of it
		{nil, "지라 티켓 정리", "jira"},
		{nil, "그냥 질문", ""},
	}
	for _, tt := range systems {
		if got := e.Classify(Features{MCPServers: tt.servers, Text: tt.text}).TargetSystem; got != tt.want {
			t.Errorf("servers %v text %q → target %q, want %q", tt.servers, tt.text, got, tt.want)
		}
	}

	// Titles are composed from registered names and never contain the prompt.
	secret := "비밀프로젝트코드네임"
	r = e.Classify(Features{Text: secret + " 관련 단위 테스트 코드 작성해줘 pytest"})
	if r.WorkTitle != "테스트 · 생성" {
		t.Errorf("title = %q", r.WorkTitle)
	}
	for _, s := range append(append([]string{r.WorkTitle, r.TargetSystem}, r.Tags...), r.Technologies...) {
		if strings.Contains(s, secret) {
			t.Errorf("prompt text leaked into the result: %q", s)
		}
	}
	for _, c := range r.Candidates {
		for _, ev := range c.Evidence {
			if strings.Contains(ev, secret) {
				t.Errorf("prompt text leaked into evidence: %q", ev)
			}
		}
	}
	if r := e.Classify(Features{Text: "코드 생성"}); r.WorkTitle != "코드 생성 · 생성" {
		t.Errorf("title = %q, want the documented form", r.WorkTitle)
	}
	if r := e.Classify(Features{Text: "ㅎ"}); r.WorkTitle != "기타 및 미분류" {
		t.Errorf("title without an action = %q", r.WorkTitle)
	}

	if !(Features{}).Cacheable() || (Features{PolicyFlags: []string{"dlp"}}).Cacheable() {
		t.Error("requests touched by a DLP or secret policy must not be cached")
	}
}

func TestClassifyIsDeterministicAndConcurrent(t *testing.T) {
	e := DefaultEngine()
	samples := loadLabeled(t)
	want := make([]Result, len(samples))
	for i, s := range samples {
		want[i] = e.Classify(s.features(true))
	}
	var wg sync.WaitGroup
	errs := make(chan string, 8)
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for round := 0; round < 5; round++ {
				for i, s := range samples {
					if got := e.Classify(s.features(true)); !reflect.DeepEqual(got, want[i]) {
						select {
						case errs <- s.ID:
						default:
						}
						return
					}
				}
			}
		}()
	}
	wg.Wait()
	close(errs)
	for id := range errs {
		t.Errorf("sample %s classified differently on a repeated or concurrent call", id)
	}

	// A second engine from the same policy must agree with the first: no
	// map-iteration order may leak into the compiled tables.
	other := mustCompile(t, DefaultPolicy())
	for i, s := range samples {
		if got := other.Classify(s.features(true)); !reflect.DeepEqual(got, want[i]) {
			t.Fatalf("sample %s differs between two engines compiled from the same policy", s.ID)
		}
	}
}

func TestClassifyBoundsItsWork(t *testing.T) {
	e := DefaultEngine()
	// The keyword sits beyond the scan limit, so it must not be seen; the
	// call must still return promptly for a multi-megabyte prompt.
	huge := strings.Repeat("가나다라 ", 400000) + " 쿠버네티스 kubectl 파드"
	if r := e.Classify(Features{Text: huge}); r.TopCategoryID != OtherCategoryID {
		t.Errorf("text beyond the scan limit was classified as %s", r.CategoryID)
	}
	// Truncation must not split a multi-byte character.
	if r := e.Classify(Features{Text: strings.Repeat("가", maxScanBytes)}); r.Status != StatusUnclassified {
		t.Errorf("status = %s", r.Status)
	}
	// Invalid UTF-8 must not panic.
	_ = e.Classify(Features{Text: "\xff\xfe쿠버\xed네티스 \xea", MCPTools: []string{"\xff"}, Languages: []string{"\xff"}})
}
