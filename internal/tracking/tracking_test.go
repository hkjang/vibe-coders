package tracking

import (
	"strings"
	"testing"
	"time"
)

const basePolicy = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'"

func momento(proxy bool) Config {
	return Config{Enabled: true, Provider: ProviderMomento, MomentoURL: "https://momento.corp.example/", MomentoSiteID: "vibe", MomentoProxy: proxy}
}

func TestDisabledByDefaultLeavesEverythingAlone(t *testing.T) {
	var c Config
	if c.Active(false) || c.Active(true) {
		t.Fatal("zero configuration must not be active")
	}
	if got := Policy(basePolicy, c, false, "n1"); got != basePolicy {
		t.Fatalf("policy changed while tracking is off: %q", got)
	}
	if got := c.Snippet("n1"); got != "" {
		t.Fatalf("snippet while off = %q", got)
	}
	page := []byte("<html><head></head><body></body></html>")
	if got := Inject(page, c.Snippet("n1"), PlacementHead); string(got) != string(page) {
		t.Fatalf("page changed while tracking is off: %s", got)
	}
	// Enabled but no provider chosen is still off.
	c.Enabled = true
	if c.Active(false) || Policy(basePolicy, c, false, "n1") != basePolicy {
		t.Fatal("enabled with provider none must stay inactive")
	}
}

func TestMomentoProxyKeepsPolicySameOrigin(t *testing.T) {
	c := momento(true)
	snippet := c.Snippet("abc")
	for _, want := range []string{`src="/momento/tracker.js"`, `data-endpoint="/momento"`, `data-site-id="vibe"`, `data-environment="prd"`, `nonce="abc"`} {
		if !strings.Contains(snippet, want) {
			t.Fatalf("momento snippet missing %s: %s", want, snippet)
		}
	}
	if strings.Contains(snippet, "momento.corp.example") {
		t.Fatalf("proxied snippet must not name the collector: %s", snippet)
	}
	scripts, connects, images := c.PolicySources()
	if len(scripts)+len(connects)+len(images) != 0 {
		t.Fatalf("proxied momento must add no policy sources, got %v %v %v", scripts, connects, images)
	}
	policy := Policy(basePolicy, c, false, "abc")
	if !strings.Contains(policy, "script-src 'self' 'nonce-abc'") || !strings.Contains(policy, "report-uri "+ReportPath) {
		t.Fatalf("policy = %q", policy)
	}
	if strings.Contains(policy, "unsafe-inline") {
		t.Fatalf("policy must never add unsafe-inline: %q", policy)
	}
	if !c.MomentoProxyActive() || momento(false).MomentoProxyActive() {
		t.Fatal("MomentoProxyActive must follow the momento_proxy switch")
	}
}

func TestMomentoDirectAddsCollectorOrigin(t *testing.T) {
	c := momento(false)
	if !strings.Contains(c.Snippet("n"), `src="https://momento.corp.example/tracker.js"`) {
		t.Fatalf("direct snippet = %s", c.Snippet("n"))
	}
	policy := Policy(basePolicy, c, false, "n")
	for _, want := range []string{"script-src 'self' 'nonce-n' https://momento.corp.example", "connect-src 'self' https://momento.corp.example", "img-src 'self' data: https://momento.corp.example"} {
		if !strings.Contains(policy, want) {
			t.Fatalf("policy missing %q: %q", want, policy)
		}
	}
}

func TestEveryScriptTagGetsTheNonce(t *testing.T) {
	c := Config{Enabled: true, Provider: ProviderGA4, MeasurementID: "G-TEST"}
	snippet := c.Snippet("n0")
	if got := strings.Count(snippet, "<script"); got != 2 || strings.Count(snippet, `nonce="n0"`) != 2 {
		t.Fatalf("ga4 snippet nonce count mismatch: %s", snippet)
	}
	custom := Config{Enabled: true, Provider: ProviderCustom, CustomSnippet: `<SCRIPT async src="https://t.example/x.js"></SCRIPT><script nonce="keep">1</script><script>2</script>`}
	got := custom.Snippet("n1")
	if strings.Count(got, `nonce="n1"`) != 2 || !strings.Contains(got, `nonce="keep"`) {
		t.Fatalf("custom snippet nonce handling: %s", got)
	}
}

