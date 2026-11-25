package dlp

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

func mustEngine(t *testing.T, cfg Config) *Engine {
	t.Helper()
	engine, issues := Compile(cfg)
	if len(issues) > 0 {
		t.Fatalf("config rejected: %+v", issues)
	}
	return engine
}

func entriesFound(result ScanResult, profileID string) []string {
	hit, ok := result.Hit(profileID)
	if !ok {
		return nil
	}
	return hit.EntryIDs()
}

// Every catalog entry must find its own example: the console offers these as the
// test-scan samples, and an entry that cannot see its example is broken.
func TestEveryEntryFindsItsExample(t *testing.T) {
	engine := mustEngine(t, DefaultConfig())
	for _, entry := range BuiltinEntries() {
		if entry.Example == "" {
			t.Fatalf("%s has no example", entry.ID)
		}
		found := false
		for _, m := range engine.Scan([]string{entry.Example}, []string{entry.Profile}).Hits {
			for _, match := range m.Matches {
				if match.EntryID == entry.ID {
					found = true
				}
			}
		}
		if !found {
			// A low-confidence entry sits below its profile's default threshold.
			lowered := DefaultConfig()
			lowered.Profiles = map[string]ProfileSettings{entry.Profile: {MinConfidence: "low"}}
			for _, m := range mustEngine(t, lowered).Scan([]string{entry.Example}, []string{entry.Profile}).Hits {
				for _, match := range m.Matches {
					if match.EntryID == entry.ID {
						found = true
					}
				}
			}
		}
		if !found {
			t.Errorf("%s does not detect its example %q", entry.ID, entry.Example)
		}
	}
}

func TestChecksRejectLookalikes(t *testing.T) {
	engine := mustEngine(t, DefaultConfig())
	cases := []struct {
		text    string
		profile string
		entry   string
		want    bool
	}{
		{"카드 4111 1111 1111 1111 결제", "financial", "credit_card", true},
		{"주문번호 4111 1111 1111 1112", "financial", "credit_card", false}, // Luhn fails
		{"송장 1234 5678 9012 3456", "financial", "credit_card", false},   // no issuer, Luhn fails
		{"900101-1234561", "government", "kr_rrn", true},
		{"901301-1234561", "government", "kr_rrn", false}, // month 13
		{"900230-1234561", "government", "kr_rrn", false}, // Feb 30
		{"사업자번호 123-45-67891", "government", "kr_business_number", true},
		{"사업자번호 123-45-67890", "government", "kr_business_number", false},
		{"SSN 123-45-6789", "government", "us_ssn", true},
		{"SSN 666-45-6789", "government", "us_ssn", false},
		{"GB82 WEST 1234 5698 7654 32", "financial", "iban", true},
		{"GB82 WEST 1234 5698 7654 33", "financial", "iban", false},
		{"서버 10.0.0.12 와 192.168.1.5", "pii", "ipv4_public", false},
		{"110-123-456789", "financial", "kr_bank_account", false}, // no context word
		{"입금 계좌 110-123-456789", "financial", "kr_bank_account", true},
		{"코드 E11.9", "health", "diagnosis_code", false},
		{"진단 코드 E11.9", "health", "diagnosis_code", true},
		{"key sk-ant-api03-EXAMPLEexampleEXAMPLEexample00", "credentials", "openai_api_key", false},
		{"메일 kim.minsu@example.com 로 회신", "pii", "email", true},
		{"postgres://app:s3cret@db.internal:5432/orders", "pii", "email", false}, // URL login, not a mailbox
		{"ssh://git@github.example.com/org/repo", "pii", "email", false},
		{"https://example.com/contact?to=kim.minsu@example.com", "pii", "email", true}, // address in a query is a mailbox
	}
	for _, tc := range cases {
		got := false
		for _, id := range entriesFound(engine.Scan([]string{tc.text}, []string{tc.profile}), tc.profile) {
			if id == tc.entry {
				got = true
			}
		}
		if got != tc.want {
			t.Errorf("%q → %s = %v, want %v", tc.text, tc.entry, got, tc.want)
		}
	}
}

