package proxy

import (
	"encoding/json"
	"sort"
)

// Small-group protection of the work analytics.
//
// It is a display safeguard: no number shown in one response, or recoverable
// from a simple pair of reads of the same endpoint, may describe 1 to
// min_group_size-1 people to a caller who may not see raw prompts
// (workIntelCaller.privileged is false). Solving systems of rows and columns
// across endpoints is not defended against; those callers can open individual
// requests anyway. Two rules decide what is withheld:
//
//   - Primary: a group of 1 to min_group_size-1 distinct users is withheld,
//     with every other measure of the same group and everything derived from
//     it (shares, deltas, ratios). A group with no users stays visible as zero.
//   - Complementary: numbers shown next to a total the caller can also see (a
//     category row next to the level's total, a matrix cell next to its row
//     and column totals, a trend point next to the bucket's total, a flow link
//     next to its node) form a line. Total minus what is shown is the sum of
//     the withheld members, and two small members can be the same person. So a
//     line with a primarily withheld member is settled only when its withheld
//     members include one of at least min_group_size users, or its total is
//     withheld itself; until then the next shown member is withheld as well.
//     The next member is the one of fewest users, then fewest requests, then
//     by id: never by the metric a chart is drawn in, which would let two
//     reads with different metrics withhold different members.
//
// workGuard runs both rules over the entries a response is made of. Entries
// that the response does not show but the caller can read elsewhere (the
// organisation total next to the team rows, a category's total next to its
// matrix column) take part in their lines: they count as withheld when they
// are small, and they are never picked to be withheld here.

// workGuardEntry is one number of a response, or one the caller can read
// elsewhere.
type workGuardEntry struct {
	key      string
	users    int64
	requests int64
	// active is whether the group measured anything at all.
	active bool
	// shown entries belong to this response and can be withheld in it.
	shown bool
	// small is the primary rule's verdict; withheld includes the complementary one.
	small    bool
	withheld bool
}

// workGuardLine is a total and the members that add up to it.
type workGuardLine struct {
	total   *workGuardEntry
	members []*workGuardEntry
}

// workGuard holds the entries and lines of one response. A guard with min 0
// withholds nothing: that is the guard of a privileged caller.
type workGuard struct {
	min     int64
	entries []*workGuardEntry
	lines   []workGuardLine
}

// guard returns the guard of the caller.
func (q *workIntelReadQuery) guard() *workGuard {
	if q.caller.privileged {
		return &workGuard{}
	}
	return &workGuard{min: int64(q.minGroup)}
}

// enabled reports whether the guard withholds anything at all.
func (g *workGuard) enabled() bool { return g.min > 1 }

// add registers a number measured over users distinct users and requests
// requests.
func (g *workGuard) add(key string, users, requests int64, active, shown bool) *workGuardEntry {
	e := &workGuardEntry{key: key, users: users, requests: requests, active: active, shown: shown}
	e.small = g.enabled() && active && users < g.min
	e.withheld = e.small
	g.entries = append(g.entries, e)
	return e
}

// cell registers a measured group.
func (g *workGuard) cell(key string, c workCell, shown bool) *workGuardEntry {
	return g.add(key, c.Users, c.Requests, c.Requests > 0 || c.Users > 0, shown)
}

// line declares members that are shown together and add up to total, which
// the caller can see in this response or elsewhere. A nil total is one the
// caller cannot see.
func (g *workGuard) line(total *workGuardEntry, members ...*workGuardEntry) {
	kept := make([]*workGuardEntry, 0, len(members))
	for _, e := range members {
		if e != nil {
			kept = append(kept, e)
		}
	}
	if len(kept) > 0 {
		g.lines = append(g.lines, workGuardLine{total: total, members: kept})
	}
}

// settled reports whether what is withheld of a line cannot be told apart by
// subtraction as a group of too few users.
func (l workGuardLine) settled(min int64) bool {
	small, strong := false, false
	for _, e := range l.members {
		small = small || e.small
		strong = strong || (e.withheld && e.users >= min)
	}
	return !small || strong || l.total == nil || l.total.withheld
}

// settle applies the complementary rule until every line is settled or has
// no member left to withhold. It ends: every step withholds one more entry.
func (g *workGuard) settle() {
	if !g.enabled() {
		return
	}
	for changed := true; changed; {
		changed = false
		for _, line := range g.lines {
			if line.settled(g.min) {
				continue
			}
			var pick *workGuardEntry
			for _, e := range line.members {
				if e.withheld || !e.shown || !e.active {
					continue
				}
				if pick == nil || e.users < pick.users || (e.users == pick.users && (e.requests < pick.requests ||
					(e.requests == pick.requests && e.key < pick.key))) {
					pick = e
				}
			}
			if pick != nil {
				pick.withheld = true
				changed = true
			}
		}
	}
}

