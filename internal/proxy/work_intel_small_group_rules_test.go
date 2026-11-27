package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
	"vibe-coders/internal/workintel"
)

// The small-group guard as a display safeguard: no number shown in one
// response, or recoverable from a simple pair of reads of the same endpoint,
// describes 1..k-1 people. These cases were found by a review that turned every
// number an unprivileged caller is shown into a linear equation; each test
// below is one of its demonstrations, asserting the fix. Facts are written
// straight through the store, so every count is chosen by hand.

// workSeedFact is a run of identical classified requests.
type workSeedFact struct {
	day, team, user, cat, model, status string
	method                              string
	conf                                float64
	n                                   int
	tokens                              int64
	cost                                float64
}

// workSeedFacts writes facts through the batch the worker uses, so the
// aggregates are maintained as in production.
func workSeedFacts(t testing.TB, db *store.SQLStore, facts []workSeedFact) {
	t.Helper()
	ctx := context.Background()
	cursor, err := db.InitWorkIntelCursor(ctx, time.Now().Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if state, err := db.GetWorkIntelState(ctx); err == nil && state.Cursor.IngestedAt != "" {
		cursor = state.Cursor
	}
	ingested := time.Now().Add(-30 * time.Minute)
	batch := []store.WorkClassification{}
	flush := func() {
		if len(batch) == 0 {
			return
		}
		last := batch[len(batch)-1]
		next := store.WorkIntelCursor{IngestedAt: last.IngestedAt, RequestID: last.RequestID}
		if res, err := db.ApplyWorkIntelBatch(ctx, batch, cursor, next); err != nil || res.Inserted != len(batch) {
			t.Fatalf("apply batch: %+v, %v", res, err)
		}
		cursor, batch = next, batch[:0]
	}
	seq := 0
	for _, f := range facts {
		day, err := time.ParseInLocation("2006-01-02", f.day, workIntelSeoul)
		if err != nil {
			t.Fatal(err)
		}
		n := max(f.n, 1)
		for i := 0; i < n; i++ {
			seq++
			ingested = ingested.Add(time.Microsecond)
			fact := store.WorkClassification{
				RequestID: fmt.Sprintf("sg-req-%06d", seq), CreatedAt: day.Add(12*time.Hour + time.Duration(seq)*time.Millisecond).UTC().Format("2006-01-02T15:04:05.000000000Z"),
				IngestedAt: ingested.UTC().Format("2006-01-02T15:04:05.000000000Z"), SessionID: "s-" + f.team + "-" + f.user + "-" + f.day,
				Team: f.team, UserKey: f.user, APIKeyID: "key-" + f.team + "-" + f.user, Model: workSeedOr(f.model, "m-large"), Provider: "p1",
				Client: "Claude Code", Endpoint: "/v1/chat/completions", CategoryID: f.cat, ActionType: "create",
				Confidence: 0.8, Method: workSeedOr(f.method, workintel.MethodRule), Status: workSeedOr(f.status, workintel.StatusClassified),
				Tags: []string{}, Technologies: []string{}, Fingerprint: fmt.Sprintf("fp-%d", seq), TokensIn: 100, CostKRW: 10, LatencyMS: 1000,
			}
			if f.tokens > 0 {
				fact.TokensIn = f.tokens
			}
			if f.cost > 0 {
				fact.CostKRW = f.cost
			}
			if f.conf > 0 {
				fact.Confidence = f.conf
			}
			if fact.Status == workintel.StatusUnclassified || fact.Status == workintel.StatusFailed {
				fact.Confidence = 0
			}
			if batch = append(batch, fact); len(batch) == store.WorkIntelMaxBatch {
				flush()
			}
		}
	}
	flush()
}

func workSeedOr(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

// workSetMinGroup makes the API server classify and present with min_group_size k.
func workSetMinGroup(t testing.TB, s *Server, k int) {
	t.Helper()
	policy := workintel.DefaultPolicy()
	policy.Thresholds.MinGroupSize = k
	engine, issues := workintel.Compile(policy)
	if len(issues) > 0 {
		t.Fatalf("compile: %+v", issues)
	}
	s.workIntel.engine.Store(&workIntelEngineSnapshot{engine: engine, version: 1, checkedAt: time.Now().Add(time.Hour), maxInputChars: 4000})
}

func workSeedUsers(prefix string, n int) []string {
	out := []string{}
	for i := 1; i <= n; i++ {
		out = append(out, fmt.Sprintf("%s%d", prefix, i))
	}
	return out
}

type workSeedEnv struct {
	*workAPIEnv
	day, period string
}

// newWorkSeedEnv seeds a Wednesday of last week with min_group_size 3.
func newWorkSeedEnv(t *testing.T, facts func(day string) []workSeedFact) *workSeedEnv {
	t.Helper()
	env := newWorkAPIEnv(t)
	workSetMinGroup(t, env.admin, 3)
	today, _ := workIntelParseDay(workAPIToday())
	monday := today.AddDate(0, 0, -((int(today.Weekday())+6)%7)-7)
	day := workIntelFormatDay(monday.AddDate(0, 0, 2))
	workSeedFacts(t, env.db, facts(day))
	return &workSeedEnv{workAPIEnv: env, day: day, period: "from=" + day + "&to=" + day + "&compare=none"}
}

func (e *workSeedEnv) json(t *testing.T, token, path string) map[string]any {
	t.Helper()
	status, body := e.call(t, token, http.MethodGet, path, nil)
	if status != http.StatusOK {
		t.Fatalf("GET %s = %d %s", path, status, body)
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func workJSONRows(v any) []any {
	rows, _ := v.([]any)
	return rows
}

func workJSONNumber(v any) float64 {
	if n, ok := v.(float64); ok {
		return n
	}
	return -1
}

// Two withheld rows can be one person: total less what is shown must leave a
// group of at least min_group_size people.
func TestWorkIntelGuardCountsPeople(t *testing.T) {
	e := newWorkSeedEnv(t, func(day string) []workSeedFact {
		out := []workSeedFact{}
		for _, u := range workSeedUsers("ua", 5) {
			out = append(out, workSeedFact{day: day, team: "alpha", user: u, cat: "dev.codegen", n: 2})
		}
		out = append(out,
			workSeedFact{day: day, team: "alpha", user: "ua1", cat: "data.sql", n: 3},
			workSeedFact{day: day, team: "alpha", user: "ua1", cat: "infra.server", n: 4},
			// beta and zeta are the same single person.
			workSeedFact{day: day, team: "beta", user: "ux", cat: "dev.codegen", n: 6},
			workSeedFact{day: day, team: "zeta", user: "ux", cat: "security.vuln", n: 2})
		for _, u := range workSeedUsers("uc", 3) {
			out = append(out, workSeedFact{day: day, team: "gamma", user: u, cat: "office.email", n: 1})
		}
		return out
	})
	// alpha's data and infra rows are both ua1's: dev is withheld with them.
	view := e.json(t, e.alphaAdmin, "/categories?"+e.period+"&metric=requests")
	shown := 0.0
	for _, row := range workJSONRows(view["rows"]) {
		if n := workJSONNumber(workJSONPath(row, "current", "requests")); n >= 0 {
			shown += n
		}
	}
	if total := workJSONNumber(workJSONPath(view, "total", "requests")); total != 17 || total-shown == 7 {
		t.Errorf("alpha categories: total %v less shown %v = ua1's requests", total, shown)
	}
	// beta and zeta are withheld; so is gamma, the smallest team of three.
	teams := e.json(t, e.viewer, "/teams?"+e.period+"&metric=requests")
	state, sum := []string{}, 0.0
	for _, row := range workJSONRows(teams["rows"]) {
		state = append(state, fmt.Sprintf("%v/%v", workJSONPath(row, "team"), workJSONPath(row, "suppressed")))
		if n := workJSONNumber(workJSONPath(row, "current", "requests")); n >= 0 {
			sum += n
		}
	}
	org := workJSONNumber(workJSONPath(e.json(t, e.viewer, "/overview?"+e.period), "current", "requests"))
	if strings.Join(state, " ") != "alpha/false beta/true gamma/true zeta/true" || org-sum != 11 {
		t.Errorf("viewer teams = %v; /overview %v less shown %v", state, org, sum)
	}
}

// Which member is withheld as the complement does not depend on the metric:
// two reads in different metrics would otherwise withhold different rows.
func TestWorkIntelGuardPickIgnoresMetric(t *testing.T) {
	e := newWorkSeedEnv(t, func(day string) []workSeedFact {
		out := []workSeedFact{}
		for _, u := range workSeedUsers("ua", 5) {
			out = append(out, workSeedFact{day: day, team: "alpha", user: u, cat: "dev.codegen", n: 4, tokens: 100})
		}
		for _, u := range workSeedUsers("uc", 3) {
			out = append(out, workSeedFact{day: day, team: "gamma", user: u, cat: "data.sql", n: 1, tokens: 3000})
		}
		for _, u := range workSeedUsers("ue", 3) {
			out = append(out, workSeedFact{day: day, team: "eps", user: u, cat: "office.email", n: 2, tokens: 10})
		}
		return append(out, workSeedFact{day: day, team: "beta", user: "ub1", cat: "infra.server", n: 1, tokens: 50, cost: 33})
	})
	withheld := func(path, key string) map[string]string {
		out := map[string]string{}
		for _, metric := range []string{"sessions", "requests", "tokens", "cost", "users"} {
			ids := []string{}
			for _, row := range workJSONRows(e.json(t, e.viewer, path+"&metric="+metric)["rows"]) {
				if workJSONPath(row, "suppressed") == true {
					id := workJSONPath(row, key)
					if key == "category" {
						id = workJSONPath(row, "category", "id")
					}
					ids = append(ids, fmt.Sprint(id))
				}
			}
			sort.Strings(ids)
			out[metric] = strings.Join(ids, ",")
		}
		return out
	}
	// The fewest users, then the fewest requests: data (three users, three requests).
	for metric, ids := range withheld("/categories?"+e.period, "category") {
		if ids != "data,infra" {
			t.Errorf("categories withheld with metric=%s: %s", metric, ids)
		}
	}
	for metric, ids := range withheld("/teams?"+e.period, "team") {
		if ids != "beta,gamma" {
			t.Errorf("teams withheld with metric=%s: %s", metric, ids)
		}
	}
}

// The overview's status, method and confidence distributions are request
// counts of buckets nobody checked: not given to an unprivileged caller.
func TestWorkIntelOverviewDistributionsWithheld(t *testing.T) {
	e := newWorkSeedEnv(t, func(day string) []workSeedFact {
		out := []workSeedFact{}
		for _, u := range workSeedUsers("uc", 3) {
			out = append(out, workSeedFact{day: day, team: "gamma", user: u, cat: "data.sql", n: 3})
		}
		return append(out,
			workSeedFact{day: day, team: "gamma", user: "uc1", cat: "other", status: workintel.StatusFailed, n: 2},
			workSeedFact{day: day, team: "gamma", user: "uc2", cat: "dev.codegen", method: workintel.MethodLLM, conf: 0.55})
	})
	view := e.json(t, e.viewer, "/overview?"+e.period+"&team=gamma")
	if len(workJSONRows(view["statuses"]))+len(workJSONRows(view["methods"]))+len(workJSONRows(view["confidence"])) != 0 ||
		workJSONNumber(workJSONPath(view, "current", "requests")) != 12 || workJSONPath(view, "scope", "small_groups_withheld") != true {
		t.Errorf("viewer overview = %v", view)
	}
	var full workOverviewResponse
	e.get(t, e.full, "/overview?"+e.period+"&team=gamma", &full)
	failed := int64(-1)
	for _, s := range full.Statuses {
		if s.Status == workintel.StatusFailed {
			failed = s.Requests
		}
	}
	if failed != 2 || len(full.Methods) != 4 || full.Scope.SmallGroupsWithheld {
		t.Errorf("full overview statuses=%+v methods=%+v", full.Statuses, full.Methods)
	}
}

// The organisation's figures of a candidate less one team's must not be a
// small team's: an unprivileged caller is not shown a small team's part.
func TestWorkIntelAutomationDropsSmallTeamParts(t *testing.T) {
	env := newWorkAPIEnv(t)
	workSetMinGroup(t, env.admin, 3)
	team := func(name string, repeats, users int64) store.WorkPatternStats {
		return store.WorkPatternStats{Team: name, Repeats: repeats, Users: users, Sessions: repeats, ActiveDays: 5, MCPCalls: repeats,
			LatencyMS: 1000 * repeats, CostKRW: 10 * float64(repeats), Actions: map[string]int64{"create": repeats}, ToolSigs: map[string]int64{},
			Hours: map[string]int64{"01": repeats}}
	}
	raw, _ := json.Marshal(workCandidatePayload{CategoryID: "infra.server", ActionType: "create", PeriodFrom: workAPIDay(-29), PeriodTo: workAPIToday(),
		WindowDays: 30, Total: store.WorkPatternStats{Repeats: 21, Users: 4, Sessions: 21, ActiveDays: 5, MCPCalls: 21, LatencyMS: 21000, CostKRW: 210},
		Teams: []store.WorkPatternStats{team("alpha", 12, 3), team("beta", 9, 1)}, Tools: []string{}, HourConcentration: 0.9})
	if err := env.db.ReplaceWorkGeneration(context.Background(), time.Now(), []store.WorkAutomationCandidate{{ID: "auto_x", PayloadJSON: string(raw),
		ReviewStatus: store.WorkReviewNew}}, nil); err != nil {
		t.Fatal(err)
	}
	var all, alpha, beta, full workAutomationResponse
	env.get(t, env.viewer, "/automation", &all)
	env.get(t, env.viewer, "/automation?team=alpha", &alpha)
	env.get(t, env.viewer, "/automation?team=beta", &beta)
	env.get(t, env.full, "/automation", &full)
	if len(all.Rows) != 1 || len(alpha.Rows) != 1 || len(beta.Rows) != 0 || strings.Join(all.Rows[0].Teams, ",") != "alpha" ||
		all.Rows[0].Repeats != alpha.Rows[0].Repeats || all.Rows[0].CostKRW != alpha.Rows[0].CostKRW || all.Rows[0].Sessions != alpha.Rows[0].Sessions {
		t.Errorf("viewer automation = %+v; ?team=alpha %+v; ?team=beta %+v", all.Rows, alpha.Rows, beta.Rows)
	}
	if len(full.Rows) != 1 || full.Rows[0].Repeats != 21 || strings.Join(full.Rows[0].Teams, ",") != "alpha,beta" {
		t.Errorf("full automation = %+v", full.Rows)
	}
}

// A concentration states a category's total and one team's (model's) part:
// the rest is every other team (model) together, which must not be a small group.
func TestWorkIntelConcentrationNeedsLargeRest(t *testing.T) {
	env := newWorkAPIEnv(t)
	workSetMinGroup(t, env.admin, 3)
	today := workAPIToday()
	facts := []workSeedFact{}
	for i := 0; i < 9; i++ {
		for _, u := range workSeedUsers("uc", 3) {
			facts = append(facts, workSeedFact{day: workIntelShiftDay(today, -i), team: "gamma", user: u, cat: "data.sql", model: "m-large"})
		}
	}
	facts = append(facts, workSeedFact{day: today, team: "beta", user: "ub1", cat: "data.sql", model: "m-small", n: 3})
	for _, u := range workSeedUsers("ua", 3) {
		facts = append(facts, workSeedFact{day: today, team: "alpha", user: u, cat: "dev.codegen"})
	}
	workSeedFacts(t, env.db, facts)
	kinds := func(token, path string) []string {
		var trends workTrendsResponse
		env.get(t, token, path, &trends)
		out := []string{}
		for _, s := range trends.Signals {
			out = append(out, s.Kind+"/"+s.Category.ID)
		}
		sort.Strings(out)
		return out
	}
	concentration := func(list []string) bool {
		for _, kind := range list {
			if strings.HasPrefix(kind, workintel.SignalTeamConcentrated) || strings.HasPrefix(kind, workintel.SignalModelDependence) {
				return true
			}
		}
		return false
	}
	if full := kinds(env.full, "/trends"); !concentration(full) {
		t.Fatalf("the fixture yields no concentration signal for a full administrator: %v", full)
	}
	if viewer := kinds(env.viewer, "/trends"); concentration(viewer) {
		t.Errorf("viewer trends = %v", viewer)
	}

	// The insights: generated for the organisation, then read by both.
	env.do(t, env.full, http.MethodPost, "/insights/run", map[string]any{}, nil)
	insightKinds := func(token string) map[string]bool {
		var insights workInsightsResponse
		env.get(t, token, "/insights", &insights)
		out := map[string]bool{}
		for _, row := range insights.Rows {
			out[row.Kind] = true
		}
		return out
	}
	full, viewer := insightKinds(env.full), insightKinds(env.viewer)
	if !full[workIntelInsightModelMix] {
		t.Fatalf("the fixture yields no model-mix insight for a full administrator: %v", full)
	}
	for _, kind := range []string{workIntelInsightModelMix, workIntelInsightModelCost, workintel.SignalTeamConcentrated, workintel.SignalModelDependence} {
		if viewer[kind] {
			t.Errorf("viewer insights include %s: %v", kind, viewer)
		}
	}
}

// Which categories and models a one-user team used is not shown either.
func TestWorkIntelSmallTeamPresenceWithheld(t *testing.T) {
	e := newWorkSeedEnv(t, func(day string) []workSeedFact {
		out := []workSeedFact{
			{day: day, team: "beta", user: "ub1", cat: "security.vuln", model: "m-local", n: 4},
			{day: day, team: "beta", user: "ub1", cat: "dev.codegen", model: "m-local", n: 1},
		}
		for _, u := range workSeedUsers("ua", 5) {
			out = append(out, workSeedFact{day: day, team: "alpha", user: u, cat: "dev.codegen"}, workSeedFact{day: day, team: "alpha", user: u, cat: "data.sql"},
				workSeedFact{day: day, team: "alpha", user: u, cat: "security.vuln"})
		}
		return out
	})
	for _, row := range workJSONRows(e.json(t, e.viewer, "/matrix?"+e.period)["rows"]) {
		if workJSONPath(row, "team") != "beta" {
			continue
		}
		for _, cell := range workJSONRows(workJSONPath(row, "cells")) {
			if workJSONPath(cell, "suppressed") != true || workJSONPath(cell, "value") != nil {
				t.Errorf("beta matrix cell %v is told apart from the others", cell)
			}
		}
	}
	scope := e.period + "&team=beta"
	categories := e.json(t, e.viewer, "/categories?"+scope)
	if len(workJSONRows(categories["rows"])) != 0 || !workWithheldMetrics(categories["total"]) || !workWithheldMetrics(categories["unclassified"]) {
		t.Errorf("viewer /categories?team=beta = %v", categories)
	}
	for _, path := range []string{"/models?", "/productivity?"} {
		view := e.json(t, e.viewer, path+scope)
		if len(workJSONRows(view["rows"])) != 0 || view["suppressed"] != true {
			t.Errorf("viewer %steam=beta = %v", path, view)
		}
	}
	trend := e.json(t, e.viewer, "/trend?"+scope)
	if len(workJSONRows(trend["series"])) != 0 || trend["suppressed"] != true || workJSONPath(trend, "total", 0) != nil {
		t.Errorf("viewer /trend?team=beta = %v", trend)
	}
	flow := e.json(t, e.viewer, "/flow?"+scope)
	if len(workJSONRows(flow["nodes"]))+len(workJSONRows(flow["links"])) != 0 || flow["suppressed"] != true {
		t.Errorf("viewer /flow?team=beta = %v", flow)
	}
	// What a full administrator sees of the same team.
	var models workModelsResponse
	e.get(t, e.full, "/models?"+scope, &models)
	if len(models.Rows) != 2 || models.Suppressed {
		t.Errorf("full /models?team=beta = %+v", models)
	}
}

// k=1 withholds nothing, k above every group withholds everything, and empty
// periods work: no read fails, and a privileged caller never sees a withheld
// number.
func TestWorkIntelSmallGroupEdgeCases(t *testing.T) {
	env := newWorkAPIEnv(t)
	today, _ := workIntelParseDay(workAPIToday())
	from := workIntelFormatDay(today.AddDate(0, 0, -((int(today.Weekday())+6)%7)-14))
	teams := []struct {
		team  string
		users []string
		cats  []string
	}{
		{"alpha", workSeedUsers("ua", 5), []string{"dev.codegen", "dev.debug", "data.sql", "infra.server"}},
		{"beta", []string{"ub1"}, []string{"infra.server", "dev.codegen"}},
		{"gamma", workSeedUsers("uc", 3), []string{"data.sql", "data.viz", "office.email"}},
		{"zeta", []string{"ub1"}, []string{"security.vuln"}},
	}
	facts := []workSeedFact{}
	for d := 0; d < 7; d++ {
		for _, team := range teams {
			for _, u := range team.users {
				facts = append(facts, workSeedFact{day: workIntelShiftDay(from, d), team: team.team, user: u, cat: team.cats[d%len(team.cats)], n: 1 + d%2})
			}
		}
	}
	workSeedFacts(t, env.db, facts)
	periods := []string{
		"from=" + from + "&to=" + workIntelShiftDay(from, 6),                           // the previous period is empty
		"from=" + workIntelShiftDay(from, -40) + "&to=" + workIntelShiftDay(from, -30), // empty
		"from=" + workIntelShiftDay(from, 7) + "&to=" + workIntelShiftDay(from, 13),    // only the previous period has data
	}
	paths := []string{"/overview", "/categories", "/categories?parent=dev", "/teams", "/matrix", "/trend", "/trend?bucket=week", "/flow", "/models",
		"/productivity", "/trends", "/automation", "/insights", "/export.csv?view=categories", "/export.csv?view=teams", "/export.csv?view=models"}
	for _, k := range []int{1, 3, 50} {
		workSetMinGroup(t, env.admin, k)
		for _, period := range periods {
			for _, path := range paths {
				sep := "?"
				if strings.Contains(path, "?") {
					sep = "&"
				}
				for _, metric := range []string{"sessions", "cost"} {
					full := path + sep + period + "&metric=" + metric
					for _, who := range []struct{ name, token string }{{"full", env.full}, {"viewer", env.viewer}, {"alpha", env.alphaAdmin}} {
						status, body := env.call(t, who.token, http.MethodGet, full, nil)
						if status != http.StatusOK {
							t.Errorf("k=%d %s GET %s = %d %s", k, who.name, full, status, body)
						}
						withheld := strings.Contains(string(body), `"suppressed":true`) || strings.Contains(string(body), `"suppressed_links":1`)
						if withheld && (who.name == "full" || k == 1) {
							t.Errorf("k=%d %s sees a withheld number in %s", k, who.name, full)
						}
					}
				}
			}
		}
	}
}
