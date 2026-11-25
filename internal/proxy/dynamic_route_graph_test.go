package proxy

import (
	"context"
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"
)

func mustCompileDynamicRoute(t *testing.T, raw string) *compiledDynamicRoute {
	t.Helper()
	graph, err := parseDynamicRouteGraph([]byte(raw))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	compiled, validation := compileDynamicRouteGraph(normalizeDynamicRouteGraph(graph))
	if compiled == nil {
		t.Fatalf("graph did not compile: %+v", validation.Errors)
	}
	return compiled
}

func dynamicRouteValidationCodes(raw string) ([]string, []string) {
	graph, err := parseDynamicRouteGraph([]byte(raw))
	if err != nil {
		return []string{"parse_error"}, nil
	}
	_, validation := compileDynamicRouteGraph(normalizeDynamicRouteGraph(graph))
	errorsOut, warnings := []string{}, []string{}
	for _, issue := range validation.Errors {
		errorsOut = append(errorsOut, issue.Code)
	}
	for _, issue := range validation.Warnings {
		warnings = append(warnings, issue.Code)
	}
	return errorsOut, warnings
}

func containsCode(codes []string, code string) bool {
	for _, c := range codes {
		if c == code {
			return true
		}
	}
	return false
}

// A route exported from Cloudflare AI Gateway carries the route's id and name and
// canvas positions next to the elements. It must load as is, so moving a route
// over is a paste and not a rewrite.
func TestDynamicRouteGraphAcceptsCloudflareExport(t *testing.T) {
	exported := `{
	  "id": "54442216", "name": "support",
	  "elements": [
	    {"id": "start", "type": "start", "position": {"x": 0, "y": 0}, "outputs": {"next": {"elementId": "plan"}}},
	    {"id": "plan", "type": "conditional", "properties": {"conditions": {"metadata.plan": {"$eq": "free"}}},
	     "outputs": {"true": {"elementId": "split"}, "false": {"elementId": "budget"}}},
	    {"id": "split", "type": "percentage", "outputs": {"80%": {"elementId": "small"}, "20%": {"elementId": "large"}}},
	    {"id": "budget", "type": "rate", "properties": {"limitType": "cost", "key": "metadata.user_id", "limit": 5000, "window": 86400},
	     "outputs": {"success": {"elementId": "large"}, "fallback": {"elementId": "small"}}},
	    {"id": "large", "type": "model", "properties": {"provider": "openai", "model": "gpt-4.1", "timeout": 30000, "retries": 2},
	     "outputs": {"success": {"elementId": "end"}, "fallback": {"elementId": "small"}}},
	    {"id": "small", "type": "model", "properties": {"provider": "workers-ai", "model": "@cf/meta/llama-3.1-8b-instruct"},
	     "outputs": {"success": {"elementId": "end"}}},
	    {"id": "end", "type": "end"}
	  ]
	}`
	errs, warnings := dynamicRouteValidationCodes(exported)
	if len(errs) != 0 {
		t.Fatalf("export did not validate: %v", errs)
	}
	if len(warnings) != 0 {
		t.Fatalf("a complete route should have no warnings: %v", warnings)
	}
	compiled := mustCompileDynamicRoute(t, exported)
	if compiled.startID != "start" || len(compiled.modelElements()) != 2 {
		t.Fatalf("compiled index is wrong: start=%q models=%d", compiled.startID, len(compiled.modelElements()))
	}
	// Normalization drops what the type does not use and what the canvas added.
	encoded, _ := json.Marshal(compiled.graph)
	if strings.Contains(string(encoded), "position") {
		t.Fatalf("canvas metadata survived normalization: %s", encoded)
	}
}

