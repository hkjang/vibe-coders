package dlp

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"
)

// Engine is a compiled configuration. It is immutable and safe for concurrent use.
type Engine struct {
	cfg      Config
	profiles map[string]*resolvedProfile
	order    []string
}

type resolvedProfile struct {
	id            string
	name          string
	builtin       bool
	entries       []*Entry
	minConfidence Confidence
	minMatches    int
	record        *ProfileInfo
}

// Compile validates cfg and prepares it for scanning.
func Compile(cfg Config) (*Engine, []Issue) {
	cfg = Normalize(cfg)
	if issues := Validate(cfg); len(issues) > 0 {
		return nil, issues
	}
	engine := &Engine{cfg: cfg, profiles: map[string]*resolvedProfile{}}
	for _, info := range builtinProfiles {
		info := info
		settings := cfg.Profiles[info.ID]
		disabled := map[string]bool{}
		for _, id := range settings.DisabledEntries {
			disabled[id] = true
		}
		profile := &resolvedProfile{id: info.ID, name: info.Name, builtin: true, minConfidence: info.DefaultMinConfidence, minMatches: info.DefaultMinMatches}
		if c, ok := ParseConfidence(settings.MinConfidence); ok {
			profile.minConfidence = c
		}
		if settings.MinMatches > 0 {
			profile.minMatches = settings.MinMatches
		}
		if len(info.RecordOf) > 0 {
			profile.record = &info
			for _, id := range info.RecordOf {
				if e := entryByID[id]; e != nil && !disabled[id] {
					profile.entries = append(profile.entries, e)
				}
			}
		} else {
			for _, e := range ProfileEntries(info.ID) {
				if !disabled[e.ID] {
					profile.entries = append(profile.entries, e)
				}
			}
		}
		engine.profiles[info.ID] = profile
		engine.order = append(engine.order, info.ID)
	}
	for _, p := range cfg.CustomProfiles {
		profile := &resolvedProfile{id: p.ID, name: p.Name, minConfidence: ConfidenceLow, minMatches: 1}
		if c, ok := ParseConfidence(p.MinConfidence); ok {
			profile.minConfidence = c
		}
		if p.MinMatches > 0 {
			profile.minMatches = p.MinMatches
		}
		for _, e := range p.Entries {
			compiled, err := compileCustomEntry(p.ID, e)
			if err != nil {
				return nil, []Issue{{Path: "custom_profiles", Message: err.Error()}}
			}
			profile.entries = append(profile.entries, compiled)
		}
		engine.profiles[p.ID] = profile
		engine.order = append(engine.order, p.ID)
	}
	return engine, nil
}

// Config returns the normalized configuration the engine was compiled from.
func (e *Engine) Config() Config { return e.cfg }

// Enabled reports whether DLP is turned on.
func (e *Engine) Enabled() bool { return e != nil && e.cfg.Enabled }

// Scope identifies the caller a policy may be limited to.
type Scope struct {
	TeamID   string
	APIKeyID string
}

func (p Policy) applies(check Check, scope Scope) bool {
	if !p.Enabled {
		return false
	}
	checked := false
	for _, c := range p.Check {
		if c == check {
			checked = true
		}
	}
	if !checked {
		return false
	}
	if len(p.Teams) > 0 && !containsString(p.Teams, scope.TeamID) {
		return false
	}
	if len(p.APIKeys) > 0 && !containsString(p.APIKeys, scope.APIKeyID) {
		return false
	}
	return true
}