func TestConfidenceAndMatchCountTuning(t *testing.T) {
	text := "서버 203.0.113.45"
	if len(mustEngine(t, DefaultConfig()).Scan([]string{text}, []string{"pii"}).Hits) != 0 {
		t.Fatal("a low-confidence IP should stay under the default medium threshold")
	}
	// "IP" nearby raises it to medium.
	text = "접속 ip 203.0.113.45"
	if len(mustEngine(t, DefaultConfig()).Scan([]string{text}, []string{"pii"}).Hits) != 1 {
		t.Fatal("context should lift the IP over the threshold")
	}
	cfg := DefaultConfig()
	cfg.Profiles = map[string]ProfileSettings{"pii": {MinMatches: 2}}
	if len(mustEngine(t, cfg).Scan([]string{"메일 a@example.com"}, []string{"pii"}).Hits) != 0 {
		t.Fatal("one match must not satisfy a match count of two")
	}
	if len(mustEngine(t, cfg).Scan([]string{"메일 a@example.com, b@example.com"}, []string{"pii"}).Hits) != 1 {
		t.Fatal("two matches satisfy a match count of two")
	}
	cfg.Profiles = map[string]ProfileSettings{"pii": {DisabledEntries: []string{"email"}}}
	if len(mustEngine(t, cfg).Scan([]string{"a@example.com"}, []string{"pii"}).Hits) != 0 {
		t.Fatal("a disabled entry must not match")
	}
}

func TestRecordProfileNeedsSeveralKindsTogether(t *testing.T) {
	engine := mustEngine(t, DefaultConfig())
	alone := "문의: kim@example.com"
	if _, ok := engine.Scan([]string{alone}, []string{"pii_record"}).Hit("pii_record"); ok {
		t.Fatal("one email is not a record")
	}
	record := "이름 김민수, 연락처 010-1234-5678, 이메일 kim@example.com, 주소 서울특별시 강남구 테헤란로 123"
	hit, ok := engine.Scan([]string{record}, []string{"pii_record"}).Hit("pii_record")
	if !ok || len(hit.EntryIDs()) < 3 {
		t.Fatalf("a row of personal data should be a record: %+v", hit)
	}
	far := "연락처 010-1234-5678" + strings.Repeat(" 공백", 300) + "kim@example.com" + strings.Repeat(" 공백", 300) + "서울특별시 강남구 테헤란로 123"
	if _, ok := engine.Scan([]string{far}, []string{"pii_record"}).Hit("pii_record"); ok {
		t.Fatal("values far apart are not one record")
	}
}

func TestPoliciesDecideTheStrongestActionAndRespectScope(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Enabled = true
	cfg.Policies = []Policy{
		{ID: "flag-pii", Enabled: true, Action: ActionFlag, Profiles: []string{"pii"}, Check: []Check{CheckRequest, CheckResponse}},
		{ID: "mask-keys", Enabled: true, Action: ActionMask, Profiles: []string{"credentials"}, Check: []Check{CheckRequest}},
		{ID: "block-ids", Enabled: true, Action: ActionBlock, Profiles: []string{"government"}, Check: []Check{CheckRequest}, Teams: []string{"team-fin"}},
		{ID: "off", Enabled: false, Action: ActionBlock, Profiles: []string{"pii"}, Check: []Check{CheckRequest}},
	}
	engine := mustEngine(t, cfg)
	text := []string{"메일 a@example.com 키 sk-proj-EXAMPLEexample1234567890abcd 주민 900101-1234561"}
	other := engine.Evaluate(CheckRequest, Scope{TeamID: "team-dev"}, text)
	if other.Action != ActionMask || len(other.Policies) != 2 {
		t.Fatalf("outside the scoped team the strongest is mask: %+v", other)
	}
	fin := engine.Evaluate(CheckRequest, Scope{TeamID: "team-fin"}, text)
	if fin.Action != ActionBlock || len(fin.Policies) != 3 {
		t.Fatalf("inside the scoped team government ids block: %+v", fin)
	}
	response := engine.Evaluate(CheckResponse, Scope{}, text)
	if response.Action != ActionFlag {
		t.Fatalf("only the flag policy inspects responses: %+v", response)
	}
	masked := engine.Mask(text, other.MaskMatches)
	if strings.Contains(masked[0], "sk-proj-") || !strings.Contains(masked[0], "[REDACTED_OPENAI_KEY]") || !strings.Contains(masked[0], "a@example.com") {
		t.Fatalf("mask must replace only what the mask policy matched: %q", masked[0])
	}
	header, ok := Header(other, response)
	if !ok {
		t.Fatal("header expected")
	}
	var parsed HeaderValue
	if err := json.Unmarshal([]byte(header), &parsed); err != nil || parsed.Action != ActionMask || len(parsed.Findings) < 3 {
		t.Fatalf("header: %s", header)
	}
	if strings.Contains(header, "sk-proj") || strings.Contains(header, "example.com") {
		t.Fatalf("the header must not repeat matched values: %s", header)
	}
	disabled := cfg
	disabled.Enabled = false
	if d := mustEngine(t, disabled).Evaluate(CheckRequest, Scope{}, text); d.Matched() {
		t.Fatal("a disabled configuration matches nothing")
	}
}

