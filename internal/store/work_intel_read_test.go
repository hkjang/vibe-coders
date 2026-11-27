package store

import (
	"context"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/workintel"
)

// The read tests use the fixture of work_intel_test.go (eight requests on two
// Seoul days, two teams) plus one handcrafted fact that called tools:
//
//	r1 alpha u1  S1 m1 dev.codegen  day1 rule  classified
//	r2 alpha u1  S1 m2 dev.codegen  day1 rule  classified   error
//	r3 alpha u1  S1 m2 infra.k8s    day1 rule  classified   retry
//	r4 alpha u1  S1 m1 dev.codegen  day1 llm   classified
//	r5 alpha kA2 S2 m1 dev.codegen  day1 rule  review
//	r6 beta  u9  S3 m3 other        day1 rule  unclassified
//	r7 beta  u9  S3 m3 data.sql     day2 cache classified   error, dlp
//	r8 beta  u9  -  m3 data.sql     day2 rule  classified
//	t1 gamma u7  S9 m1 infra.k8s    day2 rule  classified   2 MCP calls
func seedWorkReadFixture(t *testing.T, db *SQLStore) {
	t.Helper()
	_, end, _ := applyWorkFixture(t, db)
	at := workT0.Add(16 * time.Hour)
	fact := WorkClassification{
		RequestID: "t1", CreatedAt: workIntelTime(at), IngestedAt: workIntelTime(time.Now().Add(time.Minute)), SessionID: "S9", Team: "gamma", UserKey: "u7",
		APIKeyID: "kG1", Model: "m1", Provider: "p1", Client: "Cursor", Endpoint: "/v1/chat/completions",
		CategoryID: "infra.k8s", TopCategoryID: "infra", ActionType: "read", Confidence: 0.92, Method: workintel.MethodRule, Status: workintel.StatusClassified,
		Tags: []string{}, Technologies: []string{}, Fingerprint: "fpT", TokensIn: 7, TokensOut: 3, CostKRW: 1.5, LatencyMS: 2500,
		MCPCalls: 2, ToolSig: "jira/search_issues,kubectl_get",
	}
	next := WorkIntelCursor{IngestedAt: fact.IngestedAt, RequestID: fact.RequestID}
	if res, err := db.ApplyWorkIntelBatch(context.Background(), []WorkClassification{fact}, end, next); err != nil || res.Inserted != 1 {
		t.Fatalf("apply the tool fact: %+v, %v", res, err)
	}
}

func workBothDays() WorkFilter { return WorkFilter{From: workDay1, To: workDay2} }

func workSumLines(rows []WorkSums) []string {
	out := []string{}
	for _, r := range rows {
		out = append(out, fmt.Sprintf("%s|%s|%s|%s|%s|%s|%s req=%d in=%d out=%d cost=%.2f mcp=%d err=%d retry=%d lat=%d hist=%v method=%v status=%v conf=%v",
			r.Day, r.Category, r.Team, r.Model, r.Provider, r.Action, r.Client, r.Requests, r.TokensIn, r.TokensOut, r.CostKRW, r.MCPCalls,
			r.Errors, r.Retries, r.LatencyMS, r.Lat, r.Method, r.Status, r.Conf))
	}
	sort.Strings(out)
	return out
}

func workCountLines(rows []WorkCount) []string {
	out := []string{}
	for _, r := range rows {
		key := strings.Trim(strings.Join([]string{r.Day, r.Category, r.Team, r.Model}, "|"), "|")
		out = append(out, fmt.Sprintf("%s=%d", key, r.Count))
	}
	sort.Strings(out)
	return out
}

