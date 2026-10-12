package proxy

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOperationReasonParsing(t *testing.T) {
	for _, tc := range []struct {
		name, body, want string
		valid            bool
	}{
		{"legacy-empty", "", "", true},
		{"legacy-object", "{}", "", true},
		{"legacy-whitespace", " \n", "", true},
		{"trimmed", `{"reason":"  운영 검토  "}`, "운영 검토", true},
		{"limit", `{"reason":"` + strings.Repeat("가", 1024) + `"}`, strings.Repeat("가", 1024), true},
		{"null", "null", "", false},
		{"array", "[]", "", false},
		{"empty", `{"reason":" "}`, "", false},
		{"null-reason", `{"reason":null}`, "", false},
		{"numeric", `{"reason":7}`, "", false},
		{"unknown", `{"reason":"ok","extra":true}`, "", false},
		{"trailing", `{"reason":"ok"}{}`, "", false},
		{"character-limit", `{"reason":"` + strings.Repeat("가", 1025) + `"}`, "", false},
		{"body-limit", strings.Repeat("x", 8193), "", false},
		{"invalid-utf8", "{\"reason\":\"\xff\"}", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest("POST", "/admin/retention", strings.NewReader(tc.body))
			got, err := readOperationReason(httptest.NewRecorder(), request)
			if (err == nil) != tc.valid || got != tc.want {
				t.Fatal("reason parser contract mismatch")
			}
		})
	}
}
