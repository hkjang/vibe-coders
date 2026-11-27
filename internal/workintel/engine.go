package workintel

import (
	"math"
	"sort"
	"strings"
	"sync"
)

// Classification methods stored with every result.
const (
	MethodRule   = "rule"
	MethodLLM    = "llm"
	MethodCache  = "cache"
	MethodManual = "manual"
)

// Classification statuses. A request that has not been processed yet has no
// row at all, so there is no "pending" status.
const (
	StatusClassified   = "classified"
	StatusReview       = "review"
	StatusUnclassified = "unclassified"
	StatusFailed       = "failed"
)

// Difficulty classes, derived from the complexity score computed on the request path.
const (
	DifficultySimple    = "simple"
	DifficultyStandard  = "standard"
	DifficultyComplex   = "complex"
	DifficultyReasoning = "reasoning"
)

// Features is everything the engine may look at for one request. Text must
// already be redacted; the engine never stores or echoes it.
type Features struct {
	// Text is the latest user prompt, redacted. Only the first few kilobytes
	// are scanned.
	Text string `json:"text"`
	// TaskType is the coding task type computed on the request path
	// (generate, refactor, review, test, debug, docs, translate, explain,
	// text2sql, other). It is a noisy keyword heuristic, so it weighs little.
	TaskType string `json:"task_type"`
	// Languages are the programming languages detected in the prompt, as
	// display names ("Go", "SQL"). Pass only confident detections (code
	// fences, file extensions): a language guessed from a stray word such as
	// "type" would count as evidence of software work.
	Languages []string `json:"languages"`
	// MCPServers and MCPTools are the server labels and tool names invoked by
	// the request.
	MCPServers []string `json:"mcp_servers"`
	MCPTools   []string `json:"mcp_tools"`
	// Client is the friendly client label ("Claude Code", "Cursor").
	Client string `json:"client"`
	// Model and Endpoint are carried for the LLM step and future rules; the
	// rule engine does not score them, because a deployment that serves every
	// request with one coding model would bias every result.
	Model    string `json:"model"`
	Endpoint string `json:"endpoint"`
	// Complexity is the 0..100 complexity score; it only sets Difficulty.
	Complexity int `json:"complexity"`
	// PolicyFlags lists the DLP or secret policies that fired on the request.
	PolicyFlags []string `json:"policy_flags"`
}

// Cacheable reports whether a classification of this request may be stored
// in the fingerprint cache. Requests touched by a DLP or secret policy are
// never cached: the fingerprint of a redacted prompt can collide with a
// harmless one.
func (f Features) Cacheable() bool {
	return len(f.PolicyFlags) == 0
}

// Result is one classification.
type Result struct {
	CategoryID    string  `json:"category_id"`
	TopCategoryID string  `json:"top_category_id"`
	ActionType    string  `json:"action_type"`
	Difficulty    string  `json:"difficulty"`
	Confidence    float64 `json:"confidence"`
	Method        string  `json:"method"`
	Status        string  `json:"status"`
	// Tags are short safe labels. The rule engine uses them for the runner-up
	// categories of composite work.
	Tags         []string `json:"tags"`
	Technologies []string `json:"technologies"`
	TargetSystem string   `json:"target_system"`
	// WorkTitle is built from the category and action names, never from the prompt.
	WorkTitle string `json:"work_title"`
	// Secondary is the runner-up top-level category when it scored close to
	// the winner, which marks the request as composite work.
	Secondary string `json:"secondary"`
	// NewCategoryHint carries the category an LLM proposed that is not registered.
	NewCategoryHint string `json:"new_category_hint"`
	// NeedsLLM asks the caller to try the cache and then the LLM step.
	NeedsLLM   bool        `json:"needs_llm"`
	Candidates []Candidate `json:"candidates"`
}

// Candidate is a category that collected evidence, with the reasons.
type Candidate struct {
	CategoryID string   `json:"category_id"`
	Score      float64  `json:"score"`
	Evidence   []string `json:"evidence"`
}

// Evidence kinds. Their order is the order of the weight tables below.
const (
	evKeyword = iota
	evServer
	evTool
	evTask
	evLanguage
	evClient
	evKinds
)

// onceKinds is the number of evidence kinds that count once per category;
// onceKind maps an evidence kind to its slot among them, or -1.
const onceKinds = 3

var onceKind = [evKinds]int{evKeyword: -1, evServer: 0, evTool: 1, evTask: -1, evLanguage: 2, evClient: -1}

// evLeafWeight is how much one piece of evidence adds to the category that
// lists it; evTopWeight is how much it adds to that category's top level.
// The two differ only for the task type: it is good at choosing between the
// children of "dev" but, being derived from generic verbs such as "작성" or
// "설명", it says little about which top-level domain the work belongs to.
var (
	evLeafWeight = [evKinds]float64{1, 2.5, 2, 0.6, 0.6, 0.5}
	evTopWeight  = [evKinds]float64{1, 2.5, 2, 0.3, 0.6, 0.5}
	evLabel      = [evKinds]string{"키워드", "MCP 서버", "MCP 도구", "작업 유형", "언어", "클라이언트"}
)

