package proxy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"vibe-coders/internal/text2sql"
)

// Dynamic routes are named routing graphs a client calls as the model
// "dynamic/<name>". The graph format follows Cloudflare AI Gateway's dynamic
// routing JSON — {"elements": [{"id", "type", "properties", "outputs"}]} with
// outputs written as {"<name>": {"elementId": "<id>"}} — so a route exported from
// there can be pasted in and adjusted rather than rebuilt.
//
// Element types:
//
//	start        the single entry point; output "next"
//	conditional  evaluates properties.conditions; outputs "true" and "false"
//	percentage   splits traffic; outputs keyed "<n>%" that sum to 100
//	rate         a request-count or cost limit per window; outputs "success" and
//	             optionally "fallback" (taken once the limit is spent)
//	model        calls one model; output "success" (to an end) and optionally
//	             "fallback" (taken once its timeout/retries are exhausted)
//	end          returns the response of the last model that succeeded
const (
	dynamicRouteModelPrefix    = "dynamic/"
	dynamicRouteMaxElements    = 64
	dynamicRouteMaxPercentages = 5
	dynamicRouteMaxRetries     = 5
	dynamicRouteMaxTimeoutMS   = 600_000
	dynamicRouteMaxRetryDelay  = 60_000
	dynamicRouteMinWindow      = 10
	dynamicRouteMaxWindow      = 31 * 24 * 3600
	dynamicRouteMaxGraphBytes  = 256 << 10
	dynamicRouteMaxLabel       = 80
	dynamicRouteMaxConditionIn = 100
)

var (
	dynamicRouteNamePattern      = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,62}$`)
	dynamicRouteElementIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)
	dynamicRouteMetadataKey      = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,64}$`)
)

// Fields other than metadata.* that a condition, a percentage's sticky key or a
// rate key can read. They come from the authenticated caller and the request, not
// from anything the client can assert in a header.
var dynamicRouteBuiltinFields = map[string]string{
	"identity.team_id":    "호출 키의 팀 ID",
	"identity.team":       "호출 키의 팀 이름",
	"identity.user_id":    "호출 키의 사용자 ID",
	"identity.api_key_id": "호출 키 ID",
	"identity.role":       "호출 키 사용자의 역할",
	"request.stream":      "스트리밍 요청 여부 (true/false)",
	"request.endpoint":    "호출 경로 (예: /v1/chat/completions)",
}

type dynamicRouteOutput struct {
	ElementID string `json:"elementId"`
}

// dynamicRouteProperties is the union of every element type's settings. The
// normalizer clears what an element's type does not use, so a stored graph only
// carries meaningful fields.
type dynamicRouteProperties struct {
	Conditions json.RawMessage `json:"conditions,omitempty"`
	StickyKey  string          `json:"stickyKey,omitempty"`
	LimitType  string          `json:"limitType,omitempty"`
	Key        string          `json:"key,omitempty"`
	Limit      float64         `json:"limit,omitempty"`
	Window     int64           `json:"window,omitempty"`
	Provider   string          `json:"provider,omitempty"`
	Model      string          `json:"model,omitempty"`
	Timeout    int64           `json:"timeout,omitempty"`
	Retries    int             `json:"retries,omitempty"`
	RetryDelay int64           `json:"retryDelay,omitempty"`
	Backoff    string          `json:"backoff,omitempty"`
}

type dynamicRouteElement struct {
	ID         string                        `json:"id"`
	Type       string                        `json:"type"`
	Label      string                        `json:"label,omitempty"`
	Properties dynamicRouteProperties        `json:"properties"`
	Outputs    map[string]dynamicRouteOutput `json:"outputs,omitempty"`
}

func (e *dynamicRouteElement) output(name string) string {
	if e == nil || e.Outputs == nil {
		return ""
	}
	return e.Outputs[name].ElementID
}

type dynamicRouteGraph struct {
	Elements []dynamicRouteElement `json:"elements"`
}

