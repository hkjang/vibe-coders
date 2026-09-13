// Package tracking renders the visitor tracking snippet an administrator
// attaches to the served consoles, and the content security policy sources
// that snippet needs.
//
// The consoles ship with script-src 'self', so a pasted snippet cannot simply
// be written into the page: the browser refuses it and the administrator sees
// an empty dashboard with no explanation. This package produces both halves of
// the answer — the markup to inject and the policy sources to allow — with a
// per-request nonce so the snippet runs without weakening the policy for
// everything else. The policy is never opened with 'unsafe-inline'.
package tracking

import (
	"fmt"
	"html"
	"net/url"
	"strings"
)

const (
	ProviderNone    = "none"
	ProviderMomento = "momento"
	ProviderGA4     = "ga4"
	ProviderGTM     = "gtm"
	ProviderMatomo  = "matomo"
	ProviderCustom  = "custom"

	PlacementHead = "head"
	PlacementBody = "body"

	// MaxSnippetBytes bounds a pasted snippet. Every real tracker loader fits
	// in a fraction of this; anything larger is not a snippet.
	MaxSnippetBytes = 8 * 1024

	// MomentoProxyPrefix is the same-origin path the gateway forwards to the
	// Momento collector when the proxy is on. With it, the collector's origin
	// never appears in the policy at all.
	MomentoProxyPrefix = "/momento"

	// ReportPath receives the browser's policy violation reports while
	// tracking is on.
	ReportPath = "/tracking/csp-report"
)

// Providers lists the supported providers in the order the console offers
// them. Momento comes first: it is the self-hosted collector, the only option
// where visitor data never leaves the network.
var Providers = []string{ProviderNone, ProviderMomento, ProviderGA4, ProviderGTM, ProviderMatomo, ProviderCustom}

// Config is the administrator's tracking configuration. Everything is off by
// default: a fresh installation serves exactly the pages it served before.
type Config struct {
	Enabled            bool   `json:"enabled"`
	Provider           string `json:"provider"`
	MomentoURL         string `json:"momento_url,omitempty"`
	MomentoSiteID      string `json:"momento_site_id,omitempty"`
	MomentoEnvironment string `json:"momento_environment,omitempty"`
	MomentoProxy       bool   `json:"momento_proxy"`
	MeasurementID      string `json:"measurement_id,omitempty"`
	MatomoURL          string `json:"matomo_url,omitempty"`
	MatomoSiteID       string `json:"matomo_site_id,omitempty"`
	CustomSnippet      string `json:"custom_snippet,omitempty"`
	AllowedHosts       string `json:"allowed_hosts,omitempty"`
	IncludeAdmin       bool   `json:"include_admin"`
	Placement          string `json:"placement"`
}

// Normalized returns the configuration with its fields trimmed and its
// enumerations folded to the values the rest of the package understands.
func (c Config) Normalized() Config {
	c.Provider = strings.ToLower(strings.TrimSpace(c.Provider))
	if c.Provider == "" {
		c.Provider = ProviderNone
	}
	c.Placement = strings.ToLower(strings.TrimSpace(c.Placement))
	if c.Placement != PlacementBody {
		c.Placement = PlacementHead
	}
	c.MomentoURL = strings.TrimRight(strings.TrimSpace(c.MomentoURL), "/")
	c.MomentoSiteID = strings.TrimSpace(c.MomentoSiteID)
	c.MomentoEnvironment = strings.TrimSpace(c.MomentoEnvironment)
	if c.MomentoEnvironment == "" {
		c.MomentoEnvironment = "prd"
	}
	c.MeasurementID = strings.TrimSpace(c.MeasurementID)
	c.MatomoURL = strings.TrimRight(strings.TrimSpace(c.MatomoURL), "/")
	c.MatomoSiteID = strings.TrimSpace(c.MatomoSiteID)
	c.CustomSnippet = strings.TrimSpace(c.CustomSnippet)
	c.AllowedHosts = strings.TrimSpace(c.AllowedHosts)
	return c
}