func TestDynamicRouteGraphRejectsBrokenGraphs(t *testing.T) {
	model := func(id, out string) string {
		return `{"id":"` + id + `","type":"model","properties":{"model":"m-` + id + `"},"outputs":{"success":{"elementId":"` + out + `"}}}`
	}
	cases := []struct {
		name  string
		graph string
		code  string
	}{
		{"empty", `{"elements":[]}`, "graph_empty"},
		{"no start", `{"elements":[` + model("a", "end") + `,{"id":"end","type":"end"}]}`, "start_count"},
		{"two starts", `{"elements":[{"id":"s1","type":"start","outputs":{"next":{"elementId":"a"}}},{"id":"s2","type":"start","outputs":{"next":{"elementId":"a"}}},` + model("a", "end") + `,{"id":"end","type":"end"}]}`, "start_count"},
		{"duplicate id", `{"elements":[{"id":"s","type":"start","outputs":{"next":{"elementId":"a"}}},` + model("a", "end") + `,` + model("a", "end") + `,{"id":"end","type":"end"}]}`, "element_id_duplicate"},
		{"bad id", `{"elements":[{"id":"s","type":"start","outputs":{"next":{"elementId":"a b"}}},{"id":"a b","type":"end"}]}`, "element_id_invalid"},
		{"unknown type", `{"elements":[{"id":"s","type":"start","outputs":{"next":{"elementId":"x"}}},{"id":"x","type":"loop"}]}`, "element_type_invalid"},
		{"missing target", `{"elements":[{"id":"s","type":"start","outputs":{"next":{"elementId":"ghost"}}},` + model("a", "end") + `,{"id":"end","type":"end"}]}`, "output_target_missing"},
		{"wrong output", `{"elements":[{"id":"s","type":"start","outputs":{"next":{"elementId":"a"},"maybe":{"elementId":"a"}}},` + model("a", "end") + `,{"id":"end","type":"end"}]}`, "output_invalid"},
		{"cycle", `{"elements":[{"id":"s","type":"start","outputs":{"next":{"elementId":"a"}}},
			{"id":"a","type":"model","properties":{"model":"x"},"outputs":{"fallback":{"elementId":"b"}}},
			{"id":"b","type":"model","properties":{"model":"y"},"outputs":{"fallback":{"elementId":"a"}}}]}`, "graph_cycle"},
		{"percent sum", `{"elements":[{"id":"s","type":"start","outputs":{"next":{"elementId":"p"}}},
			{"id":"p","type":"percentage","outputs":{"60%":{"elementId":"a"},"30%":{"elementId":"a"}}},` + model("a", "end") + `,{"id":"end","type":"end"}]}`, "percentage_invalid"},
		{"percent key", `{"elements":[{"id":"s","type":"start","outputs":{"next":{"elementId":"p"}}},
			{"id":"p","type":"percentage","outputs":{"half":{"elementId":"a"}}},` + model("a", "end") + `,{"id":"end","type":"end"}]}`, "percentage_invalid"},
		{"virtual model", `{"elements":[{"id":"s","type":"start","outputs":{"next":{"elementId":"a"}}},
			{"id":"a","type":"model","properties":{"model":"dynamic/other"}}]}`, "model_virtual"},
		{"auto alias", `{"elements":[{"id":"s","type":"start","outputs":{"next":{"elementId":"a"}}},
			{"id":"a","type":"model","properties":{"model":"auto"}}]}`, "model_virtual"},
		{"success not end", `{"elements":[{"id":"s","type":"start","outputs":{"next":{"elementId":"a"}}},
			{"id":"a","type":"model","properties":{"model":"x"},"outputs":{"success":{"elementId":"b"}}},` + model("b", "end") + `,{"id":"end","type":"end"}]}`, "model_success_not_end"},
		{"retries", `{"elements":[{"id":"s","type":"start","outputs":{"next":{"elementId":"a"}}},
			{"id":"a","type":"model","properties":{"model":"x","retries":9}}]}`, "model_retries_invalid"},
		{"rate window", `{"elements":[{"id":"s","type":"start","outputs":{"next":{"elementId":"r"}}},
			{"id":"r","type":"rate","properties":{"limitType":"count","limit":5,"window":1},"outputs":{"success":{"elementId":"a"}}},` + model("a", "end") + `,{"id":"end","type":"end"}]}`, "rate_window_invalid"},
		{"rate fraction", `{"elements":[{"id":"s","type":"start","outputs":{"next":{"elementId":"r"}}},
			{"id":"r","type":"rate","properties":{"limitType":"count","limit":2.5,"window":60},"outputs":{"success":{"elementId":"a"}}},` + model("a", "end") + `,{"id":"end","type":"end"}]}`, "rate_limit_fraction"},
		{"condition field", `{"elements":[{"id":"s","type":"start","outputs":{"next":{"elementId":"c"}}},
			{"id":"c","type":"conditional","properties":{"conditions":{"body.model":"x"}},"outputs":{"true":{"elementId":"a"},"false":{"elementId":"a"}}},` + model("a", "end") + `,{"id":"end","type":"end"}]}`, "condition_invalid"},
		{"condition outputs", `{"elements":[{"id":"s","type":"start","outputs":{"next":{"elementId":"c"}}},
			{"id":"c","type":"conditional","properties":{"conditions":{"metadata.plan":"x"}},"outputs":{"true":{"elementId":"a"}}},` + model("a", "end") + `,{"id":"end","type":"end"}]}`, "condition_outputs_missing"},
		{"no model", `{"elements":[{"id":"s","type":"start","outputs":{"next":{"elementId":"end"}}},{"id":"end","type":"end"}]}`, "model_unreachable"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			errs, _ := dynamicRouteValidationCodes(tc.graph)
			if !containsCode(errs, tc.code) {
				t.Fatalf("expected error %q, got %v", tc.code, errs)
			}
		})
	}
}

