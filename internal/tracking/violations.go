package tracking

import (
	"encoding/json"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

// MaxViolations bounds the recorder. Blocked requests repeat on every page
// view, so the interesting information is which origins are blocked, not how
// many times — a small buffer of distinct origins is enough to fix a snippet.
const MaxViolations = 100

// MaxReportBytes bounds one browser report. A violation report is a few
// hundred bytes; the limit exists so an unauthenticated endpoint cannot be
// fed arbitrary amounts of data.
const MaxReportBytes = 16 * 1024

// Violation is one origin the content security policy refused, kept with the
// directive that refused it so the console can say what to allow.
type Violation struct {
	Origin    string    `json:"origin"`
	Directive string    `json:"directive"`
	Page      string    `json:"page"`
	Count     int       `json:"count"`
	FirstSeen time.Time `json:"first_seen"`
	LastSeen  time.Time `json:"last_seen"`
	// Allowed marks a violation the current configuration already covers,
	// so a fixed snippet stops nagging without the record being cleared.
	Allowed bool `json:"allowed"`
}

// Recorder collects policy violations reported by browsers. It is
// deliberately in memory: the reports are a live troubleshooting aid for the
// person pasting a snippet, not an audit record, and keeping them out of the
// database means the browser can report freely without growing storage.
type Recorder struct {
	mutex      sync.Mutex
	violations map[string]*Violation
	now        func() time.Time
}

func NewRecorder() *Recorder {
	return &Recorder{violations: make(map[string]*Violation), now: time.Now}
}

// Record notes one blocked request. Anything that is not an http origin,
// such as a browser extension or a data: URL, is ignored because allowing it
// is neither possible nor useful.
func (r *Recorder) Record(blockedURI, directive, page string) {
	origin := originOf(blockedURI)
	if origin == "" {
		return
	}
	directive = strings.TrimSpace(strings.ToLower(directive))
	if index := strings.IndexByte(directive, ' '); index > 0 {
		directive = directive[:index]
	}
	if directive == "" {
		directive = "connect-src"
	}
	if len(directive) > 40 {
		directive = directive[:40]
	}
	page = pagePath(page)
	r.mutex.Lock()
	defer r.mutex.Unlock()
	key := directive + " " + origin
	moment := r.now()
	if existing, found := r.violations[key]; found {
		existing.Count++
		existing.LastSeen = moment
		existing.Page = page
		return
	}
	if len(r.violations) >= MaxViolations {
		r.evictOldest()
	}
	r.violations[key] = &Violation{Origin: origin, Directive: directive, Page: page, Count: 1, FirstSeen: moment, LastSeen: moment}
}

// pagePath keeps only the path of the reporting document. The query string
// and fragment of a console URL can carry filters and return targets that do
// not belong in a diagnostic list.
func pagePath(page string) string {
	parsed, err := url.Parse(strings.TrimSpace(page))
	if err != nil || parsed.Path == "" {
		return ""
	}
	if len(parsed.Path) > 200 {
		return parsed.Path[:200]
	}
	return parsed.Path
}

func (r *Recorder) evictOldest() {
	var oldestKey string
	var oldest time.Time
	for key, violation := range r.violations {
		if oldestKey == "" || violation.LastSeen.Before(oldest) {
			oldestKey, oldest = key, violation.LastSeen
		}
	}
	delete(r.violations, oldestKey)
}

// List returns the blocked origins, most recent first, marking the ones the
// configuration already allows.
func (r *Recorder) List(config Config) []Violation {
	allowed := make(map[string]struct{})
	scripts, connects, images := config.PolicySources()
	for _, group := range [][]string{scripts, connects, images} {
		for _, origin := range group {
			allowed[strings.ToLower(strings.TrimSuffix(origin, "/"))] = struct{}{}
		}
	}
	r.mutex.Lock()
	defer r.mutex.Unlock()
	items := make([]Violation, 0, len(r.violations))
	for _, violation := range r.violations {
		copied := *violation
		_, known := allowed[copied.Origin]
		copied.Allowed = known || matchesWildcard(copied.Origin, allowed)
		items = append(items, copied)
	}
	sort.Slice(items, func(first, second int) bool {
		if items[first].LastSeen.Equal(items[second].LastSeen) {
			return items[first].Origin < items[second].Origin
		}
		return items[first].LastSeen.After(items[second].LastSeen)
	})
	return items
}

// Forget drops the recorded violations, which is what an administrator does
// after fixing a snippet to check whether anything is still blocked.
func (r *Recorder) Forget() {
	r.mutex.Lock()
	defer r.mutex.Unlock()
	r.violations = make(map[string]*Violation)
}

// matchesWildcard covers policy entries such as https://*.google-analytics.com.
func matchesWildcard(origin string, allowed map[string]struct{}) bool {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" {
		return false
	}
	for pattern := range allowed {
		star := strings.Index(pattern, "*.")
		if star < 0 {
			continue
		}
		if strings.HasPrefix(origin, pattern[:star]) && strings.HasSuffix(parsed.Host, pattern[star+1:]) {
			return true
		}
	}
	return false
}

// Report is one blocked request as the browser describes it, in either of
// the two shapes browsers send: the legacy application/csp-report document
// and the Reporting API's array of reports.
type Report struct {
	BlockedURI string
	Directive  string
	Document   string
}

// ParseReports reads the violation reports out of a request body. A body
// that is neither shape yields nothing rather than an error: the endpoint
// answers the browser, and the browser does not read the answer.
func ParseReports(body []byte) []Report {
	body = []byte(strings.TrimSpace(string(body)))
	if len(body) == 0 {
		return nil
	}
	if body[0] == '[' {
		var reports []struct {
			Type string `json:"type"`
			Body struct {
				BlockedURL         string `json:"blockedURL"`
				EffectiveDirective string `json:"effectiveDirective"`
				DocumentURL        string `json:"documentURL"`
			} `json:"body"`
		}
		if err := json.Unmarshal(body, &reports); err != nil {
			return nil
		}
		out := make([]Report, 0, len(reports))
		for _, report := range reports {
			if report.Type != "" && report.Type != "csp-violation" {
				continue
			}
			out = append(out, Report{BlockedURI: report.Body.BlockedURL, Directive: report.Body.EffectiveDirective, Document: report.Body.DocumentURL})
		}
		return out
	}
	var legacy struct {
		Report struct {
			BlockedURI         string `json:"blocked-uri"`
			EffectiveDirective string `json:"effective-directive"`
			ViolatedDirective  string `json:"violated-directive"`
			DocumentURI        string `json:"document-uri"`
		} `json:"csp-report"`
	}
	if err := json.Unmarshal(body, &legacy); err != nil || legacy.Report.BlockedURI == "" {
		return nil
	}
	directive := legacy.Report.EffectiveDirective
	if directive == "" {
		directive = legacy.Report.ViolatedDirective
	}
	return []Report{{BlockedURI: legacy.Report.BlockedURI, Directive: directive, Document: legacy.Report.DocumentURI}}
}