// Active reports whether a page should carry the snippet. Administrative
// pages are excluded unless the administrator asks for them, because console
// traffic is rarely the visitor data anybody wants.
func (c Config) Active(adminPage bool) bool {
	c = c.Normalized()
	if !c.Enabled || c.Provider == ProviderNone {
		return false
	}
	if adminPage && !c.IncludeAdmin {
		return false
	}
	return c.Validate() == nil && strings.TrimSpace(c.Snippet("")) != ""
}

// MomentoProxyActive reports whether /momento/* should be forwarded to the
// collector: tracking is on, the provider is Momento, and the same-origin
// proxy is chosen.
func (c Config) MomentoProxyActive() bool {
	c = c.Normalized()
	return c.Enabled && c.Provider == ProviderMomento && c.MomentoProxy && c.Validate() == nil
}

// Validate reports what is missing for the chosen provider. A disabled
// configuration is always valid — a half-filled form must not block saving
// the switch that turns it off.
func (c Config) Validate() error {
	c = c.Normalized()
	if !c.Enabled {
		return nil
	}
	switch c.Provider {
	case ProviderNone:
		return nil
	case ProviderMomento:
		if c.MomentoURL == "" || c.MomentoSiteID == "" {
			return fmt.Errorf("tracking.momento_url and tracking.momento_site_id are required")
		}
		if !validHTTPURL(c.MomentoURL) {
			return fmt.Errorf("tracking.momento_url must be an http(s) URL")
		}
	case ProviderGA4, ProviderGTM:
		if c.MeasurementID == "" {
			return fmt.Errorf("tracking.measurement_id is required")
		}
	case ProviderMatomo:
		if c.MatomoURL == "" || c.MatomoSiteID == "" {
			return fmt.Errorf("tracking.matomo_url and tracking.matomo_site_id are required")
		}
		if !validHTTPURL(c.MatomoURL) {
			return fmt.Errorf("tracking.matomo_url must be an http(s) URL")
		}
	case ProviderCustom:
		if c.CustomSnippet == "" {
			return fmt.Errorf("tracking.custom_snippet is empty")
		}
		if len(c.CustomSnippet) > MaxSnippetBytes {
			return fmt.Errorf("tracking.custom_snippet must not exceed %d bytes", MaxSnippetBytes)
		}
	default:
		return fmt.Errorf("tracking.provider must be one of %s", strings.Join(Providers, ", "))
	}
	return nil
}

func validHTTPURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return false
	}
	return parsed.Scheme == "http" || parsed.Scheme == "https"
}

// Snippet renders the markup to inject. The nonce is applied to every script
// tag in the snippet so the policy can stay strict.
func (c Config) Snippet(nonce string) string {
	c = c.Normalized()
	switch c.Provider {
	case ProviderMomento:
		if c.MomentoURL == "" || c.MomentoSiteID == "" {
			return ""
		}
		site := html.EscapeString(c.MomentoSiteID)
		environment := html.EscapeString(c.MomentoEnvironment)
		if c.MomentoProxy {
			// Same-origin: the loader and the endpoint both live under the
			// gateway, so the collector's address is never written into the page.
			return withNonce(fmt.Sprintf(`<script async src="%s/tracker.js" data-site-id="%s" data-environment="%s" data-contract-version="1" data-endpoint="%s"></script>`,
				MomentoProxyPrefix, site, environment, MomentoProxyPrefix), nonce)
		}
		return withNonce(fmt.Sprintf(`<script async src="%s/tracker.js" data-site-id="%s" data-environment="%s" data-contract-version="1"></script>`,
			html.EscapeString(c.MomentoURL), site, environment), nonce)
	case ProviderGA4:
		if c.MeasurementID == "" {
			return ""
		}
		id := html.EscapeString(c.MeasurementID)
		return withNonce(fmt.Sprintf(`<script async src="https://www.googletagmanager.com/gtag/js?id=%s"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','%s');</script>`, id, id), nonce)
	case ProviderGTM:
		if c.MeasurementID == "" {
			return ""
		}
		id := html.EscapeString(c.MeasurementID)
		return withNonce(fmt.Sprintf(`<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','%s');</script>`, id), nonce)
	case ProviderMatomo:
		if c.MatomoURL == "" || c.MatomoSiteID == "" {
			return ""
		}
		return withNonce(fmt.Sprintf(`<script>var _paq=window._paq=window._paq||[];_paq.push(['trackPageView']);_paq.push(['enableLinkTracking']);(function(){var u="%s/";_paq.push(['setTrackerUrl',u+'matomo.php']);_paq.push(['setSiteId','%s']);var d=document,g=d.createElement('script'),s=d.getElementsByTagName('script')[0];g.async=true;g.src=u+'matomo.js';s.parentNode.insertBefore(g,s);})();</script>`,
			html.EscapeString(c.MatomoURL), html.EscapeString(c.MatomoSiteID)), nonce)
	case ProviderCustom:
		return withNonce(c.CustomSnippet, nonce)
	}
	return ""
}

