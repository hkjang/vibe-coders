package store

import (
	"context"
	"testing"
	"time"
)

func TestChatSemanticCache(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	// Store a response under a reference vector.
	ref := []float64{1, 0, 0}
	if err := db.PutChatSemanticEntry(ctx, "e1", "gpt-4.1", ref, "application/json", []byte(`{"ok":1}`), time.Hour); err != nil {
		t.Fatal(err)
	}

	// A near-identical vector → hit above threshold.
	near := []float64{0.99, 0.01, 0}
	hit, found, err := db.SearchChatSemantic(ctx, "gpt-4.1", near, 0.95, 200)
	if err != nil {
		t.Fatal(err)
	}
	if !found || string(hit.Body) != `{"ok":1}` {
		t.Fatalf("expected near-vector hit: found=%v body=%s", found, hit.Body)
	}
	if hit.Similarity < 0.95 {
		t.Errorf("similarity should meet threshold, got %f", hit.Similarity)
	}

	// An orthogonal vector → no hit.
	if _, found, _ := db.SearchChatSemantic(ctx, "gpt-4.1", []float64{0, 1, 0}, 0.95, 200); found {
		t.Error("orthogonal vector should not hit at 0.95 threshold")
	}

	// Wrong model → no hit.
	if _, found, _ := db.SearchChatSemantic(ctx, "other-model", ref, 0.95, 200); found {
		t.Error("different model should not match")
	}

	// Expired entry → purged + not returned.
	_ = db.PutChatSemanticEntry(ctx, "e2", "m2", []float64{1, 1}, "application/json", []byte("x"), -time.Minute)
	if _, found, _ := db.SearchChatSemantic(ctx, "m2", []float64{1, 1}, 0.5, 200); found {
		t.Error("expired entry should not be returned")
	}
	if n, _ := db.PurgeChatSemanticExpired(ctx); n < 1 {
		t.Errorf("expected to purge >=1 expired entry, got %d", n)
	}
}