func containsString(list []string, value string) bool {
	if value == "" {
		return false
	}
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

// Policies returns the enabled policies that inspect check for this caller.
func (e *Engine) Policies(check Check, scope Scope) []Policy {
	if !e.Enabled() {
		return nil
	}
	out := []Policy{}
	for _, p := range e.cfg.Policies {
		if p.applies(check, scope) {
			out = append(out, p)
		}
	}
	return out
}

// Match is one detected value.
type Match struct {
	EntryID    string     `json:"entry_id"`
	Segment    int        `json:"segment"`
	Start      int        `json:"start"`
	End        int        `json:"end"`
	Confidence Confidence `json:"-"`
	value      string
}

// Fingerprint is a keyed fingerprint of the matched value: HMAC-SHA-256 under a
// server secret, cut to 64 bits. Equal values give equal fingerprints, so a value
// that keeps leaking can be followed without keeping it; without the key, a short
// identifier such as a phone or registration number cannot be recovered from it by
// trying every candidate, which a plain hash of so few digits would allow.
func (m Match) Fingerprint(key []byte) string {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(m.value))
	return hex.EncodeToString(mac.Sum(nil)[:8])
}

// Preview shows a few characters of the value and its length, enough to tell a real
// card from an order number without keeping the card.
func (m Match) Preview() string { return partialMask(m.value) }

// ProfileHit is a profile that matched.
type ProfileHit struct {
	ProfileID string
	Matches   []Match
}

// EntryIDs lists the distinct entries behind the hit.
func (h ProfileHit) EntryIDs() []string {
	seen := map[string]bool{}
	out := []string{}
	for _, m := range h.Matches {
		if !seen[m.EntryID] {
			seen[m.EntryID] = true
			out = append(out, m.EntryID)
		}
	}
	sort.Strings(out)
	return out
}

// MaxConfidence is the strongest confidence among the hit's matches.
func (h ProfileHit) MaxConfidence() Confidence {
	best := ConfidenceNone
	for _, m := range h.Matches {
		if m.Confidence > best {
			best = m.Confidence
		}
	}
	return best
}

// ScanResult is what scanning some text found, per profile.
type ScanResult struct {
	Hits []ProfileHit
	// Truncated means the text exceeded the scan limit and only the first part was read.
	Truncated bool
	// Scanned is how many bytes were inspected.
	Scanned int
}

// Hit returns the hit for a profile.
func (r ScanResult) Hit(profileID string) (ProfileHit, bool) {
	for _, h := range r.Hits {
		if h.ProfileID == profileID {
			return h, true
		}
	}
	return ProfileHit{}, false
}

// Scan inspects segments against profiles (all profiles when none are given).
func (e *Engine) Scan(segments []string, profileIDs []string) ScanResult {
	if len(profileIDs) == 0 {
		profileIDs = e.order
	}
	limit := e.cfg.MaxScanBytes
	if limit <= 0 {
		limit = DefaultMaxScanBytes
	}
	// Over the limit, the end is what is read: the newest message of a chat and the
	// end of an answer are where fresh content sits, while the start is usually a
	// system prompt the operator wrote. A segment cut in two keeps its tail, and its
	// matches are shifted back to offsets in the whole segment.
	bounded := make([]string, len(segments))
	shift := make([]int, len(segments))
	total := 0
	truncated := false
	for i := len(segments) - 1; i >= 0; i-- {
		segment := segments[i]
		if total >= limit {
			truncated = true
			break
		}
		if total+len(segment) > limit {
			cut := len(segment) - (limit - total)
			for cut < len(segment) && !utf8.RuneStart(segment[cut]) {
				cut++
			}
			shift[i] = cut
			segment = segment[cut:]
			truncated = true
		}
		total += len(segment)
		bounded[i] = segment
	}
	lowered := make([]string, len(bounded))
	for i, segment := range bounded {
		lowered[i] = asciiLower(segment)
	}
	cache := map[string][]Match{}
	matchesOf := func(entry *Entry) []Match {
		if cached, ok := cache[entry.ID]; ok {
			return cached
		}
		found := []Match{}
		for i, segment := range bounded {
			for _, m := range entry.find(i, segment, lowered[i]) {
				m.Start += shift[i]
				m.End += shift[i]
				found = append(found, m)
			}
		}
		cache[entry.ID] = found
		return found
	}
	result := ScanResult{Truncated: truncated, Scanned: total}
	for _, id := range profileIDs {
		profile := e.profiles[id]
		if profile == nil {
			continue
		}
		candidates := []Match{}
		for _, entry := range profile.entries {
			for _, m := range matchesOf(entry) {
				if m.Confidence >= profile.minConfidence {
					candidates = append(candidates, m)
				}
			}
		}
		candidates = dedupeOverlaps(candidates)
		if profile.record != nil {
			candidates = recordMatches(candidates, profile.record.RecordDistinct, profile.record.RecordWindow)
		}
		if len(candidates) >= profile.minMatches && len(candidates) > 0 {
			result.Hits = append(result.Hits, ProfileHit{ProfileID: id, Matches: candidates})
		}
	}
	return result
}