// A snippet holding a rune whose byte length changes under case folding must
// still get the nonce inside the tag, not in the middle of the tag name.
func TestNonceSurvivesCaseFoldingLengthChanges(t *testing.T) {
	for _, prefix := range []string{"İİİİ", "KKK", "ǅǅ"} {
		snippet := prefix + `<script>1</script>` + prefix + `<SCRIPT src="https://t.example/a.js"></SCRIPT>`
		got := withNonce(snippet, "n")
		if strings.Count(got, `<script nonce="n">`) != 1 || strings.Count(got, `<SCRIPT nonce="n" src=`) != 1 {
			t.Fatalf("prefix %q broke the tag: %s", prefix, got)
		}
		origins := SnippetOrigins(snippet)
		if len(origins) != 1 || origins[0] != "https://t.example" {
			t.Fatalf("prefix %q broke origin extraction: %v", prefix, origins)
		}
	}
}

func TestSnippetOriginsAndAllowedHostsReachThePolicy(t *testing.T) {
	c := Config{
		Enabled:  true,
		Provider: ProviderCustom,
		CustomSnippet: `<script>(function(){var s=document.createElement('script');s.src='HTTPS://cdn.tracker.example/loader.js?site=1';document.head.appendChild(s);
navigator.sendBeacon("https://collect.tracker.example/v1", "{}");new Image().src="https://cdn.tracker.example/px.gif"})();</script>`,
		AllowedHosts: "https://extra.example, https://cdn.tracker.example\nhttps://*.wild.example",
	}
	scripts, connects, images := c.PolicySources()
	want := []string{"https://cdn.tracker.example", "https://collect.tracker.example", "https://extra.example", "https://*.wild.example"}
	for _, group := range [][]string{scripts, connects, images} {
		if strings.Join(group, " ") != strings.Join(want, " ") {
			t.Fatalf("policy sources = %v, want %v", group, want)
		}
	}
	policy := Policy(basePolicy, c, false, "n")
	if !strings.Contains(policy, "script-src 'self' 'nonce-n' https://cdn.tracker.example https://collect.tracker.example https://extra.example https://*.wild.example") {
		t.Fatalf("policy = %q", policy)
	}
}

func TestPolicyCreatesMissingDirectiveAndReplacesNone(t *testing.T) {
	c := momento(false)
	policy := Policy("default-src 'self'; script-src 'self'; connect-src 'none'", c, false, "n")
	if !strings.Contains(policy, "connect-src https://momento.corp.example") || strings.Contains(policy, "'none' https") {
		t.Fatalf("policy = %q", policy)
	}
	if !strings.Contains(policy, "img-src https://momento.corp.example") {
		t.Fatalf("missing img-src was not created: %q", policy)
	}
}

func TestAdminPagesFollowIncludeAdmin(t *testing.T) {
	c := momento(true)
	if c.Active(true) {
		t.Fatal("admin page must be excluded by default")
	}
	if Policy(basePolicy, c, true, "n") != basePolicy {
		t.Fatal("admin page policy must stay narrow when include_admin is off")
	}
	c.IncludeAdmin = true
	if !c.Active(true) {
		t.Fatal("include_admin must attach to admin pages")
	}
}

func TestValidateRejectsOversizedAndIncompleteSetups(t *testing.T) {
	big := Config{Enabled: true, Provider: ProviderCustom, CustomSnippet: "<script>" + strings.Repeat("x", MaxSnippetBytes) + "</script>"}
	if err := big.Validate(); err == nil || !strings.Contains(err.Error(), "8192") {
		t.Fatalf("oversized snippet error = %v", err)
	}
	if big.Active(false) {
		t.Fatal("oversized snippet must not be injected")
	}
	for _, c := range []Config{
		{Enabled: true, Provider: ProviderMomento},
		{Enabled: true, Provider: ProviderMomento, MomentoURL: "ftp://x", MomentoSiteID: "s"},
		{Enabled: true, Provider: ProviderGA4},
		{Enabled: true, Provider: ProviderMatomo, MatomoURL: "https://m.example"},
		{Enabled: true, Provider: "hotjar"},
	} {
		if err := c.Validate(); err == nil {
			t.Fatalf("%+v must not validate", c)
		}
	}
	// Disabled is always valid, whatever else is in the form.
	if err := (Config{Provider: "hotjar"}).Validate(); err != nil {
		t.Fatalf("disabled config must validate: %v", err)
	}
}

