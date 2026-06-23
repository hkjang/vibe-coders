package proxy

import "testing"

func TestSBOMFlagOwner(t *testing.T) {
	// Missing owner is flagged and normalized.
	e := sbomEntry{Type: "skill", Name: "x"}
	e.flagOwner()
	if e.Owner != "(미지정)" {
		t.Fatalf("empty owner should normalize to (미지정), got %q", e.Owner)
	}
	if len(e.Gaps) != 1 || e.Gaps[0] != "owner 없음" {
		t.Fatalf("missing owner should add a gap, got %+v", e.Gaps)
	}
	// Whitespace-only owner also counts as missing.
	e2 := sbomEntry{Owner: "   "}
	e2.flagOwner()
	if e2.Owner != "(미지정)" || len(e2.Gaps) != 1 {
		t.Fatalf("whitespace owner should be flagged, got %+v", e2)
	}
	// Present owner is untouched, no gap.
	e3 := sbomEntry{Owner: "platform-team"}
	e3.flagOwner()
	if e3.Owner != "platform-team" || len(e3.Gaps) != 0 {
		t.Fatalf("present owner should be untouched, got %+v", e3)
	}
}