func (entry *Entry) find(segment int, text, lower string) []Match {
	if len(entry.prefilter) > 0 {
		present := false
		for _, literal := range entry.prefilter {
			if strings.Contains(lower, literal) {
				present = true
				break
			}
		}
		if !present {
			return nil
		}
	}
	out := []Match{}
	for _, loc := range entry.pattern.FindAllStringSubmatchIndex(text, 200) {
		start, end := loc[0], loc[1]
		if entry.group > 0 && len(loc) > 2*entry.group+1 && loc[2*entry.group] >= 0 {
			start, end = loc[2*entry.group], loc[2*entry.group+1]
		}
		if entry.around != nil && entry.around(text, start, end) {
			continue
		}
		value := text[start:end]
		confidence := entry.base
		if entry.check != nil {
			switch entry.check(value) {
			case Reject:
				continue
			case Strong:
				if confidence != ConfidenceNone {
					confidence = ConfidenceHigh
				}
			}
		}
		if len(entry.context) > 0 && hasContext(text, start, end, entry.context) {
			if confidence == ConfidenceNone {
				confidence = ConfidenceMedium
			} else if confidence < ConfidenceHigh {
				confidence++
			}
		}
		if confidence == ConfidenceNone {
			continue
		}
		out = append(out, Match{EntryID: entry.ID, Segment: segment, Start: start, End: end, Confidence: confidence, value: value})
	}
	return out
}

// hasContext looks for a context word just before or after a match. The window is
// cut from the original text and lowercased on its own, fully (context words are
// stored lowercased the same way), so a non-ASCII capital such as "MÜLLER" still
// matches "müller" without disturbing any offset.
func hasContext(text string, start, end int, words []string) bool {
	from := start - 96
	if from < 0 {
		from = 0
	}
	to := end + 48
	if to > len(text) {
		to = len(text)
	}
	window := strings.ToLower(text[from:to])
	for _, word := range words {
		if strings.Contains(window, word) {
			return true
		}
	}
	return false
}

// dedupeOverlaps keeps one match per overlapping span: the more confident one, then
// the longer one. Two entries reading the same digits must not count twice.
func dedupeOverlaps(matches []Match) []Match {
	sort.SliceStable(matches, func(i, j int) bool {
		if matches[i].Segment != matches[j].Segment {
			return matches[i].Segment < matches[j].Segment
		}
		if matches[i].Start != matches[j].Start {
			return matches[i].Start < matches[j].Start
		}
		return matches[i].End > matches[j].End
	})
	out := []Match{}
	for _, m := range matches {
		if n := len(out); n > 0 && out[n-1].Segment == m.Segment && m.Start < out[n-1].End {
			prev := out[n-1]
			if m.Confidence > prev.Confidence || (m.Confidence == prev.Confidence && m.End-m.Start > prev.End-prev.Start) {
				out[n-1] = m
			}
			continue
		}
		out = append(out, m)
	}
	return out
}

