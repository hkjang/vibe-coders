package proxy

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"vibe-coders/internal/store"
	"vibe-coders/internal/workintel"
)

// Trend signals, automation candidates and insights.
//
// All three are computed from the aggregates and from counts of repeated
// request fingerprints. Nothing here reads a prompt: a candidate's title is
// built from the names of its category and action, and an insight sentence
// from numbers that are stored next to it as its evidence.
//
// The periodic step of the worker (and POST /insights/run) stores one
// generation of candidates and insights for the whole organisation. A
// team-scoped administrator never reads that generation: their signals and
// insights are computed from their own team's aggregates when they ask.

const (
	// workIntelSignalDays is the long window of the trend detection, and how far
	// back repeated patterns are counted.
	workIntelSignalDays = 30
	// workIntelFirstSeenLookback bounds the read that decides when a category
	// was first used.
	workIntelFirstSeenLookback = 180
	// workIntelPatternMinRepeats is how often a fingerprint must repeat within a
	// category before it is worth a look, and workIntelPatternLimit how many
	// patterns one generation keeps.
	workIntelPatternMinRepeats = 5
	workIntelPatternLimit      = 200

	// The kinds of the model-mix insights of workintel.BuildInsights.
	workIntelInsightModelMix  = "model_mix"
	workIntelInsightModelCost = "model_cost"

	workIntelInsightMetaID   = "_generation"
	workIntelInsightMetaKind = "_meta"
	// workIntelInsightLLMMarker opens the system prompt of an insight rewrite.
	workIntelInsightLLMMarker = "업무 활용 인사이트 문장 다듬기"
	workIntelInsightMaxRunes  = 400
	// workIntelInsightLLMBudget bounds the whole rewrite of one generation. The
	// generation runs inside a worker cycle; a slow model must not hold the
	// cycle, so insights it did not get to keep their original sentences.
	workIntelInsightLLMBudget = 45 * time.Second
)

// workIntelGenerateMu keeps two generations (the worker's and one asked for by
// an administrator) from interleaving their reads and writes.
var workIntelGenerateMu sync.Mutex

// ---- Trend signals ----

type workSignalView struct {
	Kind          string                `json:"kind"`
	Category      workintel.CategoryRef `json:"category"`
	Team          string                `json:"team"`
	Model         string                `json:"model"`
	Current       float64               `json:"current"`
	Previous      float64               `json:"previous"`
	ChangeAbs     float64               `json:"change_abs"`
	ChangeRate    *float64              `json:"change_rate"`
	UsersCurrent  *int64                `json:"users_current"`
	UsersPrevious *int64                `json:"users_previous"`
	Sample        int64                 `json:"sample"`
	Note          string                `json:"note"`
}

type workTrendsResponse struct {
	Scope      workIntelScope             `json:"scope"`
	Signals    []workSignalView           `json:"signals"`
	Thresholds workintel.SignalThresholds `json:"thresholds"`
}

// workSignalPopulation is how many distinct users stand behind each signal:
// per category the users of the windows compared (current and previous thirty
// days, current and previous seven), and in the last thirty days per category
// and team and per category and model. It is only read for a caller refused
// small groups.
type workSignalPopulation struct {
	categories map[string][4]int64
	teams      map[[2]string]int64
	models     map[[2]string]int64
}

// visible reports whether a signal rests on groups the caller may be told
// about: every window it compares has no users or enough of them.
func (p workSignalPopulation) visible(q *workIntelReadQuery, signal workintel.Signal) bool {
	if q.caller.privileged {
		return true
	}
	users := p.categories[signal.CategoryID]
	if q.small(users[0]) || q.small(users[1]) {
		return false
	}
	// A concentration signal states the category's total and one part of it;
	// the rest is every other team (model) of the category together, so none
	// of them may be a small group either.
	anySmall := func(parts map[[2]string]int64) bool {
		for key, n := range parts {
			if key[0] == signal.CategoryID && q.small(n) {
				return true
			}
		}
		return false
	}
	switch signal.Kind {
	case workintel.SignalRising7d:
		return !q.small(users[2]) && !q.small(users[3])
	case workintel.SignalTeamConcentrated:
		return !anySmall(p.teams)
	case workintel.SignalModelDependence:
		return !anySmall(p.models)
	}
	return true
}

// signals returns the trend signals of the thirty days ending on to that the
// caller may be shown, and the input they were detected in.
func (q *workIntelReadQuery) signals(ctx context.Context, to string) ([]workintel.Signal, workintel.SignalInput, error) {
	input, population, err := q.signalInput(ctx, to)
	if err != nil {
		return nil, input, err
	}
	detected := workintel.DetectSignals(input, workintel.DefaultSignalThresholds())
	out := make([]workintel.Signal, 0, len(detected))
	for _, signal := range detected {
		if population.visible(q, signal) {
			out = append(out, signal)
		}
	}
	return out, input, nil
}

