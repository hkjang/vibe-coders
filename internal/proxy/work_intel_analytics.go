package proxy

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"vibe-coders/internal/store"
	"vibe-coders/internal/workintel"
)

// The aggregate reads of work intelligence: overview, categories, trend,
// matrix, flow, teams, models and productivity. Each has a compute function
// that returns the response, so the CSV export renders exactly what the JSON
// read returns.

// ---- Overview ----

// workOverviewMetrics is a period of the overview. A withheld period (its
// users are too few to show) is sent with its measures, active and new
// categories and classified rate null.
type workOverviewMetrics struct {
	workMetrics
	Teams                int     `json:"teams"`
	ActiveCategories     int     `json:"active_categories"`
	ClassifiedRate       float64 `json:"classified_rate"`
	NewCategories        int     `json:"new_categories"`
	AutomationCandidates int     `json:"automation_candidates"`
}

type workConfidenceCount struct {
	Bucket   string `json:"bucket"`
	Requests int64  `json:"requests"`
}

type workMethodCount struct {
	Method   string `json:"method"`
	Requests int64  `json:"requests"`
}

type workStatusCount struct {
	Status   string `json:"status"`
	Requests int64  `json:"requests"`
}

type workOverviewResponse struct {
	Scope      workIntelScope        `json:"scope"`
	Current    workOverviewMetrics   `json:"current"`
	Previous   *workOverviewMetrics  `json:"previous"`
	GrowthRate *float64              `json:"growth_rate"`
	Confidence []workConfidenceCount `json:"confidence"`
	Methods    []workMethodCount     `json:"methods"`
	Statuses   []workStatusCount     `json:"statuses"`
}

// workIntelNewCategoryLookback is how far before a period a category must be
// absent to count as new in it. It bounds the read that decides it.
const workIntelNewCategoryLookback = 90

// overviewPeriod measures one period for the overview.
func (q *workIntelReadQuery) overviewPeriod(ctx context.Context, from, to string, candidates int) (workOverviewMetrics, workCell, error) {
	var out workOverviewMetrics
	f, err := q.filter(ctx, from, to)
	if err != nil {
		return out, workCell{}, err
	}
	total, err := q.s.workIntelMeasureOne(ctx, f)
	if err != nil {
		return out, total, err
	}
	out.workMetrics = q.metrics(total)
	out.AutomationCandidates = candidates
	if total.Requests > 0 {
		classified := total.Requests - total.Status[0] - total.Status[1] - total.Status[2]
		out.ClassifiedRate = workIntelRatio(float64(classified) / float64(total.Requests))
	}

	groups, err := q.s.db.WorkSums(ctx, f, store.WorkGroup{Dims: []store.WorkDim{store.WorkDimTeam, store.WorkDimCategory}})
	if err != nil {
		return out, total, err
	}
	teams, active := map[string]bool{}, map[string]bool{}
	for _, group := range groups {
		teams[group.Team] = true
		// The bare "other" category is where requests go that nothing matched: it
		// is not a kind of work that is in use.
		if canonical := q.engine.Canonical(group.Category); canonical != workintel.OtherCategoryID {
			active[canonical] = true
		}
	}
	out.Teams, out.ActiveCategories = len(teams), len(active)

	// A category is new in a period when its first use within the lookback
	// window falls inside the period.
	first, err := q.usedIDs(ctx, workIntelShiftDay(from, -workIntelNewCategoryLookback), to)
	if err != nil {
		return out, total, err
	}
	firstDay := map[string]string{}
	for id, day := range first {
		canonical := q.engine.Canonical(id)
		if known, ok := firstDay[canonical]; !ok || day < known {
			firstDay[canonical] = day
		}
	}
	for canonical := range active {
		if day, ok := firstDay[canonical]; ok && day >= from {
			out.NewCategories++
		}
	}
	return out, total, nil
}

func (s *Server) workIntelOverview(ctx context.Context, q *workIntelReadQuery) (workOverviewResponse, error) {
	out := workOverviewResponse{Scope: q.scope}
	candidates, err := s.workIntelCandidateCount(ctx, q.caller)
	if err != nil {
		return out, err
	}
	current, total, err := q.overviewPeriod(ctx, q.from, q.to, candidates)
	if err != nil {
		return out, err
	}
	out.Current = current
	if q.compare {
		// Candidates are a current list without history, so the previous period
		// carries the same number rather than an invented change.
		previous, previousTotal, err := q.overviewPeriod(ctx, q.prevFrom, q.prevTo, candidates)
		if err != nil {
			return out, err
		}
		out.Previous = &previous
		if !current.Suppressed && !previous.Suppressed {
			out.GrowthRate = q.change(total, previousTotal)
		}
	}
	out.Confidence, out.Methods, out.Statuses = []workConfidenceCount{}, []workMethodCount{}, []workStatusCount{}
	if current.Suppressed || !q.caller.privileged {
		// The distributions are request counts of buckets nobody checked for
		// size: one failed request is one person's. They belong to whoever runs
		// the classification and may see prompts.
		return out, nil
	}
	for i, label := range workintel.ConfidenceLabels {
		out.Confidence = append(out.Confidence, workConfidenceCount{Bucket: label, Requests: total.Conf[i]})
	}
	for i, method := range workIntelMethods {
		out.Methods = append(out.Methods, workMethodCount{Method: method, Requests: total.Method[i]})
	}
	out.Statuses = []workStatusCount{
		{workintel.StatusClassified, total.Requests - total.Status[0] - total.Status[1] - total.Status[2]},
		{workintel.StatusReview, total.Status[0]},
		{workintel.StatusUnclassified, total.Status[1]},
		{workintel.StatusFailed, total.Status[2]},
	}
	return out, nil
}