func TestDynamicRouteGraphWarnsAboutLikelyMistakes(t *testing.T) {
	graph := `{"elements":[
	  {"id":"s","type":"start","outputs":{"next":{"elementId":"c"}}},
	  {"id":"c","type":"conditional","properties":{"conditions":{"metadata.plan":"free"}},"outputs":{"true":{"elementId":"end"},"false":{"elementId":"r"}}},
	  {"id":"r","type":"rate","properties":{"limitType":"count","limit":10,"window":60},"outputs":{"success":{"elementId":"a"}}},
	  {"id":"a","type":"model","properties":{"model":"x"},"outputs":{"success":{"elementId":"end"}}},
	  {"id":"orphan","type":"model","properties":{"model":"y"}},
	  {"id":"end","type":"end"}]}`
	errs, warnings := dynamicRouteValidationCodes(graph)
	if len(errs) != 0 {
		t.Fatalf("warnings must not block a save: %v", errs)
	}
	for _, want := range []string{"element_unreachable", "rate_fallback_missing", "rate_key_shared", "end_without_model"} {
		if !containsCode(warnings, want) {
			t.Fatalf("missing warning %q in %v", want, warnings)
		}
	}
}

func TestDynamicConditionSemantics(t *testing.T) {
	input := dynamicRouteInput{
		Metadata: map[string]any{"plan": "free", "tier": float64(3), "beta": true},
		Identity: map[string]string{"team": "ml", "user_id": ""},
		Request:  map[string]any{"stream": true, "endpoint": "/v1/chat/completions"},
	}
	cases := []struct {
		condition string
		want      bool
	}{
		{`{"metadata.plan": "free"}`, true},
		{`{"metadata.plan": {"$eq": "pro"}}`, false},
		{`{"metadata.plan": {"$ne": "pro"}}`, true},
		// A key the request does not carry: $eq is false and $ne is true, as in Cloudflare.
		{`{"metadata.region": {"$eq": "kr"}}`, false},
		{`{"metadata.region": {"$ne": "kr"}}`, true},
		{`{"metadata.region": {"$exists": false}}`, true},
		{`{"metadata.region": {"$nin": ["kr"]}}`, true},
		{`{"metadata.region": {"$in": ["kr"]}}`, false},
		{`{"metadata.plan": {"$in": ["trial", "free"]}}`, true},
		{`{"metadata.tier": {"$gte": 3, "$lt": 5}}`, true},
		{`{"metadata.tier": {"$gt": 3}}`, false},
		// Comparisons are typed: the string "3" is not the number 3.
		{`{"metadata.tier": "3"}`, false},
		{`{"metadata.beta": true}`, true},
		{`{"metadata.plan": {"$gt": 1}}`, false},
		{`{"identity.team": "ml", "request.stream": true}`, true},
		// An empty identity value is a missing value.
		{`{"identity.user_id": {"$exists": true}}`, false},
		{`{"$or": [{"metadata.plan": "pro"}, {"identity.team": "ml"}]}`, true},
		{`{"$and": [{"metadata.plan": "free"}, {"request.endpoint": "/v1/responses"}]}`, false},
	}
	for _, tc := range cases {
		cond, err := parseDynamicCondition(json.RawMessage(tc.condition))
		if err != nil {
			t.Fatalf("%s: %v", tc.condition, err)
		}
		if got := cond.eval(input); got != tc.want {
			t.Fatalf("%s = %v, want %v", tc.condition, got, tc.want)
		}
	}
	for _, bad := range []string{`[]`, `{}`, `{"$xor": []}`, `{"metadata.plan": {"$regex": "x"}}`, `{"metadata.plan": ["a"]}`, `{"metadata.tier": {"$gt": "3"}}`, `{"identity.secret": "x"}`} {
		if _, err := parseDynamicCondition(json.RawMessage(bad)); err == nil {
			t.Fatalf("condition %s should be rejected", bad)
		}
	}
}