// signalInput builds what the trend detection compares, for the windows
// ending on the day to: seven and thirty days against the seven and thirty
// before them, per category as it is reported now, in the selected metric.
func (q *workIntelReadQuery) signalInput(ctx context.Context, to string) (workintel.SignalInput, workSignalPopulation, error) {
	input := workintel.SignalInput{WindowStart: workIntelShiftDay(to, -(workIntelSignalDays - 1)), Series: []workintel.CategorySeries{}}
	population := workSignalPopulation{categories: map[string][4]int64{}, teams: map[[2]string]int64{}, models: map[[2]string]int64{}}
	first, err := q.usedIDs(ctx, workIntelShiftDay(to, -(workIntelFirstSeenLookback-1)), to)
	if err != nil || len(first) == 0 {
		return input, population, err
	}
	fold := map[string]string{}
	firstSeen := map[string]string{}
	for id, day := range first {
		canonical := q.engine.Canonical(id)
		fold[id] = canonical
		if known, ok := firstSeen[canonical]; !ok || day < known {
			firstSeen[canonical] = day
		}
	}
	window := func(from, to string) store.WorkFilter {
		f := q.base
		f.From, f.To = from, to
		if q.category != "" {
			f.Categories = workIntelFoldIDs(fold, nil)
		}
		return f
	}
	byCategory := store.WorkGroup{Dims: []store.WorkDim{store.WorkDimCategory}, Fold: fold}
	measure := func(from, to string, need workNeed) (map[string]workCell, error) {
		cells, err := q.s.workIntelMeasure(ctx, window(from, to), byCategory, need)
		out := make(map[string]workCell, len(cells))
		for key, cell := range cells {
			out[key.Category] = *cell
		}
		return out, err
	}
	// The thirty-day windows always need users (a signal reports them); the
	// seven-day ones what the metric is made of, and the users wherever the
	// caller may be refused a small group.
	long := workNeed{sessions: q.metric == "sessions", users: true}
	current30, err := measure(input.WindowStart, to, long)
	if err != nil {
		return input, population, err
	}
	previous30, err := measure(workIntelShiftDay(to, -(2*workIntelSignalDays-1)), workIntelShiftDay(to, -workIntelSignalDays), long)
	if err != nil {
		return input, population, err
	}
	current7, err := measure(workIntelShiftDay(to, -6), to, q.need(q.metric))
	if err != nil {
		return input, population, err
	}
	previous7, err := measure(workIntelShiftDay(to, -13), workIntelShiftDay(to, -7), q.need(q.metric))
	if err != nil {
		return input, population, err
	}

	// How a category's requests split over teams and models. Requests are used
	// for the split whatever the metric: a share of requests is what "N of M
	// requests came from one team" states.
	split := func(from, to string, dim store.WorkDim) (map[string]map[string]float64, error) {
		sums, err := q.s.db.WorkSums(ctx, window(from, to), store.WorkGroup{Dims: []store.WorkDim{store.WorkDimCategory, dim}, Fold: fold})
		out := map[string]map[string]float64{}
		for _, sum := range sums {
			name := sum.Team
			if dim == store.WorkDimModel {
				name = sum.Model
			}
			if out[sum.Category] == nil {
				out[sum.Category] = map[string]float64{}
			}
			out[sum.Category][name] += float64(sum.Requests)
		}
		return out, err
	}
	teams, err := split(input.WindowStart, to, store.WorkDimTeam)
	if err != nil {
		return input, population, err
	}
	models, err := split(input.WindowStart, to, store.WorkDimModel)
	if err != nil {
		return input, population, err
	}
	teamsBefore, err := split(workIntelShiftDay(to, -(2*workIntelSignalDays-1)), workIntelShiftDay(to, -workIntelSignalDays), store.WorkDimTeam)
	if err != nil {
		return input, population, err
	}
	activeTeams := map[string]bool{}
	for _, byTeam := range teams {
		for team := range byTeam {
			activeTeams[team] = true
		}
	}
	input.TotalTeams = len(activeTeams)

	categories := map[string]bool{}
	for _, cells := range []map[string]workCell{current30, previous30, current7, previous7} {
		for category := range cells {
			categories[category] = true
		}
	}
	ids := make([]string, 0, len(categories))
	for category := range categories {
		ids = append(ids, category)
	}
	sort.Strings(ids)
	users := func(cell workCell) int64 {
		if q.small(cell.Users) {
			// Negative means "not to be stated" to the detection.
			return -1
		}
		return cell.Users
	}
	if !q.caller.privileged {
		for _, id := range ids {
			population.categories[id] = [4]int64{current30[id].Users, previous30[id].Users, current7[id].Users, previous7[id].Users}
		}
		for _, dim := range []store.WorkDim{store.WorkDimTeam, store.WorkDimModel} {
			counts, err := q.s.db.WorkUserCounts(ctx, window(input.WindowStart, to), store.WorkGroup{Dims: []store.WorkDim{store.WorkDimCategory, dim}, Fold: fold})
			if err != nil {
				return input, population, err
			}
			for _, count := range counts {
				if dim == store.WorkDimTeam {
					population.teams[[2]string{count.Category, count.Team}] = count.Count
				} else {
					population.models[[2]string{count.Category, count.Model}] = count.Count
				}
			}
		}
	}
	for _, id := range ids {
		now, before := current30[id], previous30[id]
		input.Series = append(input.Series, workintel.CategorySeries{
			CategoryID: id,
			Current7:   q.value(current7[id]), Previous7: q.value(previous7[id]),
			Current30: q.value(now), Previous30: q.value(before),
			UsersCurrent: users(now), UsersPrevious: users(before),
			CostCurrent: now.CostKRW, CostPrevious: before.CostKRW,
			RequestsCurrent: now.Requests, RequestsPrevious: before.Requests,
			FirstSeenDay: firstSeen[id],
			TeamValues:   teams[id], ModelValues: models[id],
			TeamsCurrent: len(teams[id]), TeamsPrevious: len(teamsBefore[id]),
		})
	}
	return input, population, nil
}

func (q *workIntelReadQuery) signalViews(signals []workintel.Signal) []workSignalView {
	out := make([]workSignalView, 0, len(signals))
	for _, signal := range signals {
		out = append(out, workSignalView{
			Kind: signal.Kind, Category: q.engine.Ref(signal.CategoryID), Team: signal.Team, Model: signal.Model,
			Current: workIntelRound(signal.Current), Previous: workIntelRound(signal.Previous), ChangeAbs: workIntelRound(signal.ChangeAbs),
			ChangeRate: signal.ChangeRate, UsersCurrent: signal.UsersCurrent, UsersPrevious: signal.UsersPrevious,
			Sample: signal.Sample, Note: signal.Note,
		})
	}
	return out
}

func (s *Server) handleWorkIntelTrends(w http.ResponseWriter, r *http.Request, _ string) {
	q, ok := s.workIntelAnalytics(w, r, workIntelQueryOptions{})
	if !ok {
		return
	}
	signals, _, err := q.signals(r.Context(), q.to)
	if err != nil {
		workIntelFailed(w, r, "the trend signals", err)
		return
	}
	writeJSON(w, http.StatusOK, workTrendsResponse{Scope: q.scope, Signals: q.signalViews(signals), Thresholds: workintel.DefaultSignalThresholds()})
}

// ---- Automation candidates ----

