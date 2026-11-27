package proxy

import (
	"bytes"
	"context"
	"encoding/csv"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
	"vibe-coders/internal/workintel"
)

// workAPIFormulaSession is a session id a client chose that a spreadsheet
// would run as a formula.
const workAPIFormulaSession = "=SUM(A1)"

// workAPIFixture is the traffic the read tests are computed against by hand.
//
// Today (ten requests, four sessions, four users in two teams):
//
//	r1  ua1 sess-a1   test-model  code        dev.codegen   positive feedback
//	r2  ua1 sess-a1   test-model  code        dev.codegen
//	r3  ua1 sess-a1   test-mini   kubernetes  infra.k8s
//	r4  ua2 =SUM(A1)  test-model  code        dev.codegen
//	r5  ua2 =SUM(A1)  test-model  sql         data.sql
//	r6  ua3 sess-a3   test-mini   code        dev.codegen
//	r7  ua3 sess-a3   test-model  unclear     other         unclassified
//	r8  ub1 sess-b1   test-model  code        dev.codegen
//	r9  ub1 sess-b1   test-model  greeting    other.chat
//	r10 ub1 sess-b1   fail-model  code        dev.codegen   the provider answers 400
//
// Yesterday:
//
//	r11 ua1 sess-a0   test-model  code        dev.codegen
//	r12 ub1 sess-b0   test-model  sql         data.sql
//
// A successful request has 11 prompt and 7 completion tokens: 25 KRW on
// test-model, 12.5 KRW on test-mini. The failed one has no completion; its
// estimated prompt tokens and cost are read from the fact (failedTokens,
// failedCost) because the gateway estimates them.
type workAPIFixture struct {
	*workAPIEnv
	ids          []string
	today, prev  string
	period       string
	failedTokens int64
	failedCost   float64
}

func newWorkAPIFixture(t *testing.T) *workAPIFixture {
	t.Helper()
	env := newWorkAPIEnv(t)
	f := &workAPIFixture{workAPIEnv: env}
	for _, r := range []struct{ key, session, model, prompt string }{
		{"key-a1", "sess-a1", workAPIModel, workIntelPromptCode},
		{"key-a1", "sess-a1", workAPIModel, workIntelPromptCode},
		{"key-a1", "sess-a1", workAPIMiniModel, workIntelPromptK8s},
		{"key-a2", workAPIFormulaSession, workAPIModel, workIntelPromptCode},
		{"key-a2", workAPIFormulaSession, workAPIModel, workIntelPromptSQL},
		{"key-a3", "sess-a3", workAPIMiniModel, workIntelPromptCode},
		{"key-a3", "sess-a3", workAPIModel, workIntelPromptUnclear},
		{"key-b1", "sess-b1", workAPIModel, workIntelPromptCode},
		{"key-b1", "sess-b1", workAPIModel, workIntelPromptChat},
		{"key-b1", "sess-b1", workAPIFailModel, workIntelPromptCode},
		{"key-a1", "sess-a0", workAPIModel, workIntelPromptCode},
		{"key-b1", "sess-b0", workAPIModel, workIntelPromptSQL},
	} {
		f.ids = append(f.ids, env.send(t, r.key, r.session, r.model, r.prompt))
	}
	env.backdate(t, 1, f.ids[10], f.ids[11])
	env.feedback(t, f.ids[0], 1)
	if stats := env.run(t); stats.Classified != 12 {
		t.Fatalf("worker classified %d of 12 requests: %+v", stats.Classified, stats)
	}
	f.today, f.prev = workAPIToday(), workAPIDay(-1)
	f.period = "from=" + f.today + "&to=" + f.today
	facts, err := env.db.WorkClassificationsByID(context.Background(), []string{f.ids[9]})
	if err != nil || len(facts) != 1 || !facts[0].IsError || facts[0].TokensOut != 0 {
		t.Fatalf("the failed request's fact: %+v, %v", facts, err)
	}
	f.failedTokens, f.failedCost = facts[0].TokensIn, facts[0].CostKRW
	// The classification the fixture relies on.
	want := []string{"dev.codegen", "dev.codegen", "infra.k8s", "dev.codegen", "data.sql", "dev.codegen", "other", "dev.codegen", "other.chat", "dev.codegen", "dev.codegen", "data.sql"}
	all, err := env.db.WorkClassificationsByID(context.Background(), f.ids)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, fact := range all {
		got[fact.RequestID] = fact.CategoryID
	}
	for i, id := range f.ids {
		if got[id] != want[i] {
			t.Fatalf("request %d was classified as %q, the fixture needs %q", i+1, got[id], want[i])
		}
	}
	return f
}

func workNear(a, b float64) bool { return math.Abs(a-b) < 0.011 }

func workUsers(v *int64) string {
	if v == nil {
		return "null"
	}
	return fmt.Sprint(*v)
}

// workFloat reads a number that may be withheld: -1 stands for null.
func workFloat(v *float64) float64 {
	if v == nil {
		return -1
	}
	return *v
}

// workPointValues reads trend points; -1 stands for a withheld one.
func workPointValues(points []*float64) []float64 {
	out := make([]float64, len(points))
	for i, p := range points {
		out[i] = workFloat(p)
	}
	return out
}

// workMetricsLine renders the counts of a Metrics object for comparison.
func workMetricsLine(m workMetrics) string {
	return fmt.Sprintf("sessions=%d requests=%d users=%s tokens=%d mcp=%d", m.Sessions, m.Requests, workUsers(m.Users), m.Tokens, m.MCPCalls)
}

