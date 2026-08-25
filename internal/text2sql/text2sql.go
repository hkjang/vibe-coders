package text2sql

import (
	"encoding/json"
	"regexp"
	"strings"
)

// Mode is the Text2SQL execution mode for a virtual model.
type Mode string

const (
	ModePreview Mode = "preview" // generate + validate SQL, do not execute
	ModeExecute Mode = "execute" // generate + validate + read-only execute
)

// Models is the configured upstream model mapping for the Text2SQL profiles.
type Models struct {
	Preview  string
	Execute  string
	Accurate string
	Local    string
	Summary  string
}

// Profile maps a user-facing virtual model to an internal mode + upstream model.
type Profile struct {
	VirtualModel  string `json:"virtual_model"`
	Mode          Mode   `json:"mode"`
	UpstreamModel string `json:"upstream_model"` // empty when Auto (router decides)
	SummaryModel  string `json:"summary_model"`
	Auto          bool   `json:"auto"`
}

// IsModel reports whether a requested model name is a Text2SQL virtual model.
func IsModel(model string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(model)), "vibe/text2sql")
}

// ResolveProfile maps a virtual model name to its profile. Unknown vibe/text2sql-*
// variants fall back to a safe preview profile.
func ResolveProfile(model string, m Models) Profile {
	name := strings.ToLower(strings.TrimSpace(model))
	switch name {
	case "vibe/text2sql-execute":
		return Profile{VirtualModel: model, Mode: ModeExecute, UpstreamModel: m.Execute, SummaryModel: m.Summary}
	case "vibe/text2sql-accurate":
		return Profile{VirtualModel: model, Mode: ModePreview, UpstreamModel: m.Accurate, SummaryModel: m.Summary}
	case "vibe/text2sql-local":
		return Profile{VirtualModel: model, Mode: ModePreview, UpstreamModel: m.Local, SummaryModel: m.Summary}
	case "vibe/text2sql-auto":
		return Profile{VirtualModel: model, Mode: ModePreview, Auto: true, SummaryModel: m.Summary}
	default: // vibe/text2sql-preview and any other variant
		return Profile{VirtualModel: model, Mode: ModePreview, UpstreamModel: m.Preview, SummaryModel: m.Summary}
	}
}

// Message is a chat message in the upstream request.
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// BuildGenerationMessages assembles the SQL-generation prompt: a strict system
// instruction, the schema context, and the user's natural-language question.
func BuildGenerationMessages(dialect, schema, question string, limit int) []Message {
	if dialect == "" {
		dialect = "PostgreSQL"
	}
	var sys strings.Builder
	sys.WriteString("You are a careful " + dialect + " Text2SQL generator.\n")
	sys.WriteString("Rules:\n")
	sys.WriteString("- Generate exactly ONE read-only SELECT statement (a CTE that resolves to SELECT is allowed).\n")
	sys.WriteString("- NEVER generate INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/TRUNCATE or any statement that modifies data or schema.\n")
	sys.WriteString("- Use ONLY the tables and columns provided in the schema. Do not invent tables or columns.\n")
	if limit > 0 {
		sys.WriteString("- Always include a LIMIT clause (max " + itoa(limit) + ") unless the query is an aggregate that returns one row.\n")
	}
	sys.WriteString("- Output ONLY the SQL inside a ```sql code block, with no prose.\n")

	msgs := []Message{{Role: "system", Content: sys.String()}}
	if strings.TrimSpace(schema) != "" {
		msgs = append(msgs, Message{Role: "system", Content: "Available schema:\n" + schema})
	}
	msgs = append(msgs, Message{Role: "user", Content: question})
	return msgs
}

// Example is a verified question→SQL pair used as a few-shot example.
type Example struct {
	Question string
	SQL      string
}

// SelectExamples ranks examples by word-overlap with the question and returns the
// top n (most relevant first). Examples with no overlap are dropped.
func SelectExamples(all []Example, question string, n int) []Example {
	if n <= 0 || len(all) == 0 {
		return nil
	}
	qWords := wordSet(question)
	type scored struct {
		ex    Example
		score int
	}
	ranked := make([]scored, 0, len(all))
	for _, ex := range all {
		score := 0
		for w := range wordSet(ex.Question) {
			if qWords[w] {
				score++
			}
		}
		if score > 0 {
			ranked = append(ranked, scored{ex, score})
		}
	}
	// simple selection sort for the top-n (lists are small)
	out := []Example{}
	for len(out) < n && len(ranked) > 0 {
		best := 0
		for i := 1; i < len(ranked); i++ {
			if ranked[i].score > ranked[best].score {
				best = i
			}
		}
		out = append(out, ranked[best].ex)
		ranked = append(ranked[:best], ranked[best+1:]...)
	}
	return out
}

func wordSet(s string) map[string]bool {
	out := map[string]bool{}
	for _, w := range strings.Fields(strings.ToLower(s)) {
		w = strings.Trim(w, ".,?!()[]{}\"'`")
		if len(w) >= 2 {
			out[w] = true
		}
	}
	return out
}

