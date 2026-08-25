package text2sql

import "testing"

func TestWithOKFKnowledge(t *testing.T) {
	base := []Message{{Role: "system", Content: "instructions"}, {Role: "user", Content: "q"}}

	// Empty knowledge → unchanged.
	if got := WithOKFKnowledge(base, "  "); len(got) != 2 {
		t.Fatalf("empty knowledge should be a no-op, got %d msgs", len(got))
	}

	got := WithOKFKnowledge(base, "조인: orders.customer_id = customers.id")
	if len(got) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(got))
	}
	// Inserted right after the first system message, before the user turn.
	if got[0].Content != "instructions" || got[2].Role != "user" {
		t.Fatalf("knowledge inserted in wrong position: %+v", got)
	}
	if got[1].Role != "system" || got[1].Content == "" {
		t.Fatalf("expected a system knowledge message at index 1, got %+v", got[1])
	}
}