func TestWorkIntelAPIOverviewAndCategories(t *testing.T) {
	f := newWorkAPIFixture(t)
	okTokens := int64(18)
	todayCost := 7*25 + 2*12.5 + f.failedCost

	var overview workOverviewResponse
	f.get(t, f.full, "/overview?"+f.period, &overview)
	if overview.Scope.From != f.today || overview.Scope.To != f.today || overview.Scope.PrevFrom != f.prev || overview.Scope.PrevTo != f.prev ||
		overview.Scope.TeamScoped || overview.Scope.MinGroupSize != 3 || overview.Scope.Backlog != 0 || !overview.Scope.ClassifyEnabled ||
		overview.Scope.PolicyVersion != 1 || overview.Scope.DataThrough == "" {
		t.Fatalf("scope = %+v", overview.Scope)
	}
	wantCurrent := fmt.Sprintf("sessions=4 requests=10 users=4 tokens=%d mcp=0", 9*okTokens+f.failedTokens)
	if got := workMetricsLine(overview.Current.workMetrics); got != wantCurrent || !workNear(overview.Current.CostKRW, todayCost) {
		t.Errorf("current = %s cost %v, want %s cost %v", got, overview.Current.CostKRW, wantCurrent, todayCost)
	}
	// Four kinds of work today (the bare "other" is not one); infra.k8s and
	// other.chat were not used yesterday, so they are new.
	if overview.Current.Teams != 2 || overview.Current.ActiveCategories != 4 || overview.Current.ClassifiedRate != 0.9 || overview.Current.NewCategories != 2 {
		t.Errorf("current extras = %+v", overview.Current)
	}
	if overview.Previous == nil || workMetricsLine(overview.Previous.workMetrics) != "sessions=2 requests=2 users=2 tokens=36 mcp=0" ||
		!workNear(overview.Previous.CostKRW, 50) || overview.Previous.Teams != 2 || overview.Previous.ActiveCategories != 2 || overview.Previous.ClassifiedRate != 1 {
		t.Errorf("previous = %+v", overview.Previous)
	}
	// Four sessions against two.
	if overview.GrowthRate == nil || *overview.GrowthRate != 1 {
		t.Errorf("growth_rate = %v, want 1", overview.GrowthRate)
	}
	labels, total := []string{}, int64(0)
	for _, bucket := range overview.Confidence {
		labels = append(labels, bucket.Bucket)
		total += bucket.Requests
	}
	if !reflect.DeepEqual(labels, workintel.ConfidenceLabels) || total != 10 || overview.Confidence[0].Requests != 1 {
		t.Errorf("confidence = %+v", overview.Confidence)
	}
	if !reflect.DeepEqual(overview.Methods, []workMethodCount{{"rule", 10}, {"llm", 0}, {"cache", 0}, {"manual", 0}}) ||
		!reflect.DeepEqual(overview.Statuses, []workStatusCount{{"classified", 9}, {"review", 0}, {"unclassified", 1}, {"failed", 0}}) {
		t.Errorf("methods = %+v statuses = %+v", overview.Methods, overview.Statuses)
	}

	// The selected metric decides the growth rate: ten requests against two.
	f.get(t, f.full, "/overview?"+f.period+"&metric=requests", &overview)
	if overview.GrowthRate == nil || *overview.GrowthRate != 4 {
		t.Errorf("growth_rate by requests = %v, want 4", overview.GrowthRate)
	}
	// Without a comparison there is no previous period and no growth.
	f.get(t, f.full, "/overview?"+f.period+"&compare=none", &overview)
	if overview.Previous != nil || overview.GrowthRate != nil || overview.Scope.PrevFrom != "" || overview.Scope.PrevTo != "" {
		t.Errorf("compare=none: previous=%+v growth=%v scope=%+v", overview.Previous, overview.GrowthRate, overview.Scope)
	}
	// A period with nothing before it: the base is zero, so no rate.
	f.get(t, f.full, "/overview?from="+f.prev+"&to="+f.prev, &overview)
	if overview.GrowthRate != nil || overview.Previous == nil || overview.Previous.Requests != 0 || overview.Current.Requests != 2 {
		t.Errorf("first period: growth=%v previous=%+v current=%+v", overview.GrowthRate, overview.Previous, overview.Current)
	}
	// The default period is the last 30 Seoul days ending today.
	f.get(t, f.full, "/overview", &overview)
	if overview.Scope.From != workAPIDay(-29) || overview.Scope.To != f.today || overview.Scope.PrevFrom != workAPIDay(-59) || overview.Scope.PrevTo != workAPIDay(-30) ||
		overview.Current.Requests != 12 || overview.Current.Sessions != 6 {
		t.Errorf("default period: scope=%+v current=%+v", overview.Scope, overview.Current)
	}

	var categories workCategoriesResponse
	f.get(t, f.full, "/categories?"+f.period, &categories)
	type rowLine struct {
		id, current, previous string
		share                 float64
		delta                 string
		children, suppressed  bool
	}
	lines := func(rows []workCategoryRow) []rowLine {
		out := []rowLine{}
		for _, row := range rows {
			line := rowLine{id: row.Category.ID, current: workMetricsLine(row.Current), share: workFloat(row.Share), delta: "null", children: row.HasChildren, suppressed: row.Suppressed}
			if row.Previous != nil {
				line.previous = workMetricsLine(*row.Previous)
			}
			if row.Delta != nil {
				line.delta = fmt.Sprint(*row.Delta)
			}
			out = append(out, line)
		}
		return out
	}
	zero := "sessions=0 requests=0 users=0 tokens=0 mcp=0"
	one := "sessions=1 requests=1 users=1 tokens=18 mcp=0"
	// Sorted by sessions; "other" holds the greeting only, because the request
	// nothing matched is reported apart as unclassified.
	wantRows := []rowLine{
		{"dev", fmt.Sprintf("sessions=4 requests=6 users=4 tokens=%d mcp=0", 5*okTokens+f.failedTokens), one, 1, "3", true, false},
		{"data", one, one, 0.25, "0", true, false},
		{"infra", one, zero, 0.25, "null", true, false},
		{"other", one, zero, 0.25, "null", true, false},
	}
	if got := lines(categories.Rows); !reflect.DeepEqual(got, wantRows) {
		t.Errorf("top-level rows =\n %+v\nwant\n %+v", got, wantRows)
	}
	if categories.Parent != nil || workMetricsLine(categories.Unclassified) != one || workMetricsLine(categories.Failed) != zero ||
		workMetricsLine(categories.Total) != wantCurrent || !workNear(categories.Total.CostKRW, todayCost) {
		t.Errorf("unclassified=%+v failed=%+v total=%+v", categories.Unclassified, categories.Failed, categories.Total)
	}
	// The parts add up to the total: the unclassified request is in neither row.
	var requests int64
	for _, row := range categories.Rows {
		requests += row.Current.Requests
	}
	if requests+categories.Unclassified.Requests+categories.Failed.Requests != categories.Total.Requests {
		t.Errorf("rows %d + unclassified %d + failed %d != total %d", requests, categories.Unclassified.Requests, categories.Failed.Requests, categories.Total.Requests)
	}

	// Drill-down: the children of a parent.
	f.get(t, f.full, "/categories?"+f.period+"&parent=dev", &categories)
	if categories.Parent == nil || categories.Parent.ID != "dev" || !reflect.DeepEqual(lines(categories.Rows), []rowLine{
		{"dev.codegen", fmt.Sprintf("sessions=4 requests=6 users=4 tokens=%d mcp=0", 5*okTokens+f.failedTokens), one, 1, "3", false, false}}) ||
		categories.Total.Requests != 6 || categories.Unclassified.Requests != 0 {
		t.Errorf("children of dev = %+v total=%+v", lines(categories.Rows), categories.Total)
	}
	f.get(t, f.full, "/categories?"+f.period+"&parent=other", &categories)
	if !reflect.DeepEqual(lines(categories.Rows), []rowLine{{"other.chat", one, zero, 0.5, "null", false, false}}) ||
		workMetricsLine(categories.Unclassified) != one || categories.Total.Requests != 2 || categories.Total.Sessions != 2 {
		t.Errorf("children of other = %+v unclassified=%+v total=%+v", lines(categories.Rows), categories.Unclassified, categories.Total)
	}
	// A category the policy does not have has no level.
	f.get(t, f.full, "/categories?"+f.period+"&parent=nope", &categories)
	if categories.Parent == nil || categories.Parent.ID != "nope" || len(categories.Rows) != 0 || categories.Total.Requests != 0 {
		t.Errorf("unknown parent = %+v", categories)
	}
	// A category filter the policy does not have selects nothing, rather than
	// being read as "other".
	f.get(t, f.full, "/categories?"+f.period+"&category=nope", &categories)
	if len(categories.Rows) != 0 || categories.Total.Requests != 0 || categories.Unclassified.Requests != 0 {
		t.Errorf("unknown category filter = %+v", categories)
	}
	f.get(t, f.full, "/categories?"+f.period+"&category=dev.codegen", &categories)
	if len(categories.Rows) != 1 || categories.Rows[0].Category.ID != "dev" || categories.Rows[0].Current.Requests != 6 || categories.Total.Requests != 6 {
		t.Errorf("category filter at the top level = %+v", categories.Rows)
	}
	// By requests the share is of the level's requests.
	f.get(t, f.full, "/categories?"+f.period+"&metric=requests", &categories)
	if categories.Rows[0].Category.ID != "dev" || workFloat(categories.Rows[0].Share) != 0.6 || categories.Rows[0].Delta == nil || *categories.Rows[0].Delta != 5 {
		t.Errorf("by requests: %+v", categories.Rows[0])
	}
	// A status filter keeps the partition: only the unclassified part is left.
	f.get(t, f.full, "/categories?"+f.period+"&status=unclassified", &categories)
	if len(categories.Rows) != 0 || workMetricsLine(categories.Unclassified) != one || categories.Total.Requests != 1 {
		t.Errorf("status=unclassified: rows=%+v unclassified=%+v total=%+v", categories.Rows, categories.Unclassified, categories.Total)
	}
	// A model filter needs facts for the distinct counts and must agree with them.
	f.get(t, f.full, "/categories?"+f.period+"&model="+workAPIMiniModel, &categories)
	if got := lines(categories.Rows); len(got) != 2 || got[0].id != "dev" || got[0].current != one || got[1].id != "infra" || got[1].current != one ||
		categories.Total.Sessions != 2 || categories.Total.Requests != 2 || *categories.Total.Users != 2 {
		t.Errorf("model filter: rows=%+v total=%+v", got, categories.Total)
	}
	// A user filter reads the facts.
	f.get(t, f.full, "/categories?"+f.period+"&user=ua1", &categories)
	if got := lines(categories.Rows); len(got) != 2 || got[0].id != "dev" || got[0].current != "sessions=1 requests=2 users=1 tokens=36 mcp=0" ||
		categories.Total.Requests != 3 {
		t.Errorf("user filter: rows=%+v total=%+v", got, categories.Total)
	}
}