const (
	// maxScanBytes bounds the work done per request regardless of prompt size.
	maxScanBytes = 12 << 10
	// minGuessScore is the evidence a top-level category needs before the
	// engine names it at all. One unshared keyword reaches it, even a domain
	// word of a top-level category; a lone task type or client does not.
	minGuessScore = 0.65
	// closeRatio marks the runner-up as a second domain of the same request.
	closeRatio = 0.6
	// evidenceScale shapes how evidence turns into confidence: one keyword
	// gives 0.49, two give 0.74, three 0.86.
	evidenceScale = 1.5
	// leafMinScore is the evidence a child needs to be chosen over its parent.
	leafMinScore = 0.5
	// shortTextRunes is the length up to which a text is treated as a ping or
	// greeting when it matches the "other" category.
	shortTextRunes = 24
	// minLLMRunes is the shortest text worth sending to the LLM step.
	minLLMRunes   = 10
	maxCandidates = 5
	maxResultTags = 5
	maxTechResult = 8
	// repeatBonus and repeatCap limit what repeating one keyword can add.
	repeatBonus = 0.25
	repeatCap   = 2
)

type posting struct {
	idx int32
	w   float64
}

// evItem is one distinct piece of evidence: a keyword, an MCP hint, a task
// type, a language or a client, with the categories it speaks for.
type evItem struct {
	kind  uint8
	label string
	cats  []posting // category index → weight
	tops  []posting // top-level slot → weight
}

type compiledCat struct {
	cat      Category
	ref      CategoryRef
	children []int32
	slot     int32 // slot of the tree top-level in Engine.tops
}

type compiledAction struct {
	id, name string
}

type multiHint struct {
	tokens []string
	item   int32
}

// Engine is a compiled policy. It is immutable and safe for concurrent use.
type Engine struct {
	policy Policy
	cats   []compiledCat
	index  map[string]int32
	canon  map[string]string
	tops   []int32 // category indexes of the top-level categories, in policy order
	// otherSlot is the slot of the "other" top level, which never competes.
	otherSlot int32

	m     matcher
	items []evItem

	serverHints, toolHints map[string][]int32
	serverMulti, toolMulti []multiHint
	taskItems              map[string]int32
	langItems              map[string]int32
	clientItems            map[string]int32

	actions     []compiledAction
	actionIndex map[string]int32
	taskAction  map[string]int32

	baselines map[string]int

	pool sync.Pool
}

type scratch struct {
	buf       []byte
	itemHits  []uint8
	hit       []int32
	applied   []int32
	catScore  []float64
	topScore  []float64
	topEv     []int32
	onceCat   [onceKinds][]float64
	onceTop   [onceKinds][]float64
	actFirst  []int32
	actLast   []int32
	techSeen  []bool
	techOrder []int32
	tokens    []string
	// domainKeywords counts the matched keywords that speak for a category
	// other than "other"; calledTools records that the request used MCP.
	domainKeywords int
	calledTools    bool
	// runes is the length of the normalised text in characters.
	runes int
}

// Compile normalises and validates p and builds an Engine. When the policy
// has problems the engine is nil and the issues say why; callers that must
// keep classifying can fall back to DefaultEngine.
func Compile(p Policy) (*Engine, []Issue) {
	p = Normalize(p)
	if issues := Validate(p); len(issues) > 0 {
		return nil, issues
	}
	e := &Engine{
		policy:      p,
		cats:        make([]compiledCat, len(p.Categories)),
		index:       make(map[string]int32, len(p.Categories)),
		serverHints: map[string][]int32{},
		toolHints:   map[string][]int32{},
		taskItems:   map[string]int32{},
		langItems:   map[string]int32{},
		clientItems: map[string]int32{},
		actionIndex: map[string]int32{},
		taskAction:  map[string]int32{},
		baselines:   map[string]int{},
	}
	for i, c := range p.Categories {
		e.index[c.ID] = int32(i)
	}
	for i, c := range p.Categories {
		cc := compiledCat{cat: c}
		if c.ParentID == "" {
			cc.slot = int32(len(e.tops))
			e.tops = append(e.tops, int32(i))
			if c.ID == OtherCategoryID {
				e.otherSlot = cc.slot
			}
		} else {
			parent := e.index[c.ParentID]
			e.cats[parent].children = append(e.cats[parent].children, int32(i))
		}
		// children may have been appended to this slot already by an earlier
		// iteration only if the policy lists a child before its parent.
		cc.children = e.cats[i].children
		e.cats[i] = cc
	}
	for i := range e.cats {
		c := &e.cats[i]
		top := e.index[topOfID(c.cat.ID)]
		c.slot = e.cats[top].slot
		c.ref = CategoryRef{
			ID:       c.cat.ID,
			Name:     c.cat.Name,
			Level:    levelOfID(c.cat.ID),
			ParentID: c.cat.ParentID,
			TopID:    topOfID(c.cat.ID),
			Enabled:  e.effectivelyEnabled(int32(i)),
		}
	}
	e.computeCanonical()
	for i, b := range p.Baselines {
		e.baselines[b.CategoryID] = i
	}

	tb := newTrieBuilder()
	e.compileEvidence(tb)
	e.compileActions(tb)
	for i, t := range knownTech {
		for _, pat := range list(t.patterns) {
			id := tb.add(normalizeKeyword(pat))
			if tb.pats[id].tech < 0 {
				tb.pats[id].tech = int32(i)
			}
		}
	}
	e.m = tb.build()

	e.pool.New = func() any {
		sc := &scratch{
			buf:      make([]byte, 0, 4096),
			itemHits: make([]uint8, len(e.items)),
			catScore: make([]float64, len(e.cats)),
			topScore: make([]float64, len(e.tops)),
			topEv:    make([]int32, len(e.tops)),
			actFirst: make([]int32, len(e.actions)),
			actLast:  make([]int32, len(e.actions)),
			techSeen: make([]bool, len(knownTech)),
		}
		for k := range sc.onceCat {
			sc.onceCat[k] = make([]float64, len(e.cats))
			sc.onceTop[k] = make([]float64, len(e.tops))
		}
		return sc
	}
	return e, nil
}

