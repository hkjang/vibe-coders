package proxy

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

type providerPatternSource struct {
	Name          string
	Enabled       bool
	ModelPatterns string
	FailoverGroup string
}

type providerPatternSummary struct {
	ProviderCount         int `json:"provider_count"`
	EnabledProviderCount  int `json:"enabled_provider_count"`
	PatternCount          int `json:"pattern_count"`
	ConflictCount         int `json:"conflict_count"`
	HighConflictCount     int `json:"high_conflict_count"`
	MediumConflictCount   int `json:"medium_conflict_count"`
	AffectedProviderCount int `json:"affected_provider_count"`
	RedundantPatternCount int `json:"redundant_pattern_count"`
	FocusConflictCount    int `json:"focus_conflict_count"`
	// Failover coverage. A provider can only fail over to another provider whose
	// model_patterns overlap its own, so a pattern overlap is simultaneously a
	// routing conflict and the only thing that makes failover possible.
	FailoverReadyProviderCount     int `json:"failover_ready_provider_count"`
	FailoverUncoveredProviderCount int `json:"failover_uncovered_provider_count"`
}

// providerPatternCoverage answers "if this provider goes down, does anything take
// over?" for one provider. FailoverPeers are the providers sharing at least one
// matchable model with it; with none, every request routed here fails hard on 429/5xx.
type providerPatternCoverage struct {
	Provider      string   `json:"provider"`
	Patterns      []string `json:"patterns"`
	FailoverGroup string   `json:"failover_group,omitempty"`
	FailoverPeers []string `json:"failover_peers"`
	FailoverReady bool     `json:"failover_ready"`
	// PeerSource says how redundancy was established: an explicit failover_group, or an
	// incidental pattern overlap. The distinction matters because the second kind can
	// disappear the moment someone edits an unrelated glob.
	PeerSource string `json:"peer_source,omitempty"`
}

type providerPatternCandidate struct {
	Provider string `json:"provider"`
	Pattern  string `json:"pattern"`
}

type providerPatternConflict struct {
	ID               string                     `json:"id"`
	Type             string                     `json:"type"`
	Severity         string                     `json:"severity"`
	Candidates       []providerPatternCandidate `json:"candidates"`
	WitnessModel     string                     `json:"witness_model"`
	SelectedProvider string                     `json:"selected_provider"`
	SelectedPattern  string                     `json:"selected_pattern"`
	DecisionReason   string                     `json:"decision_reason"`
}

type providerPatternRedundancy struct {
	Provider string `json:"provider"`
	Pattern  string `json:"pattern"`
	Reason   string `json:"reason"`
}

type providerPatternRouteMatch struct {
	Provider string   `json:"provider"`
	Patterns []string `json:"patterns"`
}

type providerPatternSimulation struct {
	Model            string                      `json:"model"`
	Matches          []providerPatternRouteMatch `json:"matches"`
	SelectedProvider string                      `json:"selected_provider"`
	SelectedPattern  string                      `json:"selected_pattern,omitempty"`
	RouteReason      string                      `json:"route_reason"`
	Ambiguous        bool                        `json:"ambiguous"`
	// FailoverCandidates mirrors what pipeline.stepUpstream would actually build for
	// this model: every other matching provider, in the same order dialUpstream tries
	// them. Empty means the request has no failover at all.
	FailoverCandidates    []string `json:"failover_candidates"`
	FailoverAvailable     bool     `json:"failover_available"`
	FailoverBlockedReason string   `json:"failover_blocked_reason,omitempty"`
}

type providerPatternResolutionPolicy struct {
	Mode        string   `json:"mode"`
	Order       []string `json:"order"`
	Description string   `json:"description"`
}

type providerPatternAnalysis struct {
	GeneratedAt      string                          `json:"generated_at"`
	FocusProvider    string                          `json:"focus_provider,omitempty"`
	Summary          providerPatternSummary          `json:"summary"`
	Conflicts        []providerPatternConflict       `json:"conflicts"`
	Redundancies     []providerPatternRedundancy     `json:"redundancies"`
	Coverage         []providerPatternCoverage       `json:"coverage"`
	ResolutionPolicy providerPatternResolutionPolicy `json:"resolution_policy"`
	Simulation       *providerPatternSimulation      `json:"simulation,omitempty"`
	// DefaultProvider catches the most common misconfiguration: UPSTREAM_PROVIDER
	// serves everything that matches no pattern, but because failover candidates come
	// only from pattern matches, a default provider with no model_patterns can never
	// be failed over to — nor away from.
	DefaultProvider            string `json:"default_provider,omitempty"`
	DefaultProviderHasPatterns bool   `json:"default_provider_has_patterns"`
}

