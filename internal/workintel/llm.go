package workintel

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Limits applied to everything an LLM returns before it can be stored.
const (
	maxTitleRunes  = 80
	maxTagRunes    = 30
	maxLLMTags     = 8
	maxHintRunes   = 60
	maxSystemRunes = 40
	// maxLLMResponseBytes bounds the parsing work for a runaway response.
	maxLLMResponseBytes = 64 << 10
	maxParseAttempts    = 16
	// calibrationMinSample is the number of corrected results a method needs
	// before its observed accuracy is trusted enough to scale confidence.
	calibrationMinSample = 30
	// defaultLLMConfidence stands in when a response omits its confidence.
	defaultLLMConfidence = 0.5
	llmDescriptionRunes  = 60
	llmMaxNames          = 8
	llmMaxCandidates     = 3
	llmTextStart         = "<<<요청 시작>>>"
	llmTextEnd           = "<<<요청 끝>>>"
)

// BuildLLMMessages builds the system and user messages for the semantic
// classification step. The system message is the policy prompt followed by
// the categories and action types the model may answer with; it only changes
// when the policy changes, so providers can cache it. The user message
// carries the request: context hints, the rule engine's candidates and the
// text, truncated to max_input_chars and fenced so the model can tell data
// from instructions.
func BuildLLMMessages(e *Engine, f Features) (system, user string) {
	var sb strings.Builder
	sb.WriteString(e.policy.LLM.SystemPrompt)
	sb.WriteString("\n\n## 등록된 업무 분류\n")
	for i := range e.cats {
		c := &e.cats[i]
		// Disabled and merged categories are not valid answers.
		if e.canon[c.cat.ID] != c.cat.ID {
			continue
		}
		sb.WriteString(strings.Repeat("  ", c.ref.Level-1))
		sb.WriteString("- ")
		sb.WriteString(c.cat.ID)
		sb.WriteString(": ")
		sb.WriteString(c.cat.Name)
		if c.cat.Description != "" {
			sb.WriteString(" — ")
			sb.WriteString(clipRunes(c.cat.Description, llmDescriptionRunes))
		}
		sb.WriteByte('\n')
	}
	sb.WriteString("\n## 작업 유형\n")
	for _, a := range e.actions {
		fmt.Fprintf(&sb, "- %s: %s\n", a.id, a.name)
	}
	fmt.Fprintf(&sb, "- %s: 판단할 수 없음\n", UnknownAction)
	sb.WriteString("\n## 응답 형식\n")
	sb.WriteString(`{"primary_category":"대분류 ID","secondary_category":"중분류 ID 또는 빈 문자열","detail_category":"소분류 ID 또는 빈 문자열","work_title":"업무 제목","work_intent":"요청 의도 한 문장","action_type":"작업 유형 ID","target_system":"대상 시스템 또는 빈 문자열","technologies":["기술"],"tags":["태그"],"confidence":0.0,"classification_version":"1"}`)
	system = sb.String()

	var ub strings.Builder
	ub.WriteString("## 요청 정보\n")
	hint := func(label string, values ...string) {
		kept := make([]string, 0, len(values))
		for _, v := range values {
			if v = sanitizeLine(v, maxHintRunes); v != "" && len(kept) < llmMaxNames {
				kept = append(kept, v)
			}
		}
		if len(kept) > 0 {
			fmt.Fprintf(&ub, "- %s: %s\n", label, strings.Join(kept, ", "))
		}
	}
	hint("작업 유형 힌트", f.TaskType)
	hint("언어", f.Languages...)
	hint("MCP 서버", f.MCPServers...)
	hint("MCP 도구", f.MCPTools...)
	hint("클라이언트", f.Client)

	if cands := e.Classify(f).Candidates; len(cands) > 0 {
		ub.WriteString("\n## 규칙 기반 후보 (참고용이며 틀릴 수 있음)\n")
		for i, c := range cands {
			if i >= llmMaxCandidates {
				break
			}
			fmt.Fprintf(&ub, "- %s: %s\n", c.CategoryID, e.Ref(c.CategoryID).Name)
		}
	}

	text := strings.TrimSpace(f.Text)
	// The fence markers must not appear inside the fenced text.
	text = strings.ReplaceAll(text, llmTextStart, "")
	text = strings.ReplaceAll(text, llmTextEnd, "")
	limit := e.policy.LLM.MaxInputChars
	truncated := utf8.RuneCountInString(text) > limit
	text = clipRunes(text, limit)
	ub.WriteString("\n## 요청 내용\n")
	ub.WriteString(llmTextStart)
	ub.WriteByte('\n')
	ub.WriteString(text)
	if truncated {
		ub.WriteString("\n…(이하 생략)")
	}
	ub.WriteByte('\n')
	ub.WriteString(llmTextEnd)
	return system, ub.String()
}