func TestScanLimitAndOversizeBlock(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Enabled = true
	cfg.MaxScanBytes = 1024
	cfg.Policies = []Policy{{ID: "flag", Enabled: true, Action: ActionFlag, Profiles: []string{"pii"}, Check: []Check{CheckRequest}}}
	text := []string{"early@example.com " + strings.Repeat("가", 400)}
	d := mustEngine(t, cfg).Evaluate(CheckRequest, Scope{}, text)
	if !d.Truncated || d.Matched() {
		t.Fatalf("text before the scanned tail is not read: %+v", d)
	}
	// The newest content — the end — is what gets read, and offsets stay those of
	// the whole segment so masking lands in the right place.
	late := []string{"앞부분 " + strings.Repeat("가", 400), "최신 질문 late@example.com"}
	cfg.Policies[0].Action = ActionMask
	engine := mustEngine(t, cfg)
	d = engine.Evaluate(CheckRequest, Scope{}, late)
	if !d.Truncated || d.Action != ActionMask {
		t.Fatalf("the newest message is scanned: %+v", d)
	}
	if got := engine.Mask(late, d.MaskMatches); got[1] != "최신 질문 [REDACTED_EMAIL]" || got[0] != late[0] {
		t.Fatalf("masked at the right offsets: %q", got)
	}
	cut := []string{strings.Repeat("가", 400) + " tail@example.com"}
	d = engine.Evaluate(CheckRequest, Scope{}, cut)
	if got := engine.Mask(cut, d.MaskMatches)[0]; !strings.HasSuffix(got, " [REDACTED_EMAIL]") || !strings.HasPrefix(got, "가가") {
		t.Fatalf("a segment cut in two keeps its offsets: %q", got[len(got)-40:])
	}
	cfg.Policies[0].Action = ActionFlag
	cfg.Oversize = "block"
	if d := mustEngine(t, cfg).Evaluate(CheckRequest, Scope{}, text); d.Action != ActionBlock {
		t.Fatalf("oversize=block refuses what it could not read: %+v", d)
	}
}

func TestCustomProfiles(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Enabled = true
	cfg.CustomProfiles = []CustomProfile{{
		ID: "project-codenames", Name: "프로젝트 코드명", MinConfidence: "low",
		Entries: []CustomEntry{
			{ID: "codename", Name: "코드명", Type: "keywords", Keywords: []string{"아폴로", "Project Hermes"}},
			{ID: "ticket", Name: "내부 티켓", Type: "regex", Pattern: `INT-\d{4,}`, Confidence: "high"},
		},
	}}
	cfg.Policies = []Policy{{ID: "flag-codenames", Enabled: true, Action: ActionMask, Profiles: []string{"project-codenames"}, Check: []Check{CheckRequest}}}
	engine := mustEngine(t, cfg)
	text := []string{"아폴로 출시 일정과 project hermes, INT-20231 확인"}
	d := engine.Evaluate(CheckRequest, Scope{}, text)
	if d.Action != ActionMask || len(d.MaskMatches) != 3 {
		t.Fatalf("custom keywords (case-insensitive) and regex: %+v", d)
	}
	masked := engine.Mask(text, d.MaskMatches)[0]
	if strings.Contains(masked, "아폴로") || !strings.Contains(masked, "[REDACTED_TICKET]") {
		t.Fatalf("masked: %q", masked)
	}
	bad := []CustomEntry{
		{ID: "empty", Name: "빈", Type: "regex", Pattern: `a*`},
		{ID: "broken", Name: "깨짐", Type: "regex", Pattern: `(`},
		{ID: "none", Name: "없음", Type: "keywords"},
		{ID: "Bad ID", Name: "ID", Type: "regex", Pattern: `x`},
	}
	for _, entry := range bad {
		cfg.CustomProfiles[0].Entries = []CustomEntry{entry}
		if _, issues := Compile(cfg); len(issues) == 0 {
			t.Errorf("entry %+v should be rejected", entry)
		}
	}
}

