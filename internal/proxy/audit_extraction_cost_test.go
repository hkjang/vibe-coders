package proxy

import (
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// How many times one request re-reads its own body.
//
// extractAudit parses the request body, flattens every message and redacts each one. It
// is called from several steps, and each call repeats all of that: a 1 MB request was
// redacting 5 MB — five passes over the same prompt — before one of them turned out to
// want nothing but the model name and was replaced with extractModel.
//
// Redaction is the expensive half. It runs a table of patterns over the whole prompt, and
// profiling put it at more than half of the request path. So the number of callers is a
// cost multiplier on every request, and it grows silently: adding a step that wants the
// prompts looks free at the call site.
//
// This is a list someone has to maintain, which is normally a smell. It is deliberate
// here because the alternative — memoising the extraction on the pipeline — is unsound
// while the body is still being rewritten underneath it: an agent route swaps the model,
// knowledge expansion splices text in, and a cached prompt set would then describe a body
// that no longer exists. Until that is untangled, the honest guard is to notice when the
// multiplier changes.
var extractAuditCallers = map[string]string{
	"server.go":              "the audit record itself — the one caller that has to have the prompts",
	"intelligent_routing.go": "complexity and risk scoring for auto model selection",
	"mcp_model_router.go":    "picking MCP servers from the question",
	"tooling.go":             "tool and skill matching",
}

func TestExtractAuditCallersAreAccountedFor(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	call := regexp.MustCompile(`\bextractAudit\(`)
	found := map[string]int{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		raw, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		// The definition itself is not a call.
		body := strings.ReplaceAll(string(raw), "func extractAudit(", "func EXTRACT_DEFINITION(")
		if n := len(call.FindAllString(body, -1)); n > 0 {
			found[name] = n
		}
	}

	var unexpected, missing []string
	for file := range found {
		if _, ok := extractAuditCallers[file]; !ok {
			unexpected = append(unexpected, file)
		}
	}
	for file := range extractAuditCallers {
		if _, ok := found[file]; !ok {
			missing = append(missing, file)
		}
	}
	sort.Strings(unexpected)
	sort.Strings(missing)

	if len(unexpected) > 0 {
		t.Errorf("%v now calls extractAudit. Each call re-parses the body and re-redacts every "+
			"prompt, so this adds a full pass over the request on the hot path.\n"+
			"If the caller only needs the model, use extractModel. If it genuinely needs the "+
			"prompts, add it to extractAuditCallers with the reason.", unexpected)
	}
	if len(missing) > 0 {
		t.Errorf("%v no longer calls extractAudit; remove it from extractAuditCallers so the "+
			"list keeps describing the code", missing)
	}
}

// extractModel must stay cheap: the point of it is not doing the expensive half.
func TestExtractModelDoesNotTouchThePrompts(t *testing.T) {
	raw, err := os.ReadFile("server.go")
	if err != nil {
		t.Fatal(err)
	}
	start := strings.Index(string(raw), "func extractModel(")
	if start < 0 {
		t.Fatal("extractModel is gone; the model-only path was the cheap one")
	}
	end := strings.Index(string(raw)[start:], "\nfunc ")
	if end < 0 {
		t.Fatal("could not delimit extractModel")
	}
	body := string(raw)[start : start+end]
	for _, expensive := range []string{"promptLog", "audit.Redact", "flattenContent", "extractAudit"} {
		if strings.Contains(body, expensive) {
			t.Errorf("extractModel calls %s, which is the work it exists to skip", expensive)
		}
	}
}