func TestWorkReadSumsFromAggregatesAndFacts(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	seedWorkReadFixture(t, db)

	total, err := db.WorkSums(ctx, workBothDays(), WorkGroup{})
	if err != nil || len(total) != 1 {
		t.Fatalf("total = %+v, %v", total, err)
	}
	// Nine requests: tokens 195 in and 83 out, 10 KRW, two errors (r2, r7), one
	// retry (r3), two MCP calls. Latencies fall into the buckets
	// <=500: r1 r5 r7 r8, <=1000: r2, <=2000: r3, <=5000: t1, <=10000: r4, >60000: r6.
	want := "|||||| req=9 in=195 out=83 cost=10.00 mcp=2 err=2 retry=1 lat=81950 hist=[4 1 1 1 1 0 0 1] method=[7 1 1 0] status=[1 1 0] conf=[2 1 1 2 3]"
	if got := workSumLines(total); got[0] != want {
		t.Errorf("total =\n %s\nwant\n %s", got[0], want)
	}

	byTeam, err := db.WorkSums(ctx, workBothDays(), WorkGroup{Dims: []WorkDim{WorkDimTeam}})
	if err != nil {
		t.Fatal(err)
	}
	requests := map[string]int64{}
	for _, row := range byTeam {
		requests[row.Team] = row.Requests
	}
	if !reflect.DeepEqual(requests, map[string]int64{"alpha": 5, "beta": 3, "gamma": 1}) {
		t.Errorf("requests by team = %v", requests)
	}

	// A fold reports stored ids under the key that stands for them and leaves
	// out the ids it does not name.
	fold := map[string]string{"dev.codegen": "dev", "infra.k8s": "dev", "data.sql": "data"}
	folded, err := db.WorkSums(ctx, workBothDays(), WorkGroup{Dims: []WorkDim{WorkDimCategory}, Fold: fold})
	if err != nil {
		t.Fatal(err)
	}
	requests = map[string]int64{}
	for _, row := range folded {
		requests[row.Category] = row.Requests
	}
	if !reflect.DeepEqual(requests, map[string]int64{"dev": 6, "data": 2}) {
		t.Errorf("folded requests = %v", requests)
	}
	// Buckets replace the day by a label.
	buckets := []WorkBucket{{Label: "week", From: workDay1, To: workDay2}}
	bucketed, err := db.WorkSums(ctx, workBothDays(), WorkGroup{Dims: []WorkDim{WorkDimDay}, Buckets: buckets})
	if err != nil || len(bucketed) != 1 || bucketed[0].Day != "week" || bucketed[0].Requests != 9 {
		t.Errorf("bucketed = %+v, %v", bucketed, err)
	}
	onlyFirst, err := db.WorkSums(ctx, workBothDays(), WorkGroup{Dims: []WorkDim{WorkDimDay}, Buckets: []WorkBucket{{Label: "one", From: workDay1, To: workDay1}}})
	if err != nil || len(onlyFirst) != 1 || onlyFirst[0].Requests != 6 {
		t.Errorf("a bucket of one day = %+v, %v", onlyFirst, err)
	}

	// A read from the facts gives exactly what the aggregates hold, whatever the
	// grouping: a condition every fact meets switches the source.
	always := 0.0
	for _, group := range []WorkGroup{
		{},
		{Dims: []WorkDim{WorkDimDay}},
		{Dims: []WorkDim{WorkDimCategory, WorkDimTeam}},
		{Dims: []WorkDim{WorkDimDay, WorkDimCategory, WorkDimTeam, WorkDimModel, WorkDimProvider, WorkDimAction, WorkDimClient}},
		{Dims: []WorkDim{WorkDimCategory, WorkDimModel}, Fold: fold},
		{Dims: []WorkDim{WorkDimDay, WorkDimTeam}, Buckets: buckets},
	} {
		fromDaily, err := db.WorkSums(ctx, workBothDays(), group)
		if err != nil {
			t.Fatal(err)
		}
		facts := workBothDays()
		facts.MinConfidence = &always
		fromFacts, err := db.WorkSums(ctx, facts, group)
		if err != nil {
			t.Fatal(err)
		}
		if a, b := workSumLines(fromDaily), workSumLines(fromFacts); !reflect.DeepEqual(a, b) || len(a) == 0 {
			t.Errorf("group %v: aggregates and facts disagree\n daily: %v\n facts: %v", group.Dims, a, b)
		}
	}

	// Filters on the aggregate's own dimensions.
	for name, c := range map[string]struct {
		filter func(*WorkFilter)
		want   int64
	}{
		"team":            {func(f *WorkFilter) { f.Teams = []string{"beta"} }, 3},
		"two teams":       {func(f *WorkFilter) { f.Teams = []string{"beta", "gamma"} }, 4},
		"scoped to none":  {func(f *WorkFilter) { f.TeamScoped = true }, 0},
		"categories":      {func(f *WorkFilter) { f.Categories = []string{"dev.codegen", "data.sql"} }, 6},
		"no category":     {func(f *WorkFilter) { f.Categories = []string{} }, 0},
		"action":          {func(f *WorkFilter) { f.Action = "create" }, 4},
		"model":           {func(f *WorkFilter) { f.Model = "m1" }, 4},
		"provider":        {func(f *WorkFilter) { f.Provider = "p2" }, 3},
		"client":          {func(f *WorkFilter) { f.Client = "Cursor" }, 1},
		"one day":         {func(f *WorkFilter) { f.To = workDay1 }, 6},
		"user":            {func(f *WorkFilter) { f.User = "u1" }, 4},
		"status":          {func(f *WorkFilter) { f.Statuses = []string{workintel.StatusReview, workintel.StatusUnclassified} }, 2},
		"method":          {func(f *WorkFilter) { f.Method = workintel.MethodLLM }, 1},
		"confidence":      {func(f *WorkFilter) { lo, hi := 0.5, 0.8; f.MinConfidence, f.MaxConfidence = &lo, &hi }, 4},
		"tool":            {func(f *WorkFilter) { f.Tool = "kubectl_get" }, 1},
		"tool of server":  {func(f *WorkFilter) { f.Tool = "search_issues" }, 1},
		"tool with path":  {func(f *WorkFilter) { f.Tool = "jira/search_issues" }, 1},
		"part of a tool":  {func(f *WorkFilter) { f.Tool = "search" }, 0},
		"tool wildcard":   {func(f *WorkFilter) { f.Tool = "%" }, 0},
		"tool underscore": {func(f *WorkFilter) { f.Tool = "kubectl-get" }, 0},
		"updated before":  {func(f *WorkFilter) { f.UpdatedThrough = workIntelTime(time.Now().Add(-time.Hour)) }, 0},
		"updated by now":  {func(f *WorkFilter) { f.UpdatedThrough = workIntelTime(time.Now().Add(time.Hour)) }, 9},
	} {
		f := workBothDays()
		c.filter(&f)
		rows, err := db.WorkSums(ctx, f, WorkGroup{})
		var got int64
		if len(rows) == 1 {
			got = rows[0].Requests
		}
		if err != nil || got != c.want {
			t.Errorf("filter %q: %d requests, want %d (%v)", name, got, c.want, err)
		}
	}
	if _, err := db.WorkSums(ctx, workBothDays(), WorkGroup{Dims: []WorkDim{"nonsense"}}); err == nil {
		t.Error("an unknown dimension was accepted")
	}
}

