package workintel

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"
)

// labeledSample is one row of testdata/labeled.json.
//
// The fixture has three splits. "tune" was written by the author of the
// default policy, so its vocabulary overlaps with the keyword lists. "dev"
// and "holdout" were each written from the taxonomy alone by an author who
// never saw the rules. The misses of "dev" were then studied to find general
// vocabulary gaps; "holdout" was never inspected and is the honest estimate
// of how the rules generalise. Its misses are only logged in aggregate
// unless WORKINTEL_SHOW_HOLDOUT=1, so that nobody tunes keywords to its
// prompts by accident.
type labeledSample struct {
	ID         string   `json:"id"`
	Split      string   `json:"split"`
	Text       string   `json:"text"`
	Top        string   `json:"top"`
	Second     string   `json:"second"`
	Hard       bool     `json:"hard"`
	Chitchat   bool     `json:"chitchat"`
	TaskType   string   `json:"task_type"`
	Languages  []string `json:"languages"`
	MCPServers []string `json:"mcp_servers"`
	MCPTools   []string `json:"mcp_tools"`
	Client     string   `json:"client"`
}

func loadLabeled(tb testing.TB) []labeledSample {
	tb.Helper()
	raw, err := os.ReadFile("testdata/labeled.json")
	if err != nil {
		tb.Fatalf("read fixture: %v", err)
	}
	var samples []labeledSample
	if err := json.Unmarshal(raw, &samples); err != nil {
		tb.Fatalf("parse fixture: %v", err)
	}
	return samples
}

// proxyTaskTypeKeywords mirrors taskTypeKeywords in internal/proxy/tooling.go.
// The proxy computes a task type for every request with this first-match
// heuristic, so samples without a labelled task type get the one production
// would have produced. It is a copy on purpose: this package must not import
// the proxy, and if the copy drifts only the realism of the second
// measurement suffers.
var proxyTaskTypeKeywords = []struct {
	kind     string
	keywords []string
}{
	{"debug", []string{"버그", "오류", "에러", "고쳐", "고쳐줘", "수정", "디버그", "bug", "error", "fix", "debug", "broken", "exception", "stack trace", "traceback"}},
	{"test", []string{"테스트", "단위 테스트", "유닛", "test", "unit test", "tests", "spec", "coverage"}},
	{"refactor", []string{"리팩터", "리팩토링", "정리", "개선", "최적화", "refactor", "clean up", "cleanup", "optimi", "simplify", "rename"}},
	{"translate", []string{"번역", "변환", "포팅", "마이그레이션", "translate", "convert", "port ", "migrate", "rewrite in"}},
	{"docs", []string{"문서", "주석", "설명서", "readme", "document", "docstring", "comment", "javadoc"}},
	{"review", []string{"리뷰", "검토", "review", "audit", "critique", "code review"}},
	{"explain", []string{"설명", "분석", "이해", "무엇", "왜", "explain", "analyze", "analyse", "what does", "how does", "understand", "describe"}},
	{"generate", []string{"생성", "만들어", "작성", "추가", "구현", "create", "generate", "implement", "build", "add ", "write ", "scaffold", "controller", "endpoint", "function", "class"}},
}

func proxyTaskType(text string) string {
	lower := strings.ToLower(text)
	if strings.TrimSpace(lower) == "" {
		return "other"
	}
	for _, c := range proxyTaskTypeKeywords {
		for _, kw := range c.keywords {
			if strings.Contains(lower, kw) {
				return c.kind
			}
		}
	}
	return "other"
}

func (s labeledSample) features(deriveTaskType bool) Features {
	f := Features{
		Text:       s.Text,
		TaskType:   s.TaskType,
		Languages:  s.Languages,
		MCPServers: s.MCPServers,
		MCPTools:   s.MCPTools,
		Client:     s.Client,
	}
	if deriveTaskType && f.TaskType == "" {
		f.TaskType = proxyTaskType(s.Text)
	}
	return f
}

type accuracyTally struct {
	n, topOK          int
	withSecond, secOK int
	classified        int // status classified with a substantive category
	classifiedOK      int
	accepted          int // confidence at or above the accept threshold
	acceptedOK        int
	review            int
	unclassified      int
	needsLLM          int
}

