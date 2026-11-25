package dlp

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Action is what a policy does when one of its profiles matches.
type Action string

const (
	// ActionFlag records the match and lets the traffic through unchanged.
	ActionFlag Action = "FLAG"
	// ActionMask replaces the matched values and lets the rest through.
	ActionMask Action = "MASK"
	// ActionBlock refuses the request or withholds the response.
	ActionBlock Action = "BLOCK"
)

func (a Action) rank() int {
	switch a {
	case ActionBlock:
		return 3
	case ActionMask:
		return 2
	case ActionFlag:
		return 1
	}
	return 0
}

// Stronger returns whichever action does more.
func Stronger(a, b Action) Action {
	if b.rank() > a.rank() {
		return b
	}
	return a
}

// Check is the side of the exchange a policy inspects.
type Check string

const (
	CheckRequest  Check = "REQUEST"
	CheckResponse Check = "RESPONSE"
)

// Config is the whole DLP configuration of the gateway. It is stored as one JSON
// document with a revision so concurrent editors cannot overwrite each other.
type Config struct {
	Enabled bool `json:"enabled"`
	// Evidence decides what an event keeps of a matched value: "partial" (a few
	// characters on each end and the length) or "hash_only".
	Evidence string `json:"evidence"`
	// MaxScanBytes bounds the text inspected per request or response.
	MaxScanBytes int `json:"max_scan_bytes"`
	// Oversize decides what happens to text beyond MaxScanBytes: "allow" scans the
	// first MaxScanBytes and passes the rest, "block" refuses it.
	Oversize       string                     `json:"oversize"`
	Profiles       map[string]ProfileSettings `json:"profiles"`
	CustomProfiles []CustomProfile            `json:"custom_profiles"`
	Policies       []Policy                   `json:"policies"`
}

// ProfileSettings tunes a predefined profile.
type ProfileSettings struct {
	DisabledEntries []string `json:"disabled_entries,omitempty"`
	MinConfidence   string   `json:"min_confidence,omitempty"`
	MinMatches      int      `json:"min_matches,omitempty"`
}

// CustomProfile is an operator-defined profile of regular expressions and keyword lists.
type CustomProfile struct {
	ID            string        `json:"id"`
	Name          string        `json:"name"`
	Description   string        `json:"description,omitempty"`
	MinConfidence string        `json:"min_confidence,omitempty"`
	MinMatches    int           `json:"min_matches,omitempty"`
	Entries       []CustomEntry `json:"entries"`
}

// CustomEntry is one detection rule of a custom profile.
type CustomEntry struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Type          string   `json:"type"` // regex | keywords
	Pattern       string   `json:"pattern,omitempty"`
	Keywords      []string `json:"keywords,omitempty"`
	CaseSensitive bool     `json:"case_sensitive,omitempty"`
	Confidence    string   `json:"confidence,omitempty"`
	Context       []string `json:"context,omitempty"`
	Mask          string   `json:"mask,omitempty"`
}

// Policy selects profiles and says what to do when any of them matches.
type Policy struct {
	ID       string   `json:"id"`
	Name     string   `json:"name,omitempty"`
	Enabled  bool     `json:"enabled"`
	Action   Action   `json:"action"`
	Profiles []string `json:"profiles"`
	Check    []Check  `json:"check"`
	// Teams and APIKeys narrow the policy to those callers; empty means everyone.
	// Cloudflare offers no per-request scoping and suggests a gateway per tenant; a
	// scoped policy does the same on one gateway.
	Teams   []string `json:"teams,omitempty"`
	APIKeys []string `json:"api_keys,omitempty"`
	Note    string   `json:"note,omitempty"`
}

const (
	DefaultMaxScanBytes = 1 << 20
	MaxMaxScanBytes     = 8 << 20
	maxPolicies         = 50
	maxCustomProfiles   = 30
	maxCustomEntries    = 50
	maxPatternLength    = 512
	maxKeywords         = 500
	maxKeywordLength    = 128
)

var idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,62}$`)

// Issue is one problem with a configuration.
type Issue struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

// DefaultConfig is DLP turned off with nothing configured.
func DefaultConfig() Config {
	return Config{Evidence: "partial", MaxScanBytes: DefaultMaxScanBytes, Oversize: "allow", Profiles: map[string]ProfileSettings{}, CustomProfiles: []CustomProfile{}, Policies: []Policy{}}
}

// RecommendedPolicies is a cautious starting point: flag everything both ways, mask
// credentials before they leave, and block government identifiers in prompts.
func RecommendedPolicies() []Policy {
	return []Policy{
		{ID: "mask-credentials", Name: "자격 증명은 가리고 보내기", Enabled: true, Action: ActionMask, Profiles: []string{"credentials"}, Check: []Check{CheckRequest}},
		{ID: "block-government-ids", Name: "주민·여권 번호가 든 프롬프트 차단", Enabled: true, Action: ActionBlock, Profiles: []string{"government"}, Check: []Check{CheckRequest}},
		{ID: "flag-personal-data", Name: "개인·금융·의료 정보 기록", Enabled: true, Action: ActionFlag, Profiles: []string{"pii", "financial", "health", "pii_record"}, Check: []Check{CheckRequest, CheckResponse}},
	}
}

func cleanList(values []string, lower bool) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if lower {
			value = strings.ToLower(value)
		}
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

// Normalize trims, deduplicates and fills defaults without judging validity.
func Normalize(cfg Config) Config {
	cfg.Evidence = strings.ToLower(strings.TrimSpace(cfg.Evidence))
	if cfg.Evidence == "" {
		cfg.Evidence = "partial"
	}
	if cfg.MaxScanBytes <= 0 {
		cfg.MaxScanBytes = DefaultMaxScanBytes
	}
	cfg.Oversize = strings.ToLower(strings.TrimSpace(cfg.Oversize))
	if cfg.Oversize == "" {
		cfg.Oversize = "allow"
	}
	profiles := map[string]ProfileSettings{}
	for id, settings := range cfg.Profiles {
		id = strings.TrimSpace(id)
		settings.DisabledEntries = cleanList(settings.DisabledEntries, false)
		sort.Strings(settings.DisabledEntries)
		settings.MinConfidence = strings.ToLower(strings.TrimSpace(settings.MinConfidence))
		if len(settings.DisabledEntries) == 0 && settings.MinConfidence == "" && settings.MinMatches == 0 {
			continue
		}
		profiles[id] = settings
	}
	cfg.Profiles = profiles
	custom := make([]CustomProfile, 0, len(cfg.CustomProfiles))
	for _, p := range cfg.CustomProfiles {
		p.ID = strings.TrimSpace(p.ID)
		p.Name = strings.TrimSpace(p.Name)
		p.Description = strings.TrimSpace(p.Description)
		p.MinConfidence = strings.ToLower(strings.TrimSpace(p.MinConfidence))
		entries := make([]CustomEntry, 0, len(p.Entries))
		for _, e := range p.Entries {
			e.ID = strings.TrimSpace(e.ID)
			e.Name = strings.TrimSpace(e.Name)
			e.Type = strings.ToLower(strings.TrimSpace(e.Type))
			e.Pattern = strings.TrimSpace(e.Pattern)
			e.Keywords = cleanList(e.Keywords, false)
			e.Confidence = strings.ToLower(strings.TrimSpace(e.Confidence))
			e.Context = cleanList(e.Context, true)
			e.Mask = strings.TrimSpace(e.Mask)
			entries = append(entries, e)
		}
		p.Entries = entries
		custom = append(custom, p)
	}
	cfg.CustomProfiles = custom
	policies := make([]Policy, 0, len(cfg.Policies))
	for _, p := range cfg.Policies {
		p.ID = strings.TrimSpace(p.ID)
		p.Name = strings.TrimSpace(p.Name)
		p.Action = Action(strings.ToUpper(strings.TrimSpace(string(p.Action))))
		p.Profiles = cleanList(p.Profiles, false)
		checks := []Check{}
		seen := map[Check]bool{}
		for _, c := range p.Check {
			c = Check(strings.ToUpper(strings.TrimSpace(string(c))))
			if c != "" && !seen[c] {
				seen[c] = true
				checks = append(checks, c)
			}
		}
		sort.Slice(checks, func(i, j int) bool { return checks[i] < checks[j] })
		p.Check = checks
		p.Teams = cleanList(p.Teams, false)
		p.APIKeys = cleanList(p.APIKeys, false)
		p.Note = strings.TrimSpace(p.Note)
		policies = append(policies, p)
	}
	cfg.Policies = policies
	return cfg
}

// Validate reports every problem with a normalized configuration.
func Validate(cfg Config) []Issue {
	issues := []Issue{}
	fail := func(path, format string, args ...any) {
		issues = append(issues, Issue{Path: path, Message: fmt.Sprintf(format, args...)})
	}
	if cfg.Evidence != "partial" && cfg.Evidence != "hash_only" {
		fail("evidence", "증거 보관 방식은 partial 또는 hash_only여야 합니다.")
	}
	if cfg.MaxScanBytes < 1024 || cfg.MaxScanBytes > MaxMaxScanBytes {
		fail("max_scan_bytes", "검사 상한은 1KiB에서 8MiB 사이여야 합니다.")
	}
	if cfg.Oversize != "allow" && cfg.Oversize != "block" {
		fail("oversize", "상한 초과 처리는 allow 또는 block이어야 합니다.")
	}
	known := map[string]bool{}
	for _, p := range builtinProfiles {
		known[p.ID] = true
	}
	for id, settings := range cfg.Profiles {
		path := "profiles." + id
		if _, ok := builtinProfile(id); !ok {
			fail(path, "알 수 없는 기본 프로필 %q입니다.", id)
			continue
		}
		info, _ := builtinProfile(id)
		for _, entryID := range settings.DisabledEntries {
			e, ok := entryByID[entryID]
			// A record profile is made of other profiles' entries (RecordOf).
			if !ok || (e.Profile != id && !containsString(info.RecordOf, entryID)) {
				fail(path+".disabled_entries", "%q는 이 프로필의 탐지 항목이 아닙니다.", entryID)
			}
		}
		if settings.MinConfidence != "" {
			if _, ok := ParseConfidence(settings.MinConfidence); !ok {
				fail(path+".min_confidence", "신뢰도 기준은 low, medium, high 중 하나여야 합니다.")
			}
		}
		if settings.MinMatches < 0 || settings.MinMatches > 100 {
			fail(path+".min_matches", "최소 일치 수는 1에서 100 사이여야 합니다.")
		}
	}
	if len(cfg.CustomProfiles) > maxCustomProfiles {
		fail("custom_profiles", "사용자 정의 프로필은 최대 %d개입니다.", maxCustomProfiles)
	}
	for i, p := range cfg.CustomProfiles {
		path := fmt.Sprintf("custom_profiles[%d]", i)
		switch {
		case !idPattern.MatchString(p.ID):
			fail(path+".id", "프로필 ID는 영문 소문자·숫자로 시작하고 소문자·숫자·_ . - 만 쓸 수 있습니다.")
		case known[p.ID]:
			fail(path+".id", "프로필 ID %q가 이미 쓰이고 있습니다.", p.ID)
		}
		known[p.ID] = true
		if p.Name == "" {
			fail(path+".name", "프로필 이름을 입력하세요.")
		}
		if p.MinConfidence != "" {
			if _, ok := ParseConfidence(p.MinConfidence); !ok {
				fail(path+".min_confidence", "신뢰도 기준은 low, medium, high 중 하나여야 합니다.")
			}
		}
		if p.MinMatches < 0 || p.MinMatches > 100 {
			fail(path+".min_matches", "최소 일치 수는 1에서 100 사이여야 합니다.")
		}
		if len(p.Entries) == 0 || len(p.Entries) > maxCustomEntries {
			fail(path+".entries", "탐지 항목은 1개에서 %d개까지 둘 수 있습니다.", maxCustomEntries)
		}
		entryIDs := map[string]bool{}
		for j, e := range p.Entries {
			epath := fmt.Sprintf("%s.entries[%d]", path, j)
			if !idPattern.MatchString(e.ID) {
				fail(epath+".id", "항목 ID는 영문 소문자·숫자로 시작하고 소문자·숫자·_ . - 만 쓸 수 있습니다.")
			} else if entryIDs[e.ID] {
				fail(epath+".id", "항목 ID %q가 중복됩니다.", e.ID)
			}
			entryIDs[e.ID] = true
			if e.Name == "" {
				fail(epath+".name", "항목 이름을 입력하세요.")
			}
			if _, err := compileCustomEntry(p.ID, e); err != nil {
				fail(epath, "%v", err)
			}
		}
	}
	if len(cfg.Policies) > maxPolicies {
		fail("policies", "정책은 최대 %d개입니다.", maxPolicies)
	}
	policyIDs := map[string]bool{}
	for i, p := range cfg.Policies {
		path := fmt.Sprintf("policies[%d]", i)
		if !idPattern.MatchString(p.ID) {
			fail(path+".id", "정책 ID는 영문 소문자·숫자로 시작하고 소문자·숫자·_ . - 만 쓸 수 있습니다.")
		} else if policyIDs[p.ID] {
			fail(path+".id", "정책 ID %q가 중복됩니다.", p.ID)
		}
		policyIDs[p.ID] = true
		if p.Action.rank() == 0 {
			fail(path+".action", "동작은 FLAG, MASK, BLOCK 중 하나여야 합니다.")
		}
		if len(p.Profiles) == 0 {
			fail(path+".profiles", "프로필을 하나 이상 고르세요.")
		}
		for _, id := range p.Profiles {
			if !known[id] {
				fail(path+".profiles", "알 수 없는 프로필 %q입니다.", id)
			}
		}
		if len(p.Check) == 0 {
			fail(path+".check", "검사 대상(REQUEST, RESPONSE)을 하나 이상 고르세요.")
		}
		for _, c := range p.Check {
			if c != CheckRequest && c != CheckResponse {
				fail(path+".check", "검사 대상은 REQUEST 또는 RESPONSE입니다.")
			}
		}
	}
	return issues
}

func compileCustomEntry(profileID string, e CustomEntry) (*Entry, error) {
	confidence := ConfidenceMedium
	if e.Confidence != "" {
		parsed, ok := ParseConfidence(e.Confidence)
		if !ok {
			return nil, fmt.Errorf("신뢰도는 low, medium, high 중 하나여야 합니다")
		}
		confidence = parsed
	}
	flags := "(?i)"
	if e.CaseSensitive {
		flags = ""
	}
	var source string
	switch e.Type {
	case "regex":
		if e.Pattern == "" || len(e.Pattern) > maxPatternLength {
			return nil, fmt.Errorf("정규식은 1~%d자여야 합니다", maxPatternLength)
		}
		source = flags + e.Pattern
	case "keywords":
		if len(e.Keywords) == 0 || len(e.Keywords) > maxKeywords {
			return nil, fmt.Errorf("키워드는 1~%d개여야 합니다", maxKeywords)
		}
		quoted := make([]string, 0, len(e.Keywords))
		for _, k := range e.Keywords {
			if len(k) > maxKeywordLength {
				return nil, fmt.Errorf("키워드는 %d바이트를 넘을 수 없습니다", maxKeywordLength)
			}
			quoted = append(quoted, regexp.QuoteMeta(k))
		}
		// Longest first, so "프로젝트 아폴로" wins over "아폴로" at the same position.
		sort.SliceStable(quoted, func(i, j int) bool { return len(quoted[i]) > len(quoted[j]) })
		source = flags + "(?:" + strings.Join(quoted, "|") + ")"
	default:
		return nil, fmt.Errorf("항목 유형은 regex 또는 keywords여야 합니다")
	}
	re, err := regexp.Compile(source)
	if err != nil {
		return nil, fmt.Errorf("정규식을 해석할 수 없습니다: %v", err)
	}
	if re.MatchString("") {
		return nil, fmt.Errorf("빈 문자열과 일치하는 정규식은 모든 곳에서 탐지되어 쓸 수 없습니다")
	}
	mask := e.Mask
	if mask == "" {
		mask = "[REDACTED_" + strings.ToUpper(strings.ReplaceAll(e.ID, "-", "_")) + "]"
	}
	return &Entry{ID: profileID + "/" + e.ID, Profile: profileID, Name: e.Name, pattern: re, base: confidence, context: e.Context, mask: mask}, nil
}