func (s *Server) handleWorkIntelOverview(w http.ResponseWriter, r *http.Request, _ string) {
	q, ok := s.workIntelAnalytics(w, r, workIntelQueryOptions{})
	if !ok {
		return
	}
	out, err := s.workIntelOverview(r.Context(), q)
	if err != nil {
		workIntelFailed(w, r, "the overview", err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ---- Categories ----

type workCategoryRow struct {
	Category    workintel.CategoryRef `json:"category"`
	Current     workMetrics           `json:"current"`
	Previous    *workMetrics          `json:"previous"`
	Share       *float64              `json:"share"`
	Delta       *float64              `json:"delta"`
	HasChildren bool                  `json:"has_children"`
	Suppressed  bool                  `json:"suppressed"`
}

type workCategoriesResponse struct {
	Scope        workIntelScope         `json:"scope"`
	Parent       *workintel.CategoryRef `json:"parent"`
	Rows         []workCategoryRow      `json:"rows"`
	Unclassified workMetrics            `json:"unclassified"`
	Failed       workMetrics            `json:"failed"`
	Total        workMetrics            `json:"total"`
}

// workLevel is one level of the category tree measured over a period. The
// rows hold the requests that were classified (or await review); requests the
// classifier could not place, or failed on, are kept apart so they stay
// visible instead of inflating a category.
type workLevel struct {
	rows         map[string]*workCell
	unclassified workCell
	failed       workCell
	total        workCell
}

var workIntelPlacedStatuses = []string{workintel.StatusClassified, workintel.StatusReview}

func workIntelHasStatus(statuses []string, status string) bool {
	for _, st := range statuses {
		if st == status {
			return true
		}
	}
	return false
}

// levelOf measures the categories below parent (the top level when it is
// empty) over a period.
func (q *workIntelReadQuery) levelOf(ctx context.Context, from, to, parent string) (workLevel, error) {
	level := workLevel{rows: map[string]*workCell{}}
	used, err := q.usedIDs(ctx, from, to)
	if err != nil {
		return level, err
	}
	fold := q.fold(used, parent)
	f, err := q.filter(ctx, from, to)
	if err != nil {
		return level, err
	}
	f.Categories = workIntelFoldIDs(fold, nil)
	if len(f.Categories) == 0 {
		return level, nil
	}
	group := store.WorkGroup{Dims: []store.WorkDim{store.WorkDimCategory}, Fold: fold}
	if level.total, err = q.s.workIntelMeasureOne(ctx, f); err != nil {
		return level, err
	}

	if len(f.Statuses) > 0 {
		// The caller asked for one status, so the total is that status: it is the
		// unclassified part, the failed part, or the rows.
		if workIntelHasStatus(f.Statuses, workintel.StatusUnclassified) {
			level.unclassified = level.total
		}
		if workIntelHasStatus(f.Statuses, workintel.StatusFailed) {
			level.failed = level.total
		}
		if workIntelHasStatus(f.Statuses, workintel.StatusClassified) || workIntelHasStatus(f.Statuses, workintel.StatusReview) {
			cells, err := q.s.workIntelMeasure(ctx, f, group, workNeedBoth)
			if err != nil {
				return level, err
			}
			for key, cell := range cells {
				level.rows[key.Category] = cell
			}
		}
		return level, nil
	}

	cells, err := q.s.workIntelMeasure(ctx, f, group, workNeedBoth)
	if err != nil {
		return level, err
	}
	affected := map[string]bool{}
	for key, cell := range cells {
		level.rows[key.Category] = cell
		if cell.Status[1]+cell.Status[2] > 0 {
			affected[key.Category] = true
		}
	}
	// The aggregates count every status together. Where a category holds
	// unclassified or failed requests, its row is read again from the facts
	// without them; the status index keeps the two reads below small.
	if len(affected) > 0 {
		placed := f
		placed.Statuses = workIntelPlacedStatuses
		placed.Categories = workIntelFoldIDs(fold, affected)
		// Stored rows carry the top-level category of their id, so the read can
		// go straight to the affected categories of each day.
		tops := map[string]bool{}
		for _, id := range placed.Categories {
			if top := workIntelTopOf(id); !tops[top] {
				tops[top] = true
				placed.TopCategories = append(placed.TopCategories, top)
			}
		}
		sort.Strings(placed.TopCategories)
		recount, err := q.s.workIntelMeasure(ctx, placed, group, workNeedBoth)
		if err != nil {
			return level, err
		}
		for key := range affected {
			delete(level.rows, key)
		}
		for key, cell := range recount {
			level.rows[key.Category] = cell
		}
	}
	for _, part := range []struct {
		status string
		count  int64
		into   *workCell
	}{
		{workintel.StatusUnclassified, level.total.Status[1], &level.unclassified},
		{workintel.StatusFailed, level.total.Status[2], &level.failed},
	} {
		if part.count == 0 {
			continue
		}
		only := f
		only.Statuses = []string{part.status}
		if *part.into, err = q.s.workIntelMeasureOne(ctx, only); err != nil {
			return level, err
		}
	}
	return level, nil
}

func (s *Server) workIntelCategories(ctx context.Context, q *workIntelReadQuery, parent string) (workCategoriesResponse, error) {
	out := workCategoriesResponse{Scope: q.scope, Rows: []workCategoryRow{}}
	if parent != "" {
		// A registered parent is shown as the category that stands for it now. One
		// the policy does not have has no level to show.
		if q.engine.Known(parent) {
			parent = q.engine.Canonical(parent)
		}
		ref := q.engine.Ref(parent)
		out.Parent = &ref
	}
	current, err := q.levelOf(ctx, q.from, q.to, parent)
	if err != nil {
		return out, err
	}
	var previous workLevel
	if q.compare {
		if previous, err = q.levelOf(ctx, q.prevFrom, q.prevTo, parent); err != nil {
			return out, err
		}
	}
	keys := []string{}
	for key := range current.rows {
		keys = append(keys, key)
	}
	for key := range previous.rows {
		if current.rows[key] == nil {
			keys = append(keys, key)
		}
	}
	cellOf := func(level workLevel, key string) workCell {
		if c := level.rows[key]; c != nil {
			return *c
		}
		return workCell{}
	}
	// The rows, the unclassified and the failed requests add up to the total, in
	// either period: one line each. The previous period's total and parts are
	// not in this response, but /overview and this read for that period show them.
	guard := q.guard()
	now, before := map[string]*workGuardEntry{}, map[string]*workGuardEntry{}
	line, previousLine := []*workGuardEntry{}, []*workGuardEntry{}
	for _, key := range keys {
		now[key] = guard.cell(key, cellOf(current, key), true)
		line = append(line, now[key])
		if q.compare {
			before[key] = guard.cell("previous:"+key, cellOf(previous, key), true)
			previousLine = append(previousLine, before[key])
		}
	}
	unclassified := guard.cell("~unclassified", current.unclassified, true)
	failed := guard.cell("~failed", current.failed, true)
	total := guard.cell("~total", current.total, true)
	guard.line(total, append(line, unclassified, failed)...)
	if q.compare {
		guard.line(guard.cell("previous:~total", previous.total, false), append(previousLine,
			guard.cell("previous:~unclassified", previous.unclassified, false),
			guard.cell("previous:~failed", previous.failed, false))...)
	}
	guard.settle()
	out.Unclassified = q.metricsOf(current.unclassified, unclassified.out())
	out.Failed = q.metricsOf(current.failed, failed.out())
	out.Total = q.metricsOf(current.total, total.out())
	if total.small {
		// The whole scope is too small to show: not even which categories it used.
		out.Unclassified, out.Failed = q.metricsOf(current.unclassified, true), q.metricsOf(current.failed, true)
		return out, nil
	}

	totalValue := q.value(current.total)
	rows := map[string]workCategoryRow{}
	for _, key := range keys {
		cell := cellOf(current, key)
		withheld := now[key].out()
		row := workCategoryRow{
			Category: q.ref(key, parent), Current: q.metricsOf(cell, withheld), Suppressed: withheld,
			HasChildren: key != parent && q.hasChildren(key),
		}
		if !withheld && totalValue > 0 {
			share := workIntelRatio(q.value(cell) / totalValue)
			row.Share = &share
		}
		if q.compare {
			prior := cellOf(previous, key)
			metrics := q.metricsOf(prior, before[key].out())
			row.Previous = &metrics
			if !withheld && !before[key].out() {
				row.Delta = q.change(cell, prior)
			}
		}
		rows[key] = row
	}
	workIntelShownFirst(keys, func(key string) bool { return now[key].out() }, func(a, b string) bool {
		va, vb := q.value(cellOf(current, a)), q.value(cellOf(current, b))
		if va != vb {
			return va > vb
		}
		return rows[a].Category.ID < rows[b].Category.ID
	})
	for _, key := range keys {
		out.Rows = append(out.Rows, rows[key])
	}
	return out, nil
}

func (s *Server) handleWorkIntelCategories(w http.ResponseWriter, r *http.Request, _ string) {
	q, ok := s.workIntelAnalytics(w, r, workIntelQueryOptions{})
	if !ok {
		return
	}
	parent, err := workIntelText(r, "parent", 128)
	if err != nil {
		workIntelError(w, http.StatusBadRequest, "work_intel_invalid_query", err.Error())
		return
	}
	out, err := s.workIntelCategories(r.Context(), q, parent)
	if err != nil {
		workIntelFailed(w, r, "the category breakdown", err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ---- Shared: the level a breakdown is drawn at ----

// workBreakdown is the level a chart is drawn at for the current period: the
// fold, the filter restricted to it, and the level's keys ranked by the
// selected metric.
type workBreakdown struct {
	parent string
	fold   map[string]string
	filter store.WorkFilter
	// ranked lists the keys with usage, largest first.
	ranked []string
	totals map[string]*workCell
}

// levelFilter resolves the level a period is broken down at, without
// measuring it.
func (q *workIntelReadQuery) levelFilter(ctx context.Context, from, to string) (workBreakdown, error) {
	out := workBreakdown{totals: map[string]*workCell{}}
	used, err := q.usedIDs(ctx, from, to)
	if err != nil {
		return out, err
	}
	out.fold, out.parent = q.level(used)
	if out.filter, err = q.filter(ctx, from, to); err != nil {
		return out, err
	}
	out.filter.Categories = workIntelFoldIDs(out.fold, nil)
	return out, nil
}

// breakdown resolves the level of a period and ranks its categories by the
// selected metric; need names the distinct counts that metric is made of.
func (q *workIntelReadQuery) breakdown(ctx context.Context, from, to string, need workNeed) (workBreakdown, error) {
	out, err := q.levelFilter(ctx, from, to)
	if err != nil || len(out.filter.Categories) == 0 {
		return out, err
	}
	cells, err := q.s.workIntelMeasure(ctx, out.filter, store.WorkGroup{Dims: []store.WorkDim{store.WorkDimCategory}, Fold: out.fold}, need)
	if err != nil {
		return out, err
	}
	for key, cell := range cells {
		out.totals[key.Category] = cell
		out.ranked = append(out.ranked, key.Category)
	}
	sort.Slice(out.ranked, func(i, j int) bool {
		a, b := q.value(*out.totals[out.ranked[i]]), q.value(*out.totals[out.ranked[j]])
		if a != b {
			return a > b
		}
		return out.ranked[i] < out.ranked[j]
	})
	return out, nil
}

// shownRanked returns the ranked keys a chart may draw on their own: for a
// caller refused small groups, the categories whose users over the period are
// too few are left out (they stay in the rest).
func (b workBreakdown) shownRanked(q *workIntelReadQuery) []string {
	if q.caller.privileged {
		return b.ranked
	}
	out := []string{}
	for _, key := range b.ranked {
		if !q.small(b.totals[key].Users) {
			out = append(out, key)
		}
	}
	return out
}

// topFold keeps the n largest keys of a breakdown and reports every other id
// under workIntelRestKey.
func (b workBreakdown) topFold(n int) (fold map[string]string, top []string) {
	top = b.ranked
	if len(top) > n {
		top = top[:n]
	}
	keep := map[string]bool{}
	for _, key := range top {
		keep[key] = true
	}
	fold = map[string]string{}
	for id, key := range b.fold {
		if keep[key] {
			fold[id] = key
		} else if key != "" {
			fold[id] = workIntelRestKey
		}
	}
	return fold, top
}

func workIntelTop(r *http.Request, fallback int) (int, error) {
	return workIntelInt(r, "top", fallback, 1, 100)
}

// ---- Trend ----

// A trend point is null where it is withheld from the caller.
type workTrendSeries struct {
	Category workintel.CategoryRef `json:"category"`
	Values   []*float64            `json:"values"`
}

type workTrendResponse struct {
	Scope   workIntelScope    `json:"scope"`
	Buckets []string          `json:"buckets"`
	Series  []workTrendSeries `json:"series"`
	Other   []*float64        `json:"other"`
	Total   []*float64        `json:"total"`
	// Suppressed says the whole scope has too few users to show the caller:
	// there are no series and every point is withheld.
	Suppressed bool `json:"suppressed"`
}

// workIntelPoints renders a series, leaving out the points the guard withheld.
func workIntelPoints(values []float64, entries []*workGuardEntry) []*float64 {
	out := make([]*float64, len(values))
	for i := range values {
		if i < len(entries) && entries[i].out() {
			continue
		}
		v := workIntelRound(values[i])
		out[i] = &v
	}
	return out
}

// workIntelWeekBuckets splits a day range into Seoul ISO weeks, each labelled
// by its Monday. The first and last week are cut to the range.
func workIntelWeekBuckets(from, to string) []store.WorkBucket {
	start, ok1 := workIntelParseDay(from)
	end, ok2 := workIntelParseDay(to)
	out := []store.WorkBucket{}
	if !ok1 || !ok2 {
		return out
	}
	monday := start.AddDate(0, 0, -((int(start.Weekday()) + 6) % 7))
	for ; !monday.After(end); monday = monday.AddDate(0, 0, 7) {
		first, last := monday, monday.AddDate(0, 0, 6)
		if first.Before(start) {
			first = start
		}
		if last.After(end) {
			last = end
		}
		out = append(out, store.WorkBucket{Label: workIntelFormatDay(monday), From: workIntelFormatDay(first), To: workIntelFormatDay(last)})
	}
	return out
}

func (s *Server) workIntelTrend(ctx context.Context, q *workIntelReadQuery, bucket string, top int) (workTrendResponse, error) {
	out := workTrendResponse{Scope: q.scope, Buckets: []string{}, Series: []workTrendSeries{}, Other: []*float64{}, Total: []*float64{}}
	group := store.WorkGroup{Dims: []store.WorkDim{store.WorkDimDay, store.WorkDimCategory}}
	if bucket == "week" {
		group.Buckets = workIntelWeekBuckets(q.from, q.to)
		for _, b := range group.Buckets {
			out.Buckets = append(out.Buckets, b.Label)
		}
	} else {
		out.Buckets = workIntelDayList(q.from, q.to)
	}
	position := map[string]int{}
	for i, label := range out.Buckets {
		position[label] = i
	}
	n := len(out.Buckets)
	other, total := make([]float64, n), make([]float64, n)
	zeros := func() []*float64 {
		values := make([]*float64, n)
		for i := range values {
			zero := 0.0
			values[i] = &zero
		}
		return values
	}
	out.Other, out.Total = zeros(), zeros()

	need := q.need(q.metric)
	level, err := q.breakdown(ctx, q.from, q.to, need)
	if err != nil || len(level.ranked) == 0 {
		return out, err
	}
	// A category too small to show over the whole period gets no series of its
	// own: every point of it would be withheld. It is part of the rest.
	level.ranked = level.shownRanked(q)
	var keys []string
	group.Fold, keys = level.topFold(top)
	cells, err := s.workIntelMeasure(ctx, level.filter, group, need)
	if err != nil {
		return out, err
	}
	series := map[string][]float64{}
	for _, key := range keys {
		series[key] = make([]float64, n)
	}
	pointCell := map[string][]workCell{workIntelRestKey: make([]workCell, n)}
	for _, key := range keys {
		pointCell[key] = make([]workCell, n)
	}
	for key, cell := range cells {
		i, ok := position[key.Day]
		if !ok {
			continue
		}
		value := q.value(*cell)
		if key.Category == workIntelRestKey {
			other[i] = value
		} else if values := series[key.Category]; values != nil {
			values[i] = value
		}
		if points := pointCell[key.Category]; points != nil {
			points[i] = *cell
		}
		// Additive measures add up to the total; distinct counts are counted again
		// below, because one session or user can be in several categories.
		total[i] += value
	}
	totalCell := make([]workCell, n)
	guard := q.guard()
	if !workIntelAdditive(q.metric) || guard.enabled() {
		totals, err := s.workIntelMeasure(ctx, level.filter, store.WorkGroup{Dims: []store.WorkDim{store.WorkDimDay}, Buckets: group.Buckets}, need)
		if err != nil {
			return out, err
		}
		if !workIntelAdditive(q.metric) {
			total = make([]float64, n)
		}
		for key, cell := range totals {
			if i, ok := position[key.Day]; ok {
				totalCell[i] = *cell
				if !workIntelAdditive(q.metric) {
					total[i] = q.value(*cell)
				}
			}
		}
	}

	entries := map[string][]*workGuardEntry{}
	if guard.enabled() {
		// Each bucket's points add up to its total, and each series over the
		// buckets adds up to its total for the period, which /categories shows.
		periods, err := s.workIntelMeasure(ctx, level.filter, store.WorkGroup{Dims: []store.WorkDim{store.WorkDimCategory}, Fold: group.Fold}, need)
		if err != nil {
			return out, err
		}
		grand, err := s.workIntelMeasureOne(ctx, level.filter)
		if err != nil {
			return out, err
		}
		names := append(append([]string{}, keys...), workIntelRestKey)
		for _, name := range names {
			row := make([]*workGuardEntry, n)
			for i := 0; i < n; i++ {
				row[i] = guard.cell(fmt.Sprintf("%s@%d", name, i), pointCell[name][i], true)
			}
			period := workCell{}
			if c := periods[store.WorkKey{Category: name}]; c != nil {
				period = *c
			}
			guard.line(guard.cell(name+"@period", period, false), row...)
			entries[name] = row
		}
		row := make([]*workGuardEntry, n)
		for i := 0; i < n; i++ {
			row[i] = guard.cell(fmt.Sprintf("~total@%d", i), totalCell[i], true)
		}
		whole := guard.cell("~total@period", grand, false)
		guard.line(whole, row...)
		entries["~total"] = row
		for i := 0; i < n; i++ {
			bucketLine := []*workGuardEntry{}
			for _, name := range names {
				bucketLine = append(bucketLine, entries[name][i])
			}
			guard.line(entries["~total"][i], bucketLine...)
		}
		guard.settle()
		if whole.small {
			// The whole scope is too small to show: not even which categories it used.
			out.Suppressed = true
			keys = nil
		}
	}
	out.Other, out.Total = workIntelPoints(other, entries[workIntelRestKey]), workIntelPoints(total, entries["~total"])
	for _, key := range keys {
		out.Series = append(out.Series, workTrendSeries{Category: q.ref(key, level.parent), Values: workIntelPoints(series[key], entries[key])})
	}
	return out, nil
}

func (s *Server) handleWorkIntelTrend(w http.ResponseWriter, r *http.Request, _ string) {
	q, ok := s.workIntelAnalytics(w, r, workIntelQueryOptions{})
	if !ok {
		return
	}
	bucket, err := workIntelOneOf(r, "bucket", []string{"day", "week"}, 16)
	var top int
	if err == nil {
		top, err = workIntelTop(r, 8)
	}
	if err != nil {
		workIntelError(w, http.StatusBadRequest, "work_intel_invalid_query", err.Error())
		return
	}
	out, err := s.workIntelTrend(r.Context(), q, bucket, top)
	if err != nil {
		workIntelFailed(w, r, "the trend", err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ---- Matrix ----

type workMatrixCell struct {
	CategoryID string   `json:"category_id"`
	Value      *float64 `json:"value"`
	Users      *int64   `json:"users"`
	Suppressed bool     `json:"suppressed"`
}

type workMatrixRow struct {
	Team  string           `json:"team"`
	Total workMetrics      `json:"total"`
	Cells []workMatrixCell `json:"cells"`
}

type workMatrixResponse struct {
	Scope      workIntelScope          `json:"scope"`
	Categories []workintel.CategoryRef `json:"categories"`
	Rows       []workMatrixRow         `json:"rows"`
}

// workTeamGrid is the team × category table of one level over one period,
// with what the caller may be shown of it. The matrix and the teams view read
// the same grid, so they withhold the same cells.
type workTeamGrid struct {
	level  workBreakdown
	cells  map[store.WorkKey]*workCell
	totals map[string]*workCell
	// teams lists the teams with usage; cellOut and totalOut are the withheld
	// cells and team totals, categoryOut the withheld category totals.
	teams       []string
	cellOut     map[store.WorkKey]bool
	totalOut    map[string]bool
	categoryOut map[string]bool
	// smallTeams are the teams withheld for being small themselves.
	smallTeams map[string]bool
}

func (g *workTeamGrid) cell(team, category string) workCell {
	if c := g.cells[store.WorkKey{Team: team, Category: category}]; c != nil {
		return *c
	}
	return workCell{}
}

// teamGrid measures a period's level by team and category. Every row (a
// team's cells and its total), every column (a category's cells and its total,
// which /categories shows) and the team totals with the organisation's total
// (which /overview shows) are lines of the guard.
func (q *workIntelReadQuery) teamGrid(ctx context.Context, from, to string, cellNeed workNeed) (*workTeamGrid, error) {
	grid := &workTeamGrid{cells: map[store.WorkKey]*workCell{}, totals: map[string]*workCell{},
		cellOut: map[store.WorkKey]bool{}, totalOut: map[string]bool{}, categoryOut: map[string]bool{}, smallTeams: map[string]bool{}}
	guard := q.guard()
	if guard.enabled() {
		cellNeed.users = true
	}
	level, err := q.breakdown(ctx, from, to, cellNeed)
	grid.level = level
	if err != nil || len(level.ranked) == 0 {
		return grid, err
	}
	if grid.cells, err = q.s.workIntelMeasure(ctx, level.filter, store.WorkGroup{Dims: []store.WorkDim{store.WorkDimTeam, store.WorkDimCategory}, Fold: level.fold},
		cellNeed); err != nil {
		return grid, err
	}
	totals, err := q.s.workIntelMeasure(ctx, level.filter, store.WorkGroup{Dims: []store.WorkDim{store.WorkDimTeam}}, workNeedBoth)
	if err != nil {
		return grid, err
	}
	for key, cell := range totals {
		grid.totals[key.Team] = cell
		grid.teams = append(grid.teams, key.Team)
	}
	sort.Strings(grid.teams)
	if !guard.enabled() {
		return grid, nil
	}
	grand, err := q.s.workIntelMeasureOne(ctx, level.filter)
	if err != nil {
		return grid, err
	}
	cellEntry := map[store.WorkKey]*workGuardEntry{}
	for _, team := range grid.teams {
		for _, category := range level.ranked {
			cellEntry[store.WorkKey{Team: team, Category: category}] = guard.cell(team+"|"+category, grid.cell(team, category), true)
		}
	}
	totalEntry := map[string]*workGuardEntry{}
	for _, team := range grid.teams {
		totalEntry[team] = guard.cell(team+"|", *grid.totals[team], true)
		row := []*workGuardEntry{}
		for _, category := range level.ranked {
			row = append(row, cellEntry[store.WorkKey{Team: team, Category: category}])
		}
		guard.line(totalEntry[team], row...)
	}
	categoryEntry := map[string]*workGuardEntry{}
	for _, category := range level.ranked {
		categoryEntry[category] = guard.cell("|"+category, *level.totals[category], false)
		column := []*workGuardEntry{}
		for _, team := range grid.teams {
			column = append(column, cellEntry[store.WorkKey{Team: team, Category: category}])
		}
		guard.line(categoryEntry[category], column...)
	}
	margin := []*workGuardEntry{}
	for _, team := range grid.teams {
		margin = append(margin, totalEntry[team])
	}
	guard.line(guard.cell("|", grand, false), margin...)
	guard.settle()
	for key, entry := range cellEntry {
		if entry.out() {
			grid.cellOut[key] = true
		}
	}
	for team, entry := range totalEntry {
		if entry.out() {
			grid.totalOut[team] = true
		}
		// A team too small to show is not shown to have used any category: every
		// cell of its row reads as withheld, its zeros included.
		if entry.small {
			grid.smallTeams[team] = true
			for _, category := range level.ranked {
				grid.cellOut[store.WorkKey{Team: team, Category: category}] = true
			}
		}
	}
	for category, entry := range categoryEntry {
		if entry.out() {
			grid.categoryOut[category] = true
		}
	}
	return grid, nil
}

func (s *Server) workIntelMatrix(ctx context.Context, q *workIntelReadQuery, top int) (workMatrixResponse, error) {
	out := workMatrixResponse{Scope: q.scope, Categories: []workintel.CategoryRef{}, Rows: []workMatrixRow{}}
	// Users are always read: they decide whether a cell may be shown.
	grid, err := q.teamGrid(ctx, q.from, q.to, workNeed{sessions: q.metric == "sessions", users: true})
	if err != nil || len(grid.level.ranked) == 0 {
		return out, err
	}
	// A column of a category too small to show would be withheld whole.
	keys := grid.level.shownRanked(q)
	if len(keys) > top {
		keys = keys[:top]
	}
	for _, key := range keys {
		out.Categories = append(out.Categories, q.ref(key, grid.level.parent))
	}
	teams := append([]string{}, grid.teams...)
	workIntelShownFirst(teams, func(team string) bool { return grid.totalOut[team] }, func(a, b string) bool {
		va, vb := q.value(*grid.totals[a]), q.value(*grid.totals[b])
		if va != vb {
			return va > vb
		}
		return a < b
	})
	for _, team := range teams {
		row := workMatrixRow{Team: team, Total: q.metricsOf(*grid.totals[team], grid.totalOut[team]), Cells: make([]workMatrixCell, 0, len(keys))}
		for _, key := range keys {
			cell := grid.cell(team, key)
			view := workMatrixCell{CategoryID: key}
			if grid.cellOut[store.WorkKey{Team: team, Category: key}] {
				view.Suppressed = true
			} else {
				value := q.value(cell)
				view.Value, view.Users = &value, q.userCount(cell.Users)
			}
			row.Cells = append(row.Cells, view)
		}
		out.Rows = append(out.Rows, row)
	}
	return out, nil
}

func (s *Server) handleWorkIntelMatrix(w http.ResponseWriter, r *http.Request, _ string) {
	q, ok := s.workIntelAnalytics(w, r, workIntelQueryOptions{})
	if !ok {
		return
	}
	top, err := workIntelTop(r, 12)
	if err != nil {
		workIntelError(w, http.StatusBadRequest, "work_intel_invalid_query", err.Error())
		return
	}
	out, err := s.workIntelMatrix(r.Context(), q, top)
	if err != nil {
		workIntelFailed(w, r, "the team by category matrix", err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ---- Flow ----

type workFlowNode struct {
	ID    string  `json:"id"`
	Kind  string  `json:"kind"`
	Name  string  `json:"name"`
	Value float64 `json:"value"`
}

type workFlowLink struct {
	Source string  `json:"source"`
	Target string  `json:"target"`
	Value  float64 `json:"value"`
}

type workFlowResponse struct {
	Scope workIntelScope `json:"scope"`
	Nodes []workFlowNode `json:"nodes"`
	Links []workFlowLink `json:"links"`
	// SuppressedLinks is how many links were withheld from the caller.
	SuppressedLinks int `json:"suppressed_links"`
	// Suppressed says every link was withheld, so there is nothing to draw.
	Suppressed bool `json:"suppressed"`
}

// workIntelFlow builds the team → category → model diagram.
//
// A link carries the selected metric. Team → category is measured directly.
// For sessions and users, which are counted per team and category and not per
// model, a category's value is divided among its models by their share of the
// category's requests, so what flows into a category also flows out of it. A
// node's value is the sum of its links.
//
// For a caller refused small groups, a team, category or model with too few
// users has no node of its own and joins the remainder of its column, and a
// link whose users are too few is left out (counted in suppressed_links), with
// the complementary rule over the links of each node: a node's total is shown
// in /teams, /categories and /overview. The users of a link or node that joins
// several entities are taken as the largest of theirs, which is never more
// than the true number.
func (s *Server) workIntelFlow(ctx context.Context, q *workIntelReadQuery, top int) (workFlowResponse, error) {
	out := workFlowResponse{Scope: q.scope, Nodes: []workFlowNode{}, Links: []workFlowLink{}}
	level, err := q.levelFilter(ctx, q.from, q.to)
	if err != nil || len(level.filter.Categories) == 0 {
		return out, err
	}
	sums, err := s.db.WorkSums(ctx, level.filter, store.WorkGroup{
		Dims: []store.WorkDim{store.WorkDimTeam, store.WorkDimCategory, store.WorkDimModel}, Fold: level.fold})
	if err != nil {
		return out, err
	}
	guard := q.guard()
	type pair struct{ a, b string }
	teamCategory, categoryModel := map[pair]float64{}, map[pair]float64{}
	requests, categoryRequests := map[pair]float64{}, map[string]float64{}
	teamCategoryRequests := map[pair]int64{}
	for _, sum := range sums {
		cell := workCell{WorkSums: sum}
		requests[pair{sum.Category, sum.Model}] += float64(sum.Requests)
		teamCategoryRequests[pair{sum.Team, sum.Category}] += sum.Requests
		categoryRequests[sum.Category] += float64(sum.Requests)
		if workIntelAdditive(q.metric) {
			value := q.value(cell)
			teamCategory[pair{sum.Team, sum.Category}] += value
			categoryModel[pair{sum.Category, sum.Model}] += value
		}
	}
	teamCategoryUsers := map[pair]int64{}
	if need := q.need(q.metric); !workIntelAdditive(q.metric) || guard.enabled() {
		cells, err := s.workIntelMeasure(ctx, level.filter, store.WorkGroup{Dims: []store.WorkDim{store.WorkDimTeam, store.WorkDimCategory}, Fold: level.fold}, need)
		if err != nil {
			return out, err
		}
		categoryValue := map[string]float64{}
		for key, cell := range cells {
			teamCategoryUsers[pair{key.Team, key.Category}] = cell.Users
			if workIntelAdditive(q.metric) {
				continue
			}
			if value := q.value(*cell); value > 0 {
				teamCategory[pair{key.Team, key.Category}] = value
				categoryValue[key.Category] += value
			}
		}
		if !workIntelAdditive(q.metric) {
			for key, n := range requests {
				if total := categoryRequests[key.a]; total > 0 && categoryValue[key.a] > 0 {
					categoryModel[key] = categoryValue[key.a] * n / total
				}
			}
		}
	}

	// The users of every entity and of every category → model pair.
	users := map[string]int64{}
	categoryModelUsers := map[pair]int64{}
	if guard.enabled() {
		for _, dims := range []struct {
			prefix string
			group  store.WorkGroup
		}{
			{"team:", store.WorkGroup{Dims: []store.WorkDim{store.WorkDimTeam}}},
			{"category:", store.WorkGroup{Dims: []store.WorkDim{store.WorkDimCategory}, Fold: level.fold}},
			{"model:", store.WorkGroup{Dims: []store.WorkDim{store.WorkDimModel}}},
		} {
			counts, err := s.db.WorkUserCounts(ctx, level.filter, dims.group)
			if err != nil {
				return out, err
			}
			for _, count := range counts {
				users[dims.prefix+count.Team+count.Category+count.Model] = count.Count
			}
		}
		counts, err := s.db.WorkUserCounts(ctx, level.filter, store.WorkGroup{Dims: []store.WorkDim{store.WorkDimCategory, store.WorkDimModel}, Fold: level.fold})
		if err != nil {
			return out, err
		}
		for _, count := range counts {
			categoryModelUsers[pair{count.Category, count.Model}] = count.Count
		}
	}

	// The largest entries of each column keep their node; the rest share one.
	largest := func(kind string, totals map[string]float64) map[string]bool {
		names := make([]string, 0, len(totals))
		for name := range totals {
			if !q.small(users[kind+":"+name]) {
				names = append(names, name)
			}
		}
		sort.Slice(names, func(i, j int) bool {
			if totals[names[i]] != totals[names[j]] {
				return totals[names[i]] > totals[names[j]]
			}
			return names[i] < names[j]
		})
		if len(names) > top {
			names = names[:top]
		}
		keep := map[string]bool{}
		for _, name := range names {
			keep[name] = true
		}
		return keep
	}
	teamTotals, categoryTotals, modelTotals := map[string]float64{}, map[string]float64{}, map[string]float64{}
	for key, value := range teamCategory {
		teamTotals[key.a] += value
		categoryTotals[key.b] += value
	}
	for key, value := range categoryModel {
		modelTotals[key.b] += value
	}
	keepTeam, keepCategory, keepModel := largest("team", teamTotals), largest("category", categoryTotals), largest("model", modelTotals)
	node := func(kind, name string, keep map[string]bool) string {
		if !keep[name] {
			return kind + ":" + workIntelRestName
		}
		return kind + ":" + name
	}
	links := map[pair]float64{}
	linkUsers, linkRequests, nodeUsers := map[pair]int64{}, map[pair]int64{}, map[string]int64{}
	bound := func(into map[string]int64, id string, n int64) {
		if n > into[id] {
			into[id] = n
		}
	}
	for key, value := range teamCategory {
		link := pair{node("team", key.a, keepTeam), node("category", key.b, keepCategory)}
		links[link] += value
		linkRequests[link] += teamCategoryRequests[key]
		if n := teamCategoryUsers[key]; n > linkUsers[link] {
			linkUsers[link] = n
		}
		bound(nodeUsers, link.a, users["team:"+key.a])
		bound(nodeUsers, link.b, users["category:"+key.b])
	}
	for key, value := range categoryModel {
		link := pair{node("category", key.a, keepCategory), node("model", key.b, keepModel)}
		links[link] += value
		linkRequests[link] += int64(requests[key])
		if n := categoryModelUsers[key]; n > linkUsers[link] {
			linkUsers[link] = n
		}
		bound(nodeUsers, link.b, users["model:"+key.b])
	}

	withheld := map[pair]bool{}
	if guard.enabled() {
		entries := map[pair]*workGuardEntry{}
		into, from := map[string][]*workGuardEntry{}, map[string][]*workGuardEntry{}
		for link, value := range links {
			if value <= 0 {
				continue
			}
			entry := guard.add(link.a+">"+link.b, linkUsers[link], linkRequests[link], true, true)
			entries[link] = entry
			from[link.a] = append(from[link.a], entry)
			into[link.b] = append(into[link.b], entry)
		}
		// In a fixed order, so the same data always withholds the same links.
		ids := make([]string, 0, len(nodeUsers))
		for id := range nodeUsers {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			for _, side := range [][]*workGuardEntry{from[id], into[id]} {
				if len(side) > 0 {
					sort.Slice(side, func(i, j int) bool { return side[i].key < side[j].key })
					guard.line(guard.add(id, nodeUsers[id], 0, true, false), side...)
				}
			}
		}
		guard.settle()
		for link, entry := range entries {
			if entry.out() {
				withheld[link] = true
				out.SuppressedLinks++
			}
		}
		// Nothing is shown when every link is withheld: no node names which
		// teams, categories or models the scope used.
		out.Suppressed = out.SuppressedLinks > 0 && out.SuppressedLinks == len(entries)
	}

	values := map[string]float64{}
	categoryOut := map[string]float64{}
	for key, value := range links {
		if value <= 0 || withheld[key] {
			continue
		}
		out.Links = append(out.Links, workFlowLink{Source: key.a, Target: key.b, Value: workIntelRound(value)})
		// A category node is fed by its incoming links; counting the outgoing
		// ones as well would double it.
		if strings.HasPrefix(key.a, "team:") {
			values[key.a] += value
			values[key.b] += value
		} else {
			values[key.b] += value
			categoryOut[key.a] += value
		}
	}
	// With links left out, what is shown entering a category may differ from
	// what is shown leaving it; the node is as large as the larger side.
	for id, value := range categoryOut {
		if value > values[id] {
			values[id] = value
		}
	}
	sort.Slice(out.Links, func(i, j int) bool {
		a, b := out.Links[i], out.Links[j]
		if a.Value != b.Value {
			return a.Value > b.Value
		}
		if a.Source != b.Source {
			return a.Source < b.Source
		}
		return a.Target < b.Target
	})
	order := map[string]int{"team": 0, "category": 1, "model": 2}
	for id, value := range values {
		kind, name, _ := strings.Cut(id, ":")
		label := name
		if kind == "category" && name != workIntelRestName {
			label = q.ref(name, level.parent).Name
		}
		out.Nodes = append(out.Nodes, workFlowNode{ID: id, Kind: kind, Name: label, Value: workIntelRound(value)})
	}
	sort.Slice(out.Nodes, func(i, j int) bool {
		a, b := out.Nodes[i], out.Nodes[j]
		if order[a.Kind] != order[b.Kind] {
			return order[a.Kind] < order[b.Kind]
		}
		// The remainder node goes last in its column whatever its size.
		if restA, restB := strings.HasSuffix(a.ID, ":"+workIntelRestName), strings.HasSuffix(b.ID, ":"+workIntelRestName); restA != restB {
			return restB
		}
		if a.Value != b.Value {
			return a.Value > b.Value
		}
		return a.ID < b.ID
	})
	return out, nil
}

func (s *Server) handleWorkIntelFlow(w http.ResponseWriter, r *http.Request, _ string) {
	q, ok := s.workIntelAnalytics(w, r, workIntelQueryOptions{})
	if !ok {
		return
	}
	top, err := workIntelTop(r, 6)
	if err != nil {
		workIntelError(w, http.StatusBadRequest, "work_intel_invalid_query", err.Error())
		return
	}
	out, err := s.workIntelFlow(r.Context(), q, top)
	if err != nil {
		workIntelFailed(w, r, "the flow", err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ---- Teams ----

type workTeamCategory struct {
	Category workintel.CategoryRef `json:"category"`
	Value    float64               `json:"value"`
	Share    float64               `json:"share"`
}

type workTeamRising struct {
	Category workintel.CategoryRef `json:"category"`
	Delta    float64               `json:"delta"`
}

type workTeamDeviation struct {
	Category     workintel.CategoryRef `json:"category"`
	TeamShare    float64               `json:"team_share"`
	OverallShare float64               `json:"overall_share"`
}

type workTeamRow struct {
	Team            string              `json:"team"`
	Current         workMetrics         `json:"current"`
	Previous        *workMetrics        `json:"previous"`
	SessionsPerUser *float64            `json:"sessions_per_user"`
	Diversity       *float64            `json:"diversity"`
	TopCategories   []workTeamCategory  `json:"top_categories"`
	Rising          []workTeamRising    `json:"rising"`
	Deviation       []workTeamDeviation `json:"deviation"`
	Suppressed      bool                `json:"suppressed"`
}

type workTeamsResponse struct {
	Scope        workIntelScope `json:"scope"`
	Rows         []workTeamRow  `json:"rows"`
	Denominators string         `json:"denominators"`
}

const (
	workIntelTeamTopCategories = 5
	workIntelTeamHighlights    = 3
	// workIntelDeviationMin is the smallest difference between a team's share
	// of a category and the organisation's that is worth pointing out.
	workIntelDeviationMin = 0.1
)

// workTeamPeriod is what the teams view reads for one period: the team ×
// category grid and each team's value per category in the selected metric.
type workTeamPeriod struct {
	grid   *workTeamGrid
	values map[string]map[string]float64
	parent string
}

func (q *workIntelReadQuery) teamPeriod(ctx context.Context, from, to string) (workTeamPeriod, error) {
	out := workTeamPeriod{values: map[string]map[string]float64{}}
	grid, err := q.teamGrid(ctx, from, to, workNeedFor(q.metric))
	out.grid, out.parent = grid, grid.level.parent
	if err != nil {
		return out, err
	}
	for key, cell := range grid.cells {
		if out.values[key.Team] == nil {
			out.values[key.Team] = map[string]float64{}
		}
		out.values[key.Team][key.Category] = q.value(*cell)
	}
	return out, nil
}

// shown reports whether a team's value for a category may be stated: the cell
// is not withheld (an empty cell is zero, which is shown).
func (p workTeamPeriod) shown(team, category string) bool {
	return p.grid == nil || !p.grid.cellOut[store.WorkKey{Team: team, Category: category}]
}

func (s *Server) workIntelTeams(ctx context.Context, q *workIntelReadQuery) (workTeamsResponse, error) {
	out := workTeamsResponse{Scope: q.scope, Rows: []workTeamRow{}, Denominators: "active_users"}
	current, err := q.teamPeriod(ctx, q.from, q.to)
	if err != nil {
		return out, err
	}
	var previous workTeamPeriod
	if q.compare {
		if previous, err = q.teamPeriod(ctx, q.prevFrom, q.prevTo); err != nil {
			return out, err
		}
	}

	// The comparison set for diversity is the same for every team: the level's
	// categories as the policy lists them, plus any other key that was used.
	var set []string
	inSet := map[string]bool{}
	add := func(key string) {
		if key != "" && !inSet[key] {
			inSet[key] = true
			set = append(set, key)
		}
	}
	for _, child := range q.engine.Children(current.parent) {
		if q.engine.Canonical(child.ID) == child.ID {
			add(child.ID)
		}
	}
	overall, overallTotal := map[string]float64{}, 0.0
	var extra []string
	for _, values := range current.values {
		for key, value := range values {
			overall[key] += value
			overallTotal += value
			if !inSet[key] {
				extra = append(extra, key)
			}
		}
	}
	sort.Strings(extra)
	for _, key := range extra {
		add(key)
	}

	teams := append([]string{}, current.grid.teams...)
	totalOf := func(period workTeamPeriod, team string) workCell {
		if period.grid != nil {
			if c := period.grid.totals[team]; c != nil {
				return *c
			}
		}
		return workCell{}
	}
	workIntelShownFirst(teams, func(team string) bool { return current.grid.totalOut[team] }, func(a, b string) bool {
		va, vb := q.value(totalOf(current, a)), q.value(totalOf(current, b))
		if va != vb {
			return va > vb
		}
		return a < b
	})
	for _, team := range teams {
		total := totalOf(current, team)
		withheld := current.grid.totalOut[team]
		row := workTeamRow{Team: team, Current: q.metricsOf(total, withheld), Suppressed: withheld,
			TopCategories: []workTeamCategory{}, Rising: []workTeamRising{}, Deviation: []workTeamDeviation{}}
		if withheld {
			// Nothing more is said about a team this small: its mix of work would
			// describe one or two people.
			out.Rows = append(out.Rows, row)
			continue
		}
		if q.compare {
			metrics := q.metricsOf(totalOf(previous, team), previous.grid != nil && previous.grid.totalOut[team])
			row.Previous = &metrics
		}
		if total.Users > 0 {
			perUser := workIntelRound(float64(total.Sessions) / float64(total.Users))
			row.SessionsPerUser = &perUser
		}
		values := current.values[team]
		var sum float64
		distribution := make([]float64, len(set))
		// Withheld cells count as one: the index over them separately, next to
		// their sum, would tell how they split.
		merged := -1
		for i, key := range set {
			sum += values[key]
			if !current.shown(team, key) {
				if merged < 0 {
					merged = i
				}
				distribution[merged] += values[key]
				continue
			}
			distribution[i] += values[key]
		}
		diversity := workIntelRatio(workintel.Diversity(distribution))
		row.Diversity = &diversity

		// Only cells the caller may be shown are named.
		keys := make([]string, 0, len(values))
		for key, value := range values {
			if value > 0 && current.shown(team, key) {
				keys = append(keys, key)
			}
		}
		sort.Slice(keys, func(i, j int) bool {
			if values[keys[i]] != values[keys[j]] {
				return values[keys[i]] > values[keys[j]]
			}
			return keys[i] < keys[j]
		})
		for i, key := range keys {
			if i >= workIntelTeamTopCategories {
				break
			}
			row.TopCategories = append(row.TopCategories, workTeamCategory{
				Category: q.ref(key, current.parent), Value: values[key], Share: workIntelRatio(values[key] / sum)})
		}

		if q.compare {
			before := previous.values[team]
			type change struct {
				key   string
				delta float64
			}
			var rising []change
			for _, key := range keys {
				if !previous.shown(team, key) {
					continue
				}
				if delta := values[key] - before[key]; delta > 0 {
					rising = append(rising, change{key, delta})
				}
			}
			sort.Slice(rising, func(i, j int) bool {
				if rising[i].delta != rising[j].delta {
					return rising[i].delta > rising[j].delta
				}
				return rising[i].key < rising[j].key
			})
			for i, c := range rising {
				if i >= workIntelTeamHighlights {
					break
				}
				row.Rising = append(row.Rising, workTeamRising{Category: q.ref(c.key, current.parent), Delta: workIntelRound(c.delta)})
			}
		}

		if sum > 0 && overallTotal > 0 {
			type gap struct {
				key          string
				team, others float64
			}
			var gaps []gap
			for _, key := range set {
				// A team's share of a category states the cell; the organisation's
				// share states the category's total.
				if !current.shown(team, key) || current.grid.categoryOut[key] {
					continue
				}
				teamShare, overallShare := values[key]/sum, overall[key]/overallTotal
				if diff := teamShare - overallShare; diff >= workIntelDeviationMin || diff <= -workIntelDeviationMin {
					gaps = append(gaps, gap{key, teamShare, overallShare})
				}
			}
			sort.Slice(gaps, func(i, j int) bool {
				a, b := gaps[i].team-gaps[i].others, gaps[j].team-gaps[j].others
				if a < 0 {
					a = -a
				}
				if b < 0 {
					b = -b
				}
				if a != b {
					return a > b
				}
				return gaps[i].key < gaps[j].key
			})
			for i, g := range gaps {
				if i >= workIntelTeamHighlights {
					break
				}
				row.Deviation = append(row.Deviation, workTeamDeviation{Category: q.ref(g.key, current.parent),
					TeamShare: workIntelRatio(g.team), OverallShare: workIntelRatio(g.others)})
			}
		}
		out.Rows = append(out.Rows, row)
	}
	return out, nil
}

func (s *Server) handleWorkIntelTeams(w http.ResponseWriter, r *http.Request, _ string) {
	q, ok := s.workIntelAnalytics(w, r, workIntelQueryOptions{})
	if !ok {
		return
	}
	out, err := s.workIntelTeams(r.Context(), q)
	if err != nil {
		workIntelFailed(w, r, "the team breakdown", err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ---- Models ----

type workModelRow struct {
	Category         workintel.CategoryRef `json:"category"`
	Model            string                `json:"model"`
	Provider         string                `json:"provider"`
	Requests         int64                 `json:"requests"`
	Sessions         int64                 `json:"sessions"`
	Share            float64               `json:"share"`
	TokensPerSession float64               `json:"tokens_per_session"`
	CostPerSession   float64               `json:"cost_per_session"`
	LatencyP50MS     float64               `json:"latency_p50_ms"`
	LatencyP95MS     float64               `json:"latency_p95_ms"`
	ErrorRate        float64               `json:"error_rate"`
	RetryRate        float64               `json:"retry_rate"`
	ModelSwitchRate  float64               `json:"model_switch_rate"`
	FeedbackPositive int64                 `json:"feedback_positive"`
	FeedbackNegative int64                 `json:"feedback_negative"`
	LowSample        bool                  `json:"low_sample"`
	// Suppressed rows are sent with every measure and rate null.
	Suppressed bool `json:"suppressed"`
}

type workModelSuggestion struct {
	Category     workintel.CategoryRef `json:"category"`
	FromModel    string                `json:"from_model"`
	ToModel      string                `json:"to_model"`
	Basis        string                `json:"basis"`
	Sample       int64                 `json:"sample"`
	EstSavingKRW float64               `json:"est_saving_krw"`
}

type workModelsResponse struct {
	Scope       workIntelScope        `json:"scope"`
	Rows        []workModelRow        `json:"rows"`
	Suggestions []workModelSuggestion `json:"suggestions"`
	// Suppressed says every row is withheld from the caller, so none is listed.
	Suppressed bool `json:"suppressed"`
}

const (
	// workIntelLowSample is the number of requests below which a model row's
	// rates are marked as resting on too little.
	workIntelLowSample = 30
	// workIntelSuggestionSessions is the evidence a cheaper model needs in the
	// same category before it is suggested.
	workIntelSuggestionSessions = 30
	// workIntelSuggestionSaving is the smallest relative saving per session
	// worth a suggestion.
	workIntelSuggestionSaving = 0.1
	workIntelMaxSuggestions   = 10
	workIntelMaxModelRows     = 500
)

func (s *Server) workIntelModels(ctx context.Context, q *workIntelReadQuery) (workModelsResponse, error) {
	out := workModelsResponse{Scope: q.scope, Rows: []workModelRow{}, Suggestions: []workModelSuggestion{}}
	level, err := q.levelFilter(ctx, q.from, q.to)
	if err != nil || len(level.filter.Categories) == 0 {
		return out, err
	}
	sums, err := s.db.WorkSums(ctx, level.filter, store.WorkGroup{
		Dims: []store.WorkDim{store.WorkDimCategory, store.WorkDimModel, store.WorkDimProvider}, Fold: level.fold})
	if err != nil {
		return out, err
	}
	// Which model served which session, and what feedback its requests got, is
	// only known per request: these two reads go to the facts of the period.
	sessions, err := s.db.WorkModelSessions(ctx, level.filter, level.fold)
	if err != nil {
		return out, err
	}
	feedback, err := s.db.WorkModelFeedback(ctx, level.filter, level.fold)
	if err != nil {
		return out, err
	}
	type key struct{ category, model, provider string }
	sessionsBy := map[key]store.WorkModelSessions{}
	for _, row := range sessions {
		sessionsBy[key{row.Category, row.Model, row.Provider}] = row
	}
	feedbackBy := map[key]store.WorkModelFeedback{}
	for _, row := range feedback {
		feedbackBy[key{row.Category, row.Model, row.Provider}] = row
	}
	categoryRequests := map[string]int64{}
	for _, sum := range sums {
		categoryRequests[sum.Category] += sum.Requests
	}
	byCategory := map[string][]workModelRow{}
	for _, sum := range sums {
		k := key{sum.Category, sum.Model, sum.Provider}
		row := workModelRow{
			Category: q.ref(sum.Category, level.parent), Model: sum.Model, Provider: sum.Provider, Requests: sum.Requests,
			Sessions: sessionsBy[k].Sessions, FeedbackPositive: feedbackBy[k].Positive, FeedbackNegative: feedbackBy[k].Negative,
			LatencyP50MS: workIntelRound(workintel.Percentile(sum.Lat[:], 0.5)), LatencyP95MS: workIntelRound(workintel.Percentile(sum.Lat[:], 0.95)),
			LowSample: sum.Requests < workIntelLowSample,
		}
		if total := categoryRequests[sum.Category]; total > 0 {
			row.Share = workIntelRatio(float64(sum.Requests) / float64(total))
		}
		if sum.Requests > 0 {
			row.ErrorRate = workIntelRatio(float64(sum.Errors) / float64(sum.Requests))
			row.RetryRate = workIntelRatio(float64(sum.Retries) / float64(sum.Requests))
		}
		if row.Sessions > 0 {
			row.TokensPerSession = workIntelRound(float64(sum.TokensIn+sum.TokensOut) / float64(row.Sessions))
			row.CostPerSession = workIntelRound(sum.CostKRW / float64(row.Sessions))
			row.ModelSwitchRate = workIntelRatio(float64(sessionsBy[k].Switched) / float64(row.Sessions))
		}
		byCategory[sum.Category] = append(byCategory[sum.Category], row)
	}
	// A row is a category × model × provider group; it adds up to its category
	// (shown in /categories) and, over the categories, to its model.
	guard := q.guard()
	withheld := map[key]bool{}
	if guard.enabled() {
		rowUsers, err := s.db.WorkUserCounts(ctx, level.filter, store.WorkGroup{
			Dims: []store.WorkDim{store.WorkDimCategory, store.WorkDimModel, store.WorkDimProvider}, Fold: level.fold})
		if err != nil {
			return out, err
		}
		usersBy := map[key]int64{}
		for _, count := range rowUsers {
			usersBy[key{count.Category, count.Model, count.Provider}] = count.Count
		}
		groupUsers := map[string]int64{}
		for _, dims := range []struct {
			prefix string
			group  store.WorkGroup
		}{
			{"category:", store.WorkGroup{Dims: []store.WorkDim{store.WorkDimCategory}, Fold: level.fold}},
			{"model:", store.WorkGroup{Dims: []store.WorkDim{store.WorkDimModel}}},
		} {
			counts, err := s.db.WorkUserCounts(ctx, level.filter, dims.group)
			if err != nil {
				return out, err
			}
			for _, count := range counts {
				groupUsers[dims.prefix+count.Category+count.Model] = count.Count
			}
		}
		entries := map[key]*workGuardEntry{}
		lines := map[string][]*workGuardEntry{}
		for _, sum := range sums {
			k := key{sum.Category, sum.Model, sum.Provider}
			entry := guard.add(k.category+"|"+k.model+"|"+k.provider, usersBy[k], sum.Requests, sum.Requests > 0, true)
			entries[k] = entry
			lines["category:"+k.category] = append(lines["category:"+k.category], entry)
			lines["model:"+k.model] = append(lines["model:"+k.model], entry)
		}
		groups := make([]string, 0, len(lines))
		for group := range lines {
			groups = append(groups, group)
		}
		sort.Strings(groups)
		for _, group := range groups {
			guard.line(guard.add(group, groupUsers[group], 0, true, false), lines[group]...)
		}
		guard.settle()
		for k, entry := range entries {
			if entry.out() {
				withheld[k] = true
			}
		}
		for category, rows := range byCategory {
			for i := range rows {
				if withheld[key{category, rows[i].Model, rows[i].Provider}] {
					rows[i] = workModelRow{Category: rows[i].Category, Model: rows[i].Model, Provider: rows[i].Provider, Suppressed: true}
				}
			}
		}
	}
	// Categories by requests (largest first), and within one its models likewise.
	categories := make([]string, 0, len(byCategory))
	for category := range byCategory {
		categories = append(categories, category)
	}
	sort.Slice(categories, func(i, j int) bool {
		a, b := categoryRequests[categories[i]], categoryRequests[categories[j]]
		if a != b {
			return a > b
		}
		return categories[i] < categories[j]
	})
	// Withheld rows go after every shown one, ordered by name only: where a row
	// stands among the others would tell its size.
	var hidden []workModelRow
	for _, category := range categories {
		rows := byCategory[category]
		shown := rows[:0:0]
		for _, row := range rows {
			if row.Suppressed {
				hidden = append(hidden, row)
			} else {
				shown = append(shown, row)
			}
		}
		sort.Slice(shown, func(i, j int) bool {
			if shown[i].Requests != shown[j].Requests {
				return shown[i].Requests > shown[j].Requests
			}
			if shown[i].Model != shown[j].Model {
				return shown[i].Model < shown[j].Model
			}
			return shown[i].Provider < shown[j].Provider
		})
		out.Rows = append(out.Rows, shown...)
		// A suggestion compares two rows the caller is shown.
		out.Suggestions = append(out.Suggestions, workIntelModelSuggestions(shown)...)
	}
	sort.Slice(hidden, func(i, j int) bool {
		a, b := hidden[i], hidden[j]
		if a.Category.ID != b.Category.ID {
			return a.Category.ID < b.Category.ID
		}
		if a.Model != b.Model {
			return a.Model < b.Model
		}
		return a.Provider < b.Provider
	})
	if len(hidden) > 0 && len(hidden) == len(out.Rows)+len(hidden) {
		// Every row is withheld, which is always so when the whole scope is too
		// small to show: the rows would only name the categories and models it
		// used.
		out.Suppressed = true
		return out, nil
	}
	out.Rows = append(out.Rows, hidden...)
	if len(out.Rows) > workIntelMaxModelRows {
		out.Rows = out.Rows[:workIntelMaxModelRows]
	}
	sort.SliceStable(out.Suggestions, func(i, j int) bool { return out.Suggestions[i].EstSavingKRW > out.Suggestions[j].EstSavingKRW })
	if len(out.Suggestions) > workIntelMaxSuggestions {
		out.Suggestions = out.Suggestions[:workIntelMaxSuggestions]
	}
	return out, nil
}

// workIntelModelSuggestions proposes, within one category, moving work from a
// model to a cheaper one. A suggestion is only made on evidence: the cheaper
// model has served enough sessions of the same work, and neither its error
// rate nor its negative-feedback rate is worse. Otherwise there is none.
func workIntelModelSuggestions(rows []workModelRow) []workModelSuggestion {
	negativeRate := func(row workModelRow) float64 {
		if row.Requests == 0 {
			return 0
		}
		return float64(row.FeedbackNegative) / float64(row.Requests)
	}
	out := []workModelSuggestion{}
	for _, from := range rows {
		if from.LowSample || from.Sessions == 0 || from.CostPerSession <= 0 {
			continue
		}
		var best *workModelRow
		for i := range rows {
			to := &rows[i]
			if to.Model == from.Model || to.Sessions < workIntelSuggestionSessions {
				continue
			}
			if to.CostPerSession > from.CostPerSession*(1-workIntelSuggestionSaving) {
				continue
			}
			if to.ErrorRate > from.ErrorRate || negativeRate(*to) > negativeRate(from) {
				continue
			}
			if best == nil || to.CostPerSession < best.CostPerSession {
				best = to
			}
		}
		if best == nil {
			continue
		}
		saving := 1 - best.CostPerSession/from.CostPerSession
		out = append(out, workModelSuggestion{
			Category: from.Category, FromModel: from.Model, ToModel: best.Model, Sample: best.Sessions,
			EstSavingKRW: workIntelRound((from.CostPerSession - best.CostPerSession) * float64(from.Sessions)),
			Basis: fmt.Sprintf("%s 모델은 같은 업무의 세션 %d건에서 오류율 %.1f%%(현재 모델 %.1f%%), 부정 피드백 %d건(현재 모델 %d건)으로 더 나쁘지 않고 세션당 비용이 %.0f%% 낮습니다.",
				best.Model, best.Sessions, best.ErrorRate*100, from.ErrorRate*100, best.FeedbackNegative, from.FeedbackNegative, saving*100),
		})
	}
	return out
}

func (s *Server) handleWorkIntelModels(w http.ResponseWriter, r *http.Request, _ string) {
	q, ok := s.workIntelAnalytics(w, r, workIntelQueryOptions{})
	if !ok {
		return
	}
	out, err := s.workIntelModels(r.Context(), q)
	if err != nil {
		workIntelFailed(w, r, "the model breakdown", err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ---- Productivity ----

type workBaselineView struct {
	ManualMinutes float64 `json:"manual_minutes"`
	AIMinutes     float64 `json:"ai_minutes"`
	HourlyCostKRW float64 `json:"hourly_cost_krw"`
}

type workProductivityRow struct {
	Category          workintel.CategoryRef `json:"category"`
	Sessions          int64                 `json:"sessions"`
	ConfirmedSessions int64                 `json:"confirmed_sessions"`
	ModelTimeMS       int64                 `json:"model_time_ms"`
	Baseline          *workBaselineView     `json:"baseline"`
	EstMinutesSaved   *float64              `json:"est_minutes_saved"`
	EstCostSavedKRW   *float64              `json:"est_cost_saved_krw"`
	Reason            string                `json:"reason"`
	// Suppressed rows are sent with their counts and estimates null.
	Suppressed bool `json:"suppressed"`
}

type workProductivityResponse struct {
	Scope workIntelScope        `json:"scope"`
	Rows  []workProductivityRow `json:"rows"`
	// Suppressed says the scope is too small, or every row withheld, so none is listed.
	Suppressed bool `json:"suppressed"`
}

func (s *Server) workIntelProductivity(ctx context.Context, q *workIntelReadQuery) (workProductivityResponse, error) {
	out := workProductivityResponse{Scope: q.scope, Rows: []workProductivityRow{}}
	level, err := q.levelFilter(ctx, q.from, q.to)
	if err != nil || len(level.filter.Categories) == 0 {
		return out, err
	}
	rows, err := s.db.WorkCategorySessions(ctx, level.filter, level.fold)
	if err != nil {
		return out, err
	}
	// The rows add up to the level's sessions, which /overview shows.
	guard := q.guard()
	withheld := map[string]bool{}
	if guard.enabled() {
		counts, err := s.db.WorkUserCounts(ctx, level.filter, store.WorkGroup{Dims: []store.WorkDim{store.WorkDimCategory}, Fold: level.fold})
		if err != nil {
			return out, err
		}
		usersBy := map[string]int64{}
		for _, count := range counts {
			usersBy[count.Category] = count.Count
		}
		all, err := s.workIntelMeasureOne(ctx, level.filter)
		if err != nil {
			return out, err
		}
		entries := map[string]*workGuardEntry{}
		line := []*workGuardEntry{}
		for _, row := range rows {
			// Sessions stand in for requests in the order of picking: this read has
			// no request counts, and it is drawn in no metric.
			entries[row.Category] = guard.add(row.Category, usersBy[row.Category], row.Sessions, row.Sessions > 0 || usersBy[row.Category] > 0, true)
			line = append(line, entries[row.Category])
		}
		whole := guard.cell("~total", all, false)
		guard.line(whole, line...)
		guard.settle()
		for category, entry := range entries {
			if entry.out() {
				withheld[category] = true
			}
		}
		if whole.small || (len(rows) > 0 && len(withheld) == len(rows)) {
			// Nothing to show; the rows would only name the categories used.
			out.Suppressed = true
			return out, nil
		}
	}
	sort.Slice(rows, func(i, j int) bool {
		if wi, wj := withheld[rows[i].Category], withheld[rows[j].Category]; wi != wj {
			return wj
		} else if wi {
			return rows[i].Category < rows[j].Category
		}
		if rows[i].Sessions != rows[j].Sessions {
			return rows[i].Sessions > rows[j].Sessions
		}
		return rows[i].Category < rows[j].Category
	})
	for _, row := range rows {
		view := workProductivityRow{Category: q.ref(row.Category, level.parent), Sessions: row.Sessions,
			ConfirmedSessions: row.Confirmed, ModelTimeMS: row.ModelTimeMS}
		baseline := q.engine.BaselineFor(row.Category)
		if baseline != nil {
			view.Baseline = &workBaselineView{ManualMinutes: baseline.ManualMinutes, AIMinutes: baseline.AIMinutes, HourlyCostKRW: baseline.HourlyCostKRW}
		}
		if withheld[row.Category] {
			view = workProductivityRow{Category: view.Category, Baseline: view.Baseline, Suppressed: true,
				Reason: fmt.Sprintf("이 업무를 한 사용자가 최소 집계 인원(%d명)보다 적어 수치를 보호했습니다.", q.minGroup)}
			out.Rows = append(out.Rows, view)
			continue
		}
		// Only sessions confirmed by feedback count: a request that succeeded is
		// not evidence that the work got done.
		view.EstMinutesSaved, view.EstCostSavedKRW, view.Reason = workintel.EstimateSavings(baseline, row.Confirmed)
		out.Rows = append(out.Rows, view)
	}
	return out, nil
}

func (s *Server) handleWorkIntelProductivity(w http.ResponseWriter, r *http.Request, _ string) {
	q, ok := s.workIntelAnalytics(w, r, workIntelQueryOptions{})
	if !ok {
		return
	}
	out, err := s.workIntelProductivity(r.Context(), q)
	if err != nil {
		workIntelFailed(w, r, "the productivity estimate", err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}