// recordMatches keeps the matches that sit in a window holding at least distinct
// different entries.
func recordMatches(matches []Match, distinct, window int) []Match {
	keep := map[int]bool{}
	for i := range matches {
		seen := map[string]bool{}
		members := []int{}
		for j := i; j < len(matches) && matches[j].Segment == matches[i].Segment && matches[j].Start-matches[i].Start <= window; j++ {
			seen[matches[j].EntryID] = true
			members = append(members, j)
		}
		if len(seen) >= distinct {
			for _, j := range members {
				keep[j] = true
			}
		}
	}
	out := []Match{}
	for i, m := range matches {
		if keep[i] {
			out = append(out, m)
		}
	}
	return out
}

// PolicyHit is a policy whose profiles matched.
type PolicyHit struct {
	PolicyID string   `json:"policy_id"`
	Action   Action   `json:"action"`
	Profiles []string `json:"profiles"`
}

// Decision is the outcome of applying the policies of one check.
type Decision struct {
	Check    Check
	Action   Action
	Policies []PolicyHit
	Hits     []ProfileHit
	// Truncated and Oversize describe text beyond the scan limit.
	Truncated bool
	// MaskMatches are the matches a MASK policy asked to replace.
	MaskMatches []Match
	// JoinedMasks are MASK matches found only by reading a group of segments joined
	// (EvaluateParts): Segment is the group, offsets are in the group's joined text.
	JoinedMasks []Match
	groups      [][]int
}

// Matched reports whether any policy matched.
func (d Decision) Matched() bool { return len(d.Policies) > 0 }

// Evaluate scans segments for the policies that inspect check for this caller.
func (e *Engine) Evaluate(check Check, scope Scope, segments []string) Decision {
	decision := Decision{Check: check}
	policies := e.Policies(check, scope)
	if len(policies) == 0 {
		return decision
	}
	profileSet := map[string]bool{}
	profileIDs := []string{}
	for _, p := range policies {
		for _, id := range p.Profiles {
			if !profileSet[id] {
				profileSet[id] = true
				profileIDs = append(profileIDs, id)
			}
		}
	}
	result := e.Scan(segments, profileIDs)
	decision.Truncated = result.Truncated
	hitProfiles := map[string]bool{}
	for _, p := range policies {
		matched := []string{}
		for _, id := range p.Profiles {
			if hit, ok := result.Hit(id); ok {
				matched = append(matched, id)
				if !hitProfiles[id] {
					hitProfiles[id] = true
					decision.Hits = append(decision.Hits, hit)
				}
				if p.Action == ActionMask {
					decision.MaskMatches = append(decision.MaskMatches, hit.Matches...)
				}
			}
		}
		if len(matched) > 0 {
			decision.Policies = append(decision.Policies, PolicyHit{PolicyID: p.ID, Action: p.Action, Profiles: matched})
			decision.Action = Stronger(decision.Action, p.Action)
		}
	}
	if result.Truncated && e.cfg.Oversize == "block" {
		decision.Action = ActionBlock
		decision.Policies = append(decision.Policies, PolicyHit{PolicyID: "scan-limit", Action: ActionBlock, Profiles: []string{}})
	}
	return decision
}

// Mask replaces the given matches in segments with their entries' mask labels.
func (e *Engine) Mask(segments []string, matches []Match) []string {
	if len(matches) == 0 {
		return segments
	}
	bySegment := map[int][]Match{}
	for _, m := range matches {
		bySegment[m.Segment] = append(bySegment[m.Segment], m)
	}
	out := append([]string(nil), segments...)
	for index, list := range bySegment {
		if index >= len(out) {
			continue
		}
		list = maskSpans(list)
		text := out[index]
		var b strings.Builder
		cursor := 0
		for _, m := range list {
			if m.Start < cursor || m.End > len(text) {
				continue
			}
			b.WriteString(text[cursor:m.Start])
			b.WriteString(e.maskLabel(m.EntryID))
			cursor = m.End
		}
		b.WriteString(text[cursor:])
		out[index] = b.String()
	}
	return out
}