func TestWorkIntelAPITrendMatrixFlow(t *testing.T) {
	f := newWorkAPIFixture(t)
	twoDays := "from=" + f.prev + "&to=" + f.today

	var trend workTrendResponse
	series := func() map[string][]float64 {
		out := map[string][]float64{}
		for _, s := range trend.Series {
			out[s.Category.ID] = workPointValues(s.Values)
		}
		return out
	}
	order := func() []string {
		out := []string{}
		for _, s := range trend.Series {
			out = append(out, s.Category.ID)
		}
		return out
	}
	f.get(t, f.full, "/trend?"+twoDays, &trend)
	// Over the two days dev has five sessions, data and other two each, infra one.
	if !reflect.DeepEqual(trend.Buckets, []string{f.prev, f.today}) || !reflect.DeepEqual(order(), []string{"dev", "data", "other", "infra"}) ||
		!reflect.DeepEqual(series(), map[string][]float64{"dev": {1, 4}, "data": {1, 1}, "other": {0, 2}, "infra": {0, 1}}) ||
		!reflect.DeepEqual(workPointValues(trend.Other), []float64{0, 0}) || !reflect.DeepEqual(workPointValues(trend.Total), []float64{2, 4}) {
		t.Errorf("trend by day = buckets %v series %v other %v total %v", trend.Buckets, series(), trend.Other, trend.Total)
	}
	// The rest is counted as one group: today three sessions touched other or
	// infra (sess-a1, sess-a3, sess-b1), which is not the sum of the two rows.
	f.get(t, f.full, "/trend?"+twoDays+"&top=2", &trend)
	if !reflect.DeepEqual(order(), []string{"dev", "data"}) || !reflect.DeepEqual(workPointValues(trend.Other), []float64{0, 3}) || !reflect.DeepEqual(workPointValues(trend.Total), []float64{2, 4}) {
		t.Errorf("trend top=2 = series %v other %v total %v", series(), trend.Other, trend.Total)
	}
	// An additive metric adds up.
	f.get(t, f.full, "/trend?"+twoDays+"&metric=requests&top=1", &trend)
	if !reflect.DeepEqual(series(), map[string][]float64{"dev": {1, 6}}) || !reflect.DeepEqual(workPointValues(trend.Other), []float64{1, 4}) || !reflect.DeepEqual(workPointValues(trend.Total), []float64{2, 10}) {
		t.Errorf("trend by requests = series %v other %v total %v", series(), trend.Other, trend.Total)
	}
	// With a parent category the series are its children.
	f.get(t, f.full, "/trend?"+twoDays+"&category=dev", &trend)
	if !reflect.DeepEqual(series(), map[string][]float64{"dev.codegen": {1, 4}}) || !reflect.DeepEqual(workPointValues(trend.Total), []float64{1, 4}) {
		t.Errorf("trend of dev = series %v total %v", series(), trend.Total)
	}
	// Weeks are Seoul ISO weeks labelled by their Monday.
	f.get(t, f.full, "/trend?"+twoDays+"&bucket=week", &trend)
	monday := func(day string) string {
		parsed, _ := workIntelParseDay(day)
		return workIntelFormatDay(parsed.AddDate(0, 0, -((int(parsed.Weekday()) + 6) % 7)))
	}
	if monday(f.prev) == monday(f.today) {
		if !reflect.DeepEqual(trend.Buckets, []string{monday(f.today)}) || !reflect.DeepEqual(series()["dev"], []float64{5}) || !reflect.DeepEqual(workPointValues(trend.Total), []float64{6}) {
			t.Errorf("trend by week = buckets %v series %v total %v", trend.Buckets, series(), trend.Total)
		}
	} else if !reflect.DeepEqual(trend.Buckets, []string{monday(f.prev), monday(f.today)}) || !reflect.DeepEqual(series()["dev"], []float64{1, 4}) {
		t.Errorf("trend by week across a week boundary = buckets %v series %v", trend.Buckets, series())
	}
	if got := workIntelWeekBuckets("2026-11-27", "2026-12-08"); !reflect.DeepEqual(got, []store.WorkBucket{
		{Label: "2026-11-23", From: "2026-11-27", To: "2026-11-29"}, {Label: "2026-11-30", From: "2026-11-30", To: "2026-12-06"},
		{Label: "2026-12-07", From: "2026-12-07", To: "2026-12-08"}}) {
		t.Errorf("week buckets = %+v", got)
	}

	var matrix workMatrixResponse
	cells := func(row workMatrixRow) string {
		parts := []string{}
		for _, cell := range row.Cells {
			value := "null"
			if cell.Value != nil {
				value = fmt.Sprint(*cell.Value)
			}
			parts = append(parts, fmt.Sprintf("%s=%s/%s/%v", cell.CategoryID, value, workUsers(cell.Users), cell.Suppressed))
		}
		return row.Team + ": " + strings.Join(parts, " ")
	}
	f.get(t, f.full, "/matrix?"+f.period, &matrix)
	ids := []string{}
	for _, category := range matrix.Categories {
		ids = append(ids, category.ID)
	}
	if !reflect.DeepEqual(ids, []string{"dev", "other", "data", "infra"}) || len(matrix.Rows) != 2 ||
		cells(matrix.Rows[0]) != "alpha: dev=3/3/false other=1/1/false data=1/1/false infra=1/1/false" ||
		cells(matrix.Rows[1]) != "beta: dev=1/1/false other=1/1/false data=0/0/false infra=0/0/false" ||
		workMetricsLine(matrix.Rows[0].Total) != "sessions=3 requests=7 users=3 tokens=126 mcp=0" {
		t.Errorf("matrix = %v\n%s\n%s", ids, cells(matrix.Rows[0]), cells(matrix.Rows[1]))
	}
	// A caller who may not see small groups gets no column for a category of
	// fewer users than the minimum, and the one-user team withheld. Its total
	// and its dev cell could be recovered from alpha's by subtraction, so
	// alpha's are withheld too (TestWorkIntelSmallGroups covers the rules).
	f.get(t, f.viewer, "/matrix?"+f.period, &matrix)
	if len(matrix.Categories) != 1 || cells(matrix.Rows[0]) != "alpha: dev=null/null/true" || cells(matrix.Rows[1]) != "beta: dev=null/null/true" ||
		!matrix.Rows[0].Total.Suppressed || !matrix.Rows[1].Total.Suppressed {
		t.Errorf("matrix for a viewer =\n%s\n%s", cells(matrix.Rows[0]), cells(matrix.Rows[1]))
	}
	f.get(t, f.full, "/matrix?"+f.period+"&top=1&metric=requests", &matrix)
	if len(matrix.Categories) != 1 || cells(matrix.Rows[0]) != "alpha: dev=4/3/false" || cells(matrix.Rows[1]) != "beta: dev=2/1/false" {
		t.Errorf("matrix top=1 by requests = %s | %s", cells(matrix.Rows[0]), cells(matrix.Rows[1]))
	}

	var flow workFlowResponse
	nodes := func() map[string]float64 {
		out := map[string]float64{}
		for _, node := range flow.Nodes {
			if !strings.HasPrefix(node.ID, node.Kind+":") {
				t.Errorf("node id %q is not prefixed by its kind %q", node.ID, node.Kind)
			}
			out[node.ID] = node.Value
		}
		return out
	}
	links := func() map[string]float64 {
		out := map[string]float64{}
		for _, link := range flow.Links {
			// Links only join neighbouring columns.
			if !(strings.HasPrefix(link.Source, "team:") && strings.HasPrefix(link.Target, "category:")) &&
				!(strings.HasPrefix(link.Source, "category:") && strings.HasPrefix(link.Target, "model:")) {
				t.Errorf("link %s -> %s skips a column", link.Source, link.Target)
			}
			out[link.Source+">"+link.Target] = link.Value
		}
		return out
	}
	f.get(t, f.full, "/flow?"+f.period, &flow)
	// dev's four sessions are divided by its requests per model: 4 of 6 on
	// test-model, one each on test-mini and fail-model.
	wantLinks := map[string]float64{
		"team:alpha>category:dev": 3, "team:alpha>category:other": 1, "team:alpha>category:data": 1, "team:alpha>category:infra": 1,
		"team:beta>category:dev": 1, "team:beta>category:other": 1,
		"category:dev>model:test-model": 2.67, "category:dev>model:test-mini": 0.67, "category:dev>model:fail-model": 0.67,
		"category:other>model:test-model": 2, "category:data>model:test-model": 1, "category:infra>model:test-mini": 1,
	}
	wantNodes := map[string]float64{"team:alpha": 6, "team:beta": 2, "category:dev": 4, "category:other": 2, "category:data": 1, "category:infra": 1,
		"model:test-model": 5.67, "model:test-mini": 1.67, "model:fail-model": 0.67}
	if !reflect.DeepEqual(links(), wantLinks) || !reflect.DeepEqual(nodes(), wantNodes) {
		t.Errorf("flow =\n links %v\n nodes %v", links(), nodes())
	}
	if flow.Nodes[0].Name != "alpha" || flow.Nodes[2].Name != "소프트웨어 개발" {
		t.Errorf("node names = %+v", flow.Nodes[:3])
	}
	// The largest entry of each column keeps its node; the others share one.
	f.get(t, f.full, "/flow?"+f.period+"&top=1&metric=requests", &flow)
	if !reflect.DeepEqual(links(), map[string]float64{
		"team:alpha>category:dev": 4, "team:alpha>category:기타": 3, "team:기타>category:dev": 2, "team:기타>category:기타": 1,
		"category:dev>model:test-model": 4, "category:dev>model:기타": 2, "category:기타>model:test-model": 3, "category:기타>model:기타": 1}) ||
		!reflect.DeepEqual(nodes(), map[string]float64{"team:alpha": 7, "team:기타": 3, "category:dev": 6, "category:기타": 4, "model:test-model": 7, "model:기타": 3}) {
		t.Errorf("flow top=1 by requests =\n links %v\n nodes %v", links(), nodes())
	}
	if last := flow.Nodes[1]; last.ID != "team:기타" || last.Name != "기타" || last.Kind != "team" {
		t.Errorf("the remainder node = %+v", last)
	}
}