func TestValidateRejectsUnknownReferences(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Policies = []Policy{
		{ID: "x", Enabled: true, Action: "DELETE", Profiles: []string{"nope"}, Check: []Check{"BOTH"}},
		{ID: "x", Enabled: true, Action: ActionFlag, Profiles: []string{"pii"}},
	}
	cfg.Profiles = map[string]ProfileSettings{"pii": {DisabledEntries: []string{"credit_card"}, MinConfidence: "extreme"}}
	issues := Validate(Normalize(cfg))
	joined := ""
	for _, issue := range issues {
		joined += issue.Path + ":" + issue.Message + "\n"
	}
	for _, want := range []string{"policies[0].action", "policies[0].profiles", "policies[0].check", "policies[1].id", "policies[1].check", "disabled_entries", "min_confidence"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing issue %s in:\n%s", want, joined)
		}
	}
}

func TestJSONSegmentsAndRewrite(t *testing.T) {
	body := []byte(`{"model":"gpt-4.1","messages":[{"role":"user","content":"메일은 kim@example.com 이고\n키는 sk-proj-EXAMPLEexample1234567890abcd"},{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgo="}},{"type":"text","text":"전화 010-1234-5678"}]}],"temperature":0.2,"stream":true,"n":null}`)
	segments, ok := JSONSegments(body)
	if !ok {
		t.Fatal("JSON expected")
	}
	if len(segments) != 2 || !strings.Contains(segments[0], "kim@example.com") || segments[1] != "전화 010-1234-5678" {
		t.Fatalf("segments: %q", segments)
	}
	segments[0] = strings.ReplaceAll(segments[0], "kim@example.com", "[REDACTED_EMAIL]")
	rewritten, err := RewriteJSONSegments(body, segments)
	if err != nil {
		t.Fatal(err)
	}
	var before, after map[string]any
	if json.Unmarshal(body, &before) != nil || json.Unmarshal(rewritten, &after) != nil {
		t.Fatalf("rewritten body is not JSON: %s", rewritten)
	}
	if !strings.Contains(string(rewritten), "[REDACTED_EMAIL]") || strings.Contains(string(rewritten), "kim@example.com") {
		t.Fatalf("rewrite: %s", rewritten)
	}
	if after["model"] != "gpt-4.1" || after["temperature"] != 0.2 || after["stream"] != true || after["n"] != nil {
		t.Fatalf("other fields must survive: %v", after)
	}
	if !strings.HasPrefix(string(rewritten), `{"model":"gpt-4.1","messages":`) {
		t.Fatalf("member order must be kept: %s", rewritten[:40])
	}
	if !strings.Contains(string(rewritten), `data:image/png;base64,iVBORw0KGgo=`) {
		t.Fatal("inline images are left alone")
	}
	if _, ok := JSONSegments([]byte("not json")); ok {
		t.Fatal("non-JSON reported as JSON")
	}
}

func TestPreviewsHideTheValue(t *testing.T) {
	engine := mustEngine(t, DefaultConfig())
	hit, ok := engine.Scan([]string{"카드 4111 1111 1111 1111, 메일 kim.minsu@example.com"}, nil).Hit("financial")
	if !ok {
		t.Fatal("card expected")
	}
	preview := hit.Matches[0].Preview()
	if strings.Contains(preview, "1111 1111 1111") || !strings.Contains(preview, "19자") {
		t.Fatalf("card preview: %q", preview)
	}
	mail, _ := engine.Scan([]string{"kim.minsu@example.com"}, []string{"pii"}).Hit("pii")
	if p := mail.Matches[0].Preview(); strings.Contains(p, "minsu") || !strings.HasSuffix(strings.Split(p, " ")[0], ".com") {
		t.Fatalf("email preview: %q", p)
	}
	rrn, _ := engine.Scan([]string{"주민번호 900101-1234561"}, []string{"government"}).Hit("government")
	if p := rrn.Matches[0].Preview(); strings.Contains(p, "900") || strings.Contains(p, "1234") || p != "•••61 (14자)" {
		t.Fatalf("a number shows only its last two digits: %q", p)
	}
	key := []byte("server secret")
	fp := hit.Matches[0].Fingerprint(key)
	if len(fp) != 16 || fp != hit.Matches[0].Fingerprint(key) {
		t.Fatalf("fingerprint is stable and 16 hex digits: %q", fp)
	}
	if fp == hit.Matches[0].Fingerprint([]byte("another secret")) {
		t.Fatal("the fingerprint depends on the server key")
	}
	plain := sha256.Sum256([]byte("4111 1111 1111 1111"))
	if fp == hex.EncodeToString(plain[:8]) {
		t.Fatal("the fingerprint must not be a plain hash anyone can recompute")
	}
}