// workCandidatePayload is what a generation stores about one repeated
// pattern: counts only, overall and per team. The per-team split is what lets
// a team-scoped administrator be shown their own team's numbers and nothing
// of the others'.
type workCandidatePayload struct {
	CategoryID        string                   `json:"category_id"`
	ActionType        string                   `json:"action_type"`
	PeriodFrom        string                   `json:"period_from"`
	PeriodTo          string                   `json:"period_to"`
	WindowDays        int64                    `json:"window_days"`
	Total             store.WorkPatternStats   `json:"total"`
	Teams             []store.WorkPatternStats `json:"teams"`
	Tools             []string                 `json:"tools"`
	SameToolSequence  int64                    `json:"same_tool_sequence"`
	HourConcentration float64                  `json:"hour_concentration"`
}

type workAutomationEffect struct {
	Basis           string   `json:"basis"`
	EstMinutesSaved *float64 `json:"est_minutes_saved"`
	EstCostSavedKRW *float64 `json:"est_cost_saved_krw"`
}

type workAutomationView struct {
	ID            string                `json:"id"`
	Title         string                `json:"title"`
	Category      workintel.CategoryRef `json:"category"`
	Teams         []string              `json:"teams"`
	Repeats       int64                 `json:"repeats"`
	Users         *int64                `json:"users"`
	Sessions      int64                 `json:"sessions"`
	CostKRW       float64               `json:"cost_krw"`
	AvgLatencyMS  float64               `json:"avg_latency_ms"`
	Recommended   string                `json:"recommended"`
	Feasibility   float64               `json:"feasibility"`
	MCPTools      []string              `json:"mcp_tools"`
	Risk          string                `json:"risk"`
	NeedsApproval bool                  `json:"needs_approval"`
	Effect        workAutomationEffect  `json:"effect"`
	ReviewStatus  string                `json:"review_status"`
	ComputedAt    string                `json:"computed_at"`
}

type workAutomationResponse struct {
	Scope workIntelScope       `json:"scope"`
	Rows  []workAutomationView `json:"rows"`
	Count int                  `json:"count"`
}

// workIntelCandidateID identifies a pattern across generations, so a review
// decision stays with it.
func workIntelCandidateID(fingerprint, categoryID string) string {
	sum := sha256.Sum256([]byte(fingerprint + "\x00" + categoryID))
	return "auto_" + hex.EncodeToString(sum[:])[:20]
}

// candidateTitle names a pattern by its category and action. The prompt is
// never part of it.
func (q *workIntelReadQuery) candidateTitle(categoryID, action string) string {
	title := q.engine.Ref(categoryID).Name
	if name := q.engine.ActionName(action); name != "" && action != workintel.UnknownAction {
		title += " · " + name
	}
	return title + " 반복 요청"
}

// candidateStats returns a pattern's counts as far as the caller may see
// them: everything, or the sum over the teams they are confined to (and, with
// a team filter, over that team). ok is false when nothing of it is theirs.
// For a caller refused small groups, the part of a team with too few users is
// left out of the teams and of the counts; otherwise the pattern's numbers
// less one team's (read with ?team=) would be that small team's. users is the
// distinct-user count the small-group rule is applied to: the exact one, or
// for several teams the largest of theirs, because a user with keys in two
// teams is counted in both and the sum could pass the minimum when the people
// do not.
func (q *workIntelReadQuery) candidateStats(payload workCandidatePayload) (stats store.WorkPatternStats, teams []string, users int64, ok bool) {
	restricted := q.base.TeamScoped || len(q.base.Teams) > 0
	allowed := func(team string) bool {
		if !restricted {
			return true
		}
		for _, own := range q.base.Teams {
			if own == team {
				return true
			}
		}
		return false
	}
	teams = []string{}
	dropped := false
	for _, team := range payload.Teams {
		if !allowed(team.Team) {
			continue
		}
		if q.small(team.Users) {
			dropped = true
			continue
		}
		teams = append(teams, team.Team)
		stats.Repeats += team.Repeats
		stats.Users += team.Users
		stats.Sessions += team.Sessions
		stats.MCPCalls += team.MCPCalls
		stats.LatencyMS += team.LatencyMS
		stats.CostKRW += team.CostKRW
		stats.Flagged += team.Flagged
		if team.ActiveDays > stats.ActiveDays {
			stats.ActiveDays = team.ActiveDays
		}
		if team.Users > users {
			users = team.Users
		}
	}
	if len(teams) == 0 {
		return stats, teams, 0, false
	}
	if !restricted && !dropped {
		// The overall counts are exact; the per-team sum would count a user who
		// has keys in two teams twice.
		stats = payload.Total
		users = payload.Total.Users
	} else if len(teams) == 1 {
		users = stats.Users
	}
	return stats, teams, users, true
}

// workCandidateShape is how a pattern is done: its usual action, the tools it
// calls, how often it calls the same set of them and how much of it falls in
// one hour of the day.
type workCandidateShape struct {
	action            string
	tools             []string
	sameSequence      int64
	hourConcentration float64
}

// candidateShape describes the pattern by the requests of the given teams.
// When those are all of its teams the stored description is used. Otherwise
// it is rebuilt from the teams' own counts, so nothing of another team's
// requests is shown; a generation stored before those counts were kept has
// none, and the description is then withheld.
func workIntelCandidateShape(payload workCandidatePayload, teams []string) workCandidateShape {
	if len(teams) == len(payload.Teams) {
		return workCandidateShape{action: payload.ActionType, tools: payload.Tools, sameSequence: payload.SameToolSequence,
			hourConcentration: payload.HourConcentration}
	}
	mine := map[string]bool{}
	for _, team := range teams {
		mine[team] = true
	}
	actions, sigs, hours := map[string]int64{}, map[string]int64{}, map[string]int64{}
	var repeats int64
	for _, team := range payload.Teams {
		if !mine[team.Team] {
			continue
		}
		if team.Actions == nil {
			return workCandidateShape{action: workintel.UnknownAction, tools: []string{}}
		}
		repeats += team.Repeats
		for value, n := range team.Actions {
			actions[value] += n
		}
		for value, n := range team.ToolSigs {
			sigs[value] += n
		}
		for value, n := range team.Hours {
			hours[value] += n
		}
	}
	largest := func(counts map[string]int64) (string, int64) {
		best, bestN := "", int64(0)
		for value, n := range counts {
			if n > bestN || (n == bestN && value < best) {
				best, bestN = value, n
			}
		}
		return best, bestN
	}
	shape := workCandidateShape{tools: []string{}}
	shape.action, _ = largest(actions)
	_, shape.sameSequence = largest(sigs)
	if _, busiest := largest(hours); repeats > 0 {
		shape.hourConcentration = float64(busiest) / float64(repeats)
	}
	uses := map[string]int64{}
	for sig, n := range sigs {
		for _, tool := range strings.Split(sig, ",") {
			if tool = strings.TrimSpace(tool); tool != "" {
				uses[tool] += n
			}
		}
	}
	for tool := range uses {
		shape.tools = append(shape.tools, tool)
	}
	sort.Slice(shape.tools, func(i, j int) bool {
		if uses[shape.tools[i]] != uses[shape.tools[j]] {
			return uses[shape.tools[i]] > uses[shape.tools[j]]
		}
		return shape.tools[i] < shape.tools[j]
	})
	return shape
}

