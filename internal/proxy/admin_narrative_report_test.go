package proxy

import "testing"

func TestPctDelta(t *testing.T) {
	if pctDelta(150, 100) != 50 {
		t.Errorf("150 from 100 should be +50, got %v", pctDelta(150, 100))
	}
	if pctDelta(50, 100) != -50 {
		t.Errorf("50 from 100 should be -50, got %v", pctDelta(50, 100))
	}
	if pctDelta(100, 0) != 0 {
		t.Error("zero prior should yield 0 (no divide-by-zero)")
	}
}

func TestSignedPct(t *testing.T) {
	if signedPct(12.5) != "+12.50%" {
		t.Errorf("got %q", signedPct(12.5))
	}
	if signedPct(-3) != "-3.00%" {
		t.Errorf("got %q", signedPct(-3))
	}
}

func TestCommaInt(t *testing.T) {
	cases := map[float64]string{0: "0", 999: "999", 1000: "1,000", 1234567: "1,234,567", -1500: "-1,500"}
	for v, want := range cases {
		if got := commaInt(v); got != want {
			t.Errorf("commaInt(%v) = %q, want %q", v, got, want)
		}
	}
}