// LLMResponseSchema returns the JSON Schema of the classification response,
// for providers that support structured output. Category ids are not
// enumerated: the schema is policy-independent and ParseLLMResponse checks
// them against the engine.
func LLMResponseSchema() map[string]any {
	str := func(desc string, maxLen int) map[string]any {
		m := map[string]any{"type": "string", "description": desc}
		if maxLen > 0 {
			m["maxLength"] = maxLen
		}
		return m
	}
	strList := func(desc string, maxItems int) map[string]any {
		return map[string]any{
			"type":        "array",
			"description": desc,
			"maxItems":    maxItems,
			"items":       map[string]any{"type": "string", "maxLength": maxTagRunes},
		}
	}
	return map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"required": []string{
			"primary_category", "secondary_category", "detail_category", "work_title", "work_intent",
			"action_type", "target_system", "technologies", "tags", "confidence", "classification_version",
		},
		"properties": map[string]any{
			"primary_category":       str("등록된 대분류 ID", 0),
			"secondary_category":     str("등록된 중분류 ID. 없으면 빈 문자열", 0),
			"detail_category":        str("등록된 소분류 ID. 없으면 빈 문자열", 0),
			"work_title":             str("업무를 한 줄로 요약한 제목. 민감한 정보는 넣지 않음", maxTitleRunes),
			"work_intent":            str("요청 의도 한 문장", 200),
			"action_type":            str("등록된 작업 유형 ID 또는 unknown", 0),
			"target_system":          str("대상 시스템. 없으면 빈 문자열", maxSystemRunes),
			"technologies":           strList("사용된 기술", maxTechResult),
			"tags":                   strList("짧은 태그", maxLLMTags),
			"confidence":             map[string]any{"type": "number", "minimum": 0, "maximum": 1, "description": "분류 확신도"},
			"classification_version": str("응답 형식 버전", 20),
		},
	}
}

// ParseLLMResponse turns a model response into a Result with Method "llm".
//
// It is tolerant about packaging (code fences, prose around the JSON) and
// strict about types: a field of the wrong type fails the whole response,
// because a model that ignores the schema is not to be trusted on the rest.
// The most specific registered id among detail, secondary and primary
// category wins. When none is registered the result is "other" with
// NewCategoryHint set, so administrators can see what the taxonomy lacks.
//
// The returned title and tags come from a model that read the prompt, so
// the caller must still run them through redaction before storing them.
func ParseLLMResponse(e *Engine, raw string) (Result, error) {
	fields, err := extractJSONObject(raw)
	if err != nil {
		return Result{}, err
	}

	var ids [3]string
	for i, key := range []string{"detail_category", "secondary_category", "primary_category"} {
		if ids[i], err = stringField(fields, key); err != nil {
			return Result{}, err
		}
	}
	if ids[0] == "" && ids[1] == "" && ids[2] == "" {
		return Result{}, errors.New("primary_category: 분류 ID가 비어 있습니다")
	}
	title, err := stringField(fields, "work_title")
	if err != nil {
		return Result{}, err
	}
	if _, err = stringField(fields, "work_intent"); err != nil {
		return Result{}, err
	}
	action, err := stringField(fields, "action_type")
	if err != nil {
		return Result{}, err
	}
	system, err := stringField(fields, "target_system")
	if err != nil {
		return Result{}, err
	}
	techs, err := stringListField(fields, "technologies")
	if err != nil {
		return Result{}, err
	}
	tags, err := stringListField(fields, "tags")
	if err != nil {
		return Result{}, err
	}
	conf, err := numberField(fields, "confidence", defaultLLMConfidence)
	if err != nil {
		return Result{}, err
	}
	// classification_version is echoed by some models as a number; it carries
	// no decision, so only its presence as a scalar is checked.
	if v, ok := fields["classification_version"]; ok && len(v) > 0 && (v[0] == '{' || v[0] == '[') {
		return Result{}, errors.New("classification_version: 문자열이어야 합니다")
	}

	res := Result{
		Method:       MethodLLM,
		Confidence:   round3(clamp01(conf)),
		Tags:         capList(tags, maxLLMTags, maxTagRunes),
		Technologies: capList(techs, maxTechResult, maxTagRunes),
		TargetSystem: sanitizeLabel(system, maxSystemRunes),
		Candidates:   []Candidate{},
	}

	category, hint := "", ""
	for _, id := range ids {
		id = normalizeID(id)
		if id == "" {
			continue
		}
		if e.Known(id) {
			category = e.Canonical(id)
			break
		}
		// Remember the most specific unregistered answer even when a broader
		// level turns out to be valid: it is a suggestion for a new child.
		if hint == "" {
			hint = sanitizeLabel(id, maxHintRunes)
		}
	}
	th := e.policy.Thresholds
	switch {
	case category == "":
		res.CategoryID = OtherCategoryID
		res.NewCategoryHint = hint
		res.Status = StatusReview
	case res.Confidence < th.ReviewBelow:
		res.CategoryID = category
		res.NewCategoryHint = hint
		res.Status = StatusReview
	default:
		res.CategoryID = category
		res.NewCategoryHint = hint
		res.Status = StatusClassified
	}
	res.TopCategoryID = topOfID(res.CategoryID)

	res.ActionType = UnknownAction
	if a := normalizeID(action); e.KnownAction(a) {
		res.ActionType = a
	}
	res.WorkTitle = sanitizeLine(title, maxTitleRunes)
	if res.WorkTitle == "" {
		res.WorkTitle = e.workTitle(res.CategoryID, res.ActionType)
	}
	return res, nil
}

