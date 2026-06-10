package store

import "testing"

func TestClassifyAgent(t *testing.T) {
	cases := []struct{ ua, want string }{
		{"claude-cli/1.0.83 (external)", "Claude Code"},
		{"Cursor/0.42.3", "Cursor"},
		{"Roo-Code/3.1 vscode", "Roo Code"},
		{"Qwen-Code/0.1", "Qwen Code"},
		{"cline/2.0", "Cline"},
		{"openai-python/1.30.1", "OpenAI Python SDK"},
		{"OpenAI/Python 1.30.1", "OpenAI"}, // no openai-python substring → first-token fallback
		{"axios/1.6.0", "axios"},
		{"", "(unknown)"},
		{"SomeTool/9.9", "SomeTool"},
	}
	for _, c := range cases {
		if got := classifyAgent(c.ua); got != c.want {
			t.Errorf("classifyAgent(%q) = %q, want %q", c.ua, got, c.want)
		}
	}
}
