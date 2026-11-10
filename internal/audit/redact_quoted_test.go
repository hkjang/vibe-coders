package audit

import (
	"encoding/json"
	"strings"
	"testing"
)

// The key=value rules want the separator right after the keyword, so a key written with its
// own quote slipped past them and {"password":"hunter2"} reached redacted_text verbatim.
// That is the shape nearly every tool call and tool result arrives in.

func TestRedactQuotedKeys(t *testing.T) {
	for _, tc := range []struct{ name, in, secret string }{
		{"json", `{"password":"hunter2"}`, "hunter2"},
		{"json spaced", `{"api_key": "abc123xyz"}`, "abc123xyz"},
		{"json suffix key", `{"client_secret":"topsecretvalue"}`, "topsecretvalue"},
		{"json prefixed key", `{"refresh_token":"tok_live_abcdef"}`, "tok_live_abcdef"},
		{"json camel case", `{"apiKey":"camelsecret"}`, "camelsecret"},
		{"json upper case", `{"PASSWORD":"shoutedsecret"}`, "shoutedsecret"},
		{"python repr", `{'password': 'hunter2'}`, "hunter2"},
		{"ruby hash", `{"password" => "hunter2"}`, "hunter2"},
		{"bare number", `{"password":12345678}`, "12345678"},
		{"escaped once", `{\"password\":\"hunter2\"}`, "hunter2"},
		{"escaped once with space", `{\"api_key\": \"abc123xyz\"}`, "abc123xyz"},
		{"escaped twice", `{\\\"password\\\":\\\"hunter2\\\"}`, "hunter2"},
		{"escaped quote in value", `{"password":"hun\"ter2"}`, `ter2`},
		{"escaped quote in escaped value", `{\"password\":\"hun\\\"ter2\"}`, `ter2`},
		{"cut off by a capture limit", `{"password":"hunter2`, "hunter2"},
		{"escaped and cut off", `{\"password\":\"hunter2`, "hunter2"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := Redact(tc.in)
			if strings.Contains(got, tc.secret) {
				t.Fatalf("secret survived: %q", got)
			}
			if !strings.Contains(got, "[REDACTED]") {
				t.Fatalf("no redaction marker in %q", got)
			}
			if again := Redact(got); again != got {
				t.Fatalf("redaction is not idempotent: %q then %q", got, again)
			}
		})
	}
}

// The tool-call argument string is the case that matters most, and it has to come back as
// the same document: the console parses these to show the call.
func TestRedactQuotedKeysKeepsJSONValid(t *testing.T) {
	arguments, _ := json.Marshal(map[string]any{"user": "alice", "password": `hun"ter\2`, "note": "keep me"})
	nested, _ := json.Marshal(map[string]any{"function": map[string]any{"name": "login", "arguments": string(arguments)}})

	for _, in := range []string{string(arguments), string(nested)} {
		got := Redact(in)
		if strings.Contains(got, "hun") || strings.Contains(got, "ter") {
			t.Fatalf("secret survived: %q", got)
		}
		var decoded map[string]any
		if err := json.Unmarshal([]byte(got), &decoded); err != nil {
			t.Fatalf("redaction broke the JSON: %v\n%s", err, got)
		}
		if !strings.Contains(got, "keep me") && !strings.Contains(got, "login") {
			t.Fatalf("neighbouring fields were lost: %q", got)
		}
	}
	var decoded struct {
		Function struct {
			Arguments string `json:"arguments"`
		} `json:"function"`
	}
	if err := json.Unmarshal([]byte(Redact(string(nested))), &decoded); err != nil {
		t.Fatal(err)
	}
	var args map[string]any
	if err := json.Unmarshal([]byte(decoded.Function.Arguments), &args); err != nil {
		t.Fatalf("the argument string no longer parses: %v\n%s", err, decoded.Function.Arguments)
	}
	if args["password"] != "[REDACTED]" || args["note"] != "keep me" || args["user"] != "alice" {
		t.Fatalf("unexpected arguments after redaction: %#v", args)
	}
}

// Anything that is not a credential's value has to come back untouched, or a tool schema and
// the request parameters stop being readable.
func TestRedactQuotedKeysLeavesOtherFieldsAlone(t *testing.T) {
	for _, in := range []string{
		`{"max_tokens":100}`,
		`{"token_type":"bearer"}`,
		`{"tokenizer":"cl100k"}`,
		`{"password_hint":"first pet"}`,
		`{"token":null}`,
		`{"secret":true}`,
		`{"password":""}`,
		`{"properties":{"token":{"type":"string"},"api_key":["a","b"]}}`,
	} {
		if got := Redact(in); got != in {
			t.Errorf("%s was changed to %s", in, got)
		}
	}
}