func TestInjectPlacement(t *testing.T) {
	page := []byte("<!doctype html><html><HEAD><title>x</title></HEAD><body><div></div></body></html>")
	head := string(Inject(page, "<script>1</script>", PlacementHead))
	if !strings.Contains(head, "<script>1</script>\n</HEAD>") {
		t.Fatalf("head placement = %s", head)
	}
	body := string(Inject(page, "<script>1</script>", PlacementBody))
	if !strings.Contains(body, "<script>1</script>\n</body>") {
		t.Fatalf("body placement = %s", body)
	}
	if got := string(Inject([]byte("<p>no closing tags"), "<script>1</script>", PlacementHead)); !strings.HasSuffix(strings.TrimSpace(got), "<script>1</script>") {
		t.Fatalf("fallback append = %s", got)
	}
}

func TestRecorderKeepsDistinctOriginsOnly(t *testing.T) {
	recorder := NewRecorder()
	now := time.Date(2026, 9, 13, 12, 0, 0, 0, time.UTC)
	recorder.now = func() time.Time { return now }
	for i := 0; i < 5; i++ {
		recorder.Record("https://cdn.tracker.example/loader.js?v="+string(rune('0'+i)), "script-src-elem", "https://gw.example/app/overview?tab=x")
	}
	recorder.Record("https://collect.tracker.example/v1", "connect-src 'self'", "https://gw.example/app/overview")
	recorder.Record("chrome-extension://abc/x.js", "script-src", "")
	recorder.Record("data", "img-src", "")
	items := recorder.List(Config{})
	if len(items) != 2 {
		t.Fatalf("violations = %+v", items)
	}
	byOrigin := map[string]Violation{}
	for _, item := range items {
		byOrigin[item.Origin] = item
	}
	if got := byOrigin["https://cdn.tracker.example"]; got.Count != 5 || got.Directive != "script-src-elem" || got.Page != "/app/overview" {
		t.Fatalf("aggregated violation = %+v", got)
	}
	if got := byOrigin["https://collect.tracker.example"]; got.Directive != "connect-src" {
		t.Fatalf("directive not trimmed: %+v", got)
	}
	// Allowed marks what the configuration already covers.
	allowed := recorder.List(Config{AllowedHosts: "https://cdn.tracker.example"})
	for _, item := range allowed {
		if item.Allowed != (item.Origin == "https://cdn.tracker.example") {
			t.Fatalf("allowed marking wrong: %+v", item)
		}
	}
	recorder.Forget()
	if len(recorder.List(Config{})) != 0 {
		t.Fatal("forget did not clear")
	}
}

func TestRecorderEvictsOldestBeyondCapacity(t *testing.T) {
	recorder := NewRecorder()
	tick := time.Date(2026, 9, 13, 0, 0, 0, 0, time.UTC)
	recorder.now = func() time.Time { tick = tick.Add(time.Second); return tick }
	for i := 0; i < MaxViolations+10; i++ {
		recorder.Record("https://h"+itoa(i)+".example/x", "script-src", "")
	}
	items := recorder.List(Config{})
	if len(items) != MaxViolations {
		t.Fatalf("len = %d", len(items))
	}
	for _, item := range items {
		if item.Origin == "https://h0.example" {
			t.Fatal("oldest entry survived eviction")
		}
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}

func TestParseReportsAcceptsBothBrowserShapes(t *testing.T) {
	legacy := ParseReports([]byte(`{"csp-report":{"document-uri":"https://gw.example/app/","blocked-uri":"https://cdn.tracker.example/loader.js","violated-directive":"script-src-elem 'self'","effective-directive":"script-src-elem"}}`))
	if len(legacy) != 1 || legacy[0].BlockedURI != "https://cdn.tracker.example/loader.js" || legacy[0].Directive != "script-src-elem" {
		t.Fatalf("legacy = %+v", legacy)
	}
	modern := ParseReports([]byte(`[{"type":"csp-violation","body":{"blockedURL":"https://collect.tracker.example/v1","effectiveDirective":"connect-src","documentURL":"https://gw.example/app/"}},{"type":"deprecation","body":{}}]`))
	if len(modern) != 1 || modern[0].Directive != "connect-src" {
		t.Fatalf("modern = %+v", modern)
	}
	if got := ParseReports([]byte(`not json`)); got != nil {
		t.Fatalf("garbage = %+v", got)
	}
}

func TestAddAllowedHost(t *testing.T) {
	if got := AddAllowedHost("", "https://a.example/"); got != "https://a.example" {
		t.Fatalf("first = %q", got)
	}
	if got := AddAllowedHost("https://a.example", "HTTPS://A.EXAMPLE"); got != "https://a.example" {
		t.Fatalf("duplicate = %q", got)
	}
	if got := AddAllowedHost("https://a.example", "https://b.example"); got != "https://a.example, https://b.example" {
		t.Fatalf("append = %q", got)
	}
}
