package store

import (
	"context"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"
)

// Retention completeness.
//
// The list of tables purged alongside request_logs is a hardcoded literal, so every
// table added later has to be remembered by whoever adds it. That is why four
// request-scoped tables (routing_decisions, mcp_route_decisions,
// domain_routing_decisions, code_verify_results) went years without ever being deleted,
// and why three tables carrying expires_at were never swept.
//
// This test turns "someone has to remember" into "the build says so": a table that
// records a request or declares an expiry must appear below with an explicit decision.
// Adding one without deciding fails here rather than quietly accumulating rows — and,
// in the case of routing_decisions, quietly retaining the PII classification of prompts
// that were themselves deleted for retention.
//
// The registry is intent. The test also checks reality, so a table declared as purged
// whose purge was never written is caught too.
type retentionPolicy string

const (
	// purgedWithRequest: deleted when the request it belongs to ages out.
	purgedWithRequest retentionPolicy = "purged_with_request"
	// sweptByExpiry: deleted once its own expires_at has passed.
	sweptByExpiry retentionPolicy = "swept_by_expiry"
	// retained: deliberately kept. Operator-authored records, audit trails, or data with
	// its own lifecycle elsewhere.
	retained retentionPolicy = "retained"
)

type retentionDecision struct {
	policy retentionPolicy
	why    string
}

// Every table carrying request_id or expires_at needs an entry here.
var retentionDecisions = map[string]retentionDecision{
	// Request-scoped telemetry: meaningless once its request is gone.
	"prompt_logs":              {purgedWithRequest, "the request's prompt"},
	"response_logs":            {purgedWithRequest, "the request's response"},
	"token_usage":              {purgedWithRequest, "the request's token and cost accounting"},
	"language_stats":           {purgedWithRequest, "per-request language detection"},
	"llm_evaluations":          {purgedWithRequest, "per-request evaluation results"},
	"llm_feedback":             {purgedWithRequest, "per-request feedback"},
	"tool_invocations":         {purgedWithRequest, "per-request tool calls"},
	"routing_decisions":        {purgedWithRequest, "per-request routing, including the prompt's PII/secret classification"},
	"mcp_route_decisions":      {purgedWithRequest, "per-request MCP routing"},
	"domain_routing_decisions": {purgedWithRequest, "per-request domain routing"},
	"code_verify_results":      {purgedWithRequest, "per-request code verification"},

	// Self-expiring rows: dead the moment their expiry passes.
	"refresh_tokens":      {sweptByExpiry, "expired or long-revoked credentials"},
	"auth_sessions":       {sweptByExpiry, "expired or long-revoked sessions"},
	"text2sql_cache":      {sweptByExpiry, "cache entries that already miss on read"},
	"chat_semantic_cache": {sweptByExpiry, "cache entries that already miss on read"},
	"embedding_cache":     {sweptByExpiry, "cache entries that already miss on read"},
	"quota_reservations":  {sweptByExpiry, "in-flight quota holds, swept by their own worker"},

	// Auto-captured from live traffic. Not discovered by the column scan below — this
	// table carries neither request_id nor expires_at — so it is listed by hand, which is
	// the point: a table can hold request-derived text without either marker.
	"domain_examples": {retained, "redacted prompt text auto-promoted as a routing example; " +
		"kept as the routing corpus, but it outlives the prompt it came from — see " +
		"TestDomainExamplesOutliveThePromptsTheyCameFrom"},

	// Kept on purpose.
	"request_notes":           {retained, "operator-authored annotations, not telemetry"},
	"approvals":               {retained, "operator decisions and workflow state"},
	"secret_events":           {retained, "security audit trail, normally kept longer than request data"},
	"policy_decision_events":  {retained, "governance decisions may be required as an audit record; purging them is an operator's call, not a default"},
	"redteam_case_results":    {retained, "red team campaign results, operator-managed"},
	"text2sql_replay_bundles": {retained, "has its own retention setting (Text2SQLReplayDays)"},
	"text2sql_query_logs":     {retained, "Text2SQL analytics corpus with its own lifecycle"},
	"text2sql_spans":          {retained, "Text2SQL trace detail, tied to the query log above"},
}

var createTableRe = regexp.MustCompile(`CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\)` + "`")