// candidateView presents a stored candidate to the caller. A caller refused
// small groups is not shown a pattern of too few users at all: its title,
// repeats, sessions and cost would describe those users.
func (q *workIntelReadQuery) candidateView(row store.WorkAutomationCandidate) (workAutomationView, store.WorkPatternStats, bool) {
	var payload workCandidatePayload
	if err := json.Unmarshal([]byte(row.PayloadJSON), &payload); err != nil || payload.CategoryID == "" {
		return workAutomationView{}, store.WorkPatternStats{}, false
	}
	category := q.engine.Canonical(payload.CategoryID)
	if !q.under(payload.CategoryID, q.category) {
		return workAutomationView{}, store.WorkPatternStats{}, false
	}
	stats, teams, users, ok := q.candidateStats(payload)
	if !ok || stats.Repeats == 0 || q.small(users) {
		return workAutomationView{}, stats, false
	}
	shape := workIntelCandidateShape(payload, teams)
	// The regularity of the pattern's tool calls is counted over the teams the
	// caller sees, as the volumes are.
	score := workintel.ScoreAutomation(workintel.PatternStats{
		CategoryID: category, TopCategoryID: workIntelTopOf(category), ActionType: shape.action,
		Repeats: stats.Repeats, Users: stats.Users, Sessions: stats.Sessions, ActiveDays: stats.ActiveDays, WindowDays: payload.WindowDays,
		HourConcentration: shape.hourConcentration, MCPCalls: stats.MCPCalls, MCPTools: shape.tools,
		SameToolSequence: shape.sameSequence, Sensitive: stats.Flagged > 0,
	})
	tools := score.MCPTools
	if tools == nil {
		tools = []string{}
	}
	view := workAutomationView{
		ID: row.ID, Title: q.candidateTitle(category, shape.action), Category: q.engine.Ref(category), Teams: teams,
		Repeats: stats.Repeats, Users: q.userCount(stats.Users), Sessions: stats.Sessions, CostKRW: workIntelRound(stats.CostKRW),
		AvgLatencyMS: workIntelRound(float64(stats.LatencyMS) / float64(stats.Repeats)),
		Recommended:  score.Recommended, Feasibility: score.Feasibility, MCPTools: tools, Risk: score.Risk, NeedsApproval: score.NeedsApproval,
		Effect: q.candidateEffect(category, stats), ReviewStatus: row.ReviewStatus, ComputedAt: row.ComputedAt,
	}
	if view.ReviewStatus == "" {
		view.ReviewStatus = store.WorkReviewNew
	}
	return view, stats, true
}

// candidateEffect estimates what the repeated work has been worth, from the
// policy's baseline for the category. Without a baseline there is no estimate.
func (q *workIntelReadQuery) candidateEffect(category string, stats store.WorkPatternStats) workAutomationEffect {
	baseline := q.engine.BaselineFor(category)
	if baseline == nil {
		return workAutomationEffect{Basis: "이 업무의 기준값(수작업·AI 활용 소요 시간)이 등록되지 않아 효과를 추정하지 않습니다."}
	}
	perSession := baseline.ManualMinutes - baseline.AIMinutes
	if baseline.ManualMinutes <= 0 || baseline.AIMinutes < 0 || perSession <= 0 {
		return workAutomationEffect{Basis: "기준값에서 AI 활용 시간이 수작업 시간보다 짧지 않아 효과를 추정하지 않습니다."}
	}
	sessions := stats.Sessions
	if sessions == 0 {
		// Requests without a session id: each repeat is taken as one piece of work.
		sessions = stats.Repeats
	}
	minutes := perSession * float64(sessions)
	effect := workAutomationEffect{EstMinutesSaved: &minutes, Basis: fmt.Sprintf(
		"기준값(수작업 %s분 → AI 활용 %s분)을 반복된 작업 %d건에 적용한 추정치입니다. 작업이 실제로 끝났는지는 확인되지 않은 값입니다.",
		strconv.FormatFloat(baseline.ManualMinutes, 'f', -1, 64), strconv.FormatFloat(baseline.AIMinutes, 'f', -1, 64), sessions)}
	if baseline.HourlyCostKRW > 0 {
		cost := workIntelRound(minutes / 60 * baseline.HourlyCostKRW)
		effect.EstCostSavedKRW = &cost
	}
	return effect
}

// candidates returns the stored candidates as the caller may see them, most
// feasible first.
func (q *workIntelReadQuery) candidates(ctx context.Context) ([]workAutomationView, []store.WorkPatternStats, error) {
	rows, err := q.s.db.ListWorkAutomationCandidates(ctx)
	if err != nil {
		return nil, nil, err
	}
	type entry struct {
		view  workAutomationView
		stats store.WorkPatternStats
	}
	entries := make([]entry, 0, len(rows))
	for _, row := range rows {
		if view, stats, ok := q.candidateView(row); ok {
			entries = append(entries, entry{view, stats})
		}
	}
	sort.Slice(entries, func(i, j int) bool {
		a, b := entries[i].view, entries[j].view
		if a.Feasibility != b.Feasibility {
			return a.Feasibility > b.Feasibility
		}
		if a.Repeats != b.Repeats {
			return a.Repeats > b.Repeats
		}
		return a.ID < b.ID
	})
	views := make([]workAutomationView, len(entries))
	stats := make([]store.WorkPatternStats, len(entries))
	for i, e := range entries {
		views[i], stats[i] = e.view, e.stats
	}
	return views, stats, nil
}