// Lowercasing must not move bytes: the Kelvin sign (U+212A) lowercases to a 1-byte
// "k", which used to shift context offsets and slice out of range.
func TestCaseFoldingKeepsOffsets(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Enabled = true
	cfg.Policies = []Policy{{ID: "flag", Enabled: true, Action: ActionMask, Profiles: []string{"government", "credentials", "pii"}, Check: []Check{CheckRequest}}}
	engine := mustEngine(t, cfg)
	text := strings.Repeat("\u212a\u2126\u212b", 80) + " 여권번호 M12345678, 키 ghp_EXAMPLEexampleEXAMPLE000000000000, kim@example.com"
	d := engine.Evaluate(CheckRequest, Scope{}, []string{text})
	got := entriesFound(ScanResult{Hits: d.Hits}, "government")
	if len(got) != 1 || got[0] != "kr_passport" {
		t.Fatalf("context word after case-changing characters: %v", got)
	}
	masked := engine.Mask([]string{text}, d.MaskMatches)[0]
	if strings.Contains(masked, "M12345678") || strings.Contains(masked, "ghp_") || strings.Contains(masked, "kim@") || !strings.HasPrefix(masked, "\u212a") {
		t.Fatalf("masked: %q", masked[len(masked)-120:])
	}
	if r := engine.Redact(text, []string{"government"}); strings.Contains(r, "M12345678") {
		t.Fatal("redact after case-changing characters")
	}
	if found := FindCredentials(text, nil); len(found) == 0 {
		t.Fatal("credential finder after case-changing characters")
	}
}

func TestToolInputsAreScannedWhateverTheKey(t *testing.T) {
	body := []byte(`{"model":"m","messages":[{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"lookup","input":{"id":"900101-1234561","type":"rrn","nested":{"status":"x"}}}]}],"metadata":{"user_id":"u-1"}}`)
	segments, ok := JSONSegments(body)
	if !ok {
		t.Fatal("json")
	}
	joined := strings.Join(segments, "|")
	for _, want := range []string{"900101-1234561", "rrn", "x", "lookup", "u-1"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("%q not scanned: %v", want, segments)
		}
	}
	for _, skipped := range []string{"toolu_1", "tool_use", "assistant"} {
		if strings.Contains(joined, skipped) {
			t.Fatalf("envelope value %q scanned: %v", skipped, segments)
		}
	}
}

func TestStreamPathsSeparateChoicesAndBlocks(t *testing.T) {
	paths := func(body string) []string {
		got, ok := JSONPathStrings([]byte(body))
		if !ok {
			t.Fatalf("json: %s", body)
		}
		out := []string{}
		for _, p := range got {
			out = append(out, p.Path)
		}
		return out
	}
	a := paths(`{"choices":[{"index":0,"delta":{"content":"4111 1111"}}]}`)
	b := paths(`{"choices":[{"index":1,"delta":{"content":"x"}}]}`)
	c := paths(`{"choices":[{"index":0,"delta":{"content":" 1111 1111"}}]}`)
	if a[0] != c[0] || a[0] == b[0] {
		t.Fatalf("choice paths: %v %v %v", a, b, c)
	}
	// Key order differs between providers: the index may come after the content.
	late0 := paths(`{"choices":[{"delta":{"content":"x"},"finish_reason":null,"index":0}]}`)
	late1 := paths(`{"choices":[{"delta":{"content":"x"},"finish_reason":null,"index":1}]}`)
	quoted := paths(`{"choices":[{"delta":{"content":"x"},"index":"1"}]}`)
	if late0[0] != a[0] || late1[0] != b[0] || quoted[0] != b[0] {
		t.Fatalf("late or quoted index: %v %v %v want %v %v", late0, late1, quoted, a, b)
	}
	r := paths(`{"choices":[{"index":0,"delta":{"reasoning_content":"r"}}]}`)
	if r[0] == a[0] {
		t.Fatal("reasoning is its own stream")
	}
	block0 := paths(`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"a"}}`)
	block1 := paths(`{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"a"}}`)
	if block0[0] == block1[0] {
		t.Fatalf("content blocks: %v %v", block0, block1)
	}
}