// tablesDeclaring returns every table whose definition contains the given column.
func tablesDeclaring(t *testing.T, column string) []string {
	t.Helper()
	raw, err := os.ReadFile("sqlstore.go")
	if err != nil {
		t.Fatalf("read sqlstore.go: %v", err)
	}
	colRe := regexp.MustCompile(`\b` + regexp.QuoteMeta(column) + `\b`)
	var out []string
	for _, m := range createTableRe.FindAllStringSubmatch(string(raw), -1) {
		if colRe.MatchString(m[2]) {
			out = append(out, m[1])
		}
	}
	return out
}

func TestEveryRequestScopedTableHasARetentionDecision(t *testing.T) {
	for _, column := range []string{"request_id", "expires_at"} {
		for _, table := range tablesDeclaring(t, column) {
			if _, ok := retentionDecisions[table]; !ok {
				t.Errorf("table %q declares %s but has no retention decision.\n"+
					"Add it to retentionDecisions in this file: is it purged with its request, "+
					"swept by its own expiry, or deliberately retained — and why?", table, column)
			}
		}
	}
}

// A decision to purge is worth nothing if the purge was never written. This catches the
// exact failure the last two releases fixed: a table everyone assumed was covered.
func TestDeclaredPurgesActuallyExist(t *testing.T) {
	sources := storeSourceText(t)
	for table, decision := range retentionDecisions {
		switch decision.policy {
		case purgedWithRequest:
			want := `DELETE FROM ` + table + ` WHERE request_id IN (SELECT id FROM request_logs`
			if !strings.Contains(sources, want) {
				t.Errorf("table %q is declared purged with its request (%s) but no such delete exists",
					table, decision.why)
			}
		case sweptByExpiry:
			if !regexp.MustCompile(`DELETE FROM ` + table + `\s+WHERE`).MatchString(sources) {
				t.Errorf("table %q is declared swept by expiry (%s) but no delete exists",
					table, decision.why)
			}
		}
	}
}

// storeSourceText concatenates the package's non-test sources so the checks above can
// look for the statements they expect.
func storeSourceText(t *testing.T) string {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package dir: %v", err)
	}
	var b strings.Builder
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		raw, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		b.Write(raw)
		b.WriteByte('\n')
	}
	return b.String()
}

// A copy of a prompt that outlives the prompt.
//
// When MCP routing is confident about a request, the query is auto-promoted into
// domain_examples as a routing example. The text is redacted — promptsPlainText prefers
// RedactedText — so this is not a secrets leak. What it is, is a second copy of what a
// user asked, written without a human step and never deleted: there is no DELETE against
// this table anywhere, and it carries neither request_id nor expires_at, so neither the
// per-request purge nor the expiry sweep touches it.
//
// The consequence is concrete. An operator who sets RETENTION_PROMPT_DAYS=30 for
// compliance still has the text a year later, in a table they were not thinking about.
//
// This test asserts the current behaviour rather than changing it. Whether these should
// be purged is a trade against routing quality — the examples are the corpus that makes
// the routing work — and deleting data is not a decision to take on someone's behalf. It
// exists so the behaviour is a recorded choice, and so it fails loudly if someone adds a
// purge without also updating the reasoning above.
func TestDomainExamplesOutliveThePromptsTheyCameFrom(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	old := time.Now().UTC().AddDate(0, 0, -400)
	const text = "what is our vacation policy for contractors"

	if err := db.InsertLogRecord(ctx, LogRecord{
		Request: RequestLog{ID: "r1", TraceID: "r1", Endpoint: "/v1/chat/completions",
			Model: "m", Provider: "up", StatusCode: 200, CreatedAt: old},
		Prompts: []PromptLog{{ID: "p1", RequestID: "r1", Role: "user",
			RedactedText: text, CreatedAt: old}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertDomainExample(ctx, DomainExample{
		ID: "dex1", Route: "company_policy", Text: text, TextHash: "h1",
		Source: "mcp_evidence", Confidence: 0.9, Approved: true, AutoPromoted: true,
		CreatedAt: old.Format(time.RFC3339Nano),
	}); err != nil {
		t.Fatal(err)
	}

	purged, err := db.PurgeOlderThan(ctx, "prompt_logs", 30)
	if err != nil {
		t.Fatal(err)
	}
	if purged == 0 {
		t.Fatal("retention removed no prompt rows, so this proves nothing about what survives it")
	}

	examples, err := db.ListDomainExamples(ctx, "company_policy", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(examples) != 1 || examples[0].Text != text {
		t.Fatalf("domain_examples no longer holds the promoted text after retention (%d rows). "+
			"If that is now purged on purpose, update the retentionDecisions entry for "+
			"domain_examples to say so.", len(examples))
	}
}