// Redact replaces in text every value the given profiles recognise at their
// configured confidence. It leaves out the match-count and record thresholds on
// purpose: it is for storage, once a profile has triggered on the request or answer
// as a whole, and then each recognised value is masked wherever it sits — including
// in a single stored prompt that, on its own, would not have reached the threshold.
func (e *Engine) Redact(text string, profileIDs []string) string {
	if e == nil || text == "" || len(profileIDs) == 0 {
		return text
	}
	matches := e.recognise(text, profileIDs)
	if len(matches) == 0 {
		return text
	}
	return e.Mask([]string{text}, matches)[0]
}

// recognise returns what the given profiles recognise in text at their configured
// confidence, as matches of segment 0.
func (e *Engine) recognise(text string, profileIDs []string) []Match {
	lower := asciiLower(text)
	matches := []Match{}
	for _, id := range profileIDs {
		profile := e.profiles[id]
		if profile == nil {
			continue
		}
		for _, entry := range profile.entries {
			for _, m := range entry.find(0, text, lower) {
				if m.Confidence >= profile.minConfidence {
					matches = append(matches, m)
				}
			}
		}
	}
	return matches
}

// RedactParts is Redact over texts a model reads as one (the messages of a
// request): each is redacted, and a value split between two of them is redacted
// whole, its label in the part where it starts.
func (e *Engine) RedactParts(parts []string, profileIDs []string) []string {
	if e == nil || len(profileIDs) == 0 || len(parts) == 0 {
		return parts
	}
	offsets := partOffsets(parts)
	all := []Match{}
	for i, part := range parts {
		if part == "" {
			continue
		}
		for _, m := range e.recognise(part, profileIDs) {
			m.Start += offsets[i]
			m.End += offsets[i]
			all = append(all, m)
		}
	}
	if len(parts) > 1 {
		all = append(all, e.recognise(strings.Join(parts, ""), profileIDs)...)
	}
	if len(all) == 0 {
		return parts
	}
	return e.MaskJoined(parts, all)
}

func partOffsets(parts []string) []int {
	offsets := make([]int, len(parts))
	total := 0
	for i, part := range parts {
		offsets[i] = total
		total += len(part)
	}
	return offsets
}

// EvaluateParts is Evaluate for request text whose pieces a model reads as one:
// the content parts of a message, and consecutive messages of one role (groups,
// as segment indices in order). Each segment is read on its own, and each group is
// also read joined; from the joined read only values that span a boundary between
// two of its segments are added ("900101-" + "1234561"). A context word in one
// piece does not raise a match in another, and nothing is joined across groups,
// so text that is clean piece by piece is not blocked for what its neighbours say.
// Mask what it decides with MaskParts.
func (e *Engine) EvaluateParts(check Check, scope Scope, parts []string, groups [][]int) Decision {
	decision := e.Evaluate(check, scope, parts)
	decision.groups = groups
	if len(groups) == 0 || len(e.Policies(check, scope)) == 0 {
		return decision
	}
	for g, group := range groups {
		texts := make([]string, 0, len(group))
		for _, index := range group {
			if index >= 0 && index < len(parts) {
				texts = append(texts, parts[index])
			}
		}
		if len(texts) < 2 || len(texts) != len(group) {
			continue
		}
		offsets := partOffsets(texts)
		spans := func(m Match) bool {
			for _, at := range offsets[1:] {
				if m.Start < at && m.End > at {
					return true
				}
			}
			return false
		}
		joined := e.Evaluate(check, scope, []string{strings.Join(texts, "")})
		if !joined.Matched() {
			continue
		}
		profiles := map[string]bool{}
		for _, hit := range joined.Hits {
			matches := []Match{}
			for _, m := range hit.Matches {
				if spans(m) {
					m.Segment = g
					matches = append(matches, m)
				}
			}
			if len(matches) == 0 {
				continue
			}
			profiles[hit.ProfileID] = true
			merged := false
			for i := range decision.Hits {
				if decision.Hits[i].ProfileID == hit.ProfileID {
					decision.Hits[i].Matches = append(decision.Hits[i].Matches, matches...)
					merged = true
				}
			}
			if !merged {
				decision.Hits = append(decision.Hits, ProfileHit{ProfileID: hit.ProfileID, Matches: matches})
			}
		}
		if len(profiles) == 0 {
			continue
		}
		for _, m := range joined.MaskMatches {
			if spans(m) {
				m.Segment = g
				decision.JoinedMasks = append(decision.JoinedMasks, m)
			}
		}
		for _, p := range joined.Policies {
			kept := []string{}
			for _, id := range p.Profiles {
				if profiles[id] {
					kept = append(kept, id)
				}
			}
			if len(kept) == 0 {
				continue
			}
			decision.Action = Stronger(decision.Action, p.Action)
			found := false
			for i := range decision.Policies {
				if decision.Policies[i].PolicyID == p.PolicyID {
					found = true
					for _, id := range kept {
						if !containsString(decision.Policies[i].Profiles, id) {
							decision.Policies[i].Profiles = append(decision.Policies[i].Profiles, id)
						}
					}
				}
			}
			if !found {
				decision.Policies = append(decision.Policies, PolicyHit{PolicyID: p.PolicyID, Action: p.Action, Profiles: kept})
			}
		}
	}
	return decision
}

