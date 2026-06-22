package proxy

import "testing"

func TestCodeVerifyScore(t *testing.T) {
	// No code → neutral.
	if s := codeVerifyScore(codeVerifyReport{HasCode: false}); s != 50 {
		t.Fatalf("no-code score = %d, want 50", s)
	}
	// Clean testable code → high.
	clean := codeVerifyReport{HasCode: true, Counts: map[string]int{"testable": 1}}
	if s := codeVerifyScore(clean); s != 100 {
		t.Fatalf("clean testable score = %d, want 100 (capped)", s)
	}
	// High-severity findings deduct heavily.
	risky := codeVerifyReport{HasCode: true, Counts: map[string]int{"high": 2, "medium": 1}}
	want := 100 - 2*25 - 1*8
	if s := codeVerifyScore(risky); s != want {
		t.Fatalf("risky score = %d, want %d", s, want)
	}
	// Score floors at 0.
	veryRisky := codeVerifyReport{HasCode: true, Counts: map[string]int{"high": 10}}
	if s := codeVerifyScore(veryRisky); s != 0 {
		t.Fatalf("very risky score = %d, want 0 (floored)", s)
	}
}

func TestCodeVerifyScoreOrdering(t *testing.T) {
	safe := codeVerifyScore(verifyCode("```go\npackage main\nfunc Add(a, b int) int { return a + b }\n```"))
	dangerous := codeVerifyScore(verifyCode("```bash\nsudo rm -rf /\n```"))
	if safe <= dangerous {
		t.Fatalf("safe code (%d) should outscore dangerous code (%d)", safe, dangerous)
	}
}