var (
	defaultEngineOnce sync.Once
	defaultEngine     *Engine
)

// DefaultEngine returns the engine compiled from DefaultPolicy. It is the
// fallback when a stored policy can no longer be compiled.
func DefaultEngine() *Engine {
	defaultEngineOnce.Do(func() {
		e, issues := Compile(DefaultPolicy())
		if len(issues) > 0 {
			// The built-in policy is covered by tests; reaching this is a
			// programming error, not a runtime condition.
			panic("workintel: built-in policy is invalid: " + issues[0].Path + ": " + issues[0].Message)
		}
		defaultEngine = e
	})
	return defaultEngine
}

func (e *Engine) effectivelyEnabled(i int32) bool {
	for {
		c := &e.cats[i]
		if !c.cat.Enabled {
			return false
		}
		if c.cat.ParentID == "" {
			return true
		}
		i = e.index[c.cat.ParentID]
	}
}

// computeCanonical resolves every registered id once. Validate rejects merge
// cycles, but the depth guard keeps a future validation gap from turning
// into unbounded recursion.
func (e *Engine) computeCanonical() {
	e.canon = make(map[string]string, len(e.cats))
	limit := len(e.cats) + 4
	var resolve func(id string, depth int) string
	resolve = func(id string, depth int) string {
		if v, ok := e.canon[id]; ok {
			return v
		}
		if depth > limit {
			return OtherCategoryID
		}
		out := OtherCategoryID
		if i, ok := e.index[id]; ok {
			c := e.cats[i].cat
			switch {
			case !c.Enabled:
				if c.ParentID != "" {
					out = resolve(c.ParentID, depth+1)
				}
			case c.MergedInto != "" && c.MergedInto != id:
				out = resolve(c.MergedInto, depth+1)
			case c.ParentID == "":
				out = id
			default:
				// An enabled child stays itself only while its parent does;
				// when the parent was merged or disabled the child follows it.
				if rp := resolve(c.ParentID, depth+1); rp == c.ParentID {
					out = id
				} else {
					out = rp
				}
			}
		} else if p := parentOfID(id); p != "" {
			out = resolve(p, depth+1)
		}
		e.canon[id] = out
		return out
	}
	for i := range e.cats {
		resolve(e.cats[i].cat.ID, 0)
	}
}

// compileEvidence turns the rules of every active category into evidence
// items and registers the keywords in the matcher.
func (e *Engine) compileEvidence(tb *trieBuilder) {
	type rawPost struct{ leaf, top float64 }
	type key struct {
		kind uint8
		text string
	}
	ids := map[key]int32{}
	var raw []map[int32]rawPost
	// text identifies the evidence; display is what a reader sees. They only
	// differ for clients, which keep their capitalisation in the label.
	item := func(kind uint8, text, display string) int32 {
		k := key{kind, text}
		if id, ok := ids[k]; ok {
			return id
		}
		id := int32(len(e.items))
		ids[k] = id
		e.items = append(e.items, evItem{kind: kind, label: evLabel[kind] + ": " + display})
		raw = append(raw, map[int32]rawPost{})
		return id
	}
	post := func(id, target int32, kind uint8, weight float64) {
		p := raw[id][target]
		p.leaf = math.Max(p.leaf, evLeafWeight[kind]*weight)
		p.top = math.Max(p.top, evTopWeight[kind]*weight)
		raw[id][target] = p
	}

	for i := range e.cats {
		c := e.cats[i].cat
		// A disabled category contributes nothing. A merged one keeps
		// detecting its work and hands it to the category it was merged into.
		if !e.effectivelyEnabled(int32(i)) {
			continue
		}
		targetID := e.canon[c.ID]
		target, ok := e.index[targetID]
		if !ok || (targetID == OtherCategoryID && topOfID(c.ID) != OtherCategoryID) {
			continue
		}
		w := c.Rules.Weight
		for _, kw := range c.Rules.Keywords {
			text := normalizeKeyword(kw)
			if text == "" {
				continue
			}
			id := item(evKeyword, text, text)
			post(id, target, evKeyword, w)
			tb.pats[tb.add(text)].item = id
		}
		for _, h := range c.Rules.MCPServers {
			post(item(evServer, h, h), target, evServer, w)
		}
		for _, h := range c.Rules.MCPTools {
			post(item(evTool, h, h), target, evTool, w)
		}
		for _, t := range c.Rules.TaskTypes {
			id := item(evTask, t, t)
			post(id, target, evTask, w)
			e.taskItems[t] = id
		}
		for _, l := range c.Rules.Languages {
			id := item(evLanguage, l, l)
			post(id, target, evLanguage, w)
			e.langItems[l] = id
		}
		for _, cl := range c.Rules.Clients {
			key := strings.ToLower(cl)
			id := item(evClient, key, cl)
			post(id, target, evClient, w)
			e.clientItems[key] = id
		}
	}

	for k, id := range ids {
		switch k.kind {
		case evServer:
			e.addHint(k.text, id, e.serverHints, &e.serverMulti)
		case evTool:
			e.addHint(k.text, id, e.toolHints, &e.toolMulti)
		}
	}
	// Map iteration order must not leak into matching order.
	sort.Slice(e.serverMulti, func(i, j int) bool { return e.serverMulti[i].item < e.serverMulti[j].item })
	sort.Slice(e.toolMulti, func(i, j int) bool { return e.toolMulti[i].item < e.toolMulti[j].item })
	for _, hints := range []map[string][]int32{e.serverHints, e.toolHints} {
		for _, itemIDs := range hints {
			sort.Slice(itemIDs, func(i, j int) bool { return itemIDs[i] < itemIDs[j] })
		}
	}

	for id := range e.items {
		// Evidence shared by several top-level domains is weaker for each of
		// them. "other" is not a domain and neither dilutes nor is diluted.
		domains := map[int32]bool{}
		for target := range raw[id] {
			if slot := e.cats[target].slot; slot != e.otherSlot {
				domains[slot] = true
			}
		}
		share := float64(len(domains))
		if share < 1 {
			share = 1
		}
		topMax := map[int32]float64{}
		for target, p := range raw[id] {
			slot := e.cats[target].slot
			div := share
			if slot == e.otherSlot {
				div = 1
			}
			e.items[id].cats = append(e.items[id].cats, posting{idx: target, w: p.leaf / div})
			if v := p.top / div; v > topMax[slot] {
				topMax[slot] = v
			}
		}
		for slot, w := range topMax {
			e.items[id].tops = append(e.items[id].tops, posting{idx: slot, w: w})
		}
		sort.Slice(e.items[id].cats, func(i, j int) bool { return e.items[id].cats[i].idx < e.items[id].cats[j].idx })
		sort.Slice(e.items[id].tops, func(i, j int) bool { return e.items[id].tops[i].idx < e.items[id].tops[j].idx })
	}
}