// PolicySources lists the extra origins the snippet needs, derived from the
// provider so a common setup needs no policy knowledge at all. With the
// Momento proxy on, the collector is same-origin and nothing is added.
func (c Config) PolicySources() (scripts, connects, images []string) {
	c = c.Normalized()
	add := func(origin string) {
		if origin == "" {
			return
		}
		scripts = append(scripts, origin)
		connects = append(connects, origin)
		images = append(images, origin)
	}
	switch c.Provider {
	case ProviderMomento:
		if !c.MomentoProxy {
			add(originOf(c.MomentoURL))
		}
	case ProviderGA4, ProviderGTM:
		scripts = append(scripts, "https://www.googletagmanager.com")
		connects = append(connects, "https://www.google-analytics.com", "https://analytics.google.com", "https://*.google-analytics.com")
		images = append(images, "https://www.google-analytics.com", "https://www.googletagmanager.com")
	case ProviderMatomo:
		add(originOf(c.MatomoURL))
	case ProviderCustom:
		// A pasted snippet names the addresses it loads and reports to, so
		// those origins are allowed without anybody reading a policy error first.
		for _, origin := range SnippetOrigins(c.CustomSnippet) {
			add(origin)
		}
	}
	for _, host := range SplitHosts(c.AllowedHosts) {
		add(host)
	}
	return dedupe(scripts), dedupe(connects), dedupe(images)
}

// SplitHosts breaks the administrator's allow list, which accepts commas,
// spaces or newlines between entries.
func SplitHosts(list string) []string {
	fields := strings.FieldsFunc(list, func(letter rune) bool {
		return letter == ',' || letter == ' ' || letter == '\n' || letter == '\r' || letter == '\t'
	})
	hosts := make([]string, 0, len(fields))
	for _, host := range fields {
		host = strings.TrimSuffix(strings.TrimSpace(host), "/")
		if host != "" {
			hosts = append(hosts, host)
		}
	}
	return hosts
}

// AddAllowedHost appends an origin to the allow list, leaving the existing
// entries and their order alone.
func AddAllowedHost(existing, origin string) string {
	origin = strings.TrimSuffix(strings.TrimSpace(origin), "/")
	if origin == "" {
		return existing
	}
	for _, host := range SplitHosts(existing) {
		if strings.EqualFold(host, origin) {
			return existing
		}
	}
	if strings.TrimSpace(existing) == "" {
		return origin
	}
	return strings.TrimSpace(existing) + ", " + origin
}

func dedupe(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		key := strings.ToLower(value)
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, value)
	}
	return out
}