// MergeLLM combines the rule result of a request with the LLM result for it.
// The LLM decides the category, action and title. Facts the rule engine
// observed directly win or fill the gaps: the difficulty, the target system
// of an MCP call, detected technologies, and the candidates that explain the
// rule side of the decision.
func MergeLLM(rule, llm Result) Result {
	out := llm
	out.Method = MethodLLM
	out.Difficulty = rule.Difficulty
	out.Candidates = rule.Candidates
	out.Secondary = rule.Secondary
	out.NeedsLLM = false
	if out.ActionType == "" || out.ActionType == UnknownAction {
		out.ActionType = rule.ActionType
	}
	if rule.TargetSystem != "" {
		out.TargetSystem = rule.TargetSystem
	}
	out.Technologies = unionCapped(rule.Technologies, llm.Technologies, maxTechResult)
	out.Tags = unionCapped(llm.Tags, rule.Tags, maxLLMTags)
	if out.WorkTitle == "" {
		out.WorkTitle = rule.WorkTitle
	}
	return out
}

// MethodAccuracy is how often a classification method was right, measured
// against administrator corrections.
type MethodAccuracy struct {
	Total   int `json:"total"`
	Correct int `json:"correct"`
}

// Calibrate adjusts a confidence by how reliable its method has proven. A
// model's self-reported confidence is not trusted as is: once at least 30
// results of the method have been checked by an administrator, the confidence
// is multiplied by the observed accuracy. Rule and cache confidences are
// computed from evidence rather than reported, so they pass through; a
// manual correction is certain.
func Calibrate(conf float64, method string, acc map[string]MethodAccuracy) float64 {
	switch method {
	case MethodManual:
		return 1
	case MethodRule, MethodCache:
		return clamp01(conf)
	}
	conf = clamp01(conf)
	a, ok := acc[method]
	if !ok || a.Total < calibrationMinSample {
		return conf
	}
	correct := a.Correct
	if correct < 0 {
		correct = 0
	}
	if correct > a.Total {
		correct = a.Total
	}
	return clamp01(conf * float64(correct) / float64(a.Total))
}

// ApplyCalibration calibrates the confidence of r and re-derives its status
// from the policy thresholds. Unclassified and failed results keep their
// status; they are not a matter of confidence.
func (e *Engine) ApplyCalibration(r Result, acc map[string]MethodAccuracy) Result {
	r.Confidence = round3(Calibrate(r.Confidence, r.Method, acc))
	if r.Status == StatusClassified || r.Status == StatusReview {
		r.Status = StatusClassified
		if r.Confidence < e.policy.Thresholds.ReviewBelow || (r.CategoryID == OtherCategoryID && r.NewCategoryHint != "") {
			r.Status = StatusReview
		}
	}
	return r
}

// Session kinds, by where the session id came from.
const (
	SessionExplicit = "explicit"
	SessionInferred = "inferred"
	SessionTrace    = "trace"
	SessionUnknown  = "unknown"
)

// SessionKind tells how a session id was obtained: sent by the client,
// inferred by the proxy ("sess_" prefix) or substituted by the trace id
// ("trace:" prefix) when inference is off.
func SessionKind(sessionID string) string {
	switch {
	case sessionID == "":
		return SessionUnknown
	case strings.HasPrefix(sessionID, "sess_"):
		return SessionInferred
	case strings.HasPrefix(sessionID, "trace:"):
		return SessionTrace
	default:
		return SessionExplicit
	}
}