func TestNullJSONKeys(t *testing.T) {
	out, err := NullJSONKeys([]byte(`{"choices":[{"index":0,"message":{"content":"[REDACTED_EMAIL]"},"logprobs":{"content":[{"token":" kim","bytes":[32,107]}]}}],"n":1}`), "logprobs")
	if err != nil || string(out) != `{"choices":[{"index":0,"message":{"content":"[REDACTED_EMAIL]"},"logprobs":null}],"n":1}` {
		t.Fatalf("%s %v", out, err)
	}
}

func TestMaskJoinedReplacesValuesSplitAcrossParts(t *testing.T) {
	engine, issues := Compile(Config{Enabled: true, Policies: []Policy{{ID: "m", Enabled: true, Action: ActionMask, Profiles: []string{"pii"}, Check: []Check{CheckResponse}}}})
	if len(issues) > 0 {
		t.Fatal(issues)
	}
	parts := []string{"메일은 kim.min", "su@exam", "ple.com 입니다", " 끝"}
	decision := engine.Evaluate(CheckResponse, Scope{}, []string{strings.Join(parts, "")})
	if decision.Action != ActionMask || len(decision.MaskMatches) != 1 {
		t.Fatalf("decision: %+v", decision)
	}
	got := engine.MaskJoined(parts, decision.MaskMatches)
	want := []string{"메일은 [REDACTED_EMAIL]", "", " 입니다", " 끝"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("part %d: got %q want %q (all %q)", i, got[i], want[i], got)
		}
	}
	// A match wholly inside one part behaves like Mask.
	single := engine.MaskJoined([]string{"a@b.co 와 ", "c@d.co"}, engine.Evaluate(CheckResponse, Scope{}, []string{"a@b.co 와 c@d.co"}).MaskMatches)
	if single[0] != "[REDACTED_EMAIL] 와 " || single[1] != "[REDACTED_EMAIL]" {
		t.Fatalf("single-part matches: %q", single)
	}
}

func TestMaskJoinsOverlappingMatches(t *testing.T) {
	engine, _ := Compile(Config{Enabled: true})
	text := "0123456789ABCDEF"
	out := engine.Mask([]string{text}, []Match{
		{EntryID: "email", Start: 0, End: 10, Confidence: ConfidenceLow},
		{EntryID: "kr_rrn", Start: 5, End: 14, Confidence: ConfidenceHigh},
	})
	if strings.Contains(out[0], "0123") || strings.Contains(out[0], "ABCD") || !strings.HasSuffix(out[0], "EF") {
		t.Fatalf("overlapping matches must be masked as one span: %q", out[0])
	}
}

func TestRecordProfileEntriesCanBeDisabled(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Profiles = map[string]ProfileSettings{"pii_record": {DisabledEntries: []string{"date_of_birth"}}}
	if issues := Validate(Normalize(cfg)); len(issues) > 0 {
		t.Fatalf("a record profile's own entries can be turned off: %v", issues)
	}
	cfg.Profiles = map[string]ProfileSettings{"pii_record": {DisabledEntries: []string{"jwt"}}}
	if issues := Validate(Normalize(cfg)); len(issues) == 0 {
		t.Fatal("an entry the record profile does not use is rejected")
	}
}

func TestContextWordsIgnoreCaseBeyondASCII(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Enabled = true
	cfg.CustomProfiles = []CustomProfile{{ID: "clients", Name: "고객", Entries: []CustomEntry{
		{ID: "client-no", Name: "고객 번호", Type: "regex", Pattern: `C-\d{6}`, Confidence: "low", Context: []string{"Müller"}},
	}}}
	cfg.Policies = []Policy{{ID: "flag", Enabled: true, Action: ActionFlag, Profiles: []string{"clients"}, Check: []Check{CheckRequest}}}
	engine := mustEngine(t, cfg)
	for _, text := range []string{"MÜLLER 고객 C-123456", "müller C-123456"} {
		hit, ok := engine.Scan([]string{text}, []string{"clients"}).Hit("clients")
		if !ok || hit.Matches[0].Confidence != ConfidenceMedium {
			t.Fatalf("context word in %q raises confidence: %+v", text, hit)
		}
	}
}