func TestWorkIntelAPITeamsModelsProductivity(t *testing.T) {
	f := newWorkAPIFixture(t)

	var teams workTeamsResponse
	f.get(t, f.full, "/teams?"+f.period, &teams)
	if teams.Denominators != "active_users" || len(teams.Rows) != 2 || teams.Rows[0].Team != "alpha" || teams.Rows[1].Team != "beta" {
		t.Fatalf("teams = %+v", teams)
	}
	alpha := teams.Rows[0]
	top := []string{}
	for _, category := range alpha.TopCategories {
		top = append(top, fmt.Sprintf("%s=%v/%v", category.Category.ID, category.Value, category.Share))
	}
	rising := []string{}
	for _, category := range alpha.Rising {
		rising = append(rising, fmt.Sprintf("%s+%v", category.Category.ID, category.Delta))
	}
	// alpha's sessions per top-level category are 3, 1, 1, 1 of the policy's
	// twelve; yesterday it had one dev session.
	distribution := make([]float64, len(workintel.RequiredTopLevelIDs()))
	copy(distribution, []float64{3, 1, 1, 1})
	if workMetricsLine(alpha.Current) != "sessions=3 requests=7 users=3 tokens=126 mcp=0" || !workNear(alpha.Current.CostKRW, 150) ||
		alpha.Previous == nil || workMetricsLine(*alpha.Previous) != "sessions=1 requests=1 users=1 tokens=18 mcp=0" ||
		alpha.SessionsPerUser == nil || *alpha.SessionsPerUser != 1 || alpha.Suppressed ||
		workFloat(alpha.Diversity) != workIntelRatio(workintel.Diversity(distribution)) ||
		!reflect.DeepEqual(top, []string{"dev=3/0.5", "data=1/0.1667", "infra=1/0.1667", "other=1/0.1667"}) ||
		!reflect.DeepEqual(rising, []string{"dev+2", "data+1", "infra+1"}) {
		t.Errorf("alpha = %+v\n top %v rising %v", alpha, top, rising)
	}
	beta := teams.Rows[1]
	if workMetricsLine(beta.Current) != fmt.Sprintf("sessions=1 requests=3 users=1 tokens=%d mcp=0", 36+f.failedTokens) || beta.Suppressed || len(beta.TopCategories) != 2 {
		t.Errorf("beta = %+v", beta)
	}
	// By requests the organisation is 6 dev, 2 other, 1 data, 1 infra of 10. beta
	// has 2 dev and 1 other of 3: a third of its requests are "other" against a
	// fifth overall, and it has none of data and infra against a tenth each.
	f.get(t, f.full, "/teams?"+f.period+"&metric=requests", &teams)
	if got := teams.Rows[1].Deviation; len(got) != 3 || got[0].Category.ID != "other" || got[0].TeamShare != 0.3333 || got[0].OverallShare != 0.2 ||
		got[1].Category.ID != "data" || got[1].TeamShare != 0 || got[1].OverallShare != 0.1 {
		t.Errorf("beta deviation by requests = %+v", got)
	}
	if got := teams.Rows[0].Rising; len(got) != 3 || got[0].Category.ID != "dev" || got[0].Delta != 3 {
		t.Errorf("alpha rising by requests = %+v", got)
	}
	// A team of one user says nothing about itself to a viewer; with two teams,
	// the other one would tell it by subtraction from the organisation's total.
	f.get(t, f.viewer, "/teams?"+f.period, &teams)
	for _, hidden := range teams.Rows {
		if !hidden.Suppressed || !hidden.Current.Suppressed || hidden.Current.Users != nil || hidden.SessionsPerUser != nil || hidden.Previous != nil ||
			len(hidden.TopCategories)+len(hidden.Rising)+len(hidden.Deviation) != 0 || hidden.Diversity != nil {
			t.Errorf("%s for a viewer = %+v", hidden.Team, hidden)
		}
	}

	var models workModelsResponse
	f.get(t, f.full, "/models?"+f.period, &models)
	byKey := map[string]workModelRow{}
	keys := []string{}
	for _, row := range models.Rows {
		key := row.Category.ID + "/" + row.Model
		byKey[key] = row
		keys = append(keys, key)
	}
	// Categories by requests, and within one the models by requests.
	if !reflect.DeepEqual(keys, []string{"dev/test-model", "dev/fail-model", "dev/test-mini", "other/test-model", "data/test-model", "infra/test-mini"}) {
		t.Errorf("model rows = %v", keys)
	}
	// dev on test-model: r1, r2, r4, r8 in sessions a1, =SUM(A1) and b1; a1 and b1
	// changed model. All latencies are under 500 ms, so the histogram estimates
	// the median at 250 and the 95th percentile at 475.
	if row := byKey["dev/test-model"]; row.Requests != 4 || row.Sessions != 3 || row.Share != 0.6667 || row.TokensPerSession != 24 ||
		!workNear(row.CostPerSession, 33.33) || row.ErrorRate != 0 || row.RetryRate != 0 || row.ModelSwitchRate != 0.6667 ||
		row.FeedbackPositive != 1 || row.FeedbackNegative != 0 || !row.LowSample || row.Provider != "test" ||
		row.LatencyP50MS != 250 || row.LatencyP95MS != 475 {
		t.Errorf("dev/test-model = %+v", row)
	}
	if row := byKey["dev/fail-model"]; row.Requests != 1 || row.Sessions != 1 || row.ErrorRate != 1 || row.ModelSwitchRate != 1 {
		t.Errorf("dev/fail-model = %+v", row)
	}
	if row := byKey["data/test-model"]; row.Sessions != 1 || row.Share != 1 || row.ModelSwitchRate != 0 || !workNear(row.CostPerSession, 25) {
		t.Errorf("data/test-model = %+v", row)
	}
	// Nothing here has the sample a suggestion needs.
	if len(models.Suggestions) != 0 {
		t.Errorf("suggestions without evidence = %+v", models.Suggestions)
	}

	var productivity workProductivityResponse
	f.get(t, f.full, "/productivity?"+f.period, &productivity)
	rows := map[string]workProductivityRow{}
	for _, row := range productivity.Rows {
		rows[row.Category.ID] = row
	}
	// Only sess-a1 got positive feedback; it worked on dev and infra.
	if dev := rows["dev"]; dev.Sessions != 4 || dev.ConfirmedSessions != 1 || dev.Baseline != nil || dev.EstMinutesSaved != nil || dev.EstCostSavedKRW != nil ||
		!strings.Contains(dev.Reason, "기준값") {
		t.Errorf("dev productivity = %+v", dev)
	}
	if infra, data := rows["infra"], rows["data"]; infra.ConfirmedSessions != 1 || data.Sessions != 1 || data.ConfirmedSessions != 0 || len(productivity.Rows) != 4 {
		t.Errorf("infra = %+v data = %+v rows=%d", infra, data, len(productivity.Rows))
	}
}