func (a accuracyTally) rate(num, den int) float64 {
	if den == 0 {
		return 0
	}
	return float64(num) / float64(den)
}

func (a accuracyTally) String() string {
	return fmt.Sprintf("n=%d top=%.3f second=%.3f(%d/%d) unclassified=%.3f review=%.3f needs_llm=%.3f | classified: %d of which right %.3f | accepted(conf≥accept): %d of which right %.3f",
		a.n, a.rate(a.topOK, a.n), a.rate(a.secOK, a.withSecond), a.secOK, a.withSecond,
		a.rate(a.unclassified, a.n), a.rate(a.review, a.n), a.rate(a.needsLLM, a.n),
		a.classified, a.rate(a.classifiedOK, a.classified), a.accepted, a.rate(a.acceptedOK, a.accepted))
}

type accuracyReport struct {
	all, hard         accuracyTally
	bySplit           map[string]*accuracyTally
	perTop            map[string]*accuracyTally
	confusion         map[string]int // "expected→got"
	holdoutConfusion  map[string]int
	misses            []string
	confidentChitchat []string
}

func evaluateLabeled(e *Engine, samples []labeledSample, deriveTaskType bool) accuracyReport {
	rep := accuracyReport{
		bySplit: map[string]*accuracyTally{"tune": {}, "dev": {}, "holdout": {}},
		perTop:  map[string]*accuracyTally{}, confusion: map[string]int{}, holdoutConfusion: map[string]int{},
	}
	accept := e.Thresholds().Accept
	showHoldout := os.Getenv("WORKINTEL_SHOW_HOLDOUT") == "1"
	for _, s := range samples {
		r := e.Classify(s.features(deriveTaskType))
		topOK := r.TopCategoryID == s.Top
		tallies := []*accuracyTally{&rep.all, rep.bySplit[s.Split]}
		if s.Hard {
			tallies = append(tallies, &rep.hard)
		}
		if rep.perTop[s.Top] == nil {
			rep.perTop[s.Top] = &accuracyTally{}
		}
		tallies = append(tallies, rep.perTop[s.Top])
		for _, a := range tallies {
			a.n++
			if topOK {
				a.topOK++
			}
			if s.Second != "" {
				a.withSecond++
				if r.CategoryID == s.Second {
					a.secOK++
				}
			}
			switch r.Status {
			case StatusReview:
				a.review++
			case StatusUnclassified:
				a.unclassified++
			case StatusClassified:
				if r.TopCategoryID != OtherCategoryID {
					a.classified++
					if topOK {
						a.classifiedOK++
					}
				}
			}
			if r.Confidence >= accept && r.TopCategoryID != OtherCategoryID {
				a.accepted++
				if topOK {
					a.acceptedOK++
				}
			}
			if r.NeedsLLM {
				a.needsLLM++
			}
		}
		if !topOK {
			key := s.Top + "→" + r.TopCategoryID
			rep.confusion[key]++
			if s.Split == "holdout" {
				rep.holdoutConfusion[key]++
			}
			if s.Split != "holdout" || showHoldout {
				rep.misses = append(rep.misses, fmt.Sprintf("%s want %s got %s (%s, conf %.2f, %s) %q",
					s.ID, s.Top, r.TopCategoryID, r.CategoryID, r.Confidence, r.Status, clipRunes(s.Text, 60)))
			}
		}
		if s.Chitchat && r.TopCategoryID != OtherCategoryID && r.Status == StatusClassified && r.Confidence >= accept {
			rep.confidentChitchat = append(rep.confidentChitchat, fmt.Sprintf("%s → %s (conf %.2f)", s.ID, r.CategoryID, r.Confidence))
		}
	}
	return rep
}

func sortedCounts(m map[string]int) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if m[keys[i]] != m[keys[j]] {
			return m[keys[i]] > m[keys[j]]
		}
		return keys[i] < keys[j]
	})
	out := make([]string, len(keys))
	for i, k := range keys {
		out[i] = fmt.Sprintf("%s×%d", k, m[k])
	}
	return out
}