func (e *Engine) addHint(text string, item int32, single map[string][]int32, multi *[]multiHint) {
	tokens := splitLabel(nil, text)
	switch len(tokens) {
	case 0:
	case 1:
		single[tokens[0]] = append(single[tokens[0]], item)
	default:
		*multi = append(*multi, multiHint{tokens: tokens, item: item})
	}
}

func (e *Engine) compileActions(tb *trieBuilder) {
	for i, a := range e.policy.ActionTypes {
		e.actions = append(e.actions, compiledAction{id: a.ID, name: a.Name})
		e.actionIndex[a.ID] = int32(i)
		for _, kw := range a.Keywords {
			text := normalizeKeyword(kw)
			if text == "" {
				continue
			}
			id := tb.add(text)
			// The first action type that lists a keyword keeps it.
			if tb.pats[id].action < 0 {
				tb.pats[id].action = int32(i)
			}
		}
	}
	for task, action := range taskTypeActions {
		if i, ok := e.actionIndex[action]; ok {
			e.taskAction[task] = i
		}
	}
}

// Policy returns a copy of the normalised policy the engine was compiled from.
func (e *Engine) Policy() Policy {
	return clonePolicy(e.policy)
}

// Thresholds returns the thresholds in effect.
func (e *Engine) Thresholds() Thresholds {
	return e.policy.Thresholds
}

// Known reports whether id is a registered category, enabled or not.
func (e *Engine) Known(id string) bool {
	_, ok := e.index[normalizeID(id)]
	return ok
}

// Ref describes a category. An id the policy does not know is described
// under "other" and named after itself, so rows classified by an older
// policy still render.
func (e *Engine) Ref(id string) CategoryRef {
	if i, ok := e.index[id]; ok {
		return e.cats[i].ref
	}
	if id == "" {
		id = OtherCategoryID
		if i, ok := e.index[id]; ok {
			return e.cats[i].ref
		}
	}
	return CategoryRef{ID: id, Name: id, Level: 2, ParentID: OtherCategoryID, TopID: OtherCategoryID, Enabled: false}
}

// Canonical returns the category that currently stands for id: it follows
// merged_into chains and moves a disabled or unknown id up to its nearest
// enabled ancestor, ending at "other".
func (e *Engine) Canonical(id string) string {
	if v, ok := e.canon[id]; ok {
		return v
	}
	id = normalizeID(id)
	for id != "" {
		if v, ok := e.canon[id]; ok {
			return v
		}
		id = parentOfID(id)
	}
	return OtherCategoryID
}

// TopOf returns the top-level category that currently stands for id.
func (e *Engine) TopOf(id string) string {
	return topOfID(e.Canonical(id))
}

// Children returns the direct children of parentID in policy order. An empty
// parentID lists the top-level categories.
func (e *Engine) Children(parentID string) []CategoryRef {
	var idx []int32
	if parentID == "" {
		idx = e.tops
	} else if i, ok := e.index[parentID]; ok {
		idx = e.cats[i].children
	}
	out := make([]CategoryRef, 0, len(idx))
	for _, i := range idx {
		out = append(out, e.cats[i].ref)
	}
	return out
}