func TestWorkIntelAPISessionsAndRequests(t *testing.T) {
	f := newWorkAPIFixture(t)

	var sessions workSessionsResponse
	list := func(query string) []string {
		t.Helper()
		f.get(t, f.full, "/sessions?"+query, &sessions)
		out := []string{}
		for _, row := range sessions.Rows {
			out = append(out, row.SessionID)
		}
		return out
	}
	if got := list(f.period); !reflect.DeepEqual(got, []string{"sess-b1", "sess-a3", workAPIFormulaSession, "sess-a1"}) || sessions.Count != 4 || sessions.Limit != 50 || sessions.Offset != 0 {
		t.Errorf("sessions newest first = %v count=%d limit=%d", got, sessions.Count, sessions.Limit)
	}
	var a1 workSessionView
	for _, row := range sessions.Rows {
		if row.SessionID == "sess-a1" {
			a1 = row
		}
	}
	if a1.SessionKind != "explicit" || a1.Team != "alpha" || a1.User != "ua1" || a1.Client != "Claude Code" || a1.Primary.ID != "dev.codegen" ||
		len(a1.Secondary) != 1 || a1.Secondary[0].ID != "infra.k8s" || a1.Requests != 3 || a1.TokensIn != 33 || a1.TokensOut != 21 ||
		!workNear(a1.CostKRW, 62.5) || !reflect.DeepEqual(a1.Models, []string{workAPIModel, workAPIMiniModel}) || a1.ModelSwitches != 1 ||
		a1.Errors != 0 || a1.Completion != store.WorkCompletionConfirmed || a1.DurationMS != workIntelDuration(a1.FirstAt, a1.LastAt) || a1.DurationMS <= 0 {
		t.Errorf("sess-a1 = %+v", a1)
	}
	for query, want := range map[string][]string{
		f.period + "&sort=last_at:asc":                    {"sess-a1", workAPIFormulaSession, "sess-a3", "sess-b1"},
		f.period + "&sort=requests:desc&limit=2":          {"sess-a1", "sess-b1"},
		f.period + "&sort=errors:desc&limit=1":            {"sess-b1"},
		f.period + "&sort=cost_krw:asc&limit=1":           {"sess-a3"},
		f.period + "&session_status=confirmed":            {"sess-a1"},
		f.period + "&session_status=ended_with_error":     {"sess-b1"},
		f.period + "&session_status=unknown&team=alpha":   {"sess-a3", workAPIFormulaSession},
		f.period + "&category=infra":                      {"sess-a1"},
		f.period + "&category=dev&team=beta":              {"sess-b1"},
		f.period + "&model=" + workAPIMiniModel:           {"sess-a3", "sess-a1"},
		f.period + "&status=unclassified":                 {"sess-a3"},
		f.period + "&user=ua2":                            {workAPIFormulaSession},
		f.period + "&limit=2&offset=1":                    {"sess-a3", workAPIFormulaSession},
		"from=" + f.prev + "&to=" + f.prev:                {"sess-b0", "sess-a0"},
		"from=" + f.prev + "&to=" + f.today + "&user=ub1": {"sess-b1", "sess-b0"},
	} {
		if got := list(query); !reflect.DeepEqual(got, want) {
			t.Errorf("sessions?%s = %v, want %v", query, got, want)
		}
	}
	if list(f.period + "&limit=2&offset=1"); sessions.Count != 4 || sessions.Limit != 2 || sessions.Offset != 1 {
		t.Errorf("paging: count=%d limit=%d offset=%d", sessions.Count, sessions.Limit, sessions.Offset)
	}
	// The longest session by wall-clock time comes first.
	if got := list(f.period + "&sort=duration_ms:desc"); len(got) != 4 || sessions.Rows[0].DurationMS < sessions.Rows[3].DurationMS {
		t.Errorf("by duration = %v (%d .. %d)", got, sessions.Rows[0].DurationMS, sessions.Rows[3].DurationMS)
	}

	var detail workSessionDetailResponse
	f.get(t, f.full, "/sessions/sess-a1", &detail)
	segments := []string{}
	for _, segment := range detail.Segments {
		segments = append(segments, fmt.Sprintf("%s:%d:%v", segment.Category.ID, segment.Requests, segment.CostKRW))
	}
	requestIDs := []string{}
	for _, request := range detail.Requests {
		requestIDs = append(requestIDs, request.RequestID)
	}
	if detail.Session.SessionID != "sess-a1" || !reflect.DeepEqual(segments, []string{"dev.codegen:2:50", "infra.k8s:1:12.5"}) ||
		!reflect.DeepEqual(requestIDs, f.ids[0:3]) || detail.Requests[2].Category.ID != "infra.k8s" || detail.Requests[2].Model != workAPIMiniModel {
		t.Errorf("session detail = %+v segments %v requests %v", detail.Session, segments, requestIDs)
	}
	// A session id may hold characters a path treats specially.
	f.get(t, f.full, "/sessions/"+strings.ReplaceAll(workAPIFormulaSession, "=", "%3D"), &detail)
	if detail.Session.SessionID != workAPIFormulaSession || len(detail.Requests) != 2 {
		t.Errorf("session with a formula id = %+v", detail.Session)
	}
	if status, body := f.call(t, f.full, http.MethodGet, "/sessions/no-such-session", nil); status != http.StatusNotFound || workAPIErrorCode(body) != "work_session_not_found" {
		t.Errorf("unknown session = %d %s", status, body)
	}

	var requests workRequestsResponse
	ids := func(query string) []string {
		t.Helper()
		f.get(t, f.full, "/requests?"+query, &requests)
		out := []string{}
		for _, row := range requests.Rows {
			out = append(out, row.RequestID)
		}
		return out
	}
	newestFirst := func(indexes ...int) []string {
		out := []string{}
		for _, i := range indexes {
			out = append(out, f.ids[i-1])
		}
		return out
	}
	if got := ids(f.period); !reflect.DeepEqual(got, newestFirst(10, 9, 8, 7, 6, 5, 4, 3, 2, 1)) || requests.Count != 10 {
		t.Errorf("requests newest first = %v count=%d", got, requests.Count)
	}
	failed := requests.Rows[0]
	if !failed.IsError || failed.Model != workAPIFailModel || failed.Category.ID != "dev.codegen" || failed.Tokens != f.failedTokens || failed.Team != "beta" ||
		failed.User != "ub1" || failed.Method != "rule" || failed.Status != "classified" || failed.PolicyVersion != 1 || failed.WorkTitle == "" ||
		failed.Tags == nil || failed.Technologies == nil || failed.SessionID != "sess-b1" {
		t.Errorf("the failed request row = %+v", failed)
	}
	for query, want := range map[string][]string{
		f.period + "&status=unclassified":                   newestFirst(7),
		f.period + "&max_conf=0.5":                          newestFirst(7),
		f.period + "&min_conf=0.5&team=beta":                newestFirst(10, 9, 8),
		f.period + "&model=" + workAPIFailModel:             newestFirst(10),
		f.period + "&user=ua1":                              newestFirst(3, 2, 1),
		f.period + "&category=other":                        newestFirst(9, 7),
		f.period + "&category=dev.codegen&team=alpha":       newestFirst(6, 4, 2, 1),
		f.period + "&action=create&team=beta":               newestFirst(10, 8),
		f.period + "&method=manual":                         {},
		f.period + "&limit=3&offset=8":                      newestFirst(2, 1),
		"from=" + f.prev + "&to=" + f.prev:                  newestFirst(12, 11),
		f.period + "&client=Claude+Code&provider=test":      newestFirst(10, 9, 8, 7, 6, 5, 4, 3, 2, 1),
		f.period + "&client=Cursor":                         {},
		f.period + "&method=rule&status=classified&limit=2": newestFirst(10, 9),
	} {
		if got := ids(query); !reflect.DeepEqual(got, want) {
			t.Errorf("requests?%s = %v, want %v", query, got, want)
		}
	}

	var review workReviewResponse
	f.get(t, f.full, "/review", &review)
	if len(review.Rows) != 1 || review.Rows[0].RequestID != f.ids[6] || review.Count != 1 || review.Summary.Unclassified != 1 || review.Summary.Review != 0 ||
		review.Summary.Failed != 0 || review.Summary.NewCategoryHints == nil {
		t.Errorf("review queue = %+v", review)
	}
	f.get(t, f.full, "/review?status=review", &review)
	if len(review.Rows) != 0 || review.Summary.Unclassified != 1 {
		t.Errorf("review tab keeps the whole queue in its summary: %+v", review)
	}
	if status, body := f.call(t, f.full, http.MethodGet, "/review?status=classified", nil); status != http.StatusBadRequest || workAPIErrorCode(body) != "work_intel_invalid_query" {
		t.Errorf("review?status=classified = %d %s", status, body)
	}
}