type dynamicRouteIssue struct {
	ElementID string `json:"element_id,omitempty"`
	Code      string `json:"code"`
	Message   string `json:"message"`
}

type dynamicRouteValidation struct {
	Errors   []dynamicRouteIssue `json:"errors"`
	Warnings []dynamicRouteIssue `json:"warnings"`
}

func (v *dynamicRouteValidation) fail(elementID, code, format string, args ...any) {
	v.Errors = append(v.Errors, dynamicRouteIssue{ElementID: elementID, Code: code, Message: fmt.Sprintf(format, args...)})
}

func (v *dynamicRouteValidation) warn(elementID, code, format string, args ...any) {
	v.Warnings = append(v.Warnings, dynamicRouteIssue{ElementID: elementID, Code: code, Message: fmt.Sprintf(format, args...)})
}

func (v dynamicRouteValidation) ok() bool { return len(v.Errors) == 0 }

type dynamicPercentBranch struct {
	Key     string
	Percent float64
	Upper   float64
	Target  string
}

// compiledDynamicRoute is a validated graph indexed for the request path.
type compiledDynamicRoute struct {
	graph       dynamicRouteGraph
	byID        map[string]*dynamicRouteElement
	startID     string
	conditions  map[string]dynamicCondition
	percentages map[string][]dynamicPercentBranch
}

// dynamicRouteNameFromModel returns the route name of a "dynamic/<name>" model.
func dynamicRouteNameFromModel(model string) (string, bool) {
	model = strings.TrimSpace(model)
	if len(model) <= len(dynamicRouteModelPrefix) || !strings.EqualFold(model[:len(dynamicRouteModelPrefix)], dynamicRouteModelPrefix) {
		return "", false
	}
	return strings.ToLower(model[len(dynamicRouteModelPrefix):]), true
}

// parseDynamicRouteGraph decodes a graph document. It accepts a bare
// {"elements": [...]} as well as a whole route object exported from Cloudflare
// ({"id", "name", "elements"}); fields it does not use, such as canvas positions,
// are ignored.
func parseDynamicRouteGraph(raw []byte) (dynamicRouteGraph, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return dynamicRouteGraph{}, fmt.Errorf("graph is empty")
	}
	if len(raw) > dynamicRouteMaxGraphBytes {
		return dynamicRouteGraph{}, fmt.Errorf("graph is larger than %d bytes", dynamicRouteMaxGraphBytes)
	}
	var graph dynamicRouteGraph
	if err := json.Unmarshal(raw, &graph); err != nil {
		return dynamicRouteGraph{}, fmt.Errorf("graph is not valid JSON: %v", err)
	}
	return graph, nil
}

