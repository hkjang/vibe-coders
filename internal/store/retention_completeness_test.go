package store

import (
	"os"
	"regexp"
	"strings"
	"testing"
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
