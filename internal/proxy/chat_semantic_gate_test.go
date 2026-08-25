package proxy

import "testing"

func TestChatIsSingleTurn(t *testing.T) {
	cases := []struct {
		name string
		body string
		want bool
	}{
		{"single user", `{"messages":[{"role":"user","content":"hi"}]}`, true},
		{"system + user", `{"messages":[{"role":"system","content":"s"},{"role":"user","content":"q"}]}`, true},
		{"few-shot users", `{"messages":[{"role":"user","content":"a"},{"role":"user","content":"b"}]}`, true},
		{"multi-turn (has assistant)", `{"messages":[{"role":"user","content":"a"},{"role":"assistant","content":"b"},{"role":"user","content":"c"}]}`, false},
		{"tool turn", `{"messages":[{"role":"user","content":"a"},{"role":"tool","content":"r"}]}`, false},
		{"tools declared", `{"messages":[{"role":"user","content":"a"}],"tools":[{"type":"function"}]}`, false},
		{"tools null ok", `{"messages":[{"role":"user","content":"a"}],"tools":null}`, true},
		{"no user", `{"messages":[{"role":"system","content":"s"}]}`, false},
		{"bad json", `not json`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := chatIsSingleTurn([]byte(tc.body)); got != tc.want {
				t.Errorf("chatIsSingleTurn(%s) = %v, want %v", tc.name, got, tc.want)
			}
		})
	}
}