// A team-scoped administrator is confined to their team in every read, and a
// caller who may not see raw prompts gets neither user identifiers nor the
// size of a small group.
func TestWorkIntelAPIScopeAndMasking(t *testing.T) {
	f := newWorkAPIFixture(t)

	t.Run("team scope", func(t *testing.T) {
		var overview workOverviewResponse
		f.get(t, f.alphaAdmin, "/overview?"+f.period, &overview)
		if !overview.Scope.TeamScoped || workMetricsLine(overview.Current.workMetrics) != "sessions=3 requests=7 users=3 tokens=126 mcp=0" ||
			overview.Current.Teams != 1 || !overview.Previous.Suppressed {
			t.Errorf("alpha overview = %+v / %+v", overview.Current, overview.Previous)
		}
		// A team-scoped administrator may not see raw prompts: alpha's one-user
		// rows are withheld, and dev with them (the withheld rows must include a
		// group of three or more, or the total less dev would describe one or two
		// people). The total is alpha's own.
		var categories workCategoriesResponse
		f.get(t, f.alphaAdmin, "/categories?"+f.period, &categories)
		for _, row := range categories.Rows {
			if !row.Suppressed {
				t.Errorf("alpha category %s is shown: %+v", row.Category.ID, row)
			}
		}
		if len(categories.Rows) != 3 || categories.Total.Requests != 7 || categories.Total.Suppressed {
			t.Errorf("alpha categories = %+v total %+v", categories.Rows, categories.Total)
		}
		// Another team cannot be asked for.
		for _, path := range []string{"/overview?team=beta", "/sessions?team=beta", "/requests?team=beta", "/export.csv?view=requests&team=beta", "/automation?team=beta"} {
			if status, body := f.call(t, f.alphaAdmin, http.MethodGet, path, nil); status != http.StatusForbidden || workAPIErrorCode(body) != "work_intel_team_forbidden" {
				t.Errorf("%s as alpha = %d %s", path, status, body)
			}
		}
		// No read mentions the other team, its sessions or its user.
		twoDays := "from=" + f.prev + "&to=" + f.today
		for _, path := range []string{"/overview?" + twoDays, "/categories?" + twoDays, "/trend?" + twoDays, "/matrix?" + twoDays, "/flow?" + twoDays,
			"/teams?" + twoDays, "/models?" + twoDays, "/trends", "/automation", "/insights", "/sessions?" + twoDays, "/requests?" + twoDays,
			"/productivity?" + twoDays, "/review", "/reclassify?" + twoDays, "/export.csv?view=sessions&" + twoDays, "/export.csv?view=requests&" + twoDays,
			"/export.csv?view=teams&" + twoDays, "/export.csv?view=categories&" + twoDays, "/export.csv?view=models&" + twoDays} {
			status, body := f.call(t, f.alphaAdmin, http.MethodGet, path, nil)
			if status != http.StatusOK {
				t.Errorf("%s as alpha = %d %s", path, status, body)
				continue
			}
			for _, leak := range []string{"beta", "sess-b", "ub1", workAPIFailModel} {
				if bytes.Contains(body, []byte(leak)) {
					t.Errorf("%s as alpha mentions %q: %s", path, leak, body)
				}
			}
		}
		var sessions workSessionsResponse
		f.get(t, f.alphaAdmin, "/sessions?"+f.period, &sessions)
		var requests workRequestsResponse
		f.get(t, f.alphaAdmin, "/requests?"+f.period, &requests)
		var teams workTeamsResponse
		f.get(t, f.alphaAdmin, "/teams?"+f.period, &teams)
		var matrix workMatrixResponse
		f.get(t, f.alphaAdmin, "/matrix?"+f.period, &matrix)
		if sessions.Count != 3 || requests.Count != 7 || len(teams.Rows) != 1 || teams.Rows[0].Team != "alpha" || len(matrix.Rows) != 1 {
			t.Errorf("alpha lists: sessions=%d requests=%d teams=%d matrix=%d", sessions.Count, requests.Count, len(teams.Rows), len(matrix.Rows))
		}
		// The other team's session does not exist for them, even by its id.
		if status, body := f.call(t, f.alphaAdmin, http.MethodGet, "/sessions/sess-b1", nil); status != http.StatusNotFound {
			t.Errorf("sess-b1 as alpha = %d %s", status, body)
		}
		if status, _ := f.call(t, f.betaAdmin, http.MethodGet, "/sessions/sess-b1", nil); status != http.StatusOK {
			t.Errorf("sess-b1 as beta = %d", status)
		}
		// The reclassification preview counts their team's facts only.
		var preview workReclassifyPreview
		f.get(t, f.alphaAdmin, "/reclassify?"+twoDays, &preview)
		if preview.Total != 8 {
			t.Errorf("alpha reclassify preview total = %d, want 8", preview.Total)
		}
		f.get(t, f.full, "/reclassify?"+twoDays, &preview)
		if preview.Total != 12 {
			t.Errorf("full reclassify preview total = %d, want 12", preview.Total)
		}
		// The candidate shows their team's share of the pattern: five of the
		// seven repeats, three of the four users.
		var automation workAutomationResponse
		f.get(t, f.alphaAdmin, "/automation", &automation)
		if automation.Count != 1 || automation.Rows[0].Repeats != 5 || *automation.Rows[0].Users != 3 || !reflect.DeepEqual(automation.Rows[0].Teams, []string{"alpha"}) {
			t.Errorf("alpha automation = %+v", automation.Rows)
		}
		f.get(t, f.full, "/automation", &automation)
		if automation.Count != 1 || automation.Rows[0].Repeats != 7 || *automation.Rows[0].Users != 4 || !reflect.DeepEqual(automation.Rows[0].Teams, []string{"alpha", "beta"}) {
			t.Errorf("full automation = %+v", automation.Rows)
		}
		// A team-scoped administrator may not change what belongs to everyone.
		for _, call := range []struct {
			method, path string
			body         any
		}{
			{http.MethodPut, "/policy", map[string]any{"config": workintel.DefaultPolicy(), "expected_revision": 1, "reason": "x"}},
			{http.MethodPost, "/policy/publish", map[string]any{"expected_revision": 1, "note": "x"}},
			{http.MethodPost, "/policy/rollback", map[string]any{"version": 1, "note": "x"}},
			{http.MethodPost, "/rebuild", map[string]any{"from": f.today, "to": f.today, "reason": "x"}},
			{http.MethodPost, "/insights/run", map[string]any{}},
		} {
			if status, body := f.call(t, f.alphaAdmin, call.method, call.path, call.body); status != http.StatusForbidden || workAPIErrorCode(body) != "work_intel_forbidden" {
				t.Errorf("%s %s as alpha = %d %s", call.method, call.path, status, body)
			}
		}
	})

	t.Run("masking", func(t *testing.T) {
		var categories workCategoriesResponse
		f.get(t, f.viewer, "/categories?"+f.period, &categories)
		state := []string{}
		for _, row := range categories.Rows {
			state = append(state, fmt.Sprintf("%s users=%s suppressed=%v", row.Category.ID, workUsers(row.Current.Users), row.Suppressed))
		}
		// dev has four users; every other row has one. Total less dev would be
		// those one-user rows together, so dev is withheld as well; withheld rows
		// are listed by id.
		if !reflect.DeepEqual(state, []string{"data users=null suppressed=true", "dev users=null suppressed=true", "infra users=null suppressed=true", "other users=null suppressed=true"}) ||
			categories.Unclassified.Users != nil || *categories.Total.Users != 4 {
			t.Errorf("viewer categories = %v unclassified=%+v", state, categories.Unclassified)
		}
		// The same rows for a caller who may see them.
		f.get(t, f.full, "/categories?"+f.period, &categories)
		for _, row := range categories.Rows {
			if row.Suppressed || row.Current.Users == nil {
				t.Errorf("full admin row %s is withheld: %+v", row.Category.ID, row)
			}
		}
		// Previous period: two users, below the minimum of three. The whole
		// period is withheld, and so is the growth computed from it.
		var overview workOverviewResponse
		f.get(t, f.viewer, "/overview?"+f.period, &overview)
		if *overview.Current.Users != 4 || overview.Current.Suppressed || !overview.Previous.Suppressed || overview.Previous.Users != nil || overview.GrowthRate != nil {
			t.Errorf("viewer overview users: current=%s previous=%s growth=%v", workUsers(overview.Current.Users), workUsers(overview.Previous.Users), overview.GrowthRate)
		}
		// By users the comparison would be computed from a withheld number.
		f.get(t, f.viewer, "/overview?"+f.period+"&metric=users", &overview)
		if overview.GrowthRate != nil {
			t.Errorf("viewer growth by users = %v", *overview.GrowthRate)
		}
		f.get(t, f.full, "/overview?"+f.period+"&metric=users", &overview)
		if overview.GrowthRate == nil || *overview.GrowthRate != 1 {
			t.Errorf("full growth by users = %v", overview.GrowthRate)
		}
		// A category of fewer users than the minimum has no series of its own;
		// it is in the rest, which here has four users.
		var trend workTrendResponse
		f.get(t, f.viewer, "/trend?"+f.period+"&metric=users", &trend)
		values := map[string][]float64{}
		for _, s := range trend.Series {
			values[s.Category.ID] = workPointValues(s.Values)
		}
		if !reflect.DeepEqual(values, map[string][]float64{"dev": {4}}) || !reflect.DeepEqual(workPointValues(trend.Other), []float64{4}) ||
			!reflect.DeepEqual(workPointValues(trend.Total), []float64{4}) {
			t.Errorf("viewer trend by users = %v other %v total %v", values, workPointValues(trend.Other), workPointValues(trend.Total))
		}
		f.get(t, f.full, "/trend?"+f.period+"&metric=users", &trend)
		if got := workPointValues(trend.Series[1].Values); !reflect.DeepEqual(got, []float64{2}) {
			t.Errorf("full trend by users, other = %v", got)
		}

		// User identifiers: the real one for a full administrator, a stable
		// pseudonym for the others.
		var sessions workSessionsResponse
		f.get(t, f.viewer, "/sessions?"+f.period, &sessions)
		pseudonyms := map[string]string{}
		for _, row := range sessions.Rows {
			if !strings.HasPrefix(row.User, workIntelUserPrefix) || len(row.User) != len(workIntelUserPrefix)+10 {
				t.Errorf("viewer sees user %q", row.User)
			}
			pseudonyms[row.SessionID] = row.User
		}
		if len(map[string]bool{pseudonyms["sess-a1"]: true, pseudonyms["sess-a3"]: true, pseudonyms["sess-b1"]: true, pseudonyms[workAPIFormulaSession]: true}) != 4 {
			t.Errorf("pseudonyms are not distinct: %v", pseudonyms)
		}
		for _, path := range []string{"/sessions?" + f.period, "/requests?" + f.period, "/sessions/sess-a1", "/review", "/export.csv?view=sessions&" + f.period,
			"/export.csv?view=requests&" + f.period} {
			for _, token := range []string{f.viewer, f.alphaAdmin} {
				status, body := f.call(t, token, http.MethodGet, path, nil)
				if status != http.StatusOK {
					t.Fatalf("%s = %d %s", path, status, body)
				}
				for _, user := range []string{"ua1", "ua2", "ua3", "ub1"} {
					if bytes.Contains(body, []byte(user)) {
						t.Errorf("%s shows the user id %q to a caller who may not see it", path, user)
					}
				}
			}
		}
		// The same user has the same pseudonym in every list.
		var requests workRequestsResponse
		f.get(t, f.viewer, "/requests?"+f.period+"&limit=1&offset=9", &requests)
		if requests.Rows[0].RequestID != f.ids[0] || requests.Rows[0].User != pseudonyms["sess-a1"] {
			t.Errorf("request user %q != session user %q", requests.Rows[0].User, pseudonyms["sess-a1"])
		}
		// Filtering by a real identifier would tell who is behind a pseudonym.
		if status, body := f.call(t, f.viewer, http.MethodGet, "/sessions?"+f.period+"&user=ua1", nil); status != http.StatusForbidden || workAPIErrorCode(body) != "work_intel_user_filter_forbidden" {
			t.Errorf("viewer filtering by a user id = %d %s", status, body)
		}
		f.get(t, f.viewer, "/sessions?"+f.period+"&user="+pseudonyms["sess-a1"], &sessions)
		if len(sessions.Rows) != 1 || sessions.Rows[0].SessionID != "sess-a1" {
			t.Errorf("viewer filtering by a pseudonym = %+v", sessions.Rows)
		}
		f.get(t, f.viewer, "/sessions?"+f.period+"&user="+workIntelUserPrefix+"0000000000", &sessions)
		if len(sessions.Rows) != 0 {
			t.Errorf("an unknown pseudonym matched %d sessions", len(sessions.Rows))
		}
		// The candidate's user count is above the minimum for the organisation,
		// and at it for the alpha team; to a team of one it does not exist.
		var automation workAutomationResponse
		f.get(t, f.betaAdmin, "/automation", &automation)
		if automation.Count != 0 || len(automation.Rows) != 0 {
			t.Errorf("beta automation = %+v", automation.Rows)
		}
	})
}

