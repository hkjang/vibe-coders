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
