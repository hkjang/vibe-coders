package proxy

import "testing"

func TestDecomposeResponse(t *testing.T) {
	text := "First paragraph here.\n\n- item one\n- item two\n\n```go\nfunc x() {}\n```\nClosing paragraph."
	blocks := decomposeResponse(text)
	var paras, items, codes int
	for _, b := range blocks {
		switch b.Type {
		case "paragraph":
			paras++
		case "list_item":
			items++
		case "code":
			codes++
		}
	}
	if paras != 2 || items != 2 || codes != 1 {
		t.Fatalf("decompose mismatch: paragraphs=%d list_items=%d code=%d blocks=%+v", paras, items, codes, blocks)
	}
}

func TestDecomposeNormalizationMatches(t *testing.T) {
	// Same content with different whitespace/case must hash to the same key.
	a := decomposeResponse("The   Quick Brown Fox")
	b := decomposeResponse("the quick brown fox")
	if len(a) != 1 || len(b) != 1 {
		t.Fatalf("expected single block each, got %d/%d", len(a), len(b))
	}
	if a[0].Key != b[0].Key {
		t.Errorf("normalized blocks should share a key: %q vs %q", a[0].Key, b[0].Key)
	}
}

func TestHasMarkdownTable(t *testing.T) {
	if !hasMarkdownTable("| col | col2 |\n| --- | --- |\n| a | b |") {
		t.Error("should detect a markdown table")
	}
	if hasMarkdownTable("just a sentence with a | pipe") {
		t.Error("a stray pipe is not a table")
	}
}