func TestWorkIntelAPIExportCSV(t *testing.T) {
	f := newWorkAPIFixture(t)
	read := func(token, query string) ([][]string, http.Header) {
		t.Helper()
		r := newWorkAPIRequest(http.MethodGet, "/export.csv?"+query, token)
		w := newWorkAPIRecorder(f, r)
		if w.Code != http.StatusOK {
			t.Fatalf("export %s = %d %s", query, w.Code, w.Body.String())
		}
		body := w.Body.Bytes()
		if !bytes.HasPrefix(body, []byte{0xEF, 0xBB, 0xBF}) {
			t.Fatalf("export %s has no byte order mark", query)
		}
		records, err := csv.NewReader(bytes.NewReader(body[3:])).ReadAll()
		if err != nil {
			t.Fatalf("export %s: %v", query, err)
		}
		return records, w.Header()
	}
	records, header := read(f.full, "view=sessions&"+f.period)
	if header.Get("Cache-Control") != "no-store" || !strings.HasPrefix(header.Get("Content-Type"), "text/csv") ||
		!strings.HasPrefix(header.Get("Content-Disposition"), "attachment; filename=work-sessions-") {
		t.Errorf("export headers = %v", header)
	}
	if len(records) != 5 || records[0][0] != "session_id" || records[0][3] != "user" {
		t.Fatalf("sessions export = %v", records)
	}
	// A session id that begins with "=" must not reach a spreadsheet as a formula.
	if records[3][0] != "'"+workAPIFormulaSession || records[3][3] != "ua2" || records[4][0] != "sess-a1" || records[4][22] != store.WorkCompletionConfirmed {
		t.Errorf("sessions export rows = %v", records[1:])
	}
	records, _ = read(f.full, "view=requests&"+f.period+"&category=data")
	if len(records) != 2 || records[1][0] != f.ids[4] || records[1][2] != "'"+workAPIFormulaSession || records[1][7] != "data.sql" || records[1][16] != "18" {
		t.Errorf("requests export = %v", records)
	}
	// The same filters as the JSON read, and its row cap.
	if records, _ = read(f.full, "view=requests&"+f.period+"&limit=3"); len(records) != 4 {
		t.Errorf("requests export with limit=3 has %d rows", len(records)-1)
	}
	records, _ = read(f.full, "view=categories&"+f.period)
	if len(records) != 8 || !reflect.DeepEqual(records[1][:6], []string{"dev", "소프트웨어 개발", "1", "4", "6", "4"}) ||
		records[5][0] != "(unclassified)" || records[5][4] != "1" || records[7][0] != "(total)" || records[7][4] != "10" {
		t.Errorf("categories export = %v", records)
	}
	// Masking is the JSON read's: a withheld user count is an empty cell.
	records, _ = read(f.viewer, "view=categories&"+f.period)
	if records[1][0] != "data" || records[1][5] != "" || records[1][13] != "true" || records[2][0] != "dev" || records[2][4] != "" ||
		records[7][0] != "(total)" || records[7][4] != "10" || records[7][5] != "4" {
		t.Errorf("categories export for a viewer = %v", records)
	}
	// The one-user team is withheld, and alpha with it: the two add up to the
	// organisation's total.
	records, _ = read(f.viewer, "view=teams&"+f.period)
	if len(records) != 3 || records[1][0] != "alpha" || records[1][1] != "" || records[1][3] != "" || records[1][10] != "true" ||
		records[2][0] != "beta" || records[2][3] != "" || records[2][10] != "true" {
		t.Errorf("teams export for a viewer = %v", records)
	}
	records, _ = read(f.full, "view=models&"+f.period)
	if len(records) != 7 || records[1][2] != workAPIModel || records[1][4] != "4" || records[1][5] != "3" {
		t.Errorf("models export = %v", records)
	}
	// Team scope applies to the file as to the screen.
	records, _ = read(f.alphaAdmin, "view=sessions&"+f.period)
	if len(records) != 4 {
		t.Errorf("sessions export for the alpha team has %d rows", len(records)-1)
	}
	if status, body := f.call(t, f.full, http.MethodGet, "/export.csv?view=nope", nil); status != http.StatusBadRequest || workAPIErrorCode(body) != "work_intel_invalid_query" {
		t.Errorf("unknown view = %d %s", status, body)
	}
	if status, _ := f.call(t, f.full, http.MethodGet, "/export.csv", nil); status != http.StatusBadRequest {
		t.Errorf("missing view = %d", status)
	}
	// Every export is in the audit log.
	audits, err := f.db.ListAdminAudit(context.Background(), 50)
	if err != nil {
		t.Fatal(err)
	}
	exports := 0
	for _, audit := range audits {
		if audit.Action == "work_intel.export" {
			exports++
			if !strings.Contains(audit.AfterValue, `"view"`) || !strings.Contains(audit.AfterValue, `"rows"`) {
				t.Errorf("export audit = %s", audit.AfterValue)
			}
		}
	}
	if exports != 8 {
		t.Errorf("%d exports were audited, want 8", exports)
	}
}