func TestWorkReadDistinctCounts(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	seedWorkReadFixture(t, db)
	sessions := func(f WorkFilter, g WorkGroup) []string {
		t.Helper()
		rows, err := db.WorkSessionCounts(ctx, f, g)
		if err != nil {
			t.Fatal(err)
		}
		return workCountLines(rows)
	}
	users := func(f WorkFilter, g WorkGroup) []string {
		t.Helper()
		rows, err := db.WorkUserCounts(ctx, f, g)
		if err != nil {
			t.Fatal(err)
		}
		return workCountLines(rows)
	}
	both := workBothDays()
	top := map[string]string{"dev.codegen": "dev", "infra.k8s": "infra", "data.sql": "data", "other": "other"}

	// S1, S2, S3 and S9; the request without a session id is in none.
	if got := sessions(both, WorkGroup{}); !reflect.DeepEqual(got, []string{"=4"}) {
		t.Errorf("sessions = %v", got)
	}
	// S3 was active on both days: once per day, once in the period.
	if got := sessions(both, WorkGroup{Dims: []WorkDim{WorkDimDay}}); !reflect.DeepEqual(got, []string{workDay1 + "=3", workDay2 + "=2"}) {
		t.Errorf("sessions by day = %v", got)
	}
	if got := sessions(both, WorkGroup{Dims: []WorkDim{WorkDimCategory}, Fold: top}); !reflect.DeepEqual(got, []string{"data=1", "dev=2", "infra=2", "other=1"}) {
		t.Errorf("sessions by category = %v", got)
	}
	// One group for two categories is not the sum of the two: S1 did both.
	if got := sessions(both, WorkGroup{Dims: []WorkDim{WorkDimCategory}, Fold: map[string]string{"dev.codegen": "x", "infra.k8s": "x"}}); !reflect.DeepEqual(got, []string{"x=3"}) {
		t.Errorf("sessions of a folded group = %v", got)
	}
	if got := sessions(both, WorkGroup{Dims: []WorkDim{WorkDimTeam, WorkDimCategory}, Fold: top}); !reflect.DeepEqual(got,
		[]string{"data|beta=1", "dev|alpha=2", "infra|alpha=1", "infra|gamma=1", "other|beta=1"}) {
		t.Errorf("sessions by team and category = %v", got)
	}
	if got := sessions(both, WorkGroup{Dims: []WorkDim{WorkDimDay}, Buckets: []WorkBucket{{Label: "all", From: workDay1, To: workDay2}}}); !reflect.DeepEqual(got, []string{"all=4"}) {
		t.Errorf("sessions in one bucket = %v", got)
	}
	// A model is only known per request: these come from the facts.
	model := both
	model.Model = "m1"
	if got := sessions(model, WorkGroup{}); !reflect.DeepEqual(got, []string{"=3"}) {
		t.Errorf("sessions on m1 = %v", got)
	}
	if got := sessions(both, WorkGroup{Dims: []WorkDim{WorkDimModel}}); !reflect.DeepEqual(got, []string{"m1=3", "m2=1", "m3=1"}) {
		t.Errorf("sessions by model = %v", got)
	}
	status := both
	status.Statuses = []string{workintel.StatusReview}
	if got := sessions(status, WorkGroup{Dims: []WorkDim{WorkDimCategory}, Fold: top}); !reflect.DeepEqual(got, []string{"dev=1"}) {
		t.Errorf("sessions in review = %v", got)
	}
	// The segments and the facts agree on what both can answer.
	always := 0.0
	facts := both
	facts.MinConfidence = &always
	for _, group := range []WorkGroup{{}, {Dims: []WorkDim{WorkDimDay}}, {Dims: []WorkDim{WorkDimTeam, WorkDimCategory}, Fold: top}} {
		if a, b := sessions(both, group), sessions(facts, group); !reflect.DeepEqual(a, b) {
			t.Errorf("sessions %v: segments %v, facts %v", group.Dims, a, b)
		}
		if a, b := users(both, group), users(facts, group); !reflect.DeepEqual(a, b) {
			t.Errorf("users %v: aggregate %v, facts %v", group.Dims, a, b)
		}
	}

	// u1, kA2 (a key without a user), u9 and u7.
	if got := users(both, WorkGroup{}); !reflect.DeepEqual(got, []string{"=4"}) {
		t.Errorf("users = %v", got)
	}
	if got := users(both, WorkGroup{Dims: []WorkDim{WorkDimTeam}}); !reflect.DeepEqual(got, []string{"alpha=2", "beta=1", "gamma=1"}) {
		t.Errorf("users by team = %v", got)
	}
	if got := users(both, WorkGroup{Dims: []WorkDim{WorkDimCategory}, Fold: top}); !reflect.DeepEqual(got, []string{"data=1", "dev=2", "infra=2", "other=1"}) {
		t.Errorf("users by category = %v", got)
	}
	if got := users(model, WorkGroup{Dims: []WorkDim{WorkDimTeam}}); !reflect.DeepEqual(got, []string{"alpha=2", "gamma=1"}) {
		t.Errorf("users on m1 by team = %v", got)
	}
	scoped := both
	scoped.Teams, scoped.TeamScoped = []string{"beta"}, true
	if got := append(sessions(scoped, WorkGroup{}), users(scoped, WorkGroup{})...); !reflect.DeepEqual(got, []string{"=1", "=1"}) {
		t.Errorf("sessions and users of beta = %v", got)
	}
	scoped.Teams = nil
	if got := append(sessions(scoped, WorkGroup{}), users(scoped, WorkGroup{})...); len(got) != 0 {
		t.Errorf("a caller scoped to no team sees %v", got)
	}

	first, err := db.WorkCategoryFirstDays(ctx, both)
	if err != nil || !reflect.DeepEqual(first, map[string]string{"dev.codegen": workDay1, "infra.k8s": workDay1, "other": workDay1, "data.sql": workDay2}) {
		t.Errorf("first days = %v, %v", first, err)
	}
	first, err = db.WorkCategoryFirstDays(ctx, WorkFilter{From: workDay2, To: workDay2, Teams: []string{"gamma"}})
	if err != nil || !reflect.DeepEqual(first, map[string]string{"infra.k8s": workDay2}) {
		t.Errorf("first days of gamma on day two = %v, %v", first, err)
	}
	keys, err := db.WorkUserKeys(ctx, WorkFilter{From: workDay1, To: workDay2, Teams: []string{"alpha"}}, 10)
	sort.Strings(keys)
	if err != nil || !reflect.DeepEqual(keys, []string{"kA2", "u1"}) {
		t.Errorf("user keys of alpha = %v, %v", keys, err)
	}
}