// MaskParts applies a decision from EvaluateParts: values inside one part and
// values split across the parts of a group are both replaced, each label where its
// value starts.
func (e *Engine) MaskParts(parts []string, decision Decision) []string {
	out := e.Mask(parts, decision.MaskMatches)
	if len(decision.JoinedMasks) == 0 {
		return out
	}
	byGroup := map[int][]Match{}
	for _, m := range decision.JoinedMasks {
		byGroup[m.Segment] = append(byGroup[m.Segment], m)
	}
	for g, joined := range byGroup {
		if g >= len(decision.groups) {
			continue
		}
		group := decision.groups[g]
		texts := make([]string, len(group))
		position := map[int]int{}
		for i, index := range group {
			texts[i] = parts[index]
			position[index] = i
		}
		offsets := partOffsets(texts)
		all := append([]Match(nil), joined...)
		for _, m := range decision.MaskMatches {
			if i, ok := position[m.Segment]; ok {
				m.Start += offsets[i]
				m.End += offsets[i]
				all = append(all, m)
			}
		}
		for i, masked := range e.MaskJoined(texts, all) {
			out[group[i]] = masked
		}
	}
	return out
}

// Without drops from a decision what an earlier decision on the same side already
// found (same entry, same value), and the policies left with nothing. A request
// read again — after context was added, or on an agent's next turn — then records
// and acts on what is new, not twice on what was already handled.
func (d Decision) Without(earlier Decision) Decision {
	known := map[[2]string]bool{}
	for _, hit := range earlier.Hits {
		for _, m := range hit.Matches {
			known[[2]string{m.EntryID, m.value}] = true
		}
	}
	isNew := func(m Match) bool { return !known[[2]string{m.EntryID, m.value}] }
	out := Decision{Check: d.Check, Truncated: d.Truncated}
	profiles := map[string]bool{}
	for _, hit := range d.Hits {
		matches := []Match{}
		for _, m := range hit.Matches {
			if isNew(m) {
				matches = append(matches, m)
			}
		}
		if len(matches) > 0 {
			out.Hits = append(out.Hits, ProfileHit{ProfileID: hit.ProfileID, Matches: matches})
			profiles[hit.ProfileID] = true
		}
	}
	for _, m := range d.MaskMatches {
		if isNew(m) {
			out.MaskMatches = append(out.MaskMatches, m)
		}
	}
	for _, m := range d.JoinedMasks {
		if isNew(m) {
			out.JoinedMasks = append(out.JoinedMasks, m)
		}
	}
	for _, p := range d.Policies {
		if p.PolicyID == "scan-limit" {
			out.Policies = append(out.Policies, p)
			out.Action = Stronger(out.Action, p.Action)
			continue
		}
		kept := []string{}
		for _, id := range p.Profiles {
			if profiles[id] {
				kept = append(kept, id)
			}
		}
		if len(kept) > 0 {
			out.Policies = append(out.Policies, PolicyHit{PolicyID: p.PolicyID, Action: p.Action, Profiles: kept})
			out.Action = Stronger(out.Action, p.Action)
		}
	}
	return out
}