func TestWorkIntelAPIDispatch(t *testing.T) {
	f := newWorkAPIFixture(t)

	// Authorization comes first, and a write needs admin:write.
	if status, body := f.call(t, "not-a-token", http.MethodGet, "/overview", nil); status != http.StatusUnauthorized || workAPIErrorCode(body) != "invalid_api_key" {
		t.Errorf("no token = %d %s", status, body)
	}
	if status, _ := f.call(t, f.viewer, http.MethodPost, "/insights/run", map[string]any{}); status != http.StatusUnauthorized {
		t.Errorf("a read-only caller posting = %d", status)
	}
	for _, c := range []struct{ method, path, allow string }{
		{http.MethodPost, "/overview", "GET"}, {http.MethodDelete, "/policy", "GET, PUT"}, {http.MethodPut, "/reclassify", "GET, POST"},
		{http.MethodPut, "/review/correct", "POST"}, {http.MethodDelete, "/sessions/sess-a1", "GET"},
	} {
		r := newWorkAPIRequest(c.method, c.path, f.full)
		w := newWorkAPIRecorder(f, r)
		if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != c.allow || workAPIErrorCode(w.Body.Bytes()) != "method_not_allowed" ||
			w.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("%s %s = %d allow=%q %s", c.method, c.path, w.Code, w.Header().Get("Allow"), w.Body.String())
		}
	}
	for _, path := range []string{"/automation/x/y", "/automation/x", "/policy/versions/", "/reclassify/jobs/"} {
		if status, body := f.call(t, f.full, http.MethodGet, path, nil); status != http.StatusNotFound && status != http.StatusMethodNotAllowed {
			t.Errorf("GET %s = %d %s", path, status, body)
		}
	}
	for _, query := range []string{"from=2026-13-01", "from=yesterday", "to=20261101", "from=" + f.today + "&to=" + f.prev, "from=2020-01-01&to=2026-11-27",
		"compare=maybe", "metric=happiness", "limit=0", "limit=501", "offset=-1", "status=done", "method=guess", "min_conf=2", "max_conf=x",
		"min_conf=0.9&max_conf=0.1", "team=" + strings.Repeat("t", 200)} {
		if status, body := f.call(t, f.full, http.MethodGet, "/requests?"+query, nil); status != http.StatusBadRequest || workAPIErrorCode(body) != "work_intel_invalid_query" {
			t.Errorf("requests?%s = %d %s", query, status, body)
		}
	}
	for _, path := range []string{"/trend?bucket=month", "/trend?top=0", "/flow?top=1000", "/sessions?sort=name:asc", "/sessions?sort=requests:up",
		"/sessions?session_status=done", "/automation?status=classified", "/policy/versions/abc"} {
		if status, body := f.call(t, f.full, http.MethodGet, path, nil); status != http.StatusBadRequest || workAPIErrorCode(body) != "work_intel_invalid_query" {
			t.Errorf("%s = %d %s", path, status, body)
		}
	}
	// 400 days is the longest period.
	if status, _ := f.call(t, f.full, http.MethodGet, "/overview?from="+workAPIDay(-399)+"&to="+f.today, nil); status != http.StatusOK {
		t.Errorf("a 400-day period = %d", status)
	}
	if status, _ := f.call(t, f.full, http.MethodGet, "/overview?from="+workAPIDay(-400)+"&to="+f.today, nil); status != http.StatusBadRequest {
		t.Errorf("a 401-day period = %d", status)
	}

	// With analytics off the reads answer 503; the status and the policy stay.
	conf := f.admin.workIntelConf()
	conf.AnalyticsEnabled = false
	f.admin.workIntelRuntime.Store(&conf)
	for _, path := range []string{"/overview", "/categories", "/trend", "/matrix", "/flow", "/teams", "/models", "/trends", "/automation", "/insights",
		"/sessions", "/sessions/sess-a1", "/requests", "/productivity", "/export.csv?view=teams"} {
		if status, body := f.call(t, f.full, http.MethodGet, path, nil); status != http.StatusServiceUnavailable || workAPIErrorCode(body) != "work_intel_analytics_disabled" {
			t.Errorf("%s with analytics off = %d %s", path, status, body)
		}
	}
	if status, body := f.call(t, f.full, http.MethodPost, "/insights/run", map[string]any{}); status != http.StatusServiceUnavailable || workAPIErrorCode(body) != "work_intel_analytics_disabled" {
		t.Errorf("insights/run with analytics off = %d %s", status, body)
	}
	var status workIntelStatus
	f.get(t, f.full, "/status", &status)
	if status.AnalyticsEnabled || !status.ClassifyEnabled || status.PolicyVersion != 1 || status.ProcessedTotal != 12 || !status.WorkerActive || status.Backlog != 0 {
		t.Errorf("status with analytics off = %+v", status)
	}
	for _, path := range []string{"/policy", "/policy/versions", "/policy/versions/1", "/review", "/reclassify"} {
		if code, body := f.call(t, f.full, http.MethodGet, path, nil); code != http.StatusOK {
			t.Errorf("%s with analytics off = %d %s", path, code, body)
		}
	}
	conf.AnalyticsEnabled = true
	// With classification off a job cannot run; everything else still can.
	conf.ClassifyEnabled = false
	f.admin.workIntelRuntime.Store(&conf)
	if code, body := f.call(t, f.full, http.MethodPost, "/reclassify?reviewed=1", map[string]any{"revision": strings.Repeat("a", 64), "reviewed_at": "x", "reason": "x"}); code != http.StatusServiceUnavailable || workAPIErrorCode(body) != "work_intel_classify_disabled" {
		t.Errorf("reclassify with classification off = %d %s", code, body)
	}
	for _, path := range []string{"/overview", "/policy", "/reclassify", "/review"} {
		if code, _ := f.call(t, f.full, http.MethodGet, path, nil); code != http.StatusOK {
			t.Errorf("%s with classification off = %d", path, code)
		}
	}
	var overview workOverviewResponse
	f.get(t, f.full, "/overview", &overview)
	if overview.Scope.ClassifyEnabled {
		t.Errorf("scope says classification is on: %+v", overview.Scope)
	}
}

// The standard logger must be usable after any test of the package. One test
// used to leave it writing into an eight-slot channel nobody read, and the
// ninth line logged afterwards blocked its caller for good.
func TestWorkIntelStandardLoggerIsNotLeftBlocked(t *testing.T) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 32; i++ {
			slog.Default().Debug("work intel: logger probe", "line", i)
			slog.Default().Info("work intel: logger probe", "line", i)
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("logging blocked: an earlier test left the standard logger on a sink nobody reads")
	}
}
