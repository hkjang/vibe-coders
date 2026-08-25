package store

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestChatSemanticCache(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	// Store a response under a reference vector.
	ref := []float64{1, 0, 0}
	if err := db.PutChatSemanticEntry(ctx, "e1", "gpt-4.1", "", ref, "application/json", []byte(`{"ok":1}`), time.Hour); err != nil {
		t.Fatal(err)
	}

	// A near-identical vector → hit above threshold.
	near := []float64{0.99, 0.01, 0}
	hit, found, err := db.SearchChatSemantic(ctx, "gpt-4.1", "", near, 0.95, 200)
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
	if _, found, _ := db.SearchChatSemantic(ctx, "gpt-4.1", "", []float64{0, 1, 0}, 0.95, 200); found {
		t.Error("orthogonal vector should not hit at 0.95 threshold")
	}

	// Wrong model → no hit.
	if _, found, _ := db.SearchChatSemantic(ctx, "other-model", "", ref, 0.95, 200); found {
		t.Error("different model should not match")
	}

	// Expired entry → purged + not returned.
	_ = db.PutChatSemanticEntry(ctx, "e2", "m2", "", []float64{1, 1}, "application/json", []byte("x"), -time.Minute)
	if _, found, _ := db.SearchChatSemantic(ctx, "m2", "", []float64{1, 1}, 0.5, 200); found {
		t.Error("expired entry should not be returned")
	}
	if n, _ := db.PurgeChatSemanticExpired(ctx); n < 1 {
		t.Errorf("expected to purge >=1 expired entry, got %d", n)
	}
}

// A semantic hit does not need the prompt to match, only to be close, which makes the
// scope matter more here than on the exact cache: without it, CACHE_CHAT_SCOPE would
// isolate exact entries while leaving the looser path open — assurance that reads as
// protection and is not.
func TestSemanticCacheDoesNotCrossScopes(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	vec := []float64{1, 0, 0}
	near := []float64{0.99, 0.01, 0}
	if err := db.PutChatSemanticEntry(ctx, "s1", "m", "team:alpha", vec,
		"application/json", []byte(`{"answer":"alpha-only"}`), time.Hour); err != nil {
		t.Fatal(err)
	}

	// The team that stored it still gets it, or the scope has simply broken the cache.
	hit, found, err := db.SearchChatSemantic(ctx, "m", "team:alpha", near, 0.95, 200)
	if err != nil || !found {
		t.Fatalf("the storing team lost its own entry: found=%v err=%v", found, err)
	}
	if !strings.Contains(string(hit.Body), "alpha-only") {
		t.Fatalf("unexpected body for the storing team: %s", hit.Body)
	}

	// Another team must not, even though the vector is close enough to match.
	if _, found, _ := db.SearchChatSemantic(ctx, "m", "team:beta", near, 0.95, 200); found {
		t.Error("a near-identical prompt from another team hit an entry stored by team:alpha")
	}
	// Nor may an unscoped (global) lookup reach a scoped entry.
	if _, found, _ := db.SearchChatSemantic(ctx, "m", "", near, 0.95, 200); found {
		t.Error("a global lookup reached an entry stored under a team scope")
	}
}

// The default has to keep working: with no scope set, entries are shared, which is what
// every row written before the column existed looks like.
func TestSemanticCacheSharesWhenUnscoped(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	if err := db.PutChatSemanticEntry(ctx, "s2", "m", "", []float64{1, 0, 0},
		"application/json", []byte(`{"answer":"shared"}`), time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, found, err := db.SearchChatSemantic(ctx, "m", "", []float64{0.99, 0.01, 0}, 0.95, 200); err != nil || !found {
		t.Errorf("an unscoped entry was not reachable by an unscoped lookup: found=%v err=%v", found, err)
	}
}