// extractJSONObject finds the classification object in a model response. It
// tries every opening brace in turn, so prose, code fences and stray braces
// before the object do not matter, and it prefers an object that actually
// has a primary_category over an earlier unrelated one.
func extractJSONObject(raw string) (map[string]json.RawMessage, error) {
	if len(raw) > maxLLMResponseBytes {
		raw = raw[:maxLLMResponseBytes]
	}
	var fallback map[string]json.RawMessage
	attempts := 0
	for i := 0; i < len(raw) && attempts < maxParseAttempts; i++ {
		if raw[i] != '{' {
			continue
		}
		attempts++
		var obj map[string]json.RawMessage
		if err := json.NewDecoder(strings.NewReader(raw[i:])).Decode(&obj); err != nil || obj == nil {
			continue
		}
		if _, ok := obj["primary_category"]; ok {
			return obj, nil
		}
		if fallback == nil {
			fallback = obj
		}
	}
	if fallback != nil {
		return fallback, nil
	}
	return nil, errors.New("분류 모델 응답에서 JSON 객체를 찾지 못했습니다")
}

func isJSONNull(v json.RawMessage) bool {
	return len(v) == 0 || bytes.Equal(bytes.TrimSpace(v), []byte("null"))
}

func stringField(fields map[string]json.RawMessage, key string) (string, error) {
	v, ok := fields[key]
	if !ok || isJSONNull(v) {
		return "", nil
	}
	var s string
	if err := json.Unmarshal(v, &s); err != nil {
		return "", fmt.Errorf("%s: 문자열이어야 합니다", key)
	}
	return s, nil
}

func stringListField(fields map[string]json.RawMessage, key string) ([]string, error) {
	v, ok := fields[key]
	if !ok || isJSONNull(v) {
		return nil, nil
	}
	var list []string
	if err := json.Unmarshal(v, &list); err != nil {
		return nil, fmt.Errorf("%s: 문자열 배열이어야 합니다", key)
	}
	return list, nil
}

func numberField(fields map[string]json.RawMessage, key string, def float64) (float64, error) {
	v, ok := fields[key]
	if !ok || isJSONNull(v) {
		return def, nil
	}
	var n float64
	// Unmarshal into float64 rejects a quoted number, which is the point.
	if err := json.Unmarshal(v, &n); err != nil {
		return 0, fmt.Errorf("%s: 숫자여야 합니다", key)
	}
	return n, nil
}

func clamp01(v float64) float64 {
	switch {
	case v != v: // NaN
		return 0
	case v < 0:
		return 0
	case v > 1:
		return 1
	}
	return v
}

// clipRunes cuts s to at most n runes.
func clipRunes(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if len(s) <= n {
		return s
	}
	count := 0
	for i := range s {
		if count == n {
			return s[:i]
		}
		count++
	}
	return s
}

// sanitizeLine makes free text safe to store as a single-line label: control
// characters and line breaks become spaces, whitespace is folded and the
// result is clipped.
func sanitizeLine(s string, maxRunes int) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == utf8.RuneError {
			return ' '
		}
		return r
	}, s)
	return strings.TrimSpace(clipRunes(collapseSpace(s), maxRunes))
}

// sanitizeLabel keeps only what an identifier-like label needs: letters,
// digits and a few separators. It is used for values that end up in filters
// and grouped lists, where markup or punctuation would only cause trouble.
func sanitizeLabel(s string, maxRunes int) string {
	s = strings.Map(func(r rune) rune {
		switch {
		case unicode.IsLetter(r), unicode.IsDigit(r):
			return r
		case r == ' ', r == '.', r == '_', r == '-', r == '/', r == '+', r == '#', r == '&':
			return r
		case unicode.IsSpace(r):
			return ' '
		}
		return -1
	}, s)
	return strings.TrimSpace(clipRunes(collapseSpace(s), maxRunes))
}

// capList sanitises a list of labels: trimmed, clipped, de-duplicated
// case-insensitively and limited in number. The result is never nil.
func capList(items []string, maxItems, maxRunes int) []string {
	out := make([]string, 0, len(items))
	for _, it := range items {
		it = sanitizeLine(it, maxRunes)
		if it == "" || containsFold(out, it) {
			continue
		}
		if len(out) == maxItems {
			break
		}
		out = append(out, it)
	}
	return out
}

func unionCapped(first, second []string, maxItems int) []string {
	out := make([]string, 0, len(first)+len(second))
	for _, list := range [][]string{first, second} {
		for _, it := range list {
			if it == "" || containsFold(out, it) || len(out) == maxItems {
				continue
			}
			out = append(out, it)
		}
	}
	return out
}

func containsFold(list []string, v string) bool {
	for _, o := range list {
		if strings.EqualFold(o, v) {
			return true
		}
	}
	return false
}
