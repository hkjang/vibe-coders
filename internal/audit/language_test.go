package audit

import "testing"

func TestInferLanguagesUsesStrongSignals(t *testing.T) {
	signals := InferLanguages([]string{
		"Please refactor main.go and this snippet:\n```go\npackage main\nfunc main() {}\n```",
		"Also check package.json and the React component.",
	})

	if len(signals) == 0 {
		t.Fatal("expected language signals")
	}
	if signals[0].Language != "Go" {
		t.Fatalf("expected Go to win from code fence, got %#v", signals)
	}
	if signals[0].Confidence < 0.9 {
		t.Fatalf("expected high confidence, got %#v", signals[0])
	}
}