const splitRouteGraph = `{"elements":[
  {"id":"s","type":"start","outputs":{"next":{"elementId":"p"}}},
  {"id":"p","type":"percentage","properties":{"stickyKey":"metadata.user"},"outputs":{"70%":{"elementId":"a"},"30%":{"elementId":"b"}}},
  {"id":"a","type":"model","properties":{"model":"model-a"},"outputs":{"success":{"elementId":"end"}}},
  {"id":"b","type":"model","properties":{"model":"model-b"},"outputs":{"success":{"elementId":"end"}}},
  {"id":"end","type":"end"}]}`

func TestDynamicPercentageSplitsAndStaysSticky(t *testing.T) {
	route := mustCompileDynamicRoute(t, splitRouteGraph)
	ctx := context.Background()

	// Without a sticky value the split follows the random draw.
	draws := []float64{0.05, 0.69, 0.71, 0.99}
	want := []string{"a", "a", "b", "b"}
	for i, draw := range draws {
		value := draw
		result := simulateDynamicRoute(ctx, route, "drt_x", dynamicRouteInput{}, dynamicRouteSimOptions{Random: func() float64 { return value }})
		if result.FinalID != want[i] {
			t.Fatalf("draw %.2f went to %q, want %q", draw, result.FinalID, want[i])
		}
	}

	// A sticky value lands in the same bucket every time, whatever the draw.
	sticky := dynamicRouteInput{Metadata: map[string]any{"user": "u-42"}}
	first := simulateDynamicRoute(ctx, route, "drt_x", sticky, dynamicRouteSimOptions{Random: func() float64 { return 0 }}).FinalID
	for _, draw := range []float64{0.2, 0.5, 0.99} {
		value := draw
		if got := simulateDynamicRoute(ctx, route, "drt_x", sticky, dynamicRouteSimOptions{Random: func() float64 { return value }}).FinalID; got != first {
			t.Fatalf("sticky user moved from %q to %q", first, got)
		}
	}

	// Across many users the sticky split still approximates the declared shares.
	counts := map[string]int{}
	for i := 0; i < 4000; i++ {
		input := dynamicRouteInput{Metadata: map[string]any{"user": "user-" + itoaProxy(i)}}
		counts[simulateDynamicRoute(ctx, route, "drt_x", input, dynamicRouteSimOptions{}).FinalID]++
	}
	if share := float64(counts["a"]) / 4000; math.Abs(share-0.7) > 0.04 {
		t.Fatalf("sticky split drifted from 70%%: %.3f (%v)", share, counts)
	}

	// The distribution preview ignores sticky keys, or one fixed input would show 100%.
	rows := distributeDynamicRoute(ctx, route, "drt_x", sticky, dynamicRouteSimOptions{}, 2000)
	if len(rows) != 2 {
		t.Fatalf("distribution should show both branches: %+v", rows)
	}
}

