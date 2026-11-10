package store

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func openRequestIOTestStore(t *testing.T) *SQLStore {
	t.Helper()
	if dsn := os.Getenv("TEST_POSTGRES_DSN"); dsn != "" {
		return openPostgresStoreForTest(t, dsn)
	}
	return openStoreForTest(t)
}

func insertRequestIOSampleRow(t *testing.T, s *SQLStore, id, apiKey string, roles []string, response *ResponseLog, at time.Time) {
	t.Helper()
	prompts := make([]PromptLog, 0, len(roles))
	for index, role := range roles {
		prompts = append(prompts, PromptLog{
			ID: fmt.Sprintf("%s-prompt-%03d", id, index), RequestID: id, Role: role, ContentHash: "hash",
			RedactedText: fmt.Sprintf("%s-text-%d", id, index), CreatedAt: at,
		})
	}
	if response != nil {
		response.ID, response.RequestID, response.StatusCode, response.CreatedAt = id+"-response", id, 200, at
	}
	if err := s.InsertLogRecord(t.Context(), LogRecord{
		Request: RequestLog{ID: id, TraceID: "trace-" + id, APIKeyID: apiKey, Method: "POST", ClientIP: "192.0.2.1",
			Model: "m", Endpoint: "/v1/chat/completions", Provider: "p", StatusCode: 200, CreatedAt: at},
		Prompts: prompts, Response: response,
	}); err != nil {
		t.Fatal(err)
	}
}

// One request's messages share a timestamp, and several requests sort together, which is
// where an unstable sort shows: the last user message must stay the last one on both stores.
func TestRequestIOSamplesKeepConversationOrder(t *testing.T) {
	s := openRequestIOTestStore(t)
	at := time.Now().UTC()
	prefix := fmt.Sprintf("io-order-%d-", at.UnixNano())
	roles := make([]string, 0, 41)
	roles = append(roles, "system")
	for turn := 0; turn < 20; turn++ {
		roles = append(roles, "user", "assistant")
	}
	roles = append(roles, "tools")
	ids := []string{}
	for index := 0; index < 8; index++ {
		id := fmt.Sprintf("%s%d", prefix, index)
		ids = append(ids, id)
		insertRequestIOSampleRow(t, s, id, "key-a", roles, nil, at)
	}
	samples, err := s.RequestIOSamples(t.Context(), RequestIOSampleFilter{IDs: ids, TextChars: 1024})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range ids {
		sample := samples[id]
		// The last user message is message 39 of system + 20 user/assistant turns.
		if want := id + "-text-39"; sample.LastInput != want || sample.LastRole != "user" {
			t.Fatalf("%s: last input=%q role=%q, want %q", id, sample.LastInput, sample.LastRole, want)
		}
		if sample.MessageCount != len(roles)-1 {
			t.Fatalf("%s: message count=%d excludes only tool definitions, want %d", id, sample.MessageCount, len(roles)-1)
		}
	}
	detail, err := s.RequestDetail(t.Context(), ids[0])
	if err != nil {
		t.Fatal(err)
	}
	for index, prompt := range detail.Prompts {
		if want := fmt.Sprintf("%s-text-%d", ids[0], index); prompt.RedactedText != want {
			t.Fatalf("detail message %d=%q, want %q", index, prompt.RedactedText, want)
		}
	}
}

func TestRequestIOSamplesBoundTextAndReportState(t *testing.T) {
	s := openRequestIOTestStore(t)
	at := time.Now().UTC()
	prefix := fmt.Sprintf("io-state-%d-", at.UnixNano())
	long := strings.Repeat("가", 500)
	insertRequestIOSampleRow(t, s, prefix+"long", "key-a", []string{"user"}, &ResponseLog{FinishReason: "stop", ResponseTextOptional: long}, at)
	insertRequestIOSampleRow(t, s, prefix+"none", "key-a", nil, nil, at)
	if err := s.InsertLogRecord(t.Context(), LogRecord{
		Request: RequestLog{ID: prefix + "tool", TraceID: "t", APIKeyID: "key-a", Method: "POST", ClientIP: "192.0.2.1",
			Model: "m", Endpoint: "/v1/chat/completions", Provider: "p", StatusCode: 200, CreatedAt: at},
		Tools: []ToolInvocation{
			{ID: prefix + "tool-def", RequestID: prefix + "tool", ToolName: "defined", Source: "definition", CreatedAt: at},
			{ID: prefix + "tool-call", RequestID: prefix + "tool", ToolName: "called", Source: "call", CreatedAt: at},
		},
	}); err != nil {
		t.Fatal(err)
	}
	samples, err := s.RequestIOSamples(t.Context(), RequestIOSampleFilter{
		IDs: []string{prefix + "long", prefix + "none", prefix + "tool", prefix + "absent"}, TextChars: 100,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, found := samples[prefix+"absent"]; found || len(samples) != 3 {
		t.Fatalf("samples=%v", samples)
	}
	got := samples[prefix+"long"]
	if !got.ResponseFound || got.OutputChars != 500 || len([]rune(got.Output)) != 100 || got.FinishReason != "stop" {
		t.Fatalf("output must be cut by characters and report its full size: chars=%d kept=%d found=%v", got.OutputChars, len([]rune(got.Output)), got.ResponseFound)
	}
	if none := samples[prefix+"none"]; none.ResponseFound || none.MessageCount != 0 {
		t.Fatalf("none=%+v", none)
	}
	if tool := samples[prefix+"tool"]; len(tool.ToolNames) != 1 || tool.ToolNames[0] != "called" {
		t.Fatalf("only calls count as output: %+v", tool.ToolNames)
	}
	if empty, err := s.RequestIOSamples(t.Context(), RequestIOSampleFilter{}); err != nil || len(empty) != 0 {
		t.Fatalf("empty=%v err=%v", empty, err)
	}
}

func TestRequestIOSamplesHonorTeamScope(t *testing.T) {
	s := openRequestIOTestStore(t)
	at := time.Now().UTC()
	prefix := fmt.Sprintf("io-team-%d-", at.UnixNano())
	insertRequestIOSampleRow(t, s, prefix+"mine", prefix+"key-mine", []string{"user"}, nil, at)
	insertRequestIOSampleRow(t, s, prefix+"other", prefix+"key-other", []string{"user"}, nil, at)
	for key, team := range map[string]string{prefix + "key-mine": prefix + "team-a", prefix + "key-other": prefix + "team-b"} {
		if _, err := s.db.ExecContext(t.Context(), s.bind(`INSERT INTO api_keys (id, name, key_hash, team, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)`), key, key, key, team, formatTime(at)); err != nil {
			t.Fatal(err)
		}
	}
	ids := []string{prefix + "mine", prefix + "other"}
	scoped, err := s.RequestIOSamples(t.Context(), RequestIOSampleFilter{IDs: ids, Teams: []string{prefix + "team-a"}, TeamScoped: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, leaked := scoped[prefix+"other"]; leaked || len(scoped) != 1 {
		t.Fatalf("a team-scoped read returned another team's request: %v", scoped)
	}
	none, err := s.RequestIOSamples(t.Context(), RequestIOSampleFilter{IDs: ids, TeamScoped: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(none) != 0 {
		t.Fatalf("a scoped caller with no team must see nothing: %v", none)
	}
}
