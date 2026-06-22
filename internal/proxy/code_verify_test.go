package proxy

import "testing"

func TestExtractCodeBlocks(t *testing.T) {
	text := "설명입니다.\n\n```python\nprint('hi')\n```\n\n중간 텍스트\n\n```\npackage main\nfunc main() {}\n```\n"
	blocks := extractCodeBlocks(text)
	if len(blocks) != 2 {
		t.Fatalf("want 2 blocks, got %d", len(blocks))
	}
	if blocks[0].Lang != "python" {
		t.Fatalf("block0 lang = %q, want python", blocks[0].Lang)
	}
	// Bare fence should be guessed as Go from content.
	if blocks[1].Lang != "go" {
		t.Fatalf("block1 lang = %q, want go (guessed)", blocks[1].Lang)
	}
	if blocks[0].Lines != 1 {
		t.Fatalf("block0 lines = %d, want 1", blocks[0].Lines)
	}
}

func TestVerifyCodeNoCode(t *testing.T) {
	rep := verifyCode("코드가 전혀 없는 일반 답변입니다.")
	if rep.HasCode || rep.Risk != "none" || rep.BlockCount != 0 {
		t.Fatalf("expected no-code report, got %+v", rep)
	}
}

func TestVerifyCodeDangerousShell(t *testing.T) {
	rep := verifyCode("```bash\nsudo rm -rf /\n```")
	if rep.Risk != "high" {
		t.Fatalf("rm -rf should be high risk, got %q", rep.Risk)
	}
	if rep.Counts["high"] < 1 {
		t.Fatalf("expected >=1 high finding, got %d", rep.Counts["high"])
	}
	if len(rep.Languages) != 1 || rep.Languages[0] != "shell" {
		t.Fatalf("languages = %v, want [shell]", rep.Languages)
	}
}

func TestVerifyCodeSecretAndSQL(t *testing.T) {
	// Hardcoded OpenAI key (secret) inside python.
	repSecret := verifyCode("```python\napi_key = \"sk-abcdefghijklmnop1234\"\n```")
	if repSecret.Counts["secret"] < 1 {
		t.Fatalf("expected secret finding, got %+v", repSecret.Counts)
	}
	if repSecret.Risk != "high" {
		t.Fatalf("hardcoded secret should be high, got %q", repSecret.Risk)
	}

	// DROP TABLE → destructive high.
	repSQL := verifyCode("```sql\nDROP TABLE users;\n```")
	if repSQL.Risk != "high" {
		t.Fatalf("DROP TABLE should be high, got %q", repSQL.Risk)
	}

	// DELETE without WHERE.
	repDel := verifyCode("```sql\nDELETE FROM accounts;\n```")
	foundNoWhere := false
	for _, b := range repDel.Blocks {
		for _, f := range b.Findings {
			if f.Rule == "sql_no_where" {
				foundNoWhere = true
			}
		}
	}
	if !foundNoWhere {
		t.Fatalf("DELETE without WHERE should flag sql_no_where, got %+v", repDel.Blocks)
	}
}

func TestVerifyCodeSafeAndTestable(t *testing.T) {
	rep := verifyCode("```go\npackage main\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n```")
	if rep.Risk != "low" {
		t.Fatalf("benign go func should be low risk, got %q", rep.Risk)
	}
	if rep.Counts["testable"] != 1 {
		t.Fatalf("standalone go func should be testable, got %d", rep.Counts["testable"])
	}
}

func TestBracketImbalance(t *testing.T) {
	if bracketImbalance("func x() { return }") != "" {
		t.Fatal("balanced should report no imbalance")
	}
	if bracketImbalance("func x() { return ") != "brace" {
		t.Fatal("missing close brace should report brace")
	}
	if bracketImbalance("a)") != "paren" {
		t.Fatal("stray close paren should report paren")
	}
}

func TestNoRawCodeInFindings(t *testing.T) {
	// Findings must never echo the matched source — only rule names / details.
	rep := verifyCode("```python\nos.system('rm -rf /secret/path/value')\n```")
	for _, b := range rep.Blocks {
		for _, f := range b.Findings {
			if f.Detail == "" || f.Rule == "" {
				t.Fatalf("finding missing rule/detail: %+v", f)
			}
		}
		if b.Hash == "" {
			t.Fatal("block report should carry a hash")
		}
	}
}