// Refs returns every registered category in policy order.
func (e *Engine) Refs() []CategoryRef {
	out := make([]CategoryRef, len(e.cats))
	for i := range e.cats {
		out[i] = e.cats[i].ref
	}
	return out
}

// Descendants returns id followed by every category that is reported under
// it: the categories below it in the tree and the categories merged into any
// of them. It is the id set to filter stored rows by, because rows keep the
// id they were classified with.
func (e *Engine) Descendants(id string) []string {
	root, ok := e.index[id]
	if !ok {
		return []string{id}
	}
	in := make([]bool, len(e.cats))
	var mark func(i int32)
	mark = func(i int32) {
		if in[i] {
			return
		}
		in[i] = true
		for _, ch := range e.cats[i].children {
			mark(ch)
		}
	}
	mark(root)
	// A merge can bring in a subtree that itself is a merge target, so repeat
	// until nothing new folds in.
	for changed := true; changed; {
		changed = false
		for i := range e.cats {
			if in[i] {
				continue
			}
			if t, ok := e.index[e.canon[e.cats[i].cat.ID]]; ok && in[t] && e.cats[i].cat.MergedInto != "" {
				mark(int32(i))
				changed = true
			}
		}
	}
	out := []string{id}
	for i := range e.cats {
		if in[i] && int32(i) != root {
			out = append(out, e.cats[i].cat.ID)
		}
	}
	return out
}

// ActionName returns the display name of an action type, or "" when the id
// is not registered.
func (e *Engine) ActionName(id string) string {
	if i, ok := e.actionIndex[id]; ok {
		return e.actions[i].name
	}
	return ""
}

// KnownAction reports whether id is a registered action type.
func (e *Engine) KnownAction(id string) bool {
	_, ok := e.actionIndex[id]
	return ok
}

// BaselineFor returns the savings baseline that applies to a category: its
// own, or the nearest ancestor's. It returns nil when there is none.
func (e *Engine) BaselineFor(id string) *Baseline {
	for id != "" {
		if i, ok := e.baselines[id]; ok {
			b := e.policy.Baselines[i]
			return &b
		}
		id = parentOfID(id)
	}
	return nil
}

// DifficultyOf maps the 0..100 complexity score to a difficulty class.
func DifficultyOf(complexity int) string {
	switch {
	case complexity < 30:
		return DifficultySimple
	case complexity < 60:
		return DifficultyStandard
	case complexity < 85:
		return DifficultyComplex
	default:
		return DifficultyReasoning
	}
}

// Classify scores a request against the rules. It is deterministic, does not
// allocate proportionally to the text and never returns prompt text.
func (e *Engine) Classify(f Features) Result {
	sc := e.pool.Get().(*scratch)
	defer e.release(sc)

	sc.buf = normalizeText(sc.buf[:0], f.Text, maxScanBytes)
	korean := e.scan(sc)
	e.collectContext(sc, &f)

	for _, id := range sc.hit {
		it := &e.items[id]
		if k := onceKind[it.kind]; k >= 0 {
			e.applyOnce(sc, id, k)
			continue
		}
		mult := 1.0
		domainKeyword := false
		if n := int(sc.itemHits[id]) - 1; n > 0 {
			if n > repeatCap {
				n = repeatCap
			}
			mult += repeatBonus * float64(n)
		}
		for _, p := range it.cats {
			sc.catScore[p.idx] += p.w * mult
		}
		for _, p := range it.tops {
			sc.topScore[p.idx] += p.w * mult
			// The task type is derived from the same words the keywords
			// match, so it adds weight but is not an independent piece of
			// evidence.
			if it.kind != evTask {
				sc.topEv[p.idx]++
			}
			if it.kind == evKeyword && p.idx != e.otherSlot {
				domainKeyword = true
			}
		}
		if domainKeyword {
			sc.domainKeywords++
		}
		sc.applied = append(sc.applied, id)
	}

	res := Result{
		Method:       MethodRule,
		Difficulty:   DifficultyOf(f.Complexity),
		ActionType:   e.pickAction(sc, f.TaskType, korean),
		Technologies: e.technologies(sc, f.Languages),
		TargetSystem: e.targetSystem(sc, f.MCPServers),
		Tags:         []string{},
	}
	e.decide(sc, &res)
	res.Candidates = e.candidates(sc)
	res.WorkTitle = e.workTitle(res.CategoryID, res.ActionType)
	return res
}

func (e *Engine) release(sc *scratch) {
	clear(sc.itemHits)
	clear(sc.catScore)
	clear(sc.topScore)
	clear(sc.topEv)
	for k := range sc.onceCat {
		clear(sc.onceCat[k])
		clear(sc.onceTop[k])
	}
	clear(sc.techSeen)
	sc.hit = sc.hit[:0]
	sc.applied = sc.applied[:0]
	sc.techOrder = sc.techOrder[:0]
	sc.domainKeywords = 0
	sc.calledTools = false
	clear(sc.tokens)
	sc.tokens = sc.tokens[:0]
	e.pool.Put(sc)
}

