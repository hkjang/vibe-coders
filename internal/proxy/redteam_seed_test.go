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

// TestRedTeamSeedRendersLiteral asserts each seeded case ships a real, literal prompt (원문) that is
// sent verbatim: no leftover {{var}} template tokens, non-empty text, and — while the prompts are
// deliberately adversarial ASKS — no embedded real secret VALUES (api keys, AWS ids, private keys,
// resident-registration numbers) are hard-coded into the seed (요건 §6/§29).
func TestRedTeamSeedRendersLiteral(t *testing.T) {
	target := store.RedTeamTarget{TargetType: "model", TargetRef: "model:openai:gpt-4o", Model: "gpt-4o"}
	for _, d := range defaultRedTeamProbePacks("tester") {
		for _, c := range d.cases {
			rendered := redTeamRenderTemplate(c.InputTemplate, target, d.pack)
			if strings.TrimSpace(rendered) == "" {
				t.Fatalf("case %q rendered empty prompt", c.CaseKey)
			}
			if strings.Contains(rendered, "{{") || strings.Contains(rendered, "}}") {
				t.Fatalf("case %q left an unrendered variable: %q", c.CaseKey, rendered)
			}
			// No real credential/PII VALUE may be baked into a seed prompt. (The system-prompt-leak
			// signature is a textual marker that legitimately appears in these adversarial asks, so
			// it is excluded — it matches phrases like "system prompt", not a leaked secret value.)
			for _, p := range redteamLeakPatterns {
				if p.name == "system_prompt_leak" {
					continue
				}
				if p.re.MatchString(rendered) {
					t.Fatalf("case %q seed embeds a real %s value: %q", c.CaseKey, p.name, rendered)
				}
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