// normalizeDynamicRouteGraph trims every string, lower-cases enumerations, drops
// empty outputs and clears properties the element's type does not use.
func normalizeDynamicRouteGraph(graph dynamicRouteGraph) dynamicRouteGraph {
	out := dynamicRouteGraph{Elements: make([]dynamicRouteElement, 0, len(graph.Elements))}
	for _, el := range graph.Elements {
		el.ID = strings.TrimSpace(el.ID)
		el.Type = strings.ToLower(strings.TrimSpace(el.Type))
		el.Label = strings.TrimSpace(el.Label)
		if len([]rune(el.Label)) > dynamicRouteMaxLabel {
			el.Label = string([]rune(el.Label)[:dynamicRouteMaxLabel])
		}
		props := el.Properties
		clean := dynamicRouteProperties{}
		switch el.Type {
		case "conditional":
			if trimmed := bytes.TrimSpace(props.Conditions); len(trimmed) > 0 && !bytes.Equal(trimmed, []byte("null")) {
				var compact bytes.Buffer
				if json.Compact(&compact, trimmed) == nil {
					clean.Conditions = json.RawMessage(compact.Bytes())
				} else {
					clean.Conditions = json.RawMessage(trimmed)
				}
			}
		case "percentage":
			clean.StickyKey = strings.TrimSpace(props.StickyKey)
		case "rate":
			clean.LimitType = strings.ToLower(strings.TrimSpace(props.LimitType))
			clean.Key = strings.TrimSpace(props.Key)
			clean.Limit = props.Limit
			clean.Window = props.Window
		case "model":
			clean.Provider = strings.TrimSpace(props.Provider)
			clean.Model = strings.TrimSpace(props.Model)
			clean.Timeout = props.Timeout
			clean.Retries = props.Retries
			clean.RetryDelay = props.RetryDelay
			clean.Backoff = strings.ToLower(strings.TrimSpace(props.Backoff))
		}
		el.Properties = clean
		if len(el.Outputs) > 0 {
			outputs := make(map[string]dynamicRouteOutput, len(el.Outputs))
			for name, target := range el.Outputs {
				name = strings.TrimSpace(name)
				target.ElementID = strings.TrimSpace(target.ElementID)
				if name == "" || target.ElementID == "" {
					continue
				}
				outputs[name] = target
			}
			el.Outputs = outputs
		}
		if len(el.Outputs) == 0 {
			el.Outputs = nil
		}
		out.Elements = append(out.Elements, el)
	}
	return out
}

func validDynamicRouteField(field string) bool {
	if rest, ok := strings.CutPrefix(field, "metadata."); ok {
		return dynamicRouteMetadataKey.MatchString(rest)
	}
	_, ok := dynamicRouteBuiltinFields[field]
	return ok
}

// isReservedDynamicRouteTarget reports models a model element may not call: other
// virtual models, whose own routing would run inside this route's.
func isReservedDynamicRouteTarget(model string) bool {
	if _, ok := dynamicRouteNameFromModel(model); ok {
		return true
	}
	return isAutoModelAlias(model) || text2sql.IsModel(model) || isMCPDiscoveryModel(canonicalMCPDiscoveryModel(model))
}