// WithExamples prepends few-shot examples (as assistant-demonstration messages)
// to a generation message set, right before the user question.
func WithExamples(msgs []Message, examples []Example) []Message {
	if len(examples) == 0 {
		return msgs
	}
	var b strings.Builder
	b.WriteString("예시 (질문 → SQL):\n")
	for _, ex := range examples {
		b.WriteString("Q: " + ex.Question + "\nSQL:\n" + ex.SQL + "\n\n")
	}
	exampleMsg := Message{Role: "system", Content: strings.TrimSpace(b.String())}
	// Insert the examples just before the final (user) message.
	if len(msgs) == 0 {
		return []Message{exampleMsg}
	}
	last := msgs[len(msgs)-1]
	head := append([]Message{}, msgs[:len(msgs)-1]...)
	head = append(head, exampleMsg, last)
	return head
}

// WithOKFKnowledge inserts an OKF meta-knowledge system message (curated table notes,
// join paths, forbidden query patterns, sample SQL) right after the schema/instructions,
// so the model grounds generation in the organization's knowledge and hallucinates less.
func WithOKFKnowledge(msgs []Message, knowledge string) []Message {
	if strings.TrimSpace(knowledge) == "" {
		return msgs
	}
	k := Message{Role: "system", Content: "메타지식 (OKF — 테이블 설명·조인 경로·금지 패턴·샘플 SQL):\n" + knowledge}
	if len(msgs) == 0 {
		return []Message{k}
	}
	return append([]Message{msgs[0], k}, msgs[1:]...)
}

// WithGlossary prepends a business-glossary system message (term → table/column
// mapping) so the model can resolve business vocabulary to the schema.
func WithGlossary(msgs []Message, glossary string) []Message {
	if strings.TrimSpace(glossary) == "" {
		return msgs
	}
	g := Message{Role: "system", Content: "업무 용어 사전 (용어 → 테이블/컬럼/조건):\n" + glossary}
	if len(msgs) == 0 {
		return []Message{g}
	}
	// insert right after the first system message (schema/instructions stay first)
	return append([]Message{msgs[0], g}, msgs[1:]...)
}

var clarifyTimeTokens = []string{
	"기간", "날짜", "월", "주간", "일별", "년", "분기", "오늘", "어제", "지난", "이번", "최근", "올해", "작년", "당월", "전월",
	"between", "last ", "this ", "since", "from ", "until", "yesterday", "today", "week", "month", "year", "quarter", "daily", "20",
}

// NeedsClarification returns true (with the missing items) when a question is too
// vague to safely generate SQL — e.g. an aggregation with no time qualifier, or a
// very short prompt. Conservative: only fires for clearly underspecified questions.
func NeedsClarification(question string, requireDate bool) (bool, []string) {
	q := strings.ToLower(strings.TrimSpace(question))
	missing := []string{}
	if len([]rune(q)) < 6 {
		missing = append(missing, "구체적인 질문(대상 테이블/지표를 명시)")
	}
	if requireDate && !containsAnyToken(q, clarifyTimeTokens) {
		missing = append(missing, "조회 기간(예: 지난달, 2026-01 ~ 2026-03)")
	}
	return len(missing) > 0, missing
}

func containsAnyToken(s string, tokens []string) bool {
	for _, t := range tokens {
		if strings.Contains(s, t) {
			return true
		}
	}
	return false
}

// MessagesJSON marshals messages into the body shape runGovernanceChat understands
// (it preserves a `messages` array and only overwrites model/stream).
func MessagesJSON(msgs []Message) string {
	b, _ := json.Marshal(map[string]any{"messages": msgs})
	return string(b)
}

var (
	sqlFence  = regexp.MustCompile("(?is)```(?:sql)?\\s*(.*?)```")
	jsonSQLRe = regexp.MustCompile(`(?is)"sql"\s*:\s*"((?:[^"\\]|\\.)*)"`)
)

// ExtractSQL pulls the SQL out of an LLM response, handling ```sql fences, a
// {"sql": "..."} JSON field, or raw SQL text.
func ExtractSQL(text string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	if m := sqlFence.FindStringSubmatch(text); len(m) == 2 && strings.TrimSpace(m[1]) != "" {
		return strings.TrimSpace(m[1])
	}
	if m := jsonSQLRe.FindStringSubmatch(text); len(m) == 2 {
		var s string
		if json.Unmarshal([]byte(`"`+m[1]+`"`), &s) == nil && strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
	}
	return text
}

// LastUserQuestion returns the content of the last user message in an OpenAI
// chat-completions request body.
func LastUserQuestion(body []byte) string {
	var req struct {
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if json.Unmarshal(body, &req) != nil {
		return ""
	}
	for i := len(req.Messages) - 1; i >= 0; i-- {
		if req.Messages[i].Role == "user" {
			return contentToString(req.Messages[i].Content)
		}
	}
	return ""
}

// contentToString flattens OpenAI message content that may be a string or an array
// of content parts.
func contentToString(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) == nil {
		var b strings.Builder
		for _, p := range parts {
			if p.Text != "" {
				b.WriteString(p.Text)
				b.WriteString("\n")
			}
		}
		return strings.TrimSpace(b.String())
	}
	return ""
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