// RedactJSON is Redact over the content strings of a JSON document, keeping it a
// valid document; text that is not JSON is redacted whole.
func (e *Engine) RedactJSON(body string, profileIDs []string) string {
	segments, ok := JSONSegments([]byte(body))
	if !ok {
		return e.Redact(body, profileIDs)
	}
	redacted := e.RedactParts(segments, profileIDs)
	changed := false
	for i := range segments {
		if redacted[i] != segments[i] {
			changed = true
		}
	}
	if !changed {
		return body
	}
	rewritten, err := RewriteJSONSegments([]byte(body), redacted)
	if err != nil {
		return e.Redact(body, profileIDs)
	}
	return string(rewritten)
}

// maskSpans orders matches and joins the ones that overlap into one span, so a
// value two entries both claim is replaced whole. The span keeps the label of the
// more confident (then the longer) match.
func maskSpans(matches []Match) []Match {
	sorted := append([]Match(nil), matches...)
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].Segment != sorted[j].Segment {
			return sorted[i].Segment < sorted[j].Segment
		}
		return sorted[i].Start < sorted[j].Start
	})
	out := []Match{}
	for _, m := range sorted {
		if n := len(out); n > 0 && out[n-1].Segment == m.Segment && m.Start < out[n-1].End {
			prev := &out[n-1]
			if m.Confidence > prev.Confidence || (m.Confidence == prev.Confidence && m.End-m.Start > prev.End-prev.Start) {
				prev.EntryID, prev.Confidence = m.EntryID, m.Confidence
			}
			if m.End > prev.End {
				prev.End = m.End
			}
			continue
		}
		out = append(out, m)
	}
	return out
}

// MaskJoined masks matches that were found in the concatenation of parts — the
// pieces of a streamed answer — and returns the parts with each value replaced in
// the part where it starts and removed from the parts it runs on into. A value the
// provider happened to split across several stream events is masked whole.
func (e *Engine) MaskJoined(parts []string, matches []Match) []string {
	spans := maskSpans(matches)
	out := make([]string, len(parts))
	base := 0
	for i, part := range parts {
		var b strings.Builder
		cursor := 0
		for _, m := range spans {
			start, end := m.Start-base, m.End-base
			if end <= 0 || start >= len(part) {
				continue
			}
			labelHere := start >= 0
			if start < cursor {
				start = cursor
			}
			b.WriteString(part[cursor:start])
			if labelHere {
				b.WriteString(e.maskLabel(m.EntryID))
			}
			if end > len(part) {
				end = len(part)
			}
			if end > cursor {
				cursor = end
			}
		}
		b.WriteString(part[cursor:])
		out[i] = b.String()
		base += len(part)
	}
	return out
}

func (e *Engine) maskLabel(entryID string) string {
	if entry, ok := entryByID[entryID]; ok {
		return entry.mask
	}
	for _, profile := range e.profiles {
		for _, entry := range profile.entries {
			if entry.ID == entryID {
				return entry.mask
			}
		}
	}
	return "[REDACTED]"
}

// EntryName returns the display name of an entry, predefined or custom.
func (e *Engine) EntryName(entryID string) string {
	if entry, ok := entryByID[entryID]; ok {
		return entry.Name
	}
	if e != nil {
		for _, profile := range e.profiles {
			for _, entry := range profile.entries {
				if entry.ID == entryID {
					return entry.Name
				}
			}
		}
	}
	return entryID
}

// ProfileName returns the display name of a profile.
func (e *Engine) ProfileName(profileID string) string {
	if e != nil {
		if p := e.profiles[profileID]; p != nil {
			return p.name
		}
	}
	return profileID
}