const fallbackRouteGraph = `{"elements":[
  {"id":"start","type":"start","outputs":{"next":{"elementId":"plan"}}},
  {"id":"plan","type":"conditional","properties":{"conditions":{"metadata.plan":"free"}},"outputs":{"true":{"elementId":"cheap"},"false":{"elementId":"primary"}}},
  {"id":"primary","type":"model","properties":{"model":"primary-model","retries":1},"outputs":{"success":{"elementId":"end"},"fallback":{"elementId":"backup"}}},
  {"id":"backup","type":"model","properties":{"model":"backup-model"},"outputs":{"success":{"elementId":"end"},"fallback":{"elementId":"cheap"}}},
  {"id":"cheap","type":"model","properties":{"model":"cheap-model"},"outputs":{"success":{"elementId":"end"}}},
  {"id":"end","type":"end"}]}`

func TestDynamicRouteSimulationFollowsFallbacks(t *testing.T) {
	route := mustCompileDynamicRoute(t, fallbackRouteGraph)
	ctx := context.Background()
	paid := dynamicRouteInput{Metadata: map[string]any{"plan": "pro"}}

	result := simulateDynamicRoute(ctx, route, "drt_x", paid, dynamicRouteSimOptions{})
	if result.FinalID != "primary" || result.Path != "start>plan:false>primary:success>end" || result.Fallbacks != 0 {
		t.Fatalf("healthy path wrong: %+v", result)
	}
	result = simulateDynamicRoute(ctx, route, "drt_x", paid, dynamicRouteSimOptions{Failing: map[string]bool{"primary": true, "backup": true}})
	if result.FinalID != "cheap" || result.Fallbacks != 2 || result.Attempts != 3 ||
		result.Path != "start>plan:false>primary:failed>backup:failed>cheap:success>end" {
		t.Fatalf("fallback chain wrong: %+v", result)
	}
	result = simulateDynamicRoute(ctx, route, "drt_x", paid, dynamicRouteSimOptions{Failing: map[string]bool{"primary": true, "backup": true, "cheap": true}})
	if result.Outcome != "failed" || result.FinalID != "cheap" {
		t.Fatalf("exhausted chain should fail at the last model: %+v", result)
	}
	free := simulateDynamicRoute(ctx, route, "drt_x", dynamicRouteInput{Metadata: map[string]any{"plan": "free"}}, dynamicRouteSimOptions{})
	if free.FinalID != "cheap" || free.Path != "start>plan:true>cheap:success>end" {
		t.Fatalf("free plan path wrong: %+v", free)
	}
}

const rateRouteGraph = `{"elements":[
  {"id":"s","type":"start","outputs":{"next":{"elementId":"limit"}}},
  {"id":"limit","type":"rate","properties":{"limitType":"count","key":"metadata.user","limit":2,"window":3600},"outputs":{"success":{"elementId":"big"},"fallback":{"elementId":"small"}}},
  {"id":"big","type":"model","properties":{"model":"big-model"},"outputs":{"success":{"elementId":"end"}}},
  {"id":"small","type":"model","properties":{"model":"small-model"},"outputs":{"success":{"elementId":"end"}}},
  {"id":"end","type":"end"}]}`