func TestWorkReadSessionsAndFacts(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	seedWorkReadFixture(t, db)
	both := workBothDays()
	list := func(q WorkSessionQuery) []string {
		t.Helper()
		rows, count, err := db.ListWorkSessions(ctx, q)
		if err != nil {
			t.Fatal(err)
		}
		out := []string{}
		for _, row := range rows {
			out = append(out, row.SessionID)
		}
		return append(out, fmt.Sprint(count))
	}
	// Newest last activity first: S9 (16h), S3 (14.5h), S2 (4m), S1 (3m).
	if got := list(WorkSessionQuery{Filter: both, Desc: true}); !reflect.DeepEqual(got, []string{"S9", "S3", "S2", "S1", "4"}) {
		t.Errorf("sessions = %v", got)
	}
	for name, c := range map[string]struct {
		query WorkSessionQuery
		want  []string
	}{
		"oldest first":   {WorkSessionQuery{Filter: both, SortBy: "last_at"}, []string{"S1", "S2", "S3", "S9", "4"}},
		"by requests":    {WorkSessionQuery{Filter: both, SortBy: "requests", Desc: true, Limit: 2}, []string{"S1", "S3", "4"}},
		"by cost":        {WorkSessionQuery{Filter: both, SortBy: "cost_krw", Desc: true, Limit: 1}, []string{"S3", "4"}},
		"by errors":      {WorkSessionQuery{Filter: both, SortBy: "errors", Desc: true, Limit: 2}, []string{"S1", "S3", "4"}},
		"by duration":    {WorkSessionQuery{Filter: both, SortBy: "duration_ms", Desc: true, Limit: 2}, []string{"S3", "S1", "4"}},
		"paged":          {WorkSessionQuery{Filter: both, Desc: true, Limit: 2, Offset: 1}, []string{"S3", "S2", "4"}},
		"ended in error": {WorkSessionQuery{Filter: both, Desc: true, Completion: WorkCompletionError}, []string{"S3", "1"}},
		// S3 began on day one and was last active on day two: it overlaps both.
		"day two":    {WorkSessionQuery{Filter: WorkFilter{From: workDay2, To: workDay2}, Desc: true}, []string{"S9", "S3", "2"}},
		"day one":    {WorkSessionQuery{Filter: WorkFilter{From: workDay1, To: workDay1}, Desc: true}, []string{"S3", "S2", "S1", "3"}},
		"team":       {WorkSessionQuery{Filter: WorkFilter{From: workDay1, To: workDay2, Teams: []string{"alpha"}}, Desc: true}, []string{"S2", "S1", "2"}},
		"no team":    {WorkSessionQuery{Filter: WorkFilter{From: workDay1, To: workDay2, TeamScoped: true}, Desc: true}, []string{"0"}},
		"user":       {WorkSessionQuery{Filter: WorkFilter{From: workDay1, To: workDay2, User: "kA2"}, Desc: true}, []string{"S2", "1"}},
		"category":   {WorkSessionQuery{Filter: WorkFilter{From: workDay1, To: workDay2, Categories: []string{"infra.k8s"}}, Desc: true}, []string{"S9", "S1", "2"}},
		"category d": {WorkSessionQuery{Filter: WorkFilter{From: workDay1, To: workDay1, Categories: []string{"data.sql"}}, Desc: true}, []string{"0"}},
		"model":      {WorkSessionQuery{Filter: WorkFilter{From: workDay1, To: workDay2, Model: "m2"}, Desc: true}, []string{"S1", "1"}},
		"status":     {WorkSessionQuery{Filter: WorkFilter{From: workDay1, To: workDay2, Statuses: []string{workintel.StatusUnclassified}}, Desc: true}, []string{"S3", "1"}},
		"tool":       {WorkSessionQuery{Filter: WorkFilter{From: workDay1, To: workDay2, Tool: "kubectl_get"}, Desc: true}, []string{"S9", "1"}},
	} {
		if got := list(c.query); !reflect.DeepEqual(got, c.want) {
			t.Errorf("sessions %s = %v, want %v", name, got, c.want)
		}
	}
	rows, _, err := db.ListWorkSessions(ctx, WorkSessionQuery{Filter: both, SortBy: "last_at"})
	if err != nil {
		t.Fatal(err)
	}
	if s1 := rows[0]; s1.Team != "alpha" || s1.UserKey != "u1" || s1.Requests != 4 || s1.Errors != 1 || s1.Retries != 1 || s1.ModelSwitches != 2 ||
		!reflect.DeepEqual(s1.Models, []string{"m1", "m2"}) || !reflect.DeepEqual(s1.CategoryCounts, map[string]int64{"dev.codegen": 3, "infra.k8s": 1}) ||
		s1.PrimaryCategoryID != "dev.codegen" || s1.Completion != WorkCompletionUnknown || s1.LatencyMS != 8800 {
		t.Errorf("S1 = %+v", s1)
	}
	if _, _, err := db.ListWorkSessions(ctx, WorkSessionQuery{Filter: WorkFilter{From: "soon", To: workDay2}}); err == nil {
		t.Error("a period that is not a day was accepted")
	}
	heads, err := db.WorkSessionHeads(ctx, "S3", nil, false)
	if err != nil || len(heads) != 1 || heads[0].Team != "beta" || !reflect.DeepEqual(heads[0].PolicyFlags, []string{WorkFlagDLP}) {
		t.Errorf("heads of S3 = %+v, %v", heads, err)
	}
	if heads, err := db.WorkSessionHeads(ctx, "S3", []string{"alpha"}, true); err != nil || len(heads) != 0 {
		t.Errorf("S3 as seen by alpha = %+v, %v", heads, err)
	}
	segments, err := db.WorkSessionSegments(ctx, "S3", "beta")
	if err != nil || len(segments) != 2 || segments[0].CategoryID != "other" || segments[0].Day != workDay1 || segments[1].CategoryID != "data.sql" || segments[1].Day != workDay2 || segments[0].CostKRW != 4 {
		t.Errorf("segments of S3 = %+v, %v", segments, err)
	}

	ids := func(facts []WorkClassification) []string {
		out := []string{}
		for _, fact := range facts {
			out = append(out, fact.RequestID)
		}
		return out
	}
	facts, count, err := db.ListWorkFacts(ctx, WorkFactQuery{Filter: both})
	if err != nil || count != 9 || !reflect.DeepEqual(ids(facts), []string{"t1", "r8", "r7", "r6", "r5", "r4", "r3", "r2", "r1"}) {
		t.Errorf("facts newest first = %v count=%d (%v)", ids(facts), count, err)
	}
	facts, count, err = db.ListWorkFacts(ctx, WorkFactQuery{Filter: both, Limit: 3, Offset: 2})
	if err != nil || count != 9 || !reflect.DeepEqual(ids(facts), []string{"r7", "r6", "r5"}) {
		t.Errorf("facts page = %v count=%d (%v)", ids(facts), count, err)
	}
	review := both
	review.Statuses = []string{workintel.StatusReview, workintel.StatusUnclassified, workintel.StatusFailed}
	facts, count, err = db.ListWorkFacts(ctx, WorkFactQuery{Filter: review})
	if err != nil || count != 2 || !reflect.DeepEqual(ids(facts), []string{"r6", "r5"}) {
		t.Errorf("review queue = %v count=%d (%v)", ids(facts), count, err)
	}
	facts, err = db.WorkSessionFacts(ctx, "S1", "alpha", 3)
	if err != nil || !reflect.DeepEqual(ids(facts), []string{"r1", "r2", "r3"}) {
		t.Errorf("facts of S1 = %v (%v)", ids(facts), err)
	}
	if facts, err = db.WorkSessionFacts(ctx, "S1", "beta", 10); err != nil || len(facts) != 0 {
		t.Errorf("facts of S1 for another team = %v (%v)", ids(facts), err)
	}

	summary, err := db.WorkFactSummary(ctx, both)
	if err != nil || summary.Total != 9 || !reflect.DeepEqual(summary.ByStatus, map[string]int64{"classified": 7, "review": 1, "unclassified": 1}) ||
		!reflect.DeepEqual(summary.ByMethod, map[string]int64{"rule": 7, "llm": 1, "cache": 1}) || summary.NeedsLLM != 2 || !reflect.DeepEqual(summary.Days, []string{workDay1, workDay2}) {
		t.Errorf("summary = %+v, %v", summary, err)
	}
	if empty, err := db.WorkFactSummary(ctx, WorkFilter{From: workDay1, To: workDay2, TeamScoped: true}); err != nil || empty.Total != 0 || len(empty.Days) != 0 {
		t.Errorf("summary for no team = %+v, %v", empty, err)
	}

	// A job walks a day in chunks and resumes after its checkpoint.
	var walked []string
	afterAt, afterID := "", ""
	for {
		page, err := db.WorkFactPage(ctx, both, workDay1, afterAt, afterID, 4)
		if err != nil {
			t.Fatal(err)
		}
		if len(page) == 0 {
			break
		}
		walked = append(walked, ids(page)...)
		afterAt, afterID = page[len(page)-1].CreatedAt, page[len(page)-1].RequestID
	}
	if !reflect.DeepEqual(walked, []string{"r1", "r2", "r3", "r4", "r5", "r6"}) {
		t.Errorf("walk of day one = %v", walked)
	}

	// r6 has no usable prompt once its prompt row is gone.
	if n, capped, err := db.WorkFactsWithoutText(ctx, both, "", nil, 0); err != nil || n != 1 || capped {
		// t1 was applied without a request behind it.
		t.Errorf("facts without text = %d, want 1 (%v)", n, err)
	}
	if _, err := db.db.ExecContext(ctx, db.bind(`DELETE FROM prompt_logs WHERE request_id IN (?, ?, ?)`), "r4", "r5", "r6"); err != nil {
		t.Fatal(err)
	}
	if n, capped, err := db.WorkFactsWithoutText(ctx, both, "", nil, 0); err != nil || n != 4 || capped {
		t.Errorf("facts without text after the purge = %d, want 4 (%v)", n, err)
	}
	// The lookup is bounded: with a cap below the selection the count is a
	// lower bound and says so.
	if n, capped, err := db.WorkFactsWithoutText(ctx, both, "", nil, 2); err != nil || n > 3 || !capped {
		t.Errorf("capped lookup = %d capped=%v (%v)", n, capped, err)
	}
	// r4 is the model's, r6 unclassified: left out when asked.
	if n, _, err := db.WorkFactsWithoutText(ctx, both, workintel.MethodLLM, []string{workintel.StatusUnclassified, workintel.StatusFailed}, 0); err != nil || n != 2 {
		t.Errorf("classified rule facts without text = %d, want 2 (%v)", n, err)
	}
	hinted := WorkClassificationChange{RequestID: "r5"}
	hinted.SetResult(workintel.Result{CategoryID: "other", Method: workintel.MethodLLM, Status: workintel.StatusReview, NewCategoryHint: "legal.contract"}, 1, "judge")
	if _, err := db.UpdateWorkClassifications(ctx, []WorkClassificationChange{hinted}); err != nil {
		t.Fatal(err)
	}
	hints, err := db.WorkCategoryHints(ctx, review, 5)
	if err != nil || !reflect.DeepEqual(hints, []WorkHintCount{{Hint: "legal.contract", Count: 1}}) {
		t.Errorf("hints = %+v, %v", hints, err)
	}
}

