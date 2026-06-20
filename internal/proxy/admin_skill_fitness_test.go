package proxy

import (
	"testing"

	"vibe-coders/internal/store"
)

func TestModelFitnessRequired(t *testing.T) {
	if !modelFitnessRequired(store.Skill{RiskLevel: "high"}) {
		t.Error("high-risk skill must require model fitness")
	}
	if modelFitnessRequired(store.Skill{RiskLevel: "low"}) {
		t.Error("low-risk skill without opt-in should not require it")
	}
	if !modelFitnessRequired(store.Skill{RiskLevel: "low", Metadata: `{"require_model_fitness":true}`}) {
		t.Error("opt-in via metadata should require it")
	}
	if !modelFitnessRequired(store.Skill{RiskLevel: "medium", Metadata: `{"require_model_fitness":"true"}`}) {
		t.Error("opt-in via string metadata should require it")
	}
	if modelFitnessRequired(store.Skill{Metadata: `{"require_model_fitness":false}`}) {
		t.Error("explicit false must not require it")
	}
}

func TestModelFitnessGate(t *testing.T) {
	hi := store.Skill{RiskLevel: "high"}
	if modelFitnessGate(hi, "staging", 0) != "" {
		t.Error("gate only applies to production transitions")
	}
	if modelFitnessGate(hi, "production", 0) == "" {
		t.Error("high-risk with 0 evidence should be blocked")
	}
	if modelFitnessGate(hi, "production", skillFitnessMinEvidence) != "" {
		t.Error("enough evidence should pass the gate")
	}
	// Non-gated skill is never blocked.
	if modelFitnessGate(store.Skill{RiskLevel: "low"}, "production", 0) != "" {
		t.Error("non-gated skill should pass regardless of evidence")
	}
}

func TestSkillFitnessEvidenceStore(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	ctx := t.Context()
	for i, passed := range []bool{true, false, true} {
		if err := db.AddSkillFitnessEvidence(ctx, store.SkillFitnessEvidence{
			ID: "e" + string(rune('0'+i)), SkillName: "sk", Kind: "multimodel", RefID: "run", Passed: passed, Score: 80,
		}); err != nil {
			t.Fatal(err)
		}
	}
	n, err := db.CountPassingSkillFitnessEvidence(ctx, "sk")
	if err != nil || n != 2 {
		t.Fatalf("passing count = %d, want 2 (err=%v)", n, err)
	}
	ev, _ := db.ListSkillFitnessEvidence(ctx, "sk")
	if len(ev) != 3 {
		t.Fatalf("evidence list = %d, want 3", len(ev))
	}
}