func (s *Server) handleProviderPatternConflicts(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}

	providers, err := s.db.ListProviders(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "provider_patterns_failed")
		return
	}
	sources := providerPatternSources(providers)
	model := strings.TrimSpace(r.URL.Query().Get("model"))
	focusProvider := ""

	switch r.Method {
	case http.MethodGet:
	case http.MethodPost:
		var payload struct {
			ProviderName  string `json:"provider_name"`
			ModelPatterns string `json:"model_patterns"`
			Enabled       *bool  `json:"enabled"`
			Model         string `json:"model"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		focusProvider = strings.TrimSpace(payload.ProviderName)
		if focusProvider == "" {
			writeOpenAIError(w, http.StatusBadRequest, "provider_name is required", "invalid_request_error", "missing_provider_name")
			return
		}
		model = strings.TrimSpace(payload.Model)
		sources = previewProviderPatternSource(sources, focusProvider, payload.ModelPatterns, payload.Enabled)
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}

	writeJSON(w, http.StatusOK, analyzeProviderPatterns(sources, s.cfg.Upstream.Provider, model, focusProvider))
}

func providerPatternSources(providers []store.ProviderPublic) []providerPatternSource {
	result := make([]providerPatternSource, 0, len(providers))
	for _, provider := range providers {
		result = append(result, providerPatternSource{
			Name:          provider.Name,
			Enabled:       provider.Enabled,
			ModelPatterns: provider.ModelPatterns,
			FailoverGroup: provider.FailoverGroup,
		})
	}
	return result
}

func previewProviderPatternSource(sources []providerPatternSource, name, patterns string, enabled *bool) []providerPatternSource {
	result := append([]providerPatternSource(nil), sources...)
	found := false
	for i := range result {
		if result[i].Name != name {
			continue
		}
		result[i].ModelPatterns = strings.TrimSpace(patterns)
		if enabled != nil {
			result[i].Enabled = *enabled
		}
		found = true
		break
	}
	if !found {
		isEnabled := true
		if enabled != nil {
			isEnabled = *enabled
		}
		result = append(result, providerPatternSource{Name: name, Enabled: isEnabled, ModelPatterns: strings.TrimSpace(patterns)})
	}
	return result
}

func analyzeProviderPatterns(sources []providerPatternSource, defaultProvider, model, focusProvider string) providerPatternAnalysis {
	sortedSources := append([]providerPatternSource(nil), sources...)
	sort.Slice(sortedSources, func(i, j int) bool {
		return sortedSources[i].Name < sortedSources[j].Name
	})

	type patternEntry struct {
		provider string
		pattern  string
	}
	entries := make([]patternEntry, 0)
	redundancies := make([]providerPatternRedundancy, 0)
	order := make([]string, 0, len(sortedSources))
	enabledCount := 0
	for _, source := range sortedSources {
		if !source.Enabled {
			continue
		}
		enabledCount++
		patterns := splitProviderPatterns(source.ModelPatterns)
		if len(patterns) > 0 {
			order = append(order, source.Name)
		}
		seen := map[string]struct{}{}
		for _, pattern := range patterns {
			if _, exists := seen[pattern]; exists {
				redundancies = append(redundancies, providerPatternRedundancy{
					Provider: source.Name,
					Pattern:  pattern,
					Reason:   "duplicate_pattern_in_provider",
				})
				continue
			}
			seen[pattern] = struct{}{}
			entries = append(entries, patternEntry{provider: source.Name, pattern: pattern})
		}
	}

	conflicts := make([]providerPatternConflict, 0)
	affectedProviders := map[string]struct{}{}
	failoverPeers := map[string]map[string]struct{}{}
	highCount := 0
	mediumCount := 0
	focusCount := 0
	for i := 0; i < len(entries); i++ {
		for j := i + 1; j < len(entries); j++ {
			left, right := entries[i], entries[j]
			if left.provider == right.provider {
				continue
			}
			witness, overlaps := globIntersectionWitness(left.pattern, right.pattern)
			if !overlaps {
				continue
			}

			conflictType, severity := "overlapping_pattern", "medium"
			switch {
			case left.pattern == right.pattern:
				conflictType, severity = "duplicate_pattern", "high"
			case left.pattern == "*" || right.pattern == "*":
				conflictType, severity = "catch_all_overlap", "high"
			}
			if severity == "high" {
				highCount++
			} else {
				mediumCount++
			}
			affectedProviders[left.provider] = struct{}{}
			affectedProviders[right.provider] = struct{}{}
			// The same overlap that makes routing ambiguous is what enables failover
			// between these two providers, so record it as mutual coverage.
			if failoverPeers[left.provider] == nil {
				failoverPeers[left.provider] = map[string]struct{}{}
			}
			if failoverPeers[right.provider] == nil {
				failoverPeers[right.provider] = map[string]struct{}{}
			}
			failoverPeers[left.provider][right.provider] = struct{}{}
			failoverPeers[right.provider][left.provider] = struct{}{}
			if focusProvider != "" && (left.provider == focusProvider || right.provider == focusProvider) {
				focusCount++
			}

			candidates := []providerPatternCandidate{
				{Provider: left.provider, Pattern: left.pattern},
				{Provider: right.provider, Pattern: right.pattern},
			}
			witnessRoute := simulateProviderPatternRoute(sortedSources, defaultProvider, witness)
			conflicts = append(conflicts, providerPatternConflict{
				ID:               providerPatternConflictID(left.provider, left.pattern, right.provider, right.pattern),
				Type:             conflictType,
				Severity:         severity,
				Candidates:       candidates,
				WitnessModel:     witness,
				SelectedProvider: witnessRoute.SelectedProvider,
				SelectedPattern:  witnessRoute.SelectedPattern,
				DecisionReason:   "provider_name_ascending",
			})
		}
	}

	// An explicit failover_group is redundancy the operator declared; a pattern overlap
	// is redundancy that merely happens to exist. Group membership is collected first so
	// it can be reported as the stronger of the two.
	groupMembers := map[string][]string{}
	for _, source := range sortedSources {
		if !source.Enabled {
			continue
		}
		if g := strings.TrimSpace(source.FailoverGroup); g != "" {
			groupMembers[g] = append(groupMembers[g], source.Name)
		}
	}

	coverage := make([]providerPatternCoverage, 0, len(sortedSources))
	failoverReadyCount, failoverUncoveredCount := 0, 0
	defaultProviderHasPatterns := false
	for _, source := range sortedSources {
		if !source.Enabled {
			continue
		}
		patterns := splitProviderPatterns(source.ModelPatterns)
		if source.Name == defaultProvider && len(patterns) > 0 {
			defaultProviderHasPatterns = true
		}
		group := strings.TrimSpace(source.FailoverGroup)
		// A provider with no patterns is normally invisible to routing, but one that
		// joined a group is reachable through its peers and belongs in the report.
		if len(patterns) == 0 && group == "" {
			continue
		}

		peerSet := map[string]struct{}{}
		peerSource := ""
		for _, member := range groupMembers[group] {
			if group == "" || member == source.Name {
				continue
			}
			peerSet[member] = struct{}{}
			peerSource = "failover_group"
		}
		for peer := range failoverPeers[source.Name] {
			if _, exists := peerSet[peer]; !exists {
				peerSet[peer] = struct{}{}
				if peerSource == "" {
					peerSource = "pattern_overlap"
				}
			}
		}
		peers := make([]string, 0, len(peerSet))
		for peer := range peerSet {
			peers = append(peers, peer)
		}
		sort.Strings(peers)
		if len(peers) > 0 {
			failoverReadyCount++
		} else {
			failoverUncoveredCount++
		}
		coverage = append(coverage, providerPatternCoverage{
			Provider:      source.Name,
			Patterns:      patterns,
			FailoverGroup: group,
			FailoverPeers: peers,
			FailoverReady: len(peers) > 0,
			PeerSource:    peerSource,
		})
	}

	analysis := providerPatternAnalysis{
		GeneratedAt:   time.Now().UTC().Format(time.RFC3339Nano),
		FocusProvider: focusProvider,
		Summary: providerPatternSummary{
			ProviderCount:                  len(sortedSources),
			EnabledProviderCount:           enabledCount,
			PatternCount:                   len(entries),
			ConflictCount:                  len(conflicts),
			HighConflictCount:              highCount,
			MediumConflictCount:            mediumCount,
			AffectedProviderCount:          len(affectedProviders),
			RedundantPatternCount:          len(redundancies),
			FocusConflictCount:             focusCount,
			FailoverReadyProviderCount:     failoverReadyCount,
			FailoverUncoveredProviderCount: failoverUncoveredCount,
		},
		Conflicts:                  conflicts,
		Redundancies:               redundancies,
		Coverage:                   coverage,
		DefaultProvider:            defaultProvider,
		DefaultProviderHasPatterns: defaultProviderHasPatterns,
		ResolutionPolicy: providerPatternResolutionPolicy{
			Mode:        "provider_name_ascending",
			Order:       order,
			Description: "The first enabled provider by ascending name wins when multiple model patterns match.",
		},
	}
	if strings.TrimSpace(model) != "" {
		analysis.Simulation = simulateProviderPatternRoute(sortedSources, defaultProvider, model)
	}
	return analysis
}

func splitProviderPatterns(raw string) []string {
	parts := strings.Split(raw, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		pattern := canonicalProviderPattern(part)
		if pattern != "" {
			result = append(result, pattern)
		}
	}
	return result
}

func canonicalProviderPattern(raw string) string {
	pattern := strings.ToLower(strings.TrimSpace(raw))
	for strings.Contains(pattern, "**") {
		pattern = strings.ReplaceAll(pattern, "**", "*")
	}
	return pattern
}

func providerPatternConflictID(leftProvider, leftPattern, rightProvider, rightPattern string) string {
	sum := sha256.Sum256([]byte(leftProvider + "\x00" + leftPattern + "\x00" + rightProvider + "\x00" + rightPattern))
	return "ppc_" + hex.EncodeToString(sum[:8])
}

func simulateProviderPatternRoute(sources []providerPatternSource, defaultProvider, model string) *providerPatternSimulation {
	normalizedModel := strings.ToLower(strings.TrimSpace(model))
	matches := make([]providerPatternRouteMatch, 0)
	for _, source := range sources {
		if !source.Enabled {
			continue
		}
		patterns := make([]string, 0)
		for _, pattern := range splitProviderPatterns(source.ModelPatterns) {
			if matchGlob(pattern, normalizedModel) {
				patterns = append(patterns, pattern)
			}
		}
		if len(patterns) > 0 {
			matches = append(matches, providerPatternRouteMatch{Provider: source.Name, Patterns: patterns})
		}
	}

	simulation := &providerPatternSimulation{
		Model:       strings.TrimSpace(model),
		Matches:     matches,
		RouteReason: "default",
	}
	simulation.FailoverCandidates = make([]string, 0)
	if len(matches) == 0 {
		simulation.SelectedProvider = defaultProvider
		// providersForModel only returns pattern matches, so a model that falls through
		// to the default provider has no failover candidates whatsoever.
		simulation.FailoverBlockedReason = "no_pattern_match_default_provider_only"
		return simulation
	}
	simulation.SelectedProvider = matches[0].Provider
	simulation.SelectedPattern = matches[0].Patterns[0]
	simulation.RouteReason = "model_pattern"
	simulation.Ambiguous = len(matches) > 1
	for _, match := range matches[1:] {
		simulation.FailoverCandidates = append(simulation.FailoverCandidates, match.Provider)
	}
	simulation.FailoverAvailable = len(simulation.FailoverCandidates) > 0
	if !simulation.FailoverAvailable {
		simulation.FailoverBlockedReason = "single_matching_provider"
	}
	return simulation
}

// globIntersectionWitness returns a shortest representative model name accepted
// by both of the gateway's '*' globs. It evaluates the same wildcard language as
// matchGlob without relying on a finite list of known model names.
func globIntersectionWitness(left, right string) (string, bool) {
	left = canonicalProviderPattern(left)
	right = canonicalProviderPattern(right)
	if left == "" || right == "" {
		return "", false
	}

	alphabetSet := map[byte]struct{}{'x': {}}
	for i := 0; i < len(left); i++ {
		if left[i] != '*' {
			alphabetSet[left[i]] = struct{}{}
		}
	}
	for i := 0; i < len(right); i++ {
		if right[i] != '*' {
			alphabetSet[right[i]] = struct{}{}
		}
	}
	alphabet := make([]byte, 0, len(alphabetSet))
	for ch := range alphabetSet {
		alphabet = append(alphabet, ch)
	}
	sort.Slice(alphabet, func(i, j int) bool { return alphabet[i] < alphabet[j] })

	type searchNode struct {
		leftStates  []int
		rightStates []int
		witness     string
	}
	start := searchNode{
		leftStates:  globEpsilonClosure(left, []int{0}),
		rightStates: globEpsilonClosure(right, []int{0}),
	}
	queue := []searchNode{start}
	visited := map[string]struct{}{globStatePairKey(start.leftStates, start.rightStates): {}}
	const maxStates = 8192
	const maxWitnessLength = 256

	for head := 0; head < len(queue) && len(visited) <= maxStates; head++ {
		current := queue[head]
		if globAccepts(left, current.leftStates) && globAccepts(right, current.rightStates) {
			witness := current.witness
			if witness == "" {
				witness = "model"
			}
			if matchGlob(left, witness) && matchGlob(right, witness) {
				return witness, true
			}
		}
		if len(current.witness) >= maxWitnessLength {
			continue
		}
		for _, ch := range alphabet {
			nextLeft := globMove(left, current.leftStates, ch)
			if len(nextLeft) == 0 {
				continue
			}
			nextRight := globMove(right, current.rightStates, ch)
			if len(nextRight) == 0 {
				continue
			}
			key := globStatePairKey(nextLeft, nextRight)
			if _, exists := visited[key]; exists {
				continue
			}
			visited[key] = struct{}{}
			queue = append(queue, searchNode{
				leftStates:  nextLeft,
				rightStates: nextRight,
				witness:     current.witness + string(ch),
			})
		}
	}

	for _, candidate := range []string{globExample(left), globExample(right), "model", "gpt-4.1-mini"} {
		if candidate != "" && matchGlob(left, candidate) && matchGlob(right, candidate) {
			return candidate, true
		}
	}
	return "", false
}

func globEpsilonClosure(pattern string, initial []int) []int {
	seen := make([]bool, len(pattern)+1)
	stack := append([]int(nil), initial...)
	for len(stack) > 0 {
		state := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if state < 0 || state > len(pattern) || seen[state] {
			continue
		}
		seen[state] = true
		if state < len(pattern) && pattern[state] == '*' {
			stack = append(stack, state+1)
		}
	}
	result := make([]int, 0, len(pattern)+1)
	for state, exists := range seen {
		if exists {
			result = append(result, state)
		}
	}
	return result
}

func globMove(pattern string, states []int, ch byte) []int {
	next := make([]int, 0, len(states))
	for _, state := range states {
		if state >= len(pattern) {
			continue
		}
		switch pattern[state] {
		case '*':
			next = append(next, state)
		case ch:
			next = append(next, state+1)
		}
	}
	if len(next) == 0 {
		return nil
	}
	return globEpsilonClosure(pattern, next)
}

func globAccepts(pattern string, states []int) bool {
	for _, state := range states {
		if state == len(pattern) {
			return true
		}
	}
	return false
}

func globStatePairKey(left, right []int) string {
	var key strings.Builder
	for _, state := range left {
		key.WriteString(strconv.Itoa(state))
		key.WriteByte(',')
	}
	key.WriteByte('|')
	for _, state := range right {
		key.WriteString(strconv.Itoa(state))
		key.WriteByte(',')
	}
	return key.String()
}

func globExample(pattern string) string {
	var result strings.Builder
	star := false
	for i := 0; i < len(pattern); i++ {
		if pattern[i] == '*' {
			if !star {
				result.WriteByte('x')
				star = true
			}
			continue
		}
		star = false
		result.WriteByte(pattern[i])
	}
	return result.String()
}