// SnippetOrigins lists every http(s) origin written into a tracking snippet:
// the script it loads, the endpoint it posts to, the pixel it requests. A
// tracker almost always writes its own address somewhere in its loader, so
// reading them here is what keeps a pasted snippet working without the
// administrator translating a policy error into a host name.
func SnippetOrigins(snippet string) []string {
	origins := make([]string, 0, 2)
	seen := make(map[string]struct{}, 2)
	for index := 0; index < len(snippet); {
		start := indexFold(snippet[index:], "http")
		if start < 0 {
			break
		}
		start += index
		end := start
		for end < len(snippet) && !isURLBoundary(snippet[end]) {
			end++
		}
		index = end
		origin := originOf(snippet[start:end])
		if origin == "" {
			continue
		}
		if _, duplicate := seen[origin]; duplicate {
			continue
		}
		seen[origin] = struct{}{}
		origins = append(origins, origin)
	}
	return origins
}

// isURLBoundary reports the characters that cannot appear in a URL written
// inside HTML or JavaScript, which is where each address ends.
func isURLBoundary(letter byte) bool {
	switch letter {
	case '"', '\'', '`', '<', '>', ' ', '\t', '\n', '\r', ')', ',', ';', '\\', '+':
		return true
	}
	return false
}

// originOf reduces a URL to scheme://host, or "" when it is not an http(s)
// address. Anything else — a browser extension, a data: URL, a bare word that
// happens to start with "http" — cannot be allowed and is not reported.
func originOf(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" {
		return ""
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return ""
	}
	return scheme + "://" + strings.ToLower(parsed.Host)
}

// withNonce adds the nonce to every script tag that does not already carry
// one, which is what lets a pasted snippet run under a strict policy unchanged.
func withNonce(snippet, nonce string) string {
	if nonce == "" || snippet == "" {
		return snippet
	}
	var builder strings.Builder
	remaining := snippet
	for {
		index := indexFold(remaining, "<script")
		if index < 0 {
			builder.WriteString(remaining)
			return builder.String()
		}
		end := index + len("<script")
		builder.WriteString(remaining[:end])
		tag := remaining[end:]
		if closing := strings.IndexByte(tag, '>'); closing >= 0 {
			tag = tag[:closing]
		}
		if !containsFold(tag, "nonce=") {
			builder.WriteString(` nonce="` + html.EscapeString(nonce) + `"`)
		}
		remaining = remaining[end:]
	}
}

// indexFold finds sub in s ignoring ASCII case, and returns an index into s.
//
// strings.ToLower is the obvious way and the wrong one: it changes byte
// lengths for some runes — U+212A KELVIN SIGN is three bytes and folds to a
// one-byte 'k', U+0130 'İ' is two and folds to three — so an index taken from
// the folded copy lands somewhere else in the original, and the nonce ends up
// written into the middle of the tag name. Every needle here is ASCII, and
// folding only ASCII keeps every byte in place.
func indexFold(s, sub string) int {
	if len(sub) == 0 {
		return 0
	}
	for i := 0; i+len(sub) <= len(s); i++ {
		match := true
		for j := 0; j < len(sub); j++ {
			if foldASCII(s[i+j]) != foldASCII(sub[j]) {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

func containsFold(s, sub string) bool { return indexFold(s, sub) >= 0 }

func foldASCII(b byte) byte {
	if b >= 'A' && b <= 'Z' {
		return b + ('a' - 'A')
	}
	return b
}

// Inject places the snippet in the document at the requested placement:
// just before </head> or just before </body>. A document without the closing
// tag gets the snippet appended, which every browser still executes.
func Inject(document []byte, snippet, placement string) []byte {
	if strings.TrimSpace(snippet) == "" {
		return document
	}
	closing := "</head>"
	if strings.EqualFold(placement, PlacementBody) {
		closing = "</body>"
	}
	block := "\n" + snippet + "\n"
	if index := indexFold(string(document), closing); index >= 0 {
		out := make([]byte, 0, len(document)+len(block))
		out = append(out, document[:index]...)
		out = append(out, block...)
		out = append(out, document[index:]...)
		return out
	}
	return append(append([]byte{}, document...), block...)
}