func TestDynamicRouteRateLimitCountsInTheStore(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	route := mustCompileDynamicRoute(t, rateRouteGraph)
	ctx := context.Background()
	fixed := time.Unix(1_800_000_000, 0)
	walk := func(user string) string {
		input := dynamicRouteInput{Metadata: map[string]any{}}
		if user != "" {
			input.Metadata["user"] = user
		}
		run := newDynamicRouteRun(route, "drt_rate", "rate", 1, input, db)
		run.now = func() time.Time { return fixed }
		el := run.start(ctx)
		if el == nil {
			t.Fatalf("no model reached: %+v", run.steps)
		}
		return el.ID
	}
	for i, want := range []string{"big", "big", "small", "small"} {
		if got := walk("alice"); got != want {
			t.Fatalf("alice request %d went to %q, want %q", i+1, got, want)
		}
	}
	// Each metadata value has its own limit.
	if got := walk("bob"); got != "big" {
		t.Fatalf("bob shares alice's limit: %q", got)
	}
	// Requests without the key share one unkeyed limit.
	if walk("") != "big" || walk("") != "big" || walk("") != "small" {
		t.Fatal("unkeyed requests should share a single limit of two")
	}
	// The next window starts fresh.
	fixed = fixed.Add(time.Hour)
	if got := walk("alice"); got != "big" {
		t.Fatalf("new window should reset alice: %q", got)
	}
	counters, err := db.ListDynamicRouteCounters(ctx, "drt_rate", fixed.Unix(), 10)
	if err != nil {
		t.Fatal(err)
	}
	for _, counter := range counters {
		if strings.Contains(counter.ScopeKey, "alice") || strings.Contains(counter.ScopeKey, "bob") {
			t.Fatalf("raw metadata value stored as a counter key: %q", counter.ScopeKey)
		}
	}
}

func TestDynamicRouteCostLimitFallsBackAfterSpend(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	graph := strings.Replace(rateRouteGraph, `"limitType":"count","key":"metadata.user","limit":2`, `"limitType":"cost","key":"metadata.user","limit":100`, 1)
	route := mustCompileDynamicRoute(t, graph)
	ctx := context.Background()
	fixed := time.Unix(1_800_000_000, 0)
	start := func() *dynamicRouteRun {
		run := newDynamicRouteRun(route, "drt_cost", "cost", 1, dynamicRouteInput{Metadata: map[string]any{"user": "carol"}}, db)
		run.now = func() time.Time { return fixed }
		return run
	}
	run := start()
	if el := run.start(ctx); el == nil || el.ID != "big" || len(run.charges) != 1 {
		t.Fatalf("first request should pass under the limit and be charged: el=%v charges=%v", el, run.charges)
	}
	charge := run.charges[0]
	if err := db.AddDynamicRouteCost(ctx, "drt_cost", charge.ElementID, charge.ScopeKey, charge.WindowStart, charge.WindowEnd, 120); err != nil {
		t.Fatal(err)
	}
	run = start()
	if el := run.start(ctx); el == nil || el.ID != "small" || len(run.charges) != 0 {
		t.Fatalf("spent budget should take the fallback without charging: el=%v charges=%v", el, run.charges)
	}
}

func TestRetryBackoffShapes(t *testing.T) {
	base := 100 * time.Millisecond
	cases := []struct {
		mode string
		n    int
		want time.Duration
	}{
		{"constant", 3, base},
		{"", 2, base},
		{"linear", 3, 300 * time.Millisecond},
		{"exponential", 1, base},
		{"exponential", 4, 800 * time.Millisecond},
		{"exponential", 40, 60 * time.Second},
	}
	for _, tc := range cases {
		if got := retryBackoff(base, tc.mode, tc.n); got != tc.want {
			t.Fatalf("%s #%d = %s, want %s", tc.mode, tc.n, got, tc.want)
		}
	}
	if retryBackoff(0, "exponential", 3) != 0 {
		t.Fatal("no delay configured means no pause")
	}
}
