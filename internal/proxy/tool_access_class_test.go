package proxy

import "testing"

func TestInferToolAccessClass(t *testing.T) {
	cases := []struct {
		server, tool string
		want         string
	}{
		{"fs", "read_file", "read"},
		{"fs", "list_dir", "read"},
		{"fs", "write_file", "write"},
		{"github", "create_commit", "write"},
		{"db", "run_sql", "execute"}, // run_ matches execute before sql/write
		{"shell", "exec", "execute"},
		{"k8s", "kubectl_apply", "execute"},
		{"http", "fetch_url", "network"},
		{"mail", "send_email", "network"},
		{"vault", "get_secret", "secret"},
		{"aws", "get_access_key", "secret"},
	}
	for _, c := range cases {
		if got := inferToolAccessClass(c.server, c.tool); got != c.want {
			t.Errorf("inferToolAccessClass(%q,%q) = %q, want %q", c.server, c.tool, got, c.want)
		}
	}
}

func TestAccessClassDefaults(t *testing.T) {
	if lvl, act := accessClassDefaults("secret"); lvl != "critical" || act != "require_approval" {
		t.Errorf("secret defaults = %s/%s, want critical/require_approval", lvl, act)
	}
	if lvl, act := accessClassDefaults("network"); lvl != "high" || act != "require_approval" {
		t.Errorf("network defaults = %s/%s, want high/require_approval", lvl, act)
	}
	if lvl, act := accessClassDefaults("read"); lvl != "low" || act != "allow" {
		t.Errorf("read defaults = %s/%s, want low/allow", lvl, act)
	}
}
