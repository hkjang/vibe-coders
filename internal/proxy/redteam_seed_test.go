package proxy

import (
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func TestDefaultRedTeamProbePacksSeed(t *testing.T) {
	packs := defaultRedTeamProbePacks("tester")
	if len(packs) < 12 {
		t.Fatalf("expected a comprehensive seed (>=12 packs), got %d", len(packs))
	}

	ids := map[string]bool{}
	caseIDs := map[string]bool{}
	totalCases := 0
	for _, d := range packs {
		if d.pack.ID == "" || d.pack.Name == "" || d.pack.Category == "" {
			t.Fatalf("pack missing id/name/category: %+v", d.pack)
		}
		if ids[d.pack.ID] {
			t.Fatalf("duplicate pack id %q", d.pack.ID)
		}
		ids[d.pack.ID] = true
		if len(d.cases) == 0 {
			t.Fatalf("pack %q has no cases", d.pack.ID)
		}
		for _, c := range d.cases {
			totalCases++
			if caseIDs[c.ID] {
				t.Fatalf("duplicate case id %q in pack %q", c.ID, d.pack.ID)
			}
			caseIDs[c.ID] = true
			if c.ExpectedPolicy == "" || c.EvaluatorType == "" || c.Severity == "" {
				t.Fatalf("case %q underspecified: %+v", c.CaseKey, c)
			}
			if len(c.TargetTypes) == 0 {
				t.Fatalf("case %q has no target types", c.CaseKey)
			}
		}
	}
	if totalCases < 30 {
		t.Fatalf("expected a rich case set (>=30), got %d", totalCases)
	}
}

// TestRedTeamSeedRendersSafe asserts every seeded case renders to a non-actionable, placeholder-only
// prompt — no leftover {{var}} and no embedded real secret/exploit string (요건 §6/§29).
func TestRedTeamSeedRendersSafe(t *testing.T) {
	target := store.RedTeamTarget{TargetType: "model", TargetRef: "model:openai:gpt-4o", Model: "gpt-4o"}
	for _, d := range defaultRedTeamProbePacks("tester") {
		for _, c := range d.cases {
			rendered := redTeamRenderTemplate(c.InputTemplate, target, d.pack)
			if strings.Contains(rendered, "{{") || strings.Contains(rendered, "}}") {
				t.Fatalf("case %q left an unrendered variable: %q", c.CaseKey, rendered)
			}
			if !strings.Contains(rendered, "REDTEAM_SAFE_TEMPLATE") {
				t.Fatalf("case %q did not render a safe placeholder: %q", c.CaseKey, rendered)
			}
			// The rendered prompt must not itself trip the leak detector (i.e. no real payloads seeded).
			if len(redteamLeakFindings(rendered)) != 0 {
				t.Fatalf("case %q rendered content contains a leak signature: %q", c.CaseKey, rendered)
			}
		}
	}
}

func TestRedTeamSeedOwaspCoverage(t *testing.T) {
	want := []string{"owasp:LLM01", "owasp:LLM02", "owasp:LLM05", "owasp:LLM06", "owasp:LLM07", "owasp:LLM09", "owasp:LLM10"}
	seen := map[string]bool{}
	for _, d := range defaultRedTeamProbePacks("tester") {
		for _, c := range d.cases {
			for _, tag := range c.RiskTags {
				seen[tag] = true
			}
		}
	}
	for _, w := range want {
		if !seen[w] {
			t.Fatalf("expected OWASP tag %q in the default seed", w)
		}
	}
}