// workIntelCandidateCount is the number of candidates the caller can see that
// have not been dismissed.
func (s *Server) workIntelCandidateCount(ctx context.Context, caller workIntelCaller) (int, error) {
	q, err := s.workIntelPresenterFor(ctx, caller)
	if err != nil {
		return 0, err
	}
	views, _, err := q.candidates(ctx)
	count := 0
	for _, view := range views {
		if view.ReviewStatus != store.WorkReviewDismissed {
			count++
		}
	}
	return count, err
}

var workIntelReviewStates = []string{store.WorkReviewNew, store.WorkReviewReviewing, store.WorkReviewAccepted, store.WorkReviewDismissed}

func (s *Server) handleWorkIntelAutomation(w http.ResponseWriter, r *http.Request, _ string) {
	q, ok := s.workIntelAnalytics(w, r, workIntelQueryOptions{statusIsReview: true})
	if !ok {
		return
	}
	status, err := workIntelOneOf(r, "status", workIntelReviewStates, 32)
	if err != nil {
		workIntelError(w, http.StatusBadRequest, "work_intel_invalid_query", err.Error())
		return
	}
	views, _, err := q.candidates(r.Context())
	if err != nil {
		workIntelFailed(w, r, "the automation candidates", err)
		return
	}
	out := workAutomationResponse{Scope: q.scope, Rows: []workAutomationView{}}
	for _, view := range views {
		if status != "" && view.ReviewStatus != status {
			continue
		}
		if out.Count >= q.offset && len(out.Rows) < q.limit {
			out.Rows = append(out.Rows, view)
		}
		out.Count++
	}
	writeJSON(w, http.StatusOK, out)
}

// handleWorkIntelAutomationReview records what an administrator decided about
// a candidate. That is all it does: nothing is registered, scheduled or run.
func (s *Server) handleWorkIntelAutomationReview(w http.ResponseWriter, r *http.Request, id string) {
	q, ok := s.workIntelPresenter(w, r)
	if !ok {
		return
	}
	var payload struct {
		ReviewStatus string `json:"review_status"`
		Note         string `json:"note"`
	}
	if !workIntelDecode(w, r, &payload) {
		return
	}
	note, fits := workIntelClip(payload.Note, 1000)
	if !workIntelHasStatus(workIntelReviewStates, payload.ReviewStatus) || !fits {
		workIntelError(w, http.StatusBadRequest, "work_intel_invalid_body", "review_status must be new, reviewing, accepted or dismissed, and note at most 1,000 characters")
		return
	}
	ctx := r.Context()
	before, found, err := s.db.GetWorkAutomationCandidate(ctx, id)
	if err != nil {
		workIntelFailed(w, r, "the automation candidate", err)
		return
	}
	// A candidate that holds nothing of the caller's teams does not exist for them.
	if _, _, visible := q.candidateView(before); !found || !visible {
		workIntelError(w, http.StatusNotFound, "work_automation_not_found", "no such automation candidate")
		return
	}
	// A review decision is one for every team that repeats the pattern, so a
	// team-scoped administrator may only decide about a pattern of their own
	// teams.
	if q.caller.scoped {
		var payload workCandidatePayload
		_ = json.Unmarshal([]byte(before.PayloadJSON), &payload)
		for _, team := range payload.Teams {
			if !q.caller.allows(team.Team) {
				workIntelError(w, http.StatusForbidden, "work_intel_team_forbidden",
					"this candidate is repeated in other teams as well; only an administrator of every team may review it")
				return
			}
		}
	}
	after, found, err := s.db.SetWorkAutomationReview(ctx, id, payload.ReviewStatus, note, q.caller.actor)
	if err != nil || !found {
		if err == nil {
			err = errors.New("the candidate was replaced by a new generation")
		}
		workIntelFailed(w, r, "recording the review", err)
		return
	}
	s.auditAdmin(r, "work_intel.automation.review",
		auditJSON(map[string]any{"id": id, "review_status": before.ReviewStatus}),
		auditJSON(map[string]any{"id": id, "review_status": after.ReviewStatus, "note": note}))
	view, _, _ := q.candidateView(after)
	writeJSON(w, http.StatusOK, view)
}

// ---- Insights ----

type workInsightView struct {
	ID        string                    `json:"id"`
	Kind      string                    `json:"kind"`
	Severity  string                    `json:"severity"`
	Title     string                    `json:"title"`
	Body      string                    `json:"body"`
	Evidence  workintel.InsightEvidence `json:"evidence"`
	Link      map[string]string         `json:"link"`
	CreatedAt string                    `json:"created_at"`
}

type workInsightsResponse struct {
	Scope       workIntelScope    `json:"scope"`
	Rows        []workInsightView `json:"rows"`
	GeneratedAt string            `json:"generated_at"`
	LLMUsed     bool              `json:"llm_used"`
}

type workInsightMeta struct {
	LLMUsed    bool `json:"llm_used"`
	Insights   int  `json:"insights"`
	Candidates int  `json:"candidates"`
}