func parsePercentKey(key string) (float64, bool) {
	number, ok := strings.CutSuffix(strings.TrimSpace(key), "%")
	if !ok {
		return 0, false
	}
	value, err := strconv.ParseFloat(strings.TrimSpace(number), 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	return value, true
}

var dynamicRouteAllowedOutputs = map[string]map[string]bool{
	"start":       {"next": true},
	"conditional": {"true": true, "false": true},
	"rate":        {"success": true, "fallback": true},
	"model":       {"success": true, "fallback": true},
	"end":         {},
}

// compileDynamicRouteGraph validates a normalized graph and, when it has no
// errors, returns it indexed for evaluation. Warnings never block a save; they
// point at things that will work but probably are not what was meant.
func compileDynamicRouteGraph(graph dynamicRouteGraph) (*compiledDynamicRoute, dynamicRouteValidation) {
	v := dynamicRouteValidation{Errors: []dynamicRouteIssue{}, Warnings: []dynamicRouteIssue{}}
	compiled := &compiledDynamicRoute{
		graph:       graph,
		byID:        map[string]*dynamicRouteElement{},
		conditions:  map[string]dynamicCondition{},
		percentages: map[string][]dynamicPercentBranch{},
	}
	if len(graph.Elements) == 0 {
		v.fail("", "graph_empty", "요소가 하나도 없습니다. start, model, end 요소가 필요합니다.")
		return nil, v
	}
	if len(graph.Elements) > dynamicRouteMaxElements {
		v.fail("", "graph_too_large", "요소는 최대 %d개까지 둘 수 있습니다 (현재 %d개).", dynamicRouteMaxElements, len(graph.Elements))
		return nil, v
	}
	starts := 0
	for i := range graph.Elements {
		el := &graph.Elements[i]
		if !dynamicRouteElementIDPattern.MatchString(el.ID) {
			v.fail(el.ID, "element_id_invalid", "요소 ID %q는 영문·숫자로 시작하고 영문·숫자·_ . -만 쓸 수 있습니다 (최대 64자).", el.ID)
			continue
		}
		if _, dup := compiled.byID[el.ID]; dup {
			v.fail(el.ID, "element_id_duplicate", "요소 ID %q가 두 번 이상 쓰였습니다.", el.ID)
			continue
		}
		compiled.byID[el.ID] = el
		switch el.Type {
		case "start":
			starts++
			compiled.startID = el.ID
		case "conditional", "percentage", "rate", "model", "end":
		default:
			v.fail(el.ID, "element_type_invalid", "알 수 없는 요소 유형 %q입니다. start, conditional, percentage, rate, model, end 중 하나여야 합니다.", el.Type)
		}
	}
	if starts != 1 {
		v.fail("", "start_count", "start 요소는 정확히 하나여야 합니다 (현재 %d개).", starts)
	}
	if !v.ok() {
		return nil, v
	}

	for i := range graph.Elements {
		el := &graph.Elements[i]
		if allowed, fixed := dynamicRouteAllowedOutputs[el.Type]; fixed {
			for name := range el.Outputs {
				if !allowed[name] {
					v.fail(el.ID, "output_invalid", "%s 요소에는 %q 출력을 둘 수 없습니다.", el.Type, name)
				}
			}
		}
		for name, target := range el.Outputs {
			dest, ok := compiled.byID[target.ElementID]
			switch {
			case !ok:
				v.fail(el.ID, "output_target_missing", "%q 출력이 존재하지 않는 요소 %q를 가리킵니다.", name, target.ElementID)
			case dest.Type == "start":
				v.fail(el.ID, "output_target_start", "%q 출력이 start 요소를 가리킬 수 없습니다.", name)
			case target.ElementID == el.ID:
				v.fail(el.ID, "output_self", "%q 출력이 자기 자신을 가리킵니다.", name)
			}
		}
		props := el.Properties
		switch el.Type {
		case "start":
			if el.output("next") == "" {
				v.fail(el.ID, "start_next_missing", "start 요소의 next 출력이 비어 있습니다.")
			}
		case "conditional":
			if len(props.Conditions) == 0 {
				v.fail(el.ID, "condition_missing", "조건이 비어 있습니다. 예: {\"metadata.plan\": {\"$eq\": \"free\"}}")
			} else if cond, err := parseDynamicCondition(props.Conditions); err != nil {
				v.fail(el.ID, "condition_invalid", "조건을 해석할 수 없습니다: %v", err)
			} else {
				compiled.conditions[el.ID] = cond
			}
			if el.output("true") == "" || el.output("false") == "" {
				v.fail(el.ID, "condition_outputs_missing", "조건 요소에는 true와 false 출력이 모두 필요합니다.")
			}
		case "percentage":
			if props.StickyKey != "" && !validDynamicRouteField(props.StickyKey) {
				v.fail(el.ID, "sticky_key_invalid", "고정 분배 키 %q를 읽을 수 없습니다. metadata.<키> 또는 identity.* 를 쓰세요.", props.StickyKey)
			}
			branches, err := compilePercentBranches(el)
			if err != nil {
				v.fail(el.ID, "percentage_invalid", "%v", err)
			} else {
				compiled.percentages[el.ID] = branches
			}
		case "rate":
			if props.LimitType != "count" && props.LimitType != "cost" {
				v.fail(el.ID, "rate_type_invalid", "한도 유형은 count(요청 수) 또는 cost(비용, 원)여야 합니다.")
			}
			if props.Key != "" && !validDynamicRouteField(props.Key) {
				v.fail(el.ID, "rate_key_invalid", "한도 키 %q를 읽을 수 없습니다. metadata.<키> 또는 identity.* 를 쓰세요.", props.Key)
			}
			if !(props.Limit > 0) || math.IsInf(props.Limit, 0) {
				v.fail(el.ID, "rate_limit_invalid", "한도는 0보다 커야 합니다.")
			} else if props.LimitType == "count" && props.Limit != math.Trunc(props.Limit) {
				v.fail(el.ID, "rate_limit_fraction", "요청 수 한도는 정수여야 합니다.")
			}
			if props.Window < dynamicRouteMinWindow || props.Window > dynamicRouteMaxWindow {
				v.fail(el.ID, "rate_window_invalid", "집계 구간은 %d초 이상 %d초(31일) 이하여야 합니다.", dynamicRouteMinWindow, dynamicRouteMaxWindow)
			}
			if el.output("success") == "" {
				v.fail(el.ID, "rate_success_missing", "한도 요소에는 success 출력이 필요합니다.")
			}
			if el.output("fallback") == "" {
				v.warn(el.ID, "rate_fallback_missing", "fallback 출력이 없어 한도를 넘으면 요청이 429로 거절됩니다.")
			}
			if props.Key == "" {
				v.warn(el.ID, "rate_key_shared", "한도 키가 없어 이 경로의 모든 요청이 한도 하나를 함께 씁니다.")
			}
		case "model":
			if props.Model == "" {
				v.fail(el.ID, "model_missing", "호출할 모델이 비어 있습니다.")
			} else if len(props.Model) > 200 {
				v.fail(el.ID, "model_too_long", "모델 이름은 200자를 넘을 수 없습니다.")
			} else if isReservedDynamicRouteTarget(props.Model) {
				v.fail(el.ID, "model_virtual", "%q는 가상 모델이라 동적 경로 안에서 호출할 수 없습니다. 실제 모델을 지정하세요.", props.Model)
			}
			if len(props.Provider) > 128 {
				v.fail(el.ID, "provider_too_long", "공급자 이름은 128자를 넘을 수 없습니다.")
			}
			if props.Timeout < 0 || props.Timeout > dynamicRouteMaxTimeoutMS {
				v.fail(el.ID, "model_timeout_invalid", "제한 시간은 0(공급자 기본값)에서 %dms 사이여야 합니다.", dynamicRouteMaxTimeoutMS)
			}
			if props.Retries < 0 || props.Retries > dynamicRouteMaxRetries {
				v.fail(el.ID, "model_retries_invalid", "재시도는 0회에서 %d회 사이여야 합니다.", dynamicRouteMaxRetries)
			}
			if props.RetryDelay < 0 || props.RetryDelay > dynamicRouteMaxRetryDelay {
				v.fail(el.ID, "model_retry_delay_invalid", "재시도 간격은 0에서 %dms 사이여야 합니다.", dynamicRouteMaxRetryDelay)
			}
			switch props.Backoff {
			case "", "constant", "linear", "exponential":
			default:
				v.fail(el.ID, "model_backoff_invalid", "백오프는 constant, linear, exponential 중 하나여야 합니다.")
			}
			if target := el.output("success"); target != "" {
				if dest := compiled.byID[target]; dest != nil && dest.Type != "end" {
					v.fail(el.ID, "model_success_not_end", "모델의 success 출력은 end 요소로만 연결할 수 있습니다.")
				}
			}
		case "end":
		}
	}
	if !v.ok() {
		return nil, v
	}

	if cycle := dynamicRouteCycle(compiled); cycle != "" {
		v.fail(cycle, "graph_cycle", "요소 %q에서 시작하는 순환 연결이 있습니다. 경로는 앞으로만 진행해야 합니다.", cycle)
		return nil, v
	}

	reachable := map[string]bool{}
	var visit func(id string)
	visit = func(id string) {
		if id == "" || reachable[id] {
			return
		}
		reachable[id] = true
		for _, target := range compiled.byID[id].Outputs {
			visit(target.ElementID)
		}
	}
	visit(compiled.startID)
	models := 0
	for i := range graph.Elements {
		el := &graph.Elements[i]
		if !reachable[el.ID] {
			v.warn(el.ID, "element_unreachable", "start에서 도달할 수 없는 요소입니다. 요청이 이 요소를 지나지 않습니다.")
			continue
		}
		if el.Type == "model" {
			models++
		}
	}
	if models == 0 {
		v.fail("", "model_unreachable", "start에서 도달할 수 있는 model 요소가 없습니다.")
		return nil, v
	}
	if dead := dynamicRouteModelFreeEnd(compiled); dead != "" {
		v.warn(dead, "end_without_model", "모델을 하나도 거치지 않고 이 요소에 도달하는 경로가 있습니다. 그 요청은 오류로 끝납니다.")
	}
	return compiled, v
}

func compilePercentBranches(el *dynamicRouteElement) ([]dynamicPercentBranch, error) {
	if len(el.Outputs) == 0 {
		return nil, fmt.Errorf("비율 요소에는 \"50%%\" 같은 출력이 하나 이상 필요합니다")
	}
	if len(el.Outputs) > dynamicRouteMaxPercentages {
		return nil, fmt.Errorf("비율 출력은 최대 %d개입니다", dynamicRouteMaxPercentages)
	}
	branches := make([]dynamicPercentBranch, 0, len(el.Outputs))
	total := 0.0
	for key, target := range el.Outputs {
		percent, ok := parsePercentKey(key)
		if !ok || percent <= 0 || percent > 100 {
			return nil, fmt.Errorf("출력 이름 %q는 0보다 크고 100 이하인 \"<숫자>%%\" 형식이어야 합니다", key)
		}
		total += percent
		branches = append(branches, dynamicPercentBranch{Key: key, Percent: percent, Target: target.ElementID})
	}
	if math.Abs(total-100) > 0.0001 {
		return nil, fmt.Errorf("비율의 합이 100%%여야 합니다 (현재 %s%%)", strconv.FormatFloat(total, 'f', -1, 64))
	}
	// A fixed order keeps a sticky key on the same branch across reloads of the
	// same graph; map iteration order would move it on every restart.
	sort.Slice(branches, func(i, j int) bool {
		if branches[i].Percent != branches[j].Percent {
			return branches[i].Percent > branches[j].Percent
		}
		return branches[i].Key < branches[j].Key
	})
	upper := 0.0
	for i := range branches {
		upper += branches[i].Percent
		branches[i].Upper = upper
	}
	branches[len(branches)-1].Upper = 100
	return branches, nil
}

// dynamicRouteCycle returns an element on a cycle, or "" when the graph only
// moves forward.
func dynamicRouteCycle(compiled *compiledDynamicRoute) string {
	const (
		unvisited = iota
		active
		done
	)
	state := map[string]int{}
	ids := make([]string, 0, len(compiled.byID))
	for id := range compiled.byID {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var walk func(id string) string
	walk = func(id string) string {
		switch state[id] {
		case active:
			return id
		case done:
			return ""
		}
		state[id] = active
		el := compiled.byID[id]
		names := make([]string, 0, len(el.Outputs))
		for name := range el.Outputs {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			if hit := walk(el.Outputs[name].ElementID); hit != "" {
				return hit
			}
		}
		state[id] = done
		return ""
	}
	for _, id := range ids {
		if hit := walk(id); hit != "" {
			return hit
		}
	}
	return ""
}

// dynamicRouteModelFreeEnd finds an end element (or a dead end) that a request
// can reach from start without passing any model.
func dynamicRouteModelFreeEnd(compiled *compiledDynamicRoute) string {
	seen := map[string]bool{}
	var walk func(id string) string
	walk = func(id string) string {
		if id == "" || seen[id] {
			return ""
		}
		seen[id] = true
		el := compiled.byID[id]
		switch el.Type {
		case "model":
			return ""
		case "end":
			return id
		}
		names := make([]string, 0, len(el.Outputs))
		for name := range el.Outputs {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			if hit := walk(el.Outputs[name].ElementID); hit != "" {
				return hit
			}
		}
		return ""
	}
	return walk(compiled.startID)
}

// modelElements lists the graph's model elements, for validation warnings.
func (c *compiledDynamicRoute) modelElements() []*dynamicRouteElement {
	out := []*dynamicRouteElement{}
	for i := range c.graph.Elements {
		if c.graph.Elements[i].Type == "model" {
			out = append(out, &c.graph.Elements[i])
		}
	}
	return out
}

// ---- conditions ----

// dynamicCondition is a compiled condition tree. A condition document is a JSON
// object whose keys are field paths or the combinators $and / $or:
//
//	{"metadata.plan": "free"}                        shorthand for $eq
//	{"metadata.plan": {"$in": ["free", "trial"]}}
//	{"$or": [{"identity.team": "ml"}, {"metadata.tier": {"$gte": 3}}]}
//
// Several keys in one object must all match. A field the request does not carry
// fails every comparison except $ne, $nin and {"$exists": false}, which matches
// what Cloudflare does for a missing metadata key.
type dynamicCondition struct {
	Kind     string
	Children []dynamicCondition
	Field    string
	Op       string
	Value    any
}

var dynamicConditionOperators = map[string]bool{
	"$eq": true, "$ne": true, "$in": true, "$nin": true,
	"$gt": true, "$gte": true, "$lt": true, "$lte": true, "$exists": true,
}

func parseDynamicCondition(raw json.RawMessage) (dynamicCondition, error) {
	var doc any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := decoder.Decode(&doc); err != nil {
		return dynamicCondition{}, fmt.Errorf("JSON 형식이 아닙니다: %v", err)
	}
	obj, ok := doc.(map[string]any)
	if !ok {
		return dynamicCondition{}, fmt.Errorf("조건은 JSON 객체여야 합니다")
	}
	return compileDynamicConditionObject(obj, 0)
}

func compileDynamicConditionObject(obj map[string]any, depth int) (dynamicCondition, error) {
	if depth > 8 {
		return dynamicCondition{}, fmt.Errorf("조건 중첩은 8단계까지 가능합니다")
	}
	if len(obj) == 0 {
		return dynamicCondition{}, fmt.Errorf("빈 조건 객체가 있습니다")
	}
	keys := make([]string, 0, len(obj))
	for key := range obj {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := []dynamicCondition{}
	for _, key := range keys {
		value := obj[key]
		switch key {
		case "$and", "$or":
			list, ok := value.([]any)
			if !ok || len(list) == 0 {
				return dynamicCondition{}, fmt.Errorf("%s에는 조건 객체 배열이 필요합니다", key)
			}
			group := dynamicCondition{Kind: strings.TrimPrefix(key, "$")}
			for _, item := range list {
				child, ok := item.(map[string]any)
				if !ok {
					return dynamicCondition{}, fmt.Errorf("%s 배열의 항목은 객체여야 합니다", key)
				}
				compiled, err := compileDynamicConditionObject(child, depth+1)
				if err != nil {
					return dynamicCondition{}, err
				}
				group.Children = append(group.Children, compiled)
			}
			parts = append(parts, group)
			continue
		}
		if strings.HasPrefix(key, "$") {
			return dynamicCondition{}, fmt.Errorf("%s는 이 위치에 쓸 수 없는 연산자입니다", key)
		}
		if !validDynamicRouteField(key) {
			return dynamicCondition{}, fmt.Errorf("필드 %q를 읽을 수 없습니다. metadata.<키>, identity.*, request.* 를 쓰세요", key)
		}
		if ops, ok := value.(map[string]any); ok {
			if len(ops) == 0 {
				return dynamicCondition{}, fmt.Errorf("%s의 비교 연산자가 비어 있습니다", key)
			}
			opKeys := make([]string, 0, len(ops))
			for op := range ops {
				opKeys = append(opKeys, op)
			}
			sort.Strings(opKeys)
			for _, op := range opKeys {
				compiled, err := compileDynamicComparison(key, op, ops[op])
				if err != nil {
					return dynamicCondition{}, err
				}
				parts = append(parts, compiled)
			}
			continue
		}
		compiled, err := compileDynamicComparison(key, "$eq", value)
		if err != nil {
			return dynamicCondition{}, err
		}
		parts = append(parts, compiled)
	}
	if len(parts) == 1 {
		return parts[0], nil
	}
	return dynamicCondition{Kind: "and", Children: parts}, nil
}

func dynamicConditionScalar(value any) bool {
	switch value.(type) {
	case string, float64, bool:
		return true
	}
	return false
}

func compileDynamicComparison(field, op string, value any) (dynamicCondition, error) {
	if !dynamicConditionOperators[op] {
		return dynamicCondition{}, fmt.Errorf("%s: 알 수 없는 연산자 %s ($eq $ne $in $nin $gt $gte $lt $lte $exists)", field, op)
	}
	switch op {
	case "$eq", "$ne":
		if !dynamicConditionScalar(value) {
			return dynamicCondition{}, fmt.Errorf("%s %s에는 문자열·숫자·불리언 값이 필요합니다 (목록은 $in)", field, op)
		}
	case "$in", "$nin":
		list, ok := value.([]any)
		if !ok || len(list) == 0 || len(list) > dynamicRouteMaxConditionIn {
			return dynamicCondition{}, fmt.Errorf("%s %s에는 값 1~%d개의 배열이 필요합니다", field, op, dynamicRouteMaxConditionIn)
		}
		for _, item := range list {
			if !dynamicConditionScalar(item) {
				return dynamicCondition{}, fmt.Errorf("%s %s 배열에는 문자열·숫자·불리언만 넣을 수 있습니다", field, op)
			}
		}
	case "$gt", "$gte", "$lt", "$lte":
		if _, ok := value.(float64); !ok {
			return dynamicCondition{}, fmt.Errorf("%s %s에는 숫자가 필요합니다", field, op)
		}
	case "$exists":
		if _, ok := value.(bool); !ok {
			return dynamicCondition{}, fmt.Errorf("%s $exists에는 true 또는 false가 필요합니다", field)
		}
	}
	return dynamicCondition{Kind: "cmp", Field: field, Op: op, Value: value}, nil
}

func dynamicScalarEqual(a, b any) bool {
	switch x := a.(type) {
	case string:
		y, ok := b.(string)
		return ok && x == y
	case float64:
		y, ok := b.(float64)
		return ok && x == y
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	}
	return false
}

func (c dynamicCondition) eval(input dynamicRouteInput) bool {
	switch c.Kind {
	case "and":
		for _, child := range c.Children {
			if !child.eval(input) {
				return false
			}
		}
		return true
	case "or":
		for _, child := range c.Children {
			if child.eval(input) {
				return true
			}
		}
		return false
	}
	actual, present := input.lookup(c.Field)
	switch c.Op {
	case "$exists":
		want, _ := c.Value.(bool)
		return present == want
	case "$eq":
		return present && dynamicScalarEqual(actual, c.Value)
	case "$ne":
		return !present || !dynamicScalarEqual(actual, c.Value)
	case "$in", "$nin":
		found := false
		if present {
			for _, item := range c.Value.([]any) {
				if dynamicScalarEqual(actual, item) {
					found = true
					break
				}
			}
		}
		if c.Op == "$in" {
			return found
		}
		return !found
	case "$gt", "$gte", "$lt", "$lte":
		number, ok := actual.(float64)
		if !present || !ok {
			return false
		}
		limit := c.Value.(float64)
		switch c.Op {
		case "$gt":
			return number > limit
		case "$gte":
			return number >= limit
		case "$lt":
			return number < limit
		default:
			return number <= limit
		}
	}
	return false
}
