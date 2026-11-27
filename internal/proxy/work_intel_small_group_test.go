package proxy

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// Small-group protection (work_intel_guard.go): what a caller who may not see
// raw prompts is shown of groups with fewer users than min_group_size (three
// in these tests).
//
// The traffic, one request per session, all on test-model, today:
//
//	alpha (three users): ua1, ua2, ua3 code; ua1 SQL
//	beta  (one user):    ub1 code, ub1 kubernetes
//	gamma (three users): uc1, uc2, uc3 code; uc1, uc2, uc3 SQL; uc1 kubernetes
//
// So by category dev has 7 requests of 7 users, data 4 of 4 and infra 2 of 2
// (too few); by team alpha has 4 requests, beta 2 (one user) and gamma 7.
type workSmallGroupFixture struct {
	*workAPIEnv
	period string
}

func newWorkSmallGroupFixture(t *testing.T) *workSmallGroupFixture {
	t.Helper()
	env := newWorkAPIEnv(t)
	n := 0
	for _, r := range []struct{ key, prompt string }{
		{"key-a1", workIntelPromptCode}, {"key-a2", workIntelPromptCode}, {"key-a3", workIntelPromptCode}, {"key-a1", workIntelPromptSQL},
		{"key-b1", workIntelPromptCode}, {"key-b1", workIntelPromptK8s},
		{"key-c1", workIntelPromptCode}, {"key-c2", workIntelPromptCode}, {"key-c3", workIntelPromptCode},
		{"key-c1", workIntelPromptSQL}, {"key-c2", workIntelPromptSQL}, {"key-c3", workIntelPromptSQL}, {"key-c1", workIntelPromptK8s},
	} {
		n++
		env.send(t, r.key, fmt.Sprintf("sg-%02d", n), workAPIModel, r.prompt)
	}
	if stats := env.run(t); stats.Classified != 13 {
		t.Fatalf("worker classified %d of 13 requests: %+v", stats.Classified, stats)
	}
	today := workAPIToday()
	return &workSmallGroupFixture{workAPIEnv: env, period: "from=" + today + "&to=" + today + "&compare=none"}
}