func partialMask(value string) string {
	runes := []rune(value)
	n := len(runes)
	if at := strings.IndexRune(value, '@'); at > 0 {
		local := []rune(value[:at])
		domain := value[at+1:]
		dot := strings.LastIndex(domain, ".")
		tld := ""
		if dot >= 0 {
			tld = domain[dot:]
			domain = domain[:dot]
		}
		domainRunes := []rune(domain)
		return fmt.Sprintf("%s•••@%s•••%s (%d자)", string(local[:1]), firstRunes(domainRunes, 1), tld, n)
	}
	digits := 0
	for _, r := range runes {
		if r >= '0' && r <= '9' {
			digits++
		}
	}
	if digits*2 >= n {
		// Numbers (registration, card, account, phone) carry meaning in their leading
		// digits — a birth date, an issuer, an area — so only the last two are shown.
		if n < 8 {
			return fmt.Sprintf("••• (%d자)", n)
		}
		return fmt.Sprintf("•••%s (%d자)", string(runes[n-2:]), n)
	}
	keep := 0
	switch {
	case n >= 12:
		keep = 3
	case n >= 8:
		keep = 2
	case n >= 5:
		keep = 1
	}
	if keep == 0 {
		return fmt.Sprintf("••• (%d자)", n)
	}
	return fmt.Sprintf("%s•••%s (%d자)", string(runes[:keep]), string(runes[n-keep:]), n)
}

func firstRunes(runes []rune, k int) string {
	if len(runes) < k {
		return string(runes)
	}
	return string(runes[:k])
}

// HeaderFinding is one finding in the X-Vibe-DLP / cf-aig-dlp response header,
// in Cloudflare's shape.
type HeaderFinding struct {
	Profile   HeaderProfile `json:"profile"`
	PolicyIDs []string      `json:"policy_ids"`
	Check     Check         `json:"check"`
}

// HeaderProfile is the profile part of a header finding.
type HeaderProfile struct {
	Context   map[string]any `json:"context"`
	EntryIDs  []string       `json:"entry_ids"`
	ProfileID string         `json:"profile_id"`
}

// HeaderValue is the whole header.
type HeaderValue struct {
	Findings []HeaderFinding `json:"findings"`
	Action   Action          `json:"action"`
}

// Header renders decisions as the response header value; ok is false when none matched.
func Header(decisions ...Decision) (string, bool) {
	value := HeaderValue{Findings: []HeaderFinding{}}
	for _, d := range decisions {
		if !d.Matched() {
			continue
		}
		value.Action = Stronger(value.Action, d.Action)
		for _, hit := range d.Hits {
			policies := []string{}
			for _, p := range d.Policies {
				for _, id := range p.Profiles {
					if id == hit.ProfileID {
						policies = append(policies, p.PolicyID)
					}
				}
			}
			value.Findings = append(value.Findings, HeaderFinding{
				Profile:   HeaderProfile{Context: map[string]any{}, EntryIDs: hit.EntryIDs(), ProfileID: hit.ProfileID},
				PolicyIDs: policies,
				Check:     d.Check,
			})
		}
	}
	if value.Action == "" {
		return "", false
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", false
	}
	return string(encoded), true
}

// asciiLower lowercases ASCII letters only. Match offsets found in a text are used to
// slice its lowercased copy, so the copy must keep every byte where it was:
// strings.ToLower shortens some characters (the Kelvin sign K, U+212A, becomes a
// one-byte "k"), which would shift every later offset and could slice out of range.
func asciiLower(s string) string {
	for i := 0; i < len(s); i++ {
		if c := s[i]; c >= 'A' && c <= 'Z' {
			b := []byte(s)
			for j := i; j < len(b); j++ {
				if b[j] >= 'A' && b[j] <= 'Z' {
					b[j] += 'a' - 'A'
				}
			}
			return string(b)
		}
	}
	return s
}
