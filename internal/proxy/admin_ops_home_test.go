package proxy

import "testing"

func TestWorseStatus(t *testing.T) {
	cases := []struct{ a, b, want string }{
		{"ok", "warn", "warn"},
		{"warn", "ok", "warn"},
		{"warn", "critical", "critical"},
		{"critical", "warn", "critical"},
		{"ok", "unknown", "unknown"},
		{"unknown", "warn", "warn"},
		{"ok", "ok", "ok"},
	}
	for _, c := range cases {
		if got := worseStatus(c.a, c.b); got != c.want {
			t.Errorf("worseStatus(%q,%q) = %q, want %q", c.a, c.b, got, c.want)
		}
	}
}