// json reads a response as generic JSON, so a null stays distinguishable from 0.
func (f *workSmallGroupFixture) json(t *testing.T, token, path string) map[string]any {
	t.Helper()
	status, body := f.call(t, token, http.MethodGet, path, nil)
	if status != http.StatusOK {
		t.Fatalf("GET %s = %d %s", path, status, body)
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	return out
}

// workJSONPath walks a generic JSON value: string keys index objects, int keys arrays.
func workJSONPath(v any, path ...any) any {
	for _, step := range path {
		switch key := step.(type) {
		case string:
			m, _ := v.(map[string]any)
			v = m[key]
		case int:
			a, _ := v.([]any)
			if key >= len(a) {
				return nil
			}
			v = a[key]
		}
	}
	return v
}

// workWithheldMetrics reports whether a Metrics object is sent withheld: every
// measure null and suppressed true.
func workWithheldMetrics(v any) bool {
	m, ok := v.(map[string]any)
	if !ok || m["suppressed"] != true {
		return false
	}
	for _, key := range []string{"sessions", "requests", "users", "tokens", "cost_krw", "mcp_calls"} {
		if value, present := m[key]; !present || value != nil {
			return false
		}
	}
	return true
}

func workShownRequests(v any) float64 {
	m, _ := v.(map[string]any)
	if m["suppressed"] == true {
		return -1
	}
	n, _ := m["requests"].(float64)
	return n
}

func TestWorkIntelSmallGroups(t *testing.T) {
	f := newWorkSmallGroupFixture(t)
	byRequests := f.period + "&metric=requests"

	t.Run("categories", func(t *testing.T) {
		// infra has two users and is withheld; data, the smallest row still shown,
		// is withheld with it, or infra = total - dev - data.
		view := f.json(t, f.viewer, "/categories?"+byRequests)
		state := []string{}
		for _, row := range view["rows"].([]any) {
			r := row.(map[string]any)
			state = append(state, fmt.Sprintf("%s=%v/%v/share=%v", workJSONPath(r, "category", "id"), workShownRequests(r["current"]), r["suppressed"], r["share"]))
			if r["suppressed"] == true && (!workWithheldMetrics(r["current"]) || r["share"] != nil || r["delta"] != nil) {
				t.Errorf("withheld row is not withheld whole: %v", r)
			}
		}
		if want := []string{"dev=7/false/share=0.5385", "data=-1/true/share=<nil>", "infra=-1/true/share=<nil>"}; !reflect.DeepEqual(state, want) {
			t.Errorf("viewer categories = %v, want %v", state, want)
		}
		if workShownRequests(view["total"]) != 13 || workShownRequests(view["unclassified"]) != 0 || workShownRequests(view["failed"]) != 0 {
			t.Errorf("viewer total/unclassified/failed = %v %v %v", view["total"], view["unclassified"], view["failed"])
		}
		// The same read for a caller who may see raw prompts withholds nothing.
		var full workCategoriesResponse
		f.get(t, f.full, "/categories?"+byRequests, &full)
		for _, row := range full.Rows {
			if row.Suppressed || row.Share == nil {
				t.Errorf("full admin row %s is withheld", row.Category.ID)
			}
		}
		// A one-user team: every row and the total are withheld.
		view = f.json(t, f.viewer, "/categories?"+byRequests+"&team=beta")
		for _, row := range view["rows"].([]any) {
			if r := row.(map[string]any); r["suppressed"] != true || !workWithheldMetrics(r["current"]) {
				t.Errorf("beta row shown to a viewer: %v", r)
			}
		}
		if !workWithheldMetrics(view["total"]) {
			t.Errorf("beta total shown to a viewer: %v", view["total"])
		}
		// gamma has dev 3, data 3 (three users each) and infra 1 (one user): infra
		// is withheld, and data (tied with dev, first by id) with it.
		view = f.json(t, f.viewer, "/categories?"+byRequests+"&team=gamma")
		state = state[:0]
		for _, row := range view["rows"].([]any) {
			r := row.(map[string]any)
			state = append(state, fmt.Sprintf("%s=%v", workJSONPath(r, "category", "id"), workShownRequests(r["current"])))
		}
		if want := []string{"dev=3", "data=-1", "infra=-1"}; !reflect.DeepEqual(state, want) || workShownRequests(view["total"]) != 7 {
			t.Errorf("gamma categories for a viewer = %v total %v", state, view["total"])
		}
	})

	t.Run("overview narrowed to one user", func(t *testing.T) {
		var requests workRequestsResponse
		f.get(t, f.viewer, "/requests?"+f.period+"&team=beta", &requests)
		if len(requests.Rows) != 2 || !strings.HasPrefix(requests.Rows[0].User, workIntelUserPrefix) {
			t.Fatalf("beta requests = %+v", requests.Rows)
		}
		for _, path := range []string{"/overview?" + f.period + "&team=beta", "/overview?" + f.period + "&user=" + requests.Rows[0].User,
			"/overview?" + f.period + "&category=infra"} {
			view := f.json(t, f.viewer, path)
			current := view["current"].(map[string]any)
			if !workWithheldMetrics(current) || current["classified_rate"] != nil || current["active_categories"] != nil || current["new_categories"] != nil ||
				len(view["confidence"].([]any))+len(view["methods"].([]any))+len(view["statuses"].([]any)) != 0 || view["growth_rate"] != nil {
				t.Errorf("%s for a viewer = %v", path, view)
			}
		}
		// Three users or more: shown, without the classification-quality
		// distributions, which are request counts of unchecked buckets.
		view := f.json(t, f.viewer, "/overview?"+f.period+"&team=gamma")
		if workShownRequests(view["current"]) != 7 || len(view["statuses"].([]any))+len(view["methods"].([]any))+len(view["confidence"].([]any)) != 0 ||
			workJSONPath(view, "scope", "small_groups_withheld") != true {
			t.Errorf("gamma overview for a viewer = %v", view)
		}
		full := f.json(t, f.full, "/overview?"+f.period+"&team=gamma")
		if len(full["statuses"].([]any)) != 4 || workJSONPath(full, "scope", "small_groups_withheld") != false {
			t.Errorf("gamma overview for a full administrator = %v", full)
		}
		// The full administrator sees the one-user team.
		var overview workOverviewResponse
		f.get(t, f.full, "/overview?"+f.period+"&team=beta", &overview)
		if overview.Current.Suppressed || overview.Current.Requests != 2 {
			t.Errorf("beta overview for a full administrator = %+v", overview.Current)
		}
	})

	t.Run("teams and matrix", func(t *testing.T) {
		// beta is withheld; with the organisation's total in /overview, the
		// smallest other team (alpha) is withheld as well. In gamma's row infra
		// has one user, so data goes with it; in alpha's, data has one user, so
		// dev goes with it.
		var teams workTeamsResponse
		f.get(t, f.viewer, "/teams?"+byRequests, &teams)
		order := []string{}
		for _, row := range teams.Rows {
			order = append(order, fmt.Sprintf("%s/%v", row.Team, row.Suppressed))
		}
		if !reflect.DeepEqual(order, []string{"gamma/false", "alpha/true", "beta/true"}) {
			t.Fatalf("viewer teams = %v", order)
		}
		gamma := teams.Rows[0]
		top := []string{}
		for _, c := range gamma.TopCategories {
			top = append(top, fmt.Sprintf("%s=%v", c.Category.ID, c.Value))
		}
		deviation := []string{}
		for _, d := range gamma.Deviation {
			deviation = append(deviation, d.Category.ID)
		}
		if gamma.Current.Requests != 7 || gamma.Diversity == nil || !reflect.DeepEqual(top, []string{"dev=3"}) || !reflect.DeepEqual(deviation, []string{"dev"}) {
			t.Errorf("gamma for a viewer = %+v top %v deviation %v", gamma, top, deviation)
		}
		raw := f.json(t, f.viewer, "/teams?"+byRequests)
		for i := 1; i < 3; i++ {
			row := workJSONPath(raw, "rows", i).(map[string]any)
			if !workWithheldMetrics(row["current"]) || row["diversity"] != nil || row["sessions_per_user"] != nil || len(row["top_categories"].([]any)) != 0 {
				t.Errorf("withheld team = %v", row)
			}
		}

		var matrix workMatrixResponse
		f.get(t, f.viewer, "/matrix?"+byRequests, &matrix)
		columns := []string{}
		for _, c := range matrix.Categories {
			columns = append(columns, c.ID)
		}
		lines := []string{}
		for _, row := range matrix.Rows {
			parts := []string{fmt.Sprintf("%s total=%v", row.Team, workShownRequests(map[string]any{"suppressed": row.Total.Suppressed, "requests": float64(row.Total.Requests)}))}
			for _, cell := range row.Cells {
				value := "null"
				if cell.Value != nil {
					value = fmt.Sprint(*cell.Value)
				}
				parts = append(parts, fmt.Sprintf("%s=%s/%v", cell.CategoryID, value, cell.Suppressed))
			}
			lines = append(lines, strings.Join(parts, " "))
		}
		// infra (two users) has no column. A zero stays a zero, except in the row
		// of a team too small to show: there every cell is withheld, so nothing
		// tells which categories it used.
		if want := []string{"gamma total=7 dev=3/false data=null/true", "alpha total=-1 dev=null/true data=null/true",
			"beta total=-1 dev=null/true data=null/true"}; !reflect.DeepEqual(columns, []string{"dev", "data"}) || !reflect.DeepEqual(lines, want) {
			t.Errorf("viewer matrix = %v\n%s\nwant\n%s", columns, strings.Join(lines, "\n"), strings.Join(want, "\n"))
		}
		f.get(t, f.full, "/matrix?"+byRequests, &matrix)
		for _, row := range matrix.Rows {
			for _, cell := range row.Cells {
				if cell.Suppressed || row.Total.Suppressed {
					t.Errorf("full admin matrix withholds %s/%s", row.Team, cell.CategoryID)
				}
			}
		}
		if len(matrix.Categories) != 3 {
			t.Errorf("full admin matrix columns = %v", matrix.Categories)
		}
	})

	t.Run("trend", func(t *testing.T) {
		// infra has no series; the rest (infra) is withheld in the bucket, and
		// data, the smallest point shown, with it.
		raw := f.json(t, f.viewer, "/trend?"+byRequests)
		series := map[string]any{}
		for _, s := range raw["series"].([]any) {
			series[workJSONPath(s, "category", "id").(string)] = workJSONPath(s, "values", 0)
		}
		if !reflect.DeepEqual(series, map[string]any{"dev": 7.0, "data": nil}) || workJSONPath(raw, "other", 0) != nil || workJSONPath(raw, "total", 0) != 13.0 {
			t.Errorf("viewer trend = series %v other %v total %v", series, raw["other"], raw["total"])
		}
		var trend workTrendResponse
		f.get(t, f.full, "/trend?"+byRequests, &trend)
		if len(trend.Series) != 3 || workFloat(trend.Other[0]) != 0 || workFloat(trend.Total[0]) != 13 {
			t.Errorf("full trend = %+v", trend)
		}
		// A one-user team: every point is withheld, the total included.
		raw = f.json(t, f.viewer, "/trend?"+byRequests+"&team=beta")
		if len(raw["series"].([]any)) != 0 || workJSONPath(raw, "total", 0) != nil || workJSONPath(raw, "other", 0) != nil {
			t.Errorf("beta trend for a viewer = %v", raw)
		}
	})

	t.Run("flow", func(t *testing.T) {
		var flow workFlowResponse
		f.get(t, f.viewer, "/flow?"+byRequests, &flow)
		links := map[string]float64{}
		for _, link := range flow.Links {
			links[link.Source+">"+link.Target] = link.Value
		}
		nodes := map[string]float64{}
		for _, node := range flow.Nodes {
			nodes[node.ID] = node.Value
		}
		// Every link of beta, of infra and of alpha's one-user data is withheld;
		// each node then has none or two withheld links.
		if !reflect.DeepEqual(links, map[string]float64{"team:gamma>category:dev": 3, "category:dev>model:test-model": 7}) || flow.SuppressedLinks != 8 ||
			!reflect.DeepEqual(nodes, map[string]float64{"team:gamma": 3, "category:dev": 7, "model:test-model": 7}) {
			t.Errorf("viewer flow = links %v nodes %v suppressed %d", links, nodes, flow.SuppressedLinks)
		}
		f.get(t, f.full, "/flow?"+byRequests, &flow)
		if flow.SuppressedLinks != 0 || len(flow.Links) != 10 {
			t.Errorf("full flow = %d links, %d withheld", len(flow.Links), flow.SuppressedLinks)
		}
	})

	t.Run("models", func(t *testing.T) {
		raw := f.json(t, f.viewer, "/models?"+f.period)
		state := []string{}
		for _, row := range raw["rows"].([]any) {
			r := row.(map[string]any)
			state = append(state, fmt.Sprintf("%s=%v/%v", workJSONPath(r, "category", "id"), r["requests"], r["suppressed"]))
			if r["suppressed"] == true {
				for _, key := range []string{"requests", "sessions", "share", "tokens_per_session", "cost_per_session", "latency_p50_ms", "error_rate", "feedback_negative"} {
					if r[key] != nil {
						t.Errorf("withheld model row has %s = %v", key, r[key])
					}
				}
			}
		}
		// infra (two users) is withheld; data, the smallest other row of the
		// model, with it.
		if want := []string{"dev=7/false", "data=<nil>/true", "infra=<nil>/true"}; !reflect.DeepEqual(state, want) {
			t.Errorf("viewer models = %v, want %v", state, want)
		}
		raw = f.json(t, f.viewer, "/models?"+f.period+"&team=beta")
		for _, row := range raw["rows"].([]any) {
			if r := row.(map[string]any); r["suppressed"] != true || r["requests"] != nil || r["cost_per_session"] != nil {
				t.Errorf("beta model row for a viewer = %v", r)
			}
		}
		var models workModelsResponse
		f.get(t, f.full, "/models?"+f.period+"&team=beta", &models)
		if len(models.Rows) != 2 || models.Rows[0].Suppressed || models.Rows[0].Requests != 1 {
			t.Errorf("beta models for a full administrator = %+v", models.Rows)
		}
	})

	t.Run("productivity", func(t *testing.T) {
		raw := f.json(t, f.viewer, "/productivity?"+f.period)
		state := []string{}
		for _, row := range raw["rows"].([]any) {
			r := row.(map[string]any)
			state = append(state, fmt.Sprintf("%s=%v/%v", workJSONPath(r, "category", "id"), r["sessions"], r["suppressed"]))
			if r["suppressed"] == true && (r["confirmed_sessions"] != nil || r["model_time_ms"] != nil || r["est_minutes_saved"] != nil || r["reason"] == "") {
				t.Errorf("withheld productivity row = %v", r)
			}
		}
		if want := []string{"dev=7/false", "data=<nil>/true", "infra=<nil>/true"}; !reflect.DeepEqual(state, want) {
			t.Errorf("viewer productivity = %v, want %v", state, want)
		}
	})

	t.Run("export", func(t *testing.T) {
		read := func(token, query string) [][]string {
			t.Helper()
			status, body := f.call(t, token, http.MethodGet, "/export.csv?"+query, nil)
			if status != http.StatusOK || !bytes.HasPrefix(body, []byte{0xEF, 0xBB, 0xBF}) {
				t.Fatalf("export %s = %d", query, status)
			}
			records, err := csv.NewReader(bytes.NewReader(body[3:])).ReadAll()
			if err != nil {
				t.Fatal(err)
			}
			return records
		}
		// category_id, category, level, sessions, requests, users, tokens, cost_krw, mcp_calls, share, ..., suppressed
		records := read(f.viewer, "view=categories&"+byRequests)
		lines := []string{}
		for _, record := range records[1:] {
			lines = append(lines, record[0]+":"+record[4]+":"+record[7]+":"+record[9]+":"+record[13])
		}
		if want := []string{"dev:7:175:0.5385:false", "data::::true", "infra::::true", "(unclassified):0:0::false", "(failed):0:0::false",
			"(total):13:325::false"}; !reflect.DeepEqual(lines, want) {
			t.Errorf("viewer categories export = %v, want %v", lines, want)
		}
		records = read(f.viewer, "view=teams&"+byRequests)
		lines = lines[:0]
		for _, record := range records[1:] {
			lines = append(lines, record[0]+":"+record[2]+":"+record[5]+":"+record[8]+":"+record[10])
		}
		if want := []string{"gamma:7:175:" + records[1][8] + ":false", "alpha::::true", "beta::::true"}; !reflect.DeepEqual(lines, want) || records[1][8] == "" {
			t.Errorf("viewer teams export = %v, want %v", lines, want)
		}
		records = read(f.viewer, "view=models&"+f.period)
		lines = lines[:0]
		for _, record := range records[1:] {
			lines = append(lines, record[0]+":"+record[4]+":"+record[8]+":"+record[17])
		}
		if want := []string{"dev:7:25:false", "data:::true", "infra:::true"}; !reflect.DeepEqual(lines, want) {
			t.Errorf("viewer models export = %v, want %v", lines, want)
		}
		records = read(f.full, "view=categories&"+byRequests)
		if records[3][0] != "infra" || records[3][4] != "2" || records[3][13] != "false" {
			t.Errorf("full categories export = %v", records)
		}
	})
}

// Signals, insights and automation candidates rest on populations too: one
// whose users are too few is not shown to a caller refused small groups,
// including the stored generation that was made as a privileged caller.
func TestWorkIntelSmallGroupSignalsAndCandidates(t *testing.T) {
	env := newWorkAPIEnv(t)
	// Three alpha users repeat a code request 24 times; the one beta user
	// repeats a kubernetes request 24 times.
	for i := 0; i < 24; i++ {
		env.send(t, []string{"key-a1", "key-a2", "key-a3"}[i%3], fmt.Sprintf("sg-code-%02d", i), workAPIModel, workIntelPromptCode)
		env.send(t, "key-b1", fmt.Sprintf("sg-k8s-%02d", i), workAPIModel, workIntelPromptK8s)
	}
	if stats := env.run(t); stats.Classified != 48 {
		t.Fatalf("classified %d of 48", stats.Classified)
	}
	categories := func(signals []workSignalView) []string {
		out := []string{}
		for _, s := range signals {
			out = append(out, s.Kind+"/"+s.Category.ID)
		}
		sort.Strings(out)
		return out
	}
	var trends workTrendsResponse
	env.get(t, env.full, "/trends", &trends)
	if got := categories(trends.Signals); !reflect.DeepEqual(got, []string{"model_dependence/dev.codegen", "model_dependence/infra.k8s", "new/dev.codegen", "new/infra.k8s"}) {
		t.Fatalf("full trends = %v", got)
	}
	env.get(t, env.viewer, "/trends", &trends)
	if got := categories(trends.Signals); !reflect.DeepEqual(got, []string{"model_dependence/dev.codegen", "new/dev.codegen"}) {
		t.Errorf("viewer trends = %v", got)
	}

	var automation workAutomationResponse
	env.get(t, env.full, "/automation", &automation)
	if automation.Count != 2 {
		t.Fatalf("full automation = %+v", automation.Rows)
	}
	env.get(t, env.viewer, "/automation", &automation)
	if automation.Count != 1 || automation.Rows[0].Category.ID != "dev.codegen" || automation.Rows[0].Users == nil || *automation.Rows[0].Users != 3 {
		t.Errorf("viewer automation = %+v", automation.Rows)
	}
	env.get(t, env.betaAdmin, "/automation", &automation)
	if automation.Count != 0 {
		t.Errorf("beta automation = %+v", automation.Rows)
	}
	var overview workOverviewResponse
	env.get(t, env.viewer, "/overview", &overview)
	if overview.Current.AutomationCandidates != 1 {
		t.Errorf("viewer overview candidates = %d", overview.Current.AutomationCandidates)
	}
	env.get(t, env.full, "/overview", &overview)
	if overview.Current.AutomationCandidates != 2 {
		t.Errorf("full overview candidates = %d", overview.Current.AutomationCandidates)
	}

	// The stored generation speaks of infra.k8s; the viewer's insights do not.
	mentions := func(rows []workInsightView) bool {
		for _, row := range rows {
			if row.Link["category"] == "infra.k8s" || strings.Contains(row.Title+row.Body, "쿠버네티스") {
				return true
			}
		}
		return false
	}
	var insights workInsightsResponse
	env.get(t, env.full, "/insights", &insights)
	if !mentions(insights.Rows) {
		t.Fatalf("full insights do not mention the one-user category: %+v", insights.Rows)
	}
	env.get(t, env.viewer, "/insights", &insights)
	if mentions(insights.Rows) || len(insights.Rows) == 0 || insights.LLMUsed {
		t.Errorf("viewer insights = %+v", insights.Rows)
	}
	env.get(t, env.betaAdmin, "/insights", &insights)
	if len(insights.Rows) != 0 {
		t.Errorf("beta insights = %+v", insights.Rows)
	}
}

// A team-scoped administrator is shown a candidate as their own teams repeat
// it, and may only record a decision about one no other team repeats.
func TestWorkIntelAutomationTeamScope(t *testing.T) {
	env := newWorkAPIEnv(t)
	ctx := context.Background()
	team := func(name string, repeats, users int64, sigs map[string]int64, hours map[string]int64) store.WorkPatternStats {
		return store.WorkPatternStats{Team: name, Repeats: repeats, Users: users, Sessions: repeats, ActiveDays: 5, MCPCalls: repeats,
			LatencyMS: 1000 * repeats, CostKRW: 10 * float64(repeats), Actions: map[string]int64{"create": repeats}, ToolSigs: sigs, Hours: hours}
	}
	payload := func(category string, teams []store.WorkPatternStats, tools []string) string {
		total := store.WorkPatternStats{}
		for _, st := range teams {
			total.Repeats += st.Repeats
			total.Users += st.Users
			total.Sessions += st.Sessions
			total.ActiveDays = 5
			total.MCPCalls += st.MCPCalls
			total.LatencyMS += st.LatencyMS
			total.CostKRW += st.CostKRW
		}
		raw, err := json.Marshal(workCandidatePayload{CategoryID: category, ActionType: "create", PeriodFrom: workAPIDay(-29), PeriodTo: workAPIToday(),
			WindowDays: 30, Total: total, Teams: teams, Tools: tools, SameToolSequence: total.Repeats, HourConcentration: 0.9})
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}
	shared := payload("infra.k8s", []store.WorkPatternStats{
		team("alpha", 12, 3, map[string]int64{"kubectl_get": 12}, map[string]int64{"01": 12}),
		team("beta", 9, 3, map[string]int64{"jira_create,slack_post": 9}, map[string]int64{"05": 9}),
	}, []string{"kubectl_get", "jira_create", "slack_post"})
	own := payload("dev.codegen", []store.WorkPatternStats{team("alpha", 10, 3, map[string]int64{}, map[string]int64{"02": 10})}, []string{})
	// A generation stored before the per-team counts were kept.
	old := strings.NewReplacer(`"actions":{"create":12},`, "", `"actions":{"create":9},`, "").Replace(
		payload("data.sql", []store.WorkPatternStats{
			team("alpha", 12, 3, map[string]int64{"bq_query": 12}, nil),
			team("beta", 9, 3, map[string]int64{"sheet_write": 9}, nil),
		}, []string{"bq_query", "sheet_write"}))
	if strings.Contains(old, `"actions"`) {
		t.Fatalf("old payload still has per-team actions: %s", old)
	}
	candidates := []store.WorkAutomationCandidate{
		{ID: "auto_shared", PayloadJSON: shared, ReviewStatus: store.WorkReviewNew},
		{ID: "auto_own", PayloadJSON: own, ReviewStatus: store.WorkReviewNew},
		{ID: "auto_old", PayloadJSON: old, ReviewStatus: store.WorkReviewNew},
	}
	if err := env.db.ReplaceWorkGeneration(ctx, time.Now(), candidates, nil); err != nil {
		t.Fatal(err)
	}
	rows := func(token string) map[string]workAutomationView {
		var out workAutomationResponse
		env.get(t, token, "/automation", &out)
		byID := map[string]workAutomationView{}
		for _, row := range out.Rows {
			byID[row.ID] = row
		}
		return byID
	}
	full, alpha := rows(env.full), rows(env.alphaAdmin)
	if got := full["auto_shared"]; !reflect.DeepEqual(got.Teams, []string{"alpha", "beta"}) || len(got.MCPTools) != 3 || got.Repeats != 21 {
		t.Errorf("shared candidate for a full administrator = %+v", got)
	}
	// alpha's view of the shared pattern holds alpha's teams, repeats and tools only.
	if got := alpha["auto_shared"]; !reflect.DeepEqual(got.Teams, []string{"alpha"}) || !reflect.DeepEqual(got.MCPTools, []string{"kubectl_get"}) || got.Repeats != 12 {
		t.Errorf("shared candidate for alpha = %+v", got)
	}
	// Without per-team counts, what the other team's requests looked like is withheld.
	if got := alpha["auto_old"]; len(got.MCPTools) != 0 || strings.Contains(got.Title, " · ") || got.Repeats != 12 {
		t.Errorf("old candidate for alpha = %+v", got)
	}
	if got := full["auto_old"]; len(got.MCPTools) != 2 || !strings.Contains(got.Title, " · ") {
		t.Errorf("old candidate for a full administrator = %+v", got)
	}

	review := func(token, id string) (int, []byte) {
		return env.call(t, token, http.MethodPost, "/automation/"+id+"/review", map[string]any{"review_status": "reviewing", "note": "검토"})
	}
	if status, body := review(env.alphaAdmin, "auto_shared"); status != http.StatusForbidden || workAPIErrorCode(body) != "work_intel_team_forbidden" {
		t.Errorf("alpha reviewing a shared candidate = %d %s", status, body)
	}
	if status, body := review(env.alphaAdmin, "auto_own"); status != http.StatusOK {
		t.Errorf("alpha reviewing its own candidate = %d %s", status, body)
	}
	if status, body := review(env.full, "auto_shared"); status != http.StatusOK {
		t.Errorf("a full administrator reviewing the shared candidate = %d %s", status, body)
	}
	if got := rows(env.full)["auto_shared"].ReviewStatus; got != store.WorkReviewReviewing {
		t.Errorf("shared candidate status = %q", got)
	}
}