// scan walks the normalised text once and records keyword, action and
// technology matches. It reports whether the text is predominantly Korean,
// which decides how action ties are broken.
func (e *Engine) scan(sc *scratch) (korean bool) {
	buf := sc.buf
	m := &e.m
	n := len(buf)
	for i := range sc.actFirst {
		sc.actFirst[i] = math.MaxInt32
		sc.actLast[i] = -1
	}
	hangul, latin := 0, 0
	covered := 0 // end of the longest category keyword matched so far
	sc.runes = 0
	for i := 0; i < n; i++ {
		b := buf[i]
		switch {
		case b >= 0xEA && b <= 0xED:
			hangul++
		case b >= 'a' && b <= 'z':
			latin++
		}
		// A pattern cannot start in the middle of a rune or on a space, and an
		// English pattern cannot start in the middle of a word.
		if b >= 0x80 && b < 0xC0 {
			continue
		}
		// Characters are counted here rather than with utf8.RuneCount, which
		// copies the buffer on this toolchain.
		sc.runes++
		if b == ' ' {
			continue
		}
		if wordByte[b] && i > 0 && wordByte[buf[i-1]] {
			continue
		}
		node := m.dense[int(b)]
		if node < 0 {
			continue
		}
		bestItem, bestItemEnd := int32(-1), 0
		bestAct, bestTech := int32(-1), int32(-1)
		j := i + 1
		for {
			if p := m.nodes[node].pat; p >= 0 {
				pt := &m.pats[p]
				if !pt.exact || wordEndsAt(buf, j, pt.inflect) {
					// Only the longest match of each role counts at one
					// position, so "자바스크립트" is not also "자바".
					if pt.item >= 0 {
						bestItem, bestItemEnd = pt.item, j
					}
					if pt.action >= 0 {
						bestAct = p
					}
					if pt.tech >= 0 {
						bestTech = pt.tech
					}
				}
			}
			if j >= n {
				break
			}
			if node = m.step(node, buf[j]); node < 0 {
				break
			}
			j++
		}
		// A keyword lying entirely inside a longer one that was already
		// counted is the same piece of text, not more evidence.
		if bestItem >= 0 && bestItemEnd > covered {
			covered = bestItemEnd
			if sc.itemHits[bestItem] == 0 {
				sc.hit = append(sc.hit, bestItem)
			}
			if sc.itemHits[bestItem] < math.MaxUint8 {
				sc.itemHits[bestItem]++
			}
		}
		if bestAct >= 0 {
			a := m.pats[bestAct].action
			if int32(i) < sc.actFirst[a] {
				sc.actFirst[a] = int32(i)
			}
			if int32(i) > sc.actLast[a] {
				sc.actLast[a] = int32(i)
			}
		}
		if bestTech >= 0 && !sc.techSeen[bestTech] {
			sc.techSeen[bestTech] = true
			sc.techOrder = append(sc.techOrder, bestTech)
		}
	}
	// A Hangul syllable carries about as much as three Latin letters.
	return hangul > 0 && hangul*3 >= latin
}

// collectContext adds the evidence that does not come from the text.
func (e *Engine) collectContext(sc *scratch, f *Features) {
	add := func(id int32) {
		if sc.itemHits[id] == 0 {
			sc.itemHits[id] = 1
			sc.hit = append(sc.hit, id)
		}
	}
	match := func(tokens []string, single map[string][]int32, multi []multiHint) {
		for _, t := range tokens {
			for _, id := range single[t] {
				add(id)
			}
			// A hint of six characters or more also matches as the start of
			// a name segment ("postgres" in "postgresql").
			for k := 6; k < len(t); k++ {
				for _, id := range single[t[:k]] {
					add(id)
				}
			}
		}
		for _, h := range multi {
			if containsSequence(tokens, h.tokens) {
				add(h.item)
			}
		}
	}
	sc.calledTools = len(f.MCPServers) > 0 || len(f.MCPTools) > 0
	for _, s := range f.MCPServers {
		sc.tokens = splitLabel(sc.tokens[:0], strings.ToLower(s))
		match(sc.tokens, e.serverHints, e.serverMulti)
	}
	for _, t := range f.MCPTools {
		// Tool names are often qualified with their server
		// ("mcp__github__create_issue"), so server hints apply to them too.
		sc.tokens = splitLabel(sc.tokens[:0], strings.ToLower(t))
		match(sc.tokens, e.serverHints, e.serverMulti)
		match(sc.tokens, e.toolHints, e.toolMulti)
	}
	if f.TaskType != "" {
		if id, ok := e.taskItems[strings.ToLower(strings.TrimSpace(f.TaskType))]; ok {
			add(id)
		}
	}
	for _, l := range f.Languages {
		if id, ok := e.langItems[strings.ToLower(strings.TrimSpace(l))]; ok {
			add(id)
		}
	}
	if f.Client != "" {
		if id, ok := e.clientItems[strings.ToLower(strings.TrimSpace(f.Client))]; ok {
			add(id)
		}
	}
}

// applyOnce credits evidence of a kind at most once per category, at the
// largest weight seen. A prompt with both TypeScript and JavaScript is not
// twice as likely to be software work, and five tools of one server are one
// fact about the request, not five.
func (e *Engine) applyOnce(sc *scratch, id int32, k int) {
	it := &e.items[id]
	used := false
	for _, p := range it.cats {
		if cur := sc.onceCat[k][p.idx]; p.w > cur {
			sc.catScore[p.idx] += p.w - cur
			sc.onceCat[k][p.idx] = p.w
			used = true
		}
	}
	for _, p := range it.tops {
		if cur := sc.onceTop[k][p.idx]; p.w > cur {
			sc.topScore[p.idx] += p.w - cur
			sc.onceTop[k][p.idx] = p.w
			if cur == 0 {
				sc.topEv[p.idx]++
			}
			used = true
		}
	}
	if used {
		sc.applied = append(sc.applied, id)
	}
}