// insightsFor computes the insights of the caller's own scope from the
// aggregates: the signals of the thirty days ending on to, which models carry
// the requests, and the candidates the caller can see.
//
// For a caller refused small groups, an insight about too few users is not
// made: the signals are the ones that caller may see, the candidates already
// leave such patterns out, and an insight about a model, or about the whole
// window, is dropped when its users are too few.
func (q *workIntelReadQuery) insightsFor(ctx context.Context, to string, candidates []workAutomationView, stats []store.WorkPatternStats) ([]workintel.Insight, error) {
	signals, input, err := q.signals(ctx, to)
	if err != nil {
		return nil, err
	}
	thresholds := workintel.DefaultSignalThresholds()
	from := workIntelShiftDay(to, -(workIntelSignalDays - 1))
	in := workintel.InsightInput{
		Period:        from + "~" + to,
		Compare:       workIntelShiftDay(to, -(2*workIntelSignalDays-1)) + "~" + workIntelShiftDay(to, -workIntelSignalDays),
		CategoryNames: map[string]string{}, Signals: signals, Thresholds: thresholds,
	}
	for _, series := range input.Series {
		in.CategoryNames[series.CategoryID] = q.engine.Ref(series.CategoryID).Name
	}
	window := q.base
	window.From, window.To = from, to
	if q.category != "" {
		if window, err = q.filter(ctx, from, to); err != nil {
			return nil, err
		}
	}
	models, err := q.s.db.WorkSums(ctx, window, store.WorkGroup{Dims: []store.WorkDim{store.WorkDimModel}})
	if err != nil {
		return nil, err
	}
	for _, model := range models {
		in.Models = append(in.Models, workintel.ModelUsage{Model: model.Model, Requests: model.Requests, CostKRW: model.CostKRW})
	}
	for i, candidate := range candidates {
		// An insight sentence states how many people repeat a request, so a
		// pattern of fewer people than may be shown is not turned into one.
		if stats[i].Users < int64(q.minGroup) || candidate.ReviewStatus == store.WorkReviewDismissed {
			continue
		}
		in.CategoryNames[candidate.Category.ID] = candidate.Category.Name
		in.Automation = append(in.Automation, workintel.AutomationSummary{
			ID: candidate.ID, Title: candidate.Title, CategoryID: candidate.Category.ID, Repeats: stats[i].Repeats, Users: stats[i].Users,
			Recommended: candidate.Recommended, Feasibility: candidate.Feasibility, Risk: candidate.Risk,
		})
	}
	insights := workintel.BuildInsights(in)
	if q.caller.privileged || len(insights) == 0 {
		return insights, nil
	}
	whole, err := q.s.workIntelMeasureOne(ctx, window)
	if err != nil {
		return nil, err
	}
	if q.small(whole.Users) {
		return []workintel.Insight{}, nil
	}
	counts, err := q.s.db.WorkUserCounts(ctx, window, store.WorkGroup{Dims: []store.WorkDim{store.WorkDimModel}})
	if err != nil {
		return nil, err
	}
	modelUsers := map[string]int64{}
	for _, count := range counts {
		modelUsers[count.Model] = count.Count
	}
	// An insight about the model mix states one model's part of the whole
	// window; the rest is every other model, so none may be a small group.
	smallModel := false
	for _, n := range modelUsers {
		smallModel = smallModel || q.small(n)
	}
	kept := insights[:0]
	for _, insight := range insights {
		if model := insight.Link["model"]; model != "" && q.small(modelUsers[model]) {
			continue
		}
		if smallModel && (insight.Kind == workIntelInsightModelMix || insight.Kind == workIntelInsightModelCost) {
			continue
		}
		kept = append(kept, insight)
	}
	return kept, nil
}

func workIntelInsightID(index int, insight workintel.Insight) string {
	sum := sha256.Sum256([]byte(insight.Kind + "\x00" + insight.Link["category"] + "\x00" + insight.Link["team"] + "\x00" +
		insight.Link["model"] + "\x00" + insight.Link["candidate"]))
	// The position leads so that reading by id returns the insights as ranked.
	return fmt.Sprintf("ins-%03d-%s", index, hex.EncodeToString(sum[:])[:10])
}

func workIntelInsightViews(insights []workintel.Insight, createdAt string) []workInsightView {
	out := make([]workInsightView, 0, len(insights))
	for i, insight := range insights {
		link := insight.Link
		if link == nil {
			link = map[string]string{}
		}
		if insight.Evidence.Metrics == nil {
			insight.Evidence.Metrics = map[string]float64{}
		}
		out = append(out, workInsightView{ID: workIntelInsightID(i, insight), Kind: insight.Kind, Severity: insight.Severity,
			Title: insight.Title, Body: insight.Body, Evidence: insight.Evidence, Link: link, CreatedAt: createdAt})
	}
	return out
}

func (s *Server) handleWorkIntelInsights(w http.ResponseWriter, r *http.Request, _ string) {
	q, ok := s.workIntelAnalytics(w, r, workIntelQueryOptions{})
	if !ok {
		return
	}
	ctx := r.Context()
	out := workInsightsResponse{Scope: q.scope, Rows: []workInsightView{}}
	// A caller confined to teams, or asking about one team or category, gets
	// insights computed for exactly that; the stored generation describes the
	// whole organisation. So does a caller refused small groups: the stored
	// generation was made by a caller who may see everything.
	if q.base.TeamScoped || len(q.base.Teams) > 0 || q.category != "" || !q.caller.privileged {
		candidates, stats, err := q.candidates(ctx)
		if err == nil {
			var insights []workintel.Insight
			if insights, err = q.insightsFor(ctx, q.to, candidates, stats); err == nil {
				out.GeneratedAt = time.Now().UTC().Format(time.RFC3339)
				out.Rows = workIntelInsightViews(insights, out.GeneratedAt)
			}
		}
		if err != nil {
			workIntelFailed(w, r, "the insights", err)
			return
		}
		writeJSON(w, http.StatusOK, out)
		return
	}
	rows, err := s.db.ListWorkInsights(ctx)
	if err != nil {
		workIntelFailed(w, r, "the insights", err)
		return
	}
	for _, row := range rows {
		if row.Kind == workIntelInsightMetaKind {
			var meta workInsightMeta
			_ = json.Unmarshal([]byte(row.EvidenceJSON), &meta)
			out.GeneratedAt, out.LLMUsed = row.CreatedAt, meta.LLMUsed
			continue
		}
		view := workInsightView{ID: row.ID, Kind: row.Kind, Severity: row.Severity, Title: row.Title, Body: row.Body,
			Link: map[string]string{}, CreatedAt: row.CreatedAt}
		_ = json.Unmarshal([]byte(row.EvidenceJSON), &view.Evidence)
		_ = json.Unmarshal([]byte(row.LinkJSON), &view.Link)
		if view.Evidence.Metrics == nil {
			view.Evidence.Metrics = map[string]float64{}
		}
		out.Rows = append(out.Rows, view)
	}
	writeJSON(w, http.StatusOK, out)
}