func TestWorkReadModelsPatternsAndGeneration(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	seedWorkReadFixture(t, db)
	both := workBothDays()
	top := map[string]string{"dev.codegen": "dev", "infra.k8s": "infra", "data.sql": "data", "other": "other"}

	for _, feedback := range []LLMFeedback{
		{ID: "f1", RequestID: "r1", TraceID: "t", Rating: 1, Label: "good", Source: "test"},
		{ID: "f2", RequestID: "r4", TraceID: "t", Rating: -1, Label: "bad", Source: "test"},
		{ID: "f3", RequestID: "r7", TraceID: "t", Rating: -1, Label: "bad", Source: "test"},
	} {
		if err := db.InsertLLMFeedback(ctx, feedback); err != nil {
			t.Fatal(err)
		}
	}
	models, err := db.WorkModelSessions(ctx, both, top)
	if err != nil {
		t.Fatal(err)
	}
	lines := []string{}
	for _, m := range models {
		lines = append(lines, fmt.Sprintf("%s/%s/%s sessions=%d switched=%d", m.Category, m.Model, m.Provider, m.Sessions, m.Switched))
	}
	sort.Strings(lines)
	// S1 switched models twice; it is the only session that did.
	if !reflect.DeepEqual(lines, []string{"data/m3/p2 sessions=1 switched=0", "dev/m1/p1 sessions=2 switched=1", "dev/m2/p1 sessions=1 switched=1",
		"infra/m1/p1 sessions=1 switched=0", "infra/m2/p1 sessions=1 switched=1", "other/m3/p2 sessions=1 switched=0"}) {
		t.Errorf("model sessions = %v", lines)
	}
	feedback, err := db.WorkModelFeedback(ctx, both, top)
	if err != nil {
		t.Fatal(err)
	}
	lines = lines[:0]
	for _, f := range feedback {
		lines = append(lines, fmt.Sprintf("%s/%s +%d -%d", f.Category, f.Model, f.Positive, f.Negative))
	}
	sort.Strings(lines)
	if !reflect.DeepEqual(lines, []string{"data/m3 +0 -1", "dev/m1 +1 -1"}) {
		t.Errorf("model feedback = %v", lines)
	}
	if scoped, err := db.WorkModelSessions(ctx, WorkFilter{From: workDay1, To: workDay2, Teams: []string{"gamma"}, TeamScoped: true}, top); err != nil || len(scoped) != 1 || scoped[0].Category != "infra" {
		t.Errorf("model sessions of gamma = %+v, %v", scoped, err)
	}

	// Positive feedback on r1 confirms S1.
	if _, err := db.SyncWorkSessionFeedback(ctx, time.Now().Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	for name, filter := range map[string]WorkFilter{"segments": both, "facts": func() WorkFilter { f := both; lo := 0.0; f.MinConfidence = &lo; return f }()} {
		rows, err := db.WorkCategorySessions(ctx, filter, top)
		if err != nil {
			t.Fatal(err)
		}
		lines = lines[:0]
		for _, r := range rows {
			lines = append(lines, fmt.Sprintf("%s sessions=%d confirmed=%d ms=%d", r.Category, r.Sessions, r.Confirmed, r.ModelTimeMS))
		}
		sort.Strings(lines)
		if !reflect.DeepEqual(lines, []string{"data sessions=1 confirmed=0 ms=50", "dev sessions=2 confirmed=1 ms=7400", "infra sessions=2 confirmed=1 ms=4000", "other sessions=1 confirmed=0 ms=70000"}) {
			t.Errorf("category sessions from %s = %v", name, lines)
		}
	}

	// fpA repeats in dev.codegen (r1, r5) and fpZ in data.sql (r7, r8); fpB is
	// one request each in two categories and is no pattern.
	patterns, err := db.WorkPatterns(ctx, workDay1, workDay2, 2, 10)
	if err != nil || len(patterns) != 2 {
		t.Fatalf("patterns = %+v, %v", patterns, err)
	}
	byPrint := map[string]WorkPattern{}
	for _, p := range patterns {
		byPrint[p.Fingerprint] = p
	}
	if p := byPrint["fpA"]; p.CategoryID != "dev.codegen" || p.ActionType != "create" || p.Total.Repeats != 2 || p.Total.Users != 2 || p.Total.Sessions != 2 ||
		p.Total.ActiveDays != 1 || p.Total.CostKRW != 1.25 || p.Total.LatencyMS != 500 || p.Total.Flagged != 0 || len(p.Teams) != 1 || p.Teams[0].Team != "alpha" ||
		p.Teams[0].Repeats != 2 || len(p.Tools) != 0 || p.SameToolSequence != 2 || p.HourConcentration != 1 {
		t.Errorf("fpA = %+v", p)
	}
	// r8 has no session; r7 was touched by DLP. The two fell in different hours.
	if p := byPrint["fpZ"]; p.CategoryID != "data.sql" || p.Total.Repeats != 2 || p.Total.Users != 1 || p.Total.Sessions != 1 || p.Total.Flagged != 1 ||
		p.HourConcentration != 0.5 || p.Teams[0].Team != "beta" {
		t.Errorf("fpZ = %+v", p)
	}
	// The same counts are kept per team, so a view of some teams can be
	// described by their requests alone; they add up to the pattern.
	for _, p := range patterns {
		var actions, hours, sigs int64
		for _, team := range p.Teams {
			for _, counts := range []struct {
				into *int64
				from map[string]int64
			}{{&actions, team.Actions}, {&hours, team.Hours}, {&sigs, team.ToolSigs}} {
				for _, n := range counts.from {
					*counts.into += n
				}
			}
		}
		if actions != p.Total.Repeats || hours != p.Total.Repeats || sigs != p.Total.Repeats {
			t.Errorf("%s per-team counts: actions %d hours %d tool sets %d of %d repeats (%+v)", p.Fingerprint, actions, hours, sigs, p.Total.Repeats, p.Teams)
		}
	}
	if a := byPrint["fpA"].Teams[0]; !reflect.DeepEqual(a.Actions, map[string]int64{"create": 2}) || len(a.Hours) != 1 {
		t.Errorf("fpA alpha details = %+v", a)
	}
	if z := byPrint["fpZ"].Teams[0]; len(z.Hours) != 2 {
		t.Errorf("fpZ beta hours = %+v", z.Hours)
	}
	if few, err := db.WorkPatterns(ctx, workDay1, workDay2, 3, 10); err != nil || len(few) != 0 {
		t.Errorf("patterns of three repeats = %+v, %v", few, err)
	}
	if day, err := db.WorkPatterns(ctx, workDay1, workDay1, 2, 10); err != nil || len(day) != 1 || day[0].Fingerprint != "fpA" {
		t.Errorf("patterns of day one = %+v, %v", day, err)
	}
	tool, err := db.WorkPatterns(ctx, workDay2, workDay2, 2, 10)
	if err != nil || len(tool) != 1 || tool[0].Fingerprint != "fpZ" {
		t.Errorf("patterns of day two = %+v, %v", tool, err)
	}

	// A generation replaces the one before it; a candidate that persists keeps
	// its review.
	at := time.Now()
	if err := db.ReplaceWorkGeneration(ctx, at, []WorkAutomationCandidate{{ID: "a", PayloadJSON: `{"v":1}`}, {ID: "b", PayloadJSON: `{"v":1}`}},
		[]WorkInsightRow{{ID: "ins-000", Kind: "new", Severity: "info", Title: "first", EvidenceJSON: "{}", LinkJSON: "{}"}, {ID: "ins-001", Kind: "x", EvidenceJSON: "{}", LinkJSON: "{}"}}); err != nil {
		t.Fatal(err)
	}
	if reviewed, ok, err := db.SetWorkAutomationReview(ctx, "a", WorkReviewAccepted, "note", "admin"); err != nil || !ok || reviewed.ReviewStatus != WorkReviewAccepted || reviewed.ReviewedBy != "admin" || reviewed.ReviewedAt == "" {
		t.Fatalf("review = %+v %v %v", reviewed, ok, err)
	}
	if _, ok, err := db.SetWorkAutomationReview(ctx, "zzz", WorkReviewAccepted, "", "admin"); err != nil || ok {
		t.Errorf("review of an unknown candidate: ok=%v err=%v", ok, err)
	}
	later := at.Add(time.Second)
	if err := db.ReplaceWorkGeneration(ctx, later, []WorkAutomationCandidate{{ID: "a", PayloadJSON: `{"v":2}`}, {ID: "c", PayloadJSON: `{"v":2}`}},
		[]WorkInsightRow{{ID: "ins-000", Kind: "declining", Severity: "notice", Title: "second", EvidenceJSON: "{}", LinkJSON: "{}"}}); err != nil {
		t.Fatal(err)
	}
	candidates, err := db.ListWorkAutomationCandidates(ctx)
	if err != nil || len(candidates) != 2 || candidates[0].ID != "a" || candidates[0].PayloadJSON != `{"v":2}` || candidates[0].ReviewStatus != WorkReviewAccepted ||
		candidates[0].ReviewNote != "note" || candidates[0].ComputedAt != workIntelTime(later) || candidates[1].ID != "c" || candidates[1].ReviewStatus != WorkReviewNew {
		t.Errorf("candidates after the second generation = %+v, %v", candidates, err)
	}
	insights, err := db.ListWorkInsights(ctx)
	if err != nil || len(insights) != 1 || insights[0].Title != "second" || insights[0].CreatedAt != workIntelTime(later) {
		t.Errorf("insights after the second generation = %+v, %v", insights, err)
	}
	if err := db.ReplaceWorkGeneration(ctx, later.Add(time.Second), nil, nil); err != nil {
		t.Fatal(err)
	}
	if candidates, _ := db.ListWorkAutomationCandidates(ctx); len(candidates) != 0 {
		t.Errorf("an empty generation left candidates: %+v", candidates)
	}
	if err := db.ReplaceWorkGeneration(ctx, later, []WorkAutomationCandidate{{PayloadJSON: "{}"}}, nil); err == nil {
		t.Error("a candidate without an id was stored")
	}
}
