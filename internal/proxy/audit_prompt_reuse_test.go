package proxy

import (
	"net/http"
	"strings"
	"testing"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

// Reusing the routing pass's prompts for the audit record.
//
// stepRouting scores the request and audits it a few lines later, and both used to
// extract and redact the same body. The plan now carries what it extracted and the audit
// reuses it, which is only sound under two conditions — both of them easy to break later
// and neither visible at the call site.

// The model can be rewritten between the two, so it must be re-read from the current
// body rather than taken from the reused set. Getting this wrong records the model the
// client asked for instead of the one the request was actually sent as.
func TestReusedPromptsStillRecordTheRewrittenModel(t *testing.T) {
	s := &Server{cfg: testConfig("http://x.invalid", "k")}
	original := []byte(`{"model":"gpt-4o","messages":[{"role":"user","content":"hello there"}]}`)
	rewritten := rewriteModelField(original, "gpt-4o-mini")
	if !strings.Contains(string(rewritten), "gpt-4o-mini") {
		t.Fatalf("the fixture did not rewrite the model: %s", rewritten)
	}

	// Prompts as the routing pass would have produced them, from the pre-rewrite body.
	_, _, pre, _ := extractAudit(original, "/v1/chat/completions", false)
	if len(pre) == 0 {
		t.Fatal("no prompts extracted; the fixture proves nothing")
	}

	req, err := http.NewRequest(http.MethodPost, "http://gw/v1/chat/completions", nil)
	if err != nil {
		t.Fatal(err)
	}
	rec := s.auditRequestWithPrompts("/v1/chat/completions", rewritten, "k", "t", req, pre)

	if rec.Request.Model != "gpt-4o-mini" {
		t.Errorf("the audit recorded model %q; the body was rewritten to gpt-4o-mini before "+
			"it was audited, and reusing the routing pass must not carry the old name over",
			rec.Request.Model)
	}
	if len(rec.Prompts) != len(pre) {
		t.Errorf("reused prompts did not reach the record: %d vs %d", len(rec.Prompts), len(pre))
	}
}

// Raw prompt storage changes what extraction produces, so a set extracted without it
// must not be reused when it is on — the record would be missing the raw text it exists
// to keep.
func TestRawPromptStorageIgnoresTheReusedPrompts(t *testing.T) {
	cfg := testConfig("http://x.invalid", "k")
	cfg.Logging.RawPrompts = true
	s := &Server{cfg: cfg}

	body := []byte(`{"model":"m","messages":[{"role":"user","content":"remember this sentence"}]}`)
	_, _, pre, _ := extractAudit(body, "/v1/chat/completions", false)
	if len(pre) == 0 || pre[0].ContentText != "" {
		t.Fatalf("the fixture should carry redacted-only prompts, got %+v", pre)
	}

	req, err := http.NewRequest(http.MethodPost, "http://gw/v1/chat/completions", nil)
	if err != nil {
		t.Fatal(err)
	}
	rec := s.auditRequestWithPrompts("/v1/chat/completions", body, "k", "t", req, pre)

	if len(rec.Prompts) == 0 {
		t.Fatal("no prompts recorded")
	}
	if rec.Prompts[0].ContentText == "" {
		t.Error("raw prompt storage is on but the record has no raw text: the reused prompts " +
			"were extracted with it off and should have been discarded rather than reused")
	}
}

// And with nothing to reuse, the record is unchanged — the plain path still works.
func TestAuditWithoutReusedPromptsIsUnchanged(t *testing.T) {
	s := &Server{cfg: testConfig("http://x.invalid", "k")}
	body := []byte(`{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	req, err := http.NewRequest(http.MethodPost, "http://gw/v1/chat/completions", nil)
	if err != nil {
		t.Fatal(err)
	}

	fresh := s.auditRequest("/v1/chat/completions", body, "k", "t", req)
	_, _, pre, _ := extractAudit(body, "/v1/chat/completions", false)
	reused := s.auditRequestWithPrompts("/v1/chat/completions", body, "k", "t", req, pre)

	if fresh.Request.Model != reused.Request.Model || fresh.Request.Stream != reused.Request.Stream {
		t.Errorf("reuse changed the record: fresh model=%q stream=%v, reused model=%q stream=%v",
			fresh.Request.Model, fresh.Request.Stream, reused.Request.Model, reused.Request.Stream)
	}
	if len(fresh.Prompts) != len(reused.Prompts) {
		t.Errorf("reuse changed the prompt count: %d vs %d", len(fresh.Prompts), len(reused.Prompts))
	}
	if len(fresh.Languages) != len(reused.Languages) {
		t.Errorf("reuse changed the language signals: %d vs %d", len(fresh.Languages), len(reused.Languages))
	}
}

var _ = config.Config{}
var _ = store.PromptLog{}