// decide turns the scores into a category, a confidence and a status.
func (e *Engine) decide(sc *scratch, res *Result) {
	th := e.policy.Thresholds
	best, second := int32(-1), int32(-1)
	for slot := range e.tops {
		s := int32(slot)
		if s == e.otherSlot || sc.topScore[s] <= 0 {
			continue
		}
		switch {
		case best < 0 || sc.topScore[s] > sc.topScore[best]:
			best, second = s, best
		case second < 0 || sc.topScore[s] > sc.topScore[second]:
			second = s
		}
	}
	var t1, t2 float64
	if best >= 0 {
		t1 = sc.topScore[best]
	}
	if second >= 0 {
		t2 = sc.topScore[second]
	}
	otherScore := sc.topScore[e.otherSlot]
	runes := sc.runes

	// "other" does not compete: a greeting in front of a real request must
	// not outvote it. It only wins when nothing else has usable evidence, or
	// when a very short text matches it and at most one keyword of a real
	// category ("test" is a ping, not a testing task). A request that called
	// tools is never a ping, however short its text.
	shortChat := otherScore >= minGuessScore && runes <= shortTextRunes && !sc.calledTools
	useOther := t1 < minGuessScore || (shortChat && sc.domainKeywords <= 1)
	if useOther {
		top := e.tops[e.otherSlot]
		res.TopCategoryID = OtherCategoryID
		res.CategoryID = e.cats[e.pickLeaf(sc, top)].cat.ID
		if otherScore < minGuessScore {
			res.CategoryID = OtherCategoryID
			res.Status = StatusUnclassified
			res.NeedsLLM = runes >= minLLMRunes
			return
		}
		conf := evidenceConfidence(otherScore)
		if shortChat {
			// Short and matching nothing but chit-chat vocabulary: there is
			// nothing more an LLM could find out.
			conf = math.Max(conf, 0.9)
		}
		// Thresholds are compared against the rounded value that is stored,
		// so a stored confidence never contradicts its status.
		conf = round3(conf)
		res.Confidence = conf
		res.Status = StatusClassified
		if conf < th.ReviewBelow {
			res.Status = StatusUnclassified
		}
		res.NeedsLLM = conf < th.Accept && runes >= minLLMRunes
		return
	}

	margin := (t1 - t2) / t1
	conf := evidenceConfidence(t1) * (0.5 + 0.5*margin)
	if int(sc.topEv[best]) < th.MinEvidence {
		// Not enough distinct evidence to confirm, however strong the one
		// piece is.
		conf = math.Min(conf, math.Max(th.Accept-0.02, 0))
	}
	conf = round3(conf)
	top := e.tops[best]
	leaf := e.pickLeaf(sc, top)
	res.TopCategoryID = e.cats[top].cat.ID
	res.CategoryID = e.cats[leaf].cat.ID
	res.Confidence = conf
	res.Status = StatusClassified
	if conf < th.ReviewBelow {
		res.Status = StatusReview
	}
	if second >= 0 && t2 >= minGuessScore && t2 >= closeRatio*t1 {
		sec := e.cats[e.tops[second]].cat
		res.Secondary = sec.ID
		res.Tags = append(res.Tags, sec.Name)
	}
	res.NeedsLLM = conf < th.Accept || res.Secondary != ""

	// A sibling that scored nearly as well is worth a tag: "테스트" next to
	// "리팩토링" tells a reader more than the single winning leaf.
	if leaf != top {
		parent := e.index[e.cats[leaf].cat.ParentID]
		lead := e.subtreeScore(sc, leaf)
		for _, ch := range e.cats[parent].children {
			if ch == leaf || len(res.Tags) >= maxResultTags {
				continue
			}
			if s := e.subtreeScore(sc, ch); s >= 1 && s >= closeRatio*lead {
				res.Tags = append(res.Tags, e.cats[ch].cat.Name)
			}
		}
	}
}

// evidenceConfidence maps an evidence score to 0..1 with diminishing returns.
func evidenceConfidence(score float64) float64 {
	return 1 - math.Exp(-score/evidenceScale)
}

func (e *Engine) subtreeScore(sc *scratch, i int32) float64 {
	s := sc.catScore[i]
	for _, ch := range e.cats[i].children {
		s += e.subtreeScore(sc, ch)
	}
	return s
}

// pickLeaf descends from a top-level category to the most specific
// descendant that has enough evidence of its own. Ties keep policy order.
func (e *Engine) pickLeaf(sc *scratch, i int32) int32 {
	for {
		best, bestScore := int32(-1), 0.0
		for _, ch := range e.cats[i].children {
			if s := e.subtreeScore(sc, ch); s > bestScore {
				best, bestScore = ch, s
			}
		}
		if best < 0 || bestScore < leafMinScore {
			return i
		}
		i = best
	}
}