// ---- Generation ----

type workIntelGeneration struct {
	Insights    int
	Candidates  int
	GeneratedAt string
	LLMUsed     bool
}

// workIntelGenerate computes one generation of automation candidates and
// insights for the whole organisation and stores it in place of the previous
// one. It reads aggregates and fingerprint counts only.
func (s *Server) workIntelGenerate(ctx context.Context) (workIntelGeneration, error) {
	workIntelGenerateMu.Lock()
	defer workIntelGenerateMu.Unlock()
	var out workIntelGeneration
	// The generation speaks for everyone, so it is built as a caller who may
	// see everything; what a particular reader may see is decided when it is read.
	q, err := s.workIntelPresenterFor(ctx, workIntelCaller{privileged: true, actor: "system"})
	if err != nil {
		return out, fmt.Errorf("load work policy: %w", err)
	}
	now := time.Now()
	to := store.WorkIntelDay(now)
	from := workIntelShiftDay(to, -(workIntelSignalDays - 1))

	patterns, err := s.db.WorkPatterns(ctx, from, to, workIntelPatternMinRepeats, workIntelPatternLimit)
	if err != nil {
		return out, fmt.Errorf("read repeated patterns: %w", err)
	}
	// A pattern that was already a candidate keeps what was decided about it.
	existing, err := s.db.ListWorkAutomationCandidates(ctx)
	if err != nil {
		return out, fmt.Errorf("read the stored candidates: %w", err)
	}
	decided := make(map[string]string, len(existing))
	for _, candidate := range existing {
		decided[candidate.ID] = candidate.ReviewStatus
	}
	stored := make([]store.WorkAutomationCandidate, 0, len(patterns))
	for _, pattern := range patterns {
		payload, err := json.Marshal(workCandidatePayload{
			CategoryID: pattern.CategoryID, ActionType: pattern.ActionType, PeriodFrom: from, PeriodTo: to, WindowDays: workIntelSignalDays,
			Total: pattern.Total, Teams: pattern.Teams, Tools: pattern.Tools,
			SameToolSequence: pattern.SameToolSequence, HourConcentration: pattern.HourConcentration,
		})
		if err != nil {
			return out, err
		}
		candidate := store.WorkAutomationCandidate{ID: workIntelCandidateID(pattern.Fingerprint, pattern.CategoryID),
			PayloadJSON: string(payload), ReviewStatus: store.WorkReviewNew}
		if status := decided[candidate.ID]; status != "" {
			candidate.ReviewStatus = status
		}
		stored = append(stored, candidate)
	}
	// Scored through the same view a reader gets, so an insight and the
	// candidate it points at agree.
	var views []workAutomationView
	var stats []store.WorkPatternStats
	for _, candidate := range stored {
		if view, stat, ok := q.candidateView(candidate); ok {
			views, stats = append(views, view), append(stats, stat)
		}
	}
	insights, err := q.insightsFor(ctx, to, views, stats)
	if err != nil {
		return out, fmt.Errorf("compute insights: %w", err)
	}
	if conf := s.workIntelConf(); conf.InsightLLMEnabled && len(insights) > 0 {
		out.LLMUsed = s.workIntelRewriteInsights(ctx, conf, insights)
	}

	out.GeneratedAt = now.UTC().Format("2006-01-02T15:04:05.000000000Z")
	rows := make([]store.WorkInsightRow, 0, len(insights)+1)
	meta, _ := json.Marshal(workInsightMeta{LLMUsed: out.LLMUsed, Insights: len(insights), Candidates: len(stored)})
	rows = append(rows, store.WorkInsightRow{ID: workIntelInsightMetaID, Kind: workIntelInsightMetaKind, Severity: workintel.SeverityInfo,
		EvidenceJSON: string(meta), LinkJSON: "{}", PeriodFrom: from, PeriodTo: to})
	for _, view := range workIntelInsightViews(insights, out.GeneratedAt) {
		evidence, err := json.Marshal(view.Evidence)
		if err != nil {
			return out, err
		}
		link, err := json.Marshal(view.Link)
		if err != nil {
			return out, err
		}
		rows = append(rows, store.WorkInsightRow{ID: view.ID, Kind: view.Kind, Severity: view.Severity, Title: view.Title, Body: view.Body,
			EvidenceJSON: string(evidence), LinkJSON: string(link), PeriodFrom: from, PeriodTo: to})
	}
	if err := s.db.ReplaceWorkGeneration(ctx, now, stored, rows); err != nil {
		return out, fmt.Errorf("store the generation: %w", err)
	}
	out.Insights, out.Candidates = len(insights), len(stored)
	return out, nil
}

func (s *Server) handleWorkIntelInsightsRun(w http.ResponseWriter, r *http.Request, _ string) {
	caller, ok := s.workIntelCallerOf(w, r)
	if !ok || !caller.requireGlobal(w) {
		return
	}
	generation, err := s.workIntelGenerate(r.Context())
	if err != nil {
		workIntelFailed(w, r, "generating insights", err)
		return
	}
	s.auditAdmin(r, "work_intel.insights.run", "", auditJSON(map[string]any{
		"insights": generation.Insights, "candidates": generation.Candidates, "llm_used": generation.LLMUsed, "generated_at": generation.GeneratedAt}))
	writeJSON(w, http.StatusOK, map[string]any{"generated": generation.Insights, "generated_at": generation.GeneratedAt,
		"candidates": generation.Candidates, "llm_used": generation.LLMUsed})
}

// ---- Optional rewrite of the insight sentences ----

var workIntelNumberRe = regexp.MustCompile(`[0-9]+(?:[.,][0-9]+)*`)