// out reports whether an entry is withheld; a missing entry is not.
func (e *workGuardEntry) out() bool { return e != nil && e.withheld }

// workIntelShownFirst orders keys for display: the shown ones by the given
// order, then the withheld ones by key alone, so the position of a withheld
// row says nothing about its size.
func workIntelShownFirst(keys []string, withheld func(string) bool, less func(a, b string) bool) {
	sort.SliceStable(keys, func(i, j int) bool {
		a, b := keys[i], keys[j]
		if wa, wb := withheld(a), withheld(b); wa != wb {
			return wb
		} else if wa {
			return a < b
		}
		return less(a, b)
	})
}

// ---- Wire forms of withheld numbers ----

// workMetricsJSON is the Metrics object as it is sent: a withheld group has
// every measure null.
type workMetricsJSON struct {
	Sessions   *int64   `json:"sessions"`
	Requests   *int64   `json:"requests"`
	Users      *int64   `json:"users"`
	Tokens     *int64   `json:"tokens"`
	CostKRW    *float64 `json:"cost_krw"`
	MCPCalls   *int64   `json:"mcp_calls"`
	Suppressed bool     `json:"suppressed"`
}

func (m workMetrics) wire() workMetricsJSON {
	if m.Suppressed {
		return workMetricsJSON{Suppressed: true}
	}
	return workMetricsJSON{Sessions: &m.Sessions, Requests: &m.Requests, Users: m.Users, Tokens: &m.Tokens, CostKRW: &m.CostKRW, MCPCalls: &m.MCPCalls}
}

func (m workMetrics) MarshalJSON() ([]byte, error) { return json.Marshal(m.wire()) }

// MarshalJSON sends a withheld period of the overview with its measures and
// the numbers derived from them null; the number of teams and of automation
// candidates are not measures of the group.
func (m workOverviewMetrics) MarshalJSON() ([]byte, error) {
	out := struct {
		workMetricsJSON
		Teams                int      `json:"teams"`
		ActiveCategories     *int     `json:"active_categories"`
		ClassifiedRate       *float64 `json:"classified_rate"`
		NewCategories        *int     `json:"new_categories"`
		AutomationCandidates int      `json:"automation_candidates"`
	}{workMetricsJSON: m.workMetrics.wire(), Teams: m.Teams, AutomationCandidates: m.AutomationCandidates}
	if !m.Suppressed {
		out.ActiveCategories, out.ClassifiedRate, out.NewCategories = &m.ActiveCategories, &m.ClassifiedRate, &m.NewCategories
	}
	return json.Marshal(out)
}

// MarshalJSON sends a withheld model row with every measure and rate null.
func (row workModelRow) MarshalJSON() ([]byte, error) {
	type plain workModelRow
	if !row.Suppressed {
		return json.Marshal(plain(row))
	}
	return json.Marshal(struct {
		Category         any      `json:"category"`
		Model            string   `json:"model"`
		Provider         string   `json:"provider"`
		Requests         *int64   `json:"requests"`
		Sessions         *int64   `json:"sessions"`
		Share            *float64 `json:"share"`
		TokensPerSession *float64 `json:"tokens_per_session"`
		CostPerSession   *float64 `json:"cost_per_session"`
		LatencyP50MS     *float64 `json:"latency_p50_ms"`
		LatencyP95MS     *float64 `json:"latency_p95_ms"`
		ErrorRate        *float64 `json:"error_rate"`
		RetryRate        *float64 `json:"retry_rate"`
		ModelSwitchRate  *float64 `json:"model_switch_rate"`
		FeedbackPositive *int64   `json:"feedback_positive"`
		FeedbackNegative *int64   `json:"feedback_negative"`
		LowSample        bool     `json:"low_sample"`
		Suppressed       bool     `json:"suppressed"`
	}{Category: row.Category, Model: row.Model, Provider: row.Provider, Suppressed: true})
}

// MarshalJSON sends a withheld productivity row with its counts null.
func (row workProductivityRow) MarshalJSON() ([]byte, error) {
	type plain workProductivityRow
	if !row.Suppressed {
		return json.Marshal(plain(row))
	}
	return json.Marshal(struct {
		Category          any      `json:"category"`
		Sessions          *int64   `json:"sessions"`
		ConfirmedSessions *int64   `json:"confirmed_sessions"`
		ModelTimeMS       *int64   `json:"model_time_ms"`
		Baseline          any      `json:"baseline"`
		EstMinutesSaved   *float64 `json:"est_minutes_saved"`
		EstCostSavedKRW   *float64 `json:"est_cost_saved_krw"`
		Reason            string   `json:"reason"`
		Suppressed        bool     `json:"suppressed"`
	}{Category: row.Category, Baseline: row.Baseline, Reason: row.Reason, Suppressed: true})
}