// pickAction chooses the action type. Action keywords in the text decide;
// when several actions are named, word order does, because counting synonyms
// says nothing about which verb is the request: Korean puts the main verb
// last ("분석해서 보고서 만들어줘"), English puts it first ("create a report
// analysing …"). The task type is only a fallback for texts that name no
// action, since it is itself guessed from the same words.
func (e *Engine) pickAction(sc *scratch, taskType string, korean bool) string {
	best := int32(-1)
	for i := range e.actions {
		a := int32(i)
		if sc.actLast[a] < 0 {
			continue
		}
		switch {
		case best < 0:
			best = a
		case korean && sc.actLast[a] > sc.actLast[best]:
			best = a
		case !korean && sc.actFirst[a] < sc.actFirst[best]:
			best = a
		}
	}
	if best < 0 && taskType != "" {
		if a, ok := e.taskAction[strings.ToLower(strings.TrimSpace(taskType))]; ok {
			best = a
		}
	}
	if best < 0 {
		return UnknownAction
	}
	return e.actions[best].id
}

func (e *Engine) technologies(sc *scratch, languages []string) []string {
	out := make([]string, 0, len(languages)+len(sc.techOrder))
	has := func(v string) bool {
		for _, o := range out {
			if strings.EqualFold(o, v) {
				return true
			}
		}
		return false
	}
	for _, l := range languages {
		if l = strings.TrimSpace(l); l != "" && !has(l) && len(out) < maxTechResult {
			out = append(out, clipRunes(l, maxTagRunes))
		}
	}
	for _, t := range sc.techOrder {
		if label := knownTech[t].label; !has(label) && len(out) < maxTechResult {
			out = append(out, label)
		}
	}
	return out
}

// targetSystem prefers what the request actually called over what it merely
// mentioned: the first MCP server, then the first system named in the text.
func (e *Engine) targetSystem(sc *scratch, servers []string) string {
	first := ""
	for _, s := range servers {
		s = strings.ToLower(strings.TrimSpace(s))
		if s == "" {
			continue
		}
		if first == "" {
			first = s
		}
		sc.tokens = splitLabel(sc.tokens[:0], s)
		for _, t := range sc.tokens {
			if sys, ok := systemByToken[t]; ok {
				return sys
			}
			for k := 6; k < len(t); k++ {
				if sys, ok := systemByToken[t[:k]]; ok {
					return sys
				}
			}
		}
	}
	if first != "" {
		return sanitizeLabel(first, maxSystemRunes)
	}
	for _, t := range sc.techOrder {
		if sys := knownTech[t].system; sys != "" {
			return sys
		}
	}
	return ""
}

func (e *Engine) candidates(sc *scratch) []Candidate {
	type scored struct {
		idx   int32
		score float64
	}
	var top [maxCandidates]scored
	n := 0
	for i := range e.cats {
		s := sc.catScore[i]
		if s <= 0 {
			continue
		}
		// Insertion into a small sorted array: strictly greater moves ahead,
		// so equal scores keep policy order.
		pos := n
		for pos > 0 && s > top[pos-1].score {
			pos--
		}
		if pos >= maxCandidates {
			continue
		}
		if n < maxCandidates {
			n++
		}
		copy(top[pos+1:n], top[pos:n-1])
		top[pos] = scored{int32(i), s}
	}
	out := make([]Candidate, 0, n)
	for _, c := range top[:n] {
		ev := []string{}
		for _, id := range sc.applied {
			for _, p := range e.items[id].cats {
				if p.idx == c.idx {
					ev = append(ev, e.items[id].label)
					break
				}
			}
		}
		out = append(out, Candidate{CategoryID: e.cats[c.idx].cat.ID, Score: round3(c.score), Evidence: ev})
	}
	return out
}

// workTitle builds a title from registered names only, so it is safe to
// store and show without another redaction pass.
func (e *Engine) workTitle(categoryID, action string) string {
	name := e.Ref(categoryID).Name
	if an := e.ActionName(action); an != "" {
		return name + " · " + an
	}
	return name
}

// systemByToken maps a name segment to a canonical system id. Only
// single-segment ASCII names are usable for matching server labels.
var systemByToken = func() map[string]string {
	m := map[string]string{}
	for _, t := range knownTech {
		if t.system == "" {
			continue
		}
		m[t.system] = t.system
		for _, p := range list(t.patterns) {
			if tokens := splitLabel(nil, p); len(tokens) == 1 && tokens[0] == p {
				if _, taken := m[p]; !taken {
					m[p] = t.system
				}
			}
		}
	}
	return m
}()

// splitLabel splits a lower-cased server or tool name into its segments.
// Every ASCII character that is not a letter or digit separates segments;
// other bytes stay inside them so non-English labels still work.
func splitLabel(dst []string, s string) []string {
	start := -1
	for i := 0; i < len(s); i++ {
		if c := s[i]; wordByte[c] || c >= 0x80 {
			if start < 0 {
				start = i
			}
			continue
		}
		if start >= 0 {
			dst = append(dst, s[start:i])
			start = -1
		}
	}
	if start >= 0 {
		dst = append(dst, s[start:])
	}
	return dst
}

func containsSequence(tokens, seq []string) bool {
	for i := 0; i+len(seq) <= len(tokens); i++ {
		ok := true
		for j := range seq {
			if tokens[i+j] != seq[j] {
				ok = false
				break
			}
		}
		if ok {
			return true
		}
	}
	return false
}

func round3(v float64) float64 {
	return math.Round(v*1000) / 1000
}