func logAccuracy(t *testing.T, title string, rep accuracyReport) {
	t.Helper()
	t.Logf("== %s ==", title)
	t.Logf("all      %s", rep.all)
	for _, split := range []string{"tune", "dev", "holdout"} {
		t.Logf("%-8s %s", split, rep.bySplit[split])
	}
	t.Logf("hard     %s", rep.hard)
	tops := make([]string, 0, len(rep.perTop))
	for top := range rep.perTop {
		tops = append(tops, top)
	}
	sort.Strings(tops)
	var per []string
	for _, top := range tops {
		a := rep.perTop[top]
		per = append(per, fmt.Sprintf("%s %d/%d", top, a.topOK, a.n))
	}
	t.Logf("recall by expected top-level: %s", strings.Join(per, ", "))
	t.Logf("confusions (expected→got): %s", strings.Join(sortedCounts(rep.confusion), ", "))
	t.Logf("holdout confusions: %s", strings.Join(sortedCounts(rep.holdoutConfusion), ", "))
	for _, m := range rep.misses {
		t.Logf("miss: %s", m)
	}
}

func TestLabeledFixtureIsWellFormed(t *testing.T) {
	samples := loadLabeled(t)
	if len(samples) < 150 {
		t.Fatalf("fixture has %d samples, want at least 150", len(samples))
	}
	e := DefaultEngine()
	seen := map[string]bool{}
	perTop := map[string]int{}
	for _, s := range samples {
		if seen[s.ID] {
			t.Errorf("%s: duplicate id", s.ID)
		}
		seen[s.ID] = true
		if strings.TrimSpace(s.Text) == "" {
			t.Errorf("%s: empty text", s.ID)
		}
		if ref := e.Ref(s.Top); !e.Known(s.Top) || ref.Level != 1 {
			t.Errorf("%s: top %q is not a top-level category", s.ID, s.Top)
		}
		if s.Second != "" && (!e.Known(s.Second) || e.Ref(s.Second).ParentID != s.Top) {
			t.Errorf("%s: second %q is not a child of %q", s.ID, s.Second, s.Top)
		}
		if s.Chitchat && s.Top != OtherCategoryID {
			t.Errorf("%s: chit-chat must be labelled %q", s.ID, OtherCategoryID)
		}
		if s.Split != "tune" && s.Split != "dev" && s.Split != "holdout" {
			t.Errorf("%s: unknown split %q", s.ID, s.Split)
		}
		perTop[s.Top]++
	}
	for _, id := range RequiredTopLevelIDs() {
		if perTop[id] < 8 {
			t.Errorf("category %s has only %d samples", id, perTop[id])
		}
	}
}

func TestLabeledAccuracy(t *testing.T) {
	samples := loadLabeled(t)
	e := DefaultEngine()

	rep := evaluateLabeled(e, samples, false)
	logAccuracy(t, "task types as labelled", rep)

	if got := rep.all.rate(rep.all.topOK, rep.all.n); got < 0.85 {
		t.Errorf("top-level accuracy %.3f is below 0.85", got)
	}
	// The holdout split is the one nobody could tune to; a collapse there
	// means the rules only memorised the tune split.
	if h := rep.bySplit["holdout"]; h.rate(h.topOK, h.n) < 0.75 {
		t.Errorf("holdout top-level accuracy %.3f is below 0.75", h.rate(h.topOK, h.n))
	}
	// What the engine confirms on its own must be right nearly always:
	// accepted results skip the LLM and the review queue.
	if got := rep.all.rate(rep.all.acceptedOK, rep.all.accepted); got < 0.95 {
		t.Errorf("precision of accepted results %.3f is below 0.95", got)
	}
	for _, c := range rep.confidentChitchat {
		t.Errorf("chit-chat confidently assigned to a work category: %s", c)
	}

	// Production feeds a task type for every request, computed by a noisy
	// first-match heuristic. The rules must hold up with that noise too.
	noisy := evaluateLabeled(e, samples, true)
	logAccuracy(t, "task types as the proxy would compute them", noisy)
	if got := noisy.all.rate(noisy.all.topOK, noisy.all.n); got < 0.85 {
		t.Errorf("top-level accuracy with derived task types %.3f is below 0.85", got)
	}
	for _, c := range noisy.confidentChitchat {
		t.Errorf("chit-chat confidently assigned with derived task types: %s", c)
	}
}
