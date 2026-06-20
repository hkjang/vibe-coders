package proxy

import "testing"

func TestCSVContains(t *testing.T) {
	if !csvContains("code_review, summary", "summary") {
		t.Error("should match trimmed member")
	}
	if !csvContains("Code_Review", "code_review") {
		t.Error("should match case-insensitively")
	}
	if csvContains("code_review", "summary") {
		t.Error("should not match absent member")
	}
	if csvContains("", "x") || csvContains("a,b", "") {
		t.Error("empty inputs should not match")
	}
}