// workIntelNumbers returns the numbers written in a text, without grouping
// separators and without trailing zeros of a fraction, so "1,200" and "1200"
// or "12.50" and "12.5" are the same number.
func workIntelNumbers(text string) []string {
	out := []string{}
	for _, raw := range workIntelNumberRe.FindAllString(text, -1) {
		value := raw
		// A comma is a grouping separator when three digits follow each one.
		if strings.Contains(value, ",") {
			parts := strings.Split(value, ",")
			grouped := true
			for _, part := range parts[1:] {
				if len(strings.SplitN(part, ".", 2)[0]) != 3 {
					grouped = false
				}
			}
			if grouped {
				value = strings.ReplaceAll(value, ",", "")
			}
		}
		if strings.Contains(value, ".") && !strings.Contains(value, ",") {
			value = strings.TrimRight(strings.TrimRight(value, "0"), ".")
		}
		out = append(out, value)
	}
	return out
}

// workIntelSameNumbers reports whether two texts state the same numbers in
// the same order.
func workIntelSameNumbers(original, rewritten string) bool {
	want, got := workIntelNumbers(original), workIntelNumbers(rewritten)
	if len(want) != len(got) {
		return false
	}
	for i := range want {
		if want[i] != got[i] {
			return false
		}
	}
	return true
}

// workIntelInsightRewriteOK accepts a rewritten sentence only when its title
// and its body each state exactly the numbers of the sentence they replace, in
// the same order. Membership in the evidence is not enough: a model that
// swaps the current and the previous figure, or takes "2026" from a date for
// a count, has not polished the sentence, it has changed what it claims. A
// rewrite may reorder words, not numbers.
func workIntelInsightRewriteOK(insight workintel.Insight, title, body string) bool {
	if strings.TrimSpace(title) == "" || strings.TrimSpace(body) == "" ||
		utf8.RuneCountInString(title) > workIntelInsightMaxRunes || utf8.RuneCountInString(body) > workIntelInsightMaxRunes {
		return false
	}
	return workIntelSameNumbers(insight.Title, title) && workIntelSameNumbers(insight.Body, body)
}

// workIntelRewriteInsights asks the configured model to reword each insight.
// The model is given the insight's kind, its two sentences and its evidence:
// aggregates only, never a prompt. A rewrite is kept only when it passes the
// number check and the redaction that every model-written label goes
// through; otherwise the original sentence stays. It reports whether any
// rewrite was kept.
func (s *Server) workIntelRewriteInsights(ctx context.Context, conf workIntelConfig, insights []workintel.Insight) bool {
	target, block := s.workIntelLLMTargetFor(ctx, conf)
	if block != nil {
		slog.Info("work intel: insight sentences were not rewritten", "reason", block.Code)
		return false
	}
	redact := s.workIntelRedactor(ctx)
	used := false
	deadline := time.Now().Add(workIntelInsightLLMBudget)
	for i := range insights {
		remaining := time.Until(deadline)
		if ctx.Err() != nil || remaining <= 0 {
			break
		}
		timeout := conf.LLMTimeout
		if timeout <= 0 || timeout > remaining {
			timeout = remaining
		}
		request, err := json.Marshal(map[string]any{
			"kind": insights[i].Kind, "severity": insights[i].Severity, "title": insights[i].Title, "body": insights[i].Body,
			"evidence": insights[i].Evidence,
		})
		if err != nil {
			continue
		}
		system := workIntelInsightLLMMarker + "\n" +
			"주어진 인사이트의 제목(title)과 본문(body)을 같은 뜻의 자연스러운 한국어 문장으로 다듬으세요.\n" +
			"title과 body에 나오는 수치는 각각 원래 문장과 같은 값을 같은 순서로 쓰고, 수치를 빼거나 더하거나 바꾸지 마세요. 새로운 사실, 원인 추측, 사람 이름을 덧붙이지 마세요.\n" +
			`다른 설명 없이 {"title": "...", "body": "..."} 형식의 JSON 객체 하나만 답하세요.`
		content, err := s.workIntelLLMChat(ctx, target, system, string(request), timeout)
		if err != nil {
			// A model that is down is not asked about every remaining insight.
			slog.Warn("work intel: rewriting insight sentences failed", "error", boundedWorkIntelError(err))
			break
		}
		var rewritten struct {
			Title string `json:"title"`
			Body  string `json:"body"`
		}
		if start, end := strings.IndexByte(content, '{'), strings.LastIndexByte(content, '}'); start < 0 || end <= start ||
			json.Unmarshal([]byte(content[start:end+1]), &rewritten) != nil {
			continue
		}
		title, body := strings.TrimSpace(redact(rewritten.Title)), strings.TrimSpace(redact(rewritten.Body))
		if !workIntelInsightRewriteOK(insights[i], title, body) {
			continue
		}
		insights[i].Title, insights[i].Body = title, body
		used = true
	}
	return used
}

// workIntelLLMChat sends one system and one user message to the
// classification model and returns the text of its answer. Like the
// classification call it does not go through the proxy pipeline.
func (s *Server) workIntelLLMChat(ctx context.Context, target workIntelLLMTarget, system, user string, timeout time.Duration) (string, error) {
	if timeout <= 0 {
		timeout = defaultWorkIntelConfig().LLMTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	body, err := json.Marshal(map[string]any{
		"model": target.model, "stream": false,
		"messages": []map[string]string{{"role": "system", "content": system}, {"role": "user", "content": user}},
	})
	if err != nil {
		return "", errors.New(governanceRunErrRequestEncoding)
	}
	upstreamURL, err := s.upstreamURL(target.provider.BaseURL, &url.URL{Path: "/v1/chat/completions"})
	if err != nil {
		return "", errors.New(governanceRunErrUpstreamURL)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, upstreamURL, bytes.NewReader(body))
	if err != nil {
		return "", errors.New(governanceRunErrRequestBuild)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+target.provider.APIKey)
	req.Header.Set("X-Request-ID", newID("trace"))
	resp, err := s.workIntelLLMClient().Do(req)
	if err != nil {
		// The transport error can quote the provider URL; only its kind is kept.
		if ctx.Err() != nil || fallbackReasonForError(err) == "timeout" {
			return "", errors.New(governanceRunErrTimeout)
		}
		return "", errors.New(governanceRunErrTransport)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, workIntelLLMMaxResponseBytes))
	if err != nil {
		return "", errors.New(governanceRunErrResponseRead)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("%s (%d)", governanceRunErrStatus, resp.StatusCode)
	}
	return extractChatContent(raw), nil
}
