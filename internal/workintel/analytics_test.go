package workintel

import (
	"encoding/json"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

func TestLatencyBucket(t *testing.T) {
	if len(LatencyBounds) != 7 || LatencyBuckets != 8 {
		t.Fatalf("histogram layout changed: %v / %d buckets", LatencyBounds, LatencyBuckets)
	}
	for i, want := range []int64{500, 1000, 2000, 5000, 10000, 30000, 60000} {
		if LatencyBounds[i] != want {
			t.Errorf("bound %d = %d, want %d", i, LatencyBounds[i], want)
		}
	}
	for ms, want := range map[int64]int{
		-5: 0, 0: 0, 499: 0, 500: 0, 501: 1, 1000: 1, 1001: 2, 2000: 2, 2001: 3, 5000: 3, 5001: 4,
		10000: 4, 10001: 5, 30000: 5, 30001: 6, 60000: 6, 60001: 7, math.MaxInt64: 7,
	} {
		if got := LatencyBucket(ms); got != want {
			t.Errorf("LatencyBucket(%d) = %d, want %d", ms, got, want)
		}
	}
}

func TestConfidenceBucket(t *testing.T) {
	if len(ConfidenceLabels) != 5 {
		t.Fatalf("labels = %v", ConfidenceLabels)
	}
	for c, want := range map[float64]int{
		-1: 0, 0: 0, 0.4999: 0, 0.5: 1, 0.5999: 1, 0.6: 2, 0.7499: 2, 0.75: 3, 0.8999: 3, 0.9: 4, 1: 4, 2: 4,
	} {
		if got := ConfidenceBucket(c); got != want {
			t.Errorf("ConfidenceBucket(%v) = %d, want %d", c, got, want)
		}
	}
}

func TestPercentile(t *testing.T) {
	tests := []struct {
		name   string
		counts []int64
		p      float64
		want   float64
	}{
		{"empty", nil, 0.5, 0},
		{"all zero", make([]int64, 8), 0.95, 0},
		{"median of the first bucket", []int64{10, 0, 0, 0, 0, 0, 0, 0}, 0.5, 250},
		{"median of the second bucket", []int64{0, 10, 0, 0, 0, 0, 0, 0}, 0.5, 750},
		{"p95 across two buckets", []int64{50, 50, 0, 0, 0, 0, 0, 0}, 0.95, 950},
		{"p50 at a bucket edge", []int64{50, 50, 0, 0, 0, 0, 0, 0}, 0.5, 500},
		{"interpolates wide buckets", []int64{0, 0, 0, 0, 0, 4, 0, 0}, 0.25, 15000},
		{"open-ended bucket reports its lower bound", []int64{0, 0, 0, 0, 0, 0, 0, 10}, 0.5, 60000},
		{"tail in the open-ended bucket", []int64{90, 0, 0, 0, 0, 0, 0, 10}, 0.95, 60000},
		{"p90 stays below the tail", []int64{90, 0, 0, 0, 0, 0, 0, 10}, 0.90, 500},
		{"p above one is the maximum", []int64{10, 10, 0, 0, 0, 0, 0, 0}, 3, 1000},
		{"p below zero is the minimum", []int64{0, 10, 10, 0, 0, 0, 0, 0}, -1, 500},
		{"negative counts are ignored", []int64{-50, 10, 0, 0, 0, 0, 0, 0}, 0.5, 750},
		{"short histogram", []int64{4}, 0.5, 250},
		{"over-long histogram", []int64{0, 0, 0, 0, 0, 0, 0, 0, 5}, 0.5, 60000},
	}
	for _, tt := range tests {
		if got := Percentile(tt.counts, tt.p); math.Abs(got-tt.want) > 1e-6 {
			t.Errorf("%s: Percentile(%v, %v) = %v, want %v", tt.name, tt.counts, tt.p, got, tt.want)
		}
	}

	// A higher quantile is never a lower latency.
	for _, counts := range [][]int64{{3, 9, 27, 5, 1, 0, 2, 1}, {0, 0, 1, 0, 0, 7, 0, 0}, {100, 1, 1, 1, 1, 1, 1, 1}} {
		prev := -1.0
		for p := 0.0; p <= 1.0001; p += 0.01 {
			v := Percentile(counts, p)
			if v < prev-1e-9 {
				t.Fatalf("Percentile(%v) decreases at p=%.2f: %v after %v", counts, p, v, prev)
			}
			prev = v
		}
	}
}

func TestDiversity(t *testing.T) {
	tests := []struct {
		values []float64
		want   float64
	}{
		{nil, 0},
		{[]float64{5}, 0},
		{[]float64{0, 0, 0}, 0},
		{[]float64{7, 0}, 0},
		{[]float64{1, 1}, 1},
		{[]float64{4, 4, 4, 4}, 1},
		{[]float64{1, 1, 0, 0}, 0.5},                // two of four categories used evenly
		{[]float64{3, 1}, 0.8112781244591328},       // H(0.75, 0.25) / ln 2
		{[]float64{30, 10}, 0.8112781244591328},     // scale does not matter
		{[]float64{3, 1, -8}, 0.5118595071429148},   // negatives count as unused categories
		{[]float64{1, 1, 1, 0, 0, 0, 0, 0, 0}, 0.5}, // ln 3 / ln 9
	}
	for _, tt := range tests {
		if got := Diversity(tt.values); math.Abs(got-tt.want) > 1e-9 {
			t.Errorf("Diversity(%v) = %v, want %v", tt.values, got, tt.want)
		}
	}
}

func signalKinds(signals []Signal) string {
	var out []string
	for _, s := range signals {
		out = append(out, s.Kind+":"+s.CategoryID)
	}
	return strings.Join(out, " ")
}

func findSignal(t *testing.T, signals []Signal, kind, category string) Signal {
	t.Helper()
	for _, s := range signals {
		if s.Kind == kind && s.CategoryID == category {
			return s
		}
	}
	t.Fatalf("no %s signal for %s in %s", kind, category, signalKinds(signals))
	return Signal{}
}

func TestDetectSignals(t *testing.T) {
	if DefaultSignalThresholds() != (SignalThresholds{MinSample: 20, MinChangeAbs: 10, MinChangeRate: 0.3}) {
		t.Fatalf("defaults = %+v", DefaultSignalThresholds())
	}
	quiet := func(id string) CategorySeries {
		return CategorySeries{CategoryID: id, UsersCurrent: -1, UsersPrevious: -1}
	}

	t.Run("a small blip is not a trend", func(t *testing.T) {
		blips := []CategorySeries{}
		add := func(id string, mutate func(*CategorySeries)) {
			s := quiet(id)
			mutate(&s)
			blips = append(blips, s)
		}
		add("tripled-but-tiny", func(s *CategorySeries) { s.Current7, s.Previous7, s.Current30, s.Previous30 = 6, 2, 6, 2 })
		add("big-rate-small-sample", func(s *CategorySeries) { s.Current7, s.Previous7, s.Current30, s.Previous30 = 15, 2, 15, 2 })
		add("big-sample-small-change", func(s *CategorySeries) { s.Current7, s.Previous7, s.Current30, s.Previous30 = 30, 25, 130, 125 })
		add("big-absolute-small-rate", func(s *CategorySeries) { s.Current7, s.Previous7, s.Current30, s.Previous30 = 200, 180, 800, 760 })
		add("tiny-decline", func(s *CategorySeries) { s.Current30, s.Previous30 = 3, 9 })
		add("slow-decline", func(s *CategorySeries) { s.Current30, s.Previous30 = 900, 950 })
		add("new-but-tiny", func(s *CategorySeries) { s.Current30, s.FirstSeenDay = 5, "2026-11-10" })
		add("cost-up-with-usage", func(s *CategorySeries) {
			s.RequestsCurrent, s.RequestsPrevious, s.CostCurrent, s.CostPrevious = 300, 100, 30000, 10000
		})
		add("cost-spike-on-five-requests", func(s *CategorySeries) {
			s.RequestsCurrent, s.RequestsPrevious, s.CostCurrent, s.CostPrevious = 6, 5, 90000, 10000
		})
		add("one-model-but-tiny", func(s *CategorySeries) { s.ModelValues = map[string]float64{"alpha": 9, "beta": 1} })
		add("balanced-models", func(s *CategorySeries) { s.ModelValues = map[string]float64{"alpha": 60, "beta": 40} })
		add("one-team-but-tiny", func(s *CategorySeries) { s.TeamValues = map[string]float64{"플랫폼": 9, "결제": 1} })
		add("one-more-team", func(s *CategorySeries) { s.Current30, s.Previous30, s.TeamsCurrent, s.TeamsPrevious = 100, 100, 4, 3 })
		add("spread-without-volume", func(s *CategorySeries) { s.Current30, s.TeamsCurrent, s.TeamsPrevious = 8, 5, 1 })
		got := DetectSignals(SignalInput{WindowStart: "2026-10-28", TotalTeams: 6, Series: blips}, SignalThresholds{})
		if len(got) != 0 {
			t.Errorf("noise reported as signals: %s", signalKinds(got))
		}
		if got == nil {
			t.Error("the result must be an empty list, not nil")
		}
	})

	in := SignalInput{
		WindowStart: "2026-10-28",
		TotalTeams:  6,
		Series: []CategorySeries{
			{CategoryID: "dev.test", Current7: 42, Previous7: 20, Current30: 150, Previous30: 100, UsersCurrent: 12, UsersPrevious: 9},
			{CategoryID: "ai.rag", Current7: 25, Current30: 60, UsersCurrent: 7, UsersPrevious: 0, FirstSeenDay: "2026-11-02"},
			{CategoryID: "office.translate", Current30: 50, Previous30: 100, UsersCurrent: -1, UsersPrevious: -1},
			{CategoryID: "data.sql", Current30: 110, Previous30: 100, RequestsCurrent: 110, RequestsPrevious: 100, CostCurrent: 30000, CostPrevious: 10000, UsersCurrent: 5, UsersPrevious: 5},
			{CategoryID: "infra.k8s", Current30: 100, Previous30: 95, ModelValues: map[string]float64{"alpha": 90, "beta": 10}, TeamValues: map[string]float64{"플랫폼": 80, "결제": 20}, UsersCurrent: 4, UsersPrevious: 4},
			{CategoryID: "office.summary", Current30: 50, Previous30: 45, TeamsCurrent: 5, TeamsPrevious: 2, UsersCurrent: 20, UsersPrevious: 8},
			{CategoryID: "support.reply", Current7: 30, Previous7: 0, Current30: 40, Previous30: 38, FirstSeenDay: "2026-03-01", UsersCurrent: 3, UsersPrevious: 3},
		},
	}
	got := DetectSignals(in, SignalThresholds{})
	want := "new:ai.rag rising_7d:support.reply rising_7d:dev.test rising_30d:dev.test cost_spike:data.sql " +
		"declining:office.translate spreading:office.summary model_dependence:infra.k8s team_concentrated:infra.k8s"
	if signalKinds(got) != want {
		t.Fatalf("signals = %s\nwant      %s", signalKinds(got), want)
	}

	rising := findSignal(t, got, SignalRising7d, "dev.test")
	if rising.Current != 42 || rising.Previous != 20 || rising.ChangeAbs != 22 || rising.ChangeRate == nil || math.Abs(*rising.ChangeRate-1.1) > 1e-9 || rising.Sample != 42 {
		t.Errorf("rising_7d = %+v", rising)
	}
	if rising.UsersCurrent == nil || *rising.UsersCurrent != 12 || rising.UsersPrevious == nil || *rising.UsersPrevious != 9 {
		t.Errorf("rising_7d users = %v / %v", rising.UsersCurrent, rising.UsersPrevious)
	}
	if !strings.Contains(rising.Note, "42") || !strings.Contains(rising.Note, "20") || !strings.Contains(rising.Note, "110%") {
		t.Errorf("note = %q", rising.Note)
	}
	month := findSignal(t, got, SignalRising30d, "dev.test")
	if month.ChangeAbs != 50 || month.ChangeRate == nil || *month.ChangeRate != 0.5 {
		t.Errorf("rising_30d = %+v", month)
	}

	// A category that is new is reported once, as new, not also as rising.
	fresh := findSignal(t, got, SignalNew, "ai.rag")
	if fresh.Current != 60 || fresh.Previous != 0 || fresh.ChangeRate != nil || fresh.Sample != 60 {
		t.Errorf("new = %+v", fresh)
	}
	// A surge from nothing in an old category has no rate to report.
	surge := findSignal(t, got, SignalRising7d, "support.reply")
	if surge.ChangeRate != nil || surge.ChangeAbs != 30 {
		t.Errorf("surge = %+v", surge)
	}

	down := findSignal(t, got, SignalDeclining, "office.translate")
	if down.ChangeAbs != -50 || down.ChangeRate == nil || *down.ChangeRate != -0.5 || down.Sample != 100 {
		t.Errorf("declining = %+v", down)
	}
	if down.UsersCurrent != nil || down.UsersPrevious != nil {
		t.Error("unknown user counts must stay nil")
	}

	spike := findSignal(t, got, SignalCostSpike, "data.sql")
	if spike.Current != 30000 || spike.Previous != 10000 || spike.ChangeAbs != 20000 || *spike.ChangeRate != 2 || spike.Sample != 110 {
		t.Errorf("cost_spike = %+v", spike)
	}

	model := findSignal(t, got, SignalModelDependence, "infra.k8s")
	if model.Model != "alpha" || model.Current != 90 || model.Share == nil || *model.Share != 0.9 || model.Sample != 100 {
		t.Errorf("model_dependence = %+v", model)
	}
	team := findSignal(t, got, SignalTeamConcentrated, "infra.k8s")
	if team.Team != "플랫폼" || team.Current != 80 || *team.Share != 0.8 {
		t.Errorf("team_concentrated = %+v", team)
	}
	spread := findSignal(t, got, SignalSpreading, "office.summary")
	if spread.Current != 5 || spread.Previous != 2 || spread.ChangeAbs != 3 || *spread.ChangeRate != 1.5 {
		t.Errorf("spreading = %+v", spread)
	}

	t.Run("deterministic", func(t *testing.T) {
		for i := 0; i < 20; i++ {
			if again := signalKinds(DetectSignals(in, SignalThresholds{})); again != want {
				t.Fatalf("run %d: %s", i, again)
			}
		}
	})

	t.Run("with few teams concentration means nothing", func(t *testing.T) {
		small := in
		small.TotalTeams = 2
		for _, s := range DetectSignals(small, SignalThresholds{}) {
			if s.Kind == SignalTeamConcentrated {
				t.Errorf("team_concentrated reported with two teams: %+v", s)
			}
		}
	})

	t.Run("thresholds are honoured", func(t *testing.T) {
		strict := DetectSignals(in, SignalThresholds{MinSample: 1000, MinChangeAbs: 10, MinChangeRate: 0.3})
		if len(strict) != 0 {
			t.Errorf("signals above a sample of 1000: %s", signalKinds(strict))
		}
		loose := DetectSignals(SignalInput{Series: []CategorySeries{{CategoryID: "x", Current7: 6, Previous7: 2}}},
			SignalThresholds{MinSample: 5, MinChangeAbs: 3, MinChangeRate: 0.5})
		if signalKinds(loose) != "rising_7d:x" {
			t.Errorf("loose thresholds gave %q", signalKinds(loose))
		}
	})

	t.Run("JSON shape", func(t *testing.T) {
		raw, _ := json.Marshal(rising)
		for _, key := range []string{`"kind"`, `"category_id"`, `"team"`, `"model"`, `"current"`, `"previous"`, `"change_abs"`, `"change_rate"`, `"users_current"`, `"users_previous"`, `"sample"`, `"note"`} {
			if !strings.Contains(string(raw), key) {
				t.Errorf("signal JSON lacks %s: %s", key, raw)
			}
		}
		raw, _ = json.Marshal(fresh)
		if !strings.Contains(string(raw), `"change_rate":null`) {
			t.Errorf("a missing rate must serialise as null: %s", raw)
		}
		raw, _ = json.Marshal(DefaultSignalThresholds())
		if string(raw) != `{"min_sample":20,"min_change_abs":10,"min_change_rate":0.3}` {
			t.Errorf("thresholds JSON = %s", raw)
		}
	})
}

func TestScoreAutomation(t *testing.T) {
	tests := []struct {
		name     string
		p        PatternStats
		want     string
		risk     string
		approval bool
		basis    []string
	}{
		{
			name: "same prompt by many users without tools",
			p:    PatternStats{CategoryID: "office.summary", ActionType: "create", Repeats: 148, Users: 12, Sessions: 140, ActiveDays: 9, WindowDays: 30, HourConcentration: 0.2},
			want: AutomationPromptTemplate, risk: RiskLow,
			basis: []string{"12명", "148회", "프롬프트 템플릿"},
		},
		{
			name: "multi-step sessions without tools",
			p:    PatternStats{CategoryID: "planning.project", ActionType: "plan", Repeats: 90, Users: 6, Sessions: 30, ActiveDays: 10, WindowDays: 30},
			want: AutomationSkill, risk: RiskLow,
			basis: []string{"6명", "30개 세션", "90회", "스킬"},
		},
		{
			name: "one tool called over and over",
			p:    PatternStats{CategoryID: "data.sql", ActionType: "read", Repeats: 60, Users: 4, Sessions: 55, MCPCalls: 70, MCPTools: []string{"run_query"}, SameToolSequence: 58, ActiveDays: 8, WindowDays: 30},
			want: AutomationMCPTool, risk: RiskLow,
			basis: []string{"60회", "70회", "MCP 도구"},
		},
		{
			name: "a fixed sequence of two tools",
			p:    PatternStats{CategoryID: "knowledge.search", ActionType: "read", Repeats: 50, Users: 5, Sessions: 45, MCPCalls: 100, MCPTools: []string{"search_pages", "get_page"}, SameToolSequence: 44, ActiveDays: 12, WindowDays: 30},
			want: AutomationWorkflow, risk: RiskLow,
			basis: []string{"50회", "44회", "2종", "워크플로"},
		},
		{
			name: "many tools in varying order",
			p:    PatternStats{CategoryID: "dev.debug", ActionType: "analyze", Repeats: 120, Users: 8, Sessions: 20, MCPCalls: 400, MCPTools: []string{"read_file", "search_code", "list_dir", "get_logs"}, SameToolSequence: 15, ActiveDays: 15, WindowDays: 30},
			want: AutomationAgent, risk: RiskLow,
			basis: []string{"20개 세션", "4종", "120회", "에이전트"},
		},
		{
			name: "runs like clockwork",
			p:    PatternStats{CategoryID: "data.extract", ActionType: "read", Repeats: 28, Users: 1, Sessions: 28, ActiveDays: 26, WindowDays: 30, HourConcentration: 0.9, MCPCalls: 28, MCPTools: []string{"run_query"}, SameToolSequence: 28},
			want: AutomationBatch, risk: RiskLow,
			basis: []string{"30일 중 26일", "90%", "배치"},
		},
		{
			name: "writing tools raise the risk",
			p:    PatternStats{CategoryID: "support.reply", ActionType: "create", Repeats: 60, Users: 4, Sessions: 55, MCPCalls: 60, MCPTools: []string{"send_email"}, SameToolSequence: 55},
			want: AutomationMCPTool, risk: RiskMedium,
		},
		{
			name: "deleting on infrastructure needs approval",
			p:    PatternStats{CategoryID: "infra.k8s", TopCategoryID: "infra", ActionType: "delete", Repeats: 80, Users: 3, Sessions: 70, MCPCalls: 90, MCPTools: []string{"kubectl_delete"}, SameToolSequence: 75},
			want: AutomationMCPTool, risk: RiskHigh, approval: true,
			basis: []string{"승인"},
		},
		{
			name: "modifying a service in operation needs approval",
			p:    PatternStats{CategoryID: "itsm.change", ActionType: "modify", Repeats: 40, Users: 3, Sessions: 40},
			want: AutomationPromptTemplate, risk: RiskHigh, approval: true,
			basis: []string{"승인"},
		},
		{
			name: "deleting elsewhere is a medium risk but still needs approval",
			p:    PatternStats{CategoryID: "office.report", ActionType: "delete", Repeats: 40, Users: 3, Sessions: 40},
			want: AutomationPromptTemplate, risk: RiskMedium, approval: true,
		},
		{
			name: "modifying a document is ordinary work",
			p:    PatternStats{CategoryID: "office.report", ActionType: "modify", Repeats: 40, Users: 3, Sessions: 40},
			want: AutomationPromptTemplate, risk: RiskLow,
		},
		{
			name: "sensitive patterns need approval",
			p:    PatternStats{CategoryID: "office.email", ActionType: "create", Repeats: 40, Users: 3, Sessions: 40, Sensitive: true},
			want: AutomationPromptTemplate, risk: RiskMedium, approval: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ScoreAutomation(tt.p)
			if got.Recommended != tt.want || got.Risk != tt.risk || got.NeedsApproval != tt.approval {
				t.Errorf("got %s risk %s approval %v, want %s %s %v", got.Recommended, got.Risk, got.NeedsApproval, tt.want, tt.risk, tt.approval)
			}
			if got.Feasibility < 0 || got.Feasibility > 1 {
				t.Errorf("feasibility %v out of range", got.Feasibility)
			}
			for _, part := range tt.basis {
				if !strings.Contains(got.Basis, part) {
					t.Errorf("basis %q lacks %q", got.Basis, part)
				}
			}
			if got.MCPTools == nil {
				t.Error("mcp_tools must not be nil")
			}
			if len(tt.p.MCPTools) > 0 && got.MCPTools[0] != tt.p.MCPTools[0] {
				t.Errorf("mcp_tools = %v", got.MCPTools)
			}
		})
	}

	// More repetition by more people is more worth automating; risk costs.
	base := PatternStats{CategoryID: "office.summary", ActionType: "create", Repeats: 20, Users: 2, Sessions: 20}
	more := base
	more.Repeats, more.Users, more.Sessions = 200, 9, 200
	if a, b := ScoreAutomation(base).Feasibility, ScoreAutomation(more).Feasibility; b <= a {
		t.Errorf("feasibility did not grow with volume: %v → %v", a, b)
	}
	risky := more
	risky.CategoryID, risky.ActionType = "infra.server", "delete"
	if a, b := ScoreAutomation(more).Feasibility, ScoreAutomation(risky).Feasibility; b >= a {
		t.Errorf("a high-risk pattern is as feasible as a safe one: %v vs %v", a, b)
	}
	if got := ScoreAutomation(PatternStats{}); got.Feasibility > 0.3 || got.Recommended == "" || got.Risk != RiskLow {
		t.Errorf("empty pattern scored %+v", got)
	}
	raw, _ := json.Marshal(ScoreAutomation(base))
	for _, key := range []string{`"recommended"`, `"feasibility"`, `"risk"`, `"needs_approval"`, `"mcp_tools":[]`, `"basis"`} {
		if !strings.Contains(string(raw), key) {
			t.Errorf("score JSON lacks %s: %s", key, raw)
		}
	}
}

func TestEstimateSavings(t *testing.T) {
	b := &Baseline{CategoryID: "dev", ManualMinutes: 60, AIMinutes: 15, HourlyCostKRW: 50000}

	minutes, cost, reason := EstimateSavings(nil, 10)
	if minutes != nil || cost != nil || !strings.Contains(reason, "기준값") {
		t.Errorf("no baseline: %v %v %q", minutes, cost, reason)
	}
	for _, sessions := range []int64{0, -3} {
		minutes, cost, reason = EstimateSavings(b, sessions)
		if minutes != nil || cost != nil || !strings.Contains(reason, "완료가 확인된 세션이 없어") {
			t.Errorf("%d confirmed sessions: %v %v %q", sessions, minutes, cost, reason)
		}
	}

	minutes, cost, reason = EstimateSavings(b, 10)
	if minutes == nil || *minutes != 450 || cost == nil || *cost != 375000 {
		t.Fatalf("estimate = %v min, %v KRW; want 450 and 375000", minutes, cost)
	}
	for _, part := range []string{"10건", "60분", "15분"} {
		if !strings.Contains(reason, part) {
			t.Errorf("reason %q lacks %q", reason, part)
		}
	}

	noCost := &Baseline{ManualMinutes: 30, AIMinutes: 7.5}
	minutes, cost, reason = EstimateSavings(noCost, 4)
	if minutes == nil || *minutes != 90 || cost != nil || !strings.Contains(reason, "시간당 비용") || !strings.Contains(reason, "7.5분") {
		t.Errorf("without hourly cost: %v %v %q", minutes, cost, reason)
	}

	slower := &Baseline{ManualMinutes: 10, AIMinutes: 12, HourlyCostKRW: 50000}
	minutes, cost, reason = EstimateSavings(slower, 5)
	if minutes == nil || *minutes != 0 || cost == nil || *cost != 0 || !strings.Contains(reason, "절감 효과가 없습니다") {
		t.Errorf("AI slower than manual: %v %v %q", minutes, cost, reason)
	}

	minutes, cost, _ = EstimateSavings(&Baseline{ManualMinutes: 0, AIMinutes: 5}, 5)
	if minutes != nil || cost != nil {
		t.Errorf("a broken baseline produced an estimate: %v %v", minutes, cost)
	}
}

var numberInText = regexp.MustCompile(`\d+(?:\.\d+)?`)

// assertGrounded checks that every number an insight states can be found in
// its evidence, either as the value itself or as the percentage of a ratio.
func assertGrounded(t *testing.T, ins Insight) {
	t.Helper()
	allowed := map[string]bool{strconv.FormatInt(ins.Evidence.Sample, 10): true}
	for _, v := range ins.Evidence.Metrics {
		allowed[formatCount(math.Abs(v))] = true
		allowed[formatPercent(math.Abs(v))] = true
	}
	for _, num := range numberInText.FindAllString(ins.Title+" "+ins.Body, -1) {
		if !allowed[num] {
			keys := make([]string, 0, len(ins.Evidence.Metrics))
			for k, v := range ins.Evidence.Metrics {
				keys = append(keys, k+"="+strconv.FormatFloat(v, 'g', -1, 64))
			}
			sort.Strings(keys)
			t.Errorf("%s: the text states %s, which is not in the evidence (%s)\n  %s %s", ins.Kind, num, strings.Join(keys, ", "), ins.Title, ins.Body)
		}
	}
}

func TestBuildInsights(t *testing.T) {
	names := map[string]string{
		"dev.test": "테스트", "ai.rag": "RAG·검색 증강", "office.translate": "번역", "data.sql": "SQL 생성",
		"infra.k8s": "쿠버네티스·컨테이너 운영", "office.summary": "요약·회의록", "support.reply": "고객 문의 응대",
	}
	signals := DetectSignals(SignalInput{
		WindowStart: "2026-10-28",
		TotalTeams:  6,
		Series: []CategorySeries{
			{CategoryID: "dev.test", Current7: 42, Previous7: 20, Current30: 157, Previous30: 103, UsersCurrent: 12, UsersPrevious: 9},
			{CategoryID: "ai.rag", Current7: 25, Current30: 61, UsersCurrent: 7, FirstSeenDay: "2026-11-02"},
			{CategoryID: "office.translate", Current30: 53, Previous30: 118, UsersCurrent: -1, UsersPrevious: -1},
			{CategoryID: "data.sql", Current30: 110, Previous30: 100, RequestsCurrent: 113, RequestsPrevious: 97, CostCurrent: 31400, CostPrevious: 10900},
			{CategoryID: "infra.k8s", Current30: 104, Previous30: 95, ModelValues: map[string]float64{"alpha": 91, "beta": 13}, TeamValues: map[string]float64{"플랫폼": 83, "결제": 21}},
			{CategoryID: "office.summary", Current30: 50, Previous30: 45, TeamsCurrent: 5, TeamsPrevious: 2},
			{CategoryID: "support.reply", Current7: 33, Previous7: 0, Current30: 40, Previous30: 38, FirstSeenDay: "2026-03-01"},
		},
	}, SignalThresholds{})

	in := InsightInput{
		Period:        "2026-10-28~2026-11-26",
		Compare:       "2026-09-28~2026-10-27",
		CategoryNames: names,
		Signals:       signals,
		Models: []ModelUsage{
			{Model: "alpha", Requests: 612, CostKRW: 41000},
			{Model: "beta", Requests: 243, CostKRW: 287000},
			{Model: "gamma", Requests: 11, CostKRW: 900},
		},
		Automation: []AutomationSummary{
			{ID: "fp1:office.summary", Title: "회의록 정리", CategoryID: "office.summary", Repeats: 148, Users: 12, Recommended: AutomationPromptTemplate, Feasibility: 0.86, Risk: RiskLow},
			{ID: "fp2:infra.k8s", Title: "파드 재시작", CategoryID: "infra.k8s", Repeats: 77, Users: 3, Recommended: AutomationMCPTool, Feasibility: 0.64, Risk: RiskHigh},
			{ID: "fp3:dev.test", Title: "드문 요청", CategoryID: "dev.test", Repeats: 6, Users: 2, Recommended: AutomationSkill, Feasibility: 0.9, Risk: RiskLow},
			{ID: "fp4:dev.test", Title: "애매한 요청", CategoryID: "dev.test", Repeats: 90, Users: 5, Recommended: AutomationAgent, Feasibility: 0.4, Risk: RiskLow},
		},
	}
	got := BuildInsights(in)

	byKind := map[string][]Insight{}
	for _, ins := range got {
		byKind[ins.Kind] = append(byKind[ins.Kind], ins)
		assertGrounded(t, ins)
		if ins.Title == "" || ins.Body == "" {
			t.Errorf("%s: empty text", ins.Kind)
		}
		if ins.Severity != SeverityInfo && ins.Severity != SeverityNotice && ins.Severity != SeverityWarning {
			t.Errorf("%s: severity %q", ins.Kind, ins.Severity)
		}
		if ins.Evidence.Period != in.Period || ins.Evidence.Compare != in.Compare || ins.Evidence.Sample <= 0 || len(ins.Evidence.Metrics) == 0 {
			t.Errorf("%s: evidence %+v", ins.Kind, ins.Evidence)
		}
		if ins.Link["tab"] == "" {
			t.Errorf("%s: no link target", ins.Kind)
		}
	}
	for _, kind := range []string{
		SignalNew, SignalRising7d, SignalRising30d, SignalCostSpike, SignalDeclining, SignalSpreading,
		SignalModelDependence, SignalTeamConcentrated, "model_mix", "model_cost", "automation_candidate",
	} {
		if len(byKind[kind]) == 0 {
			t.Errorf("no %s insight", kind)
		}
	}

	rising := byKind[SignalRising7d]
	if len(rising) != 2 {
		t.Fatalf("rising_7d insights = %d", len(rising))
	}
	if want := "최근 7일 동안 42건으로, 이전 7일의 20건보다 110% 늘었습니다."; rising[1].Body != want || rising[1].Title != "테스트 업무가 늘고 있습니다" {
		t.Errorf("rising insight = %q / %q\nwant body %q", rising[1].Title, rising[1].Body, want)
	}
	if rising[1].Evidence.Metrics["current"] != 42 || rising[1].Evidence.Metrics["previous"] != 20 || rising[1].Evidence.Sample != 42 {
		t.Errorf("rising evidence = %+v", rising[1].Evidence)
	}
	if rising[0].Body != "이전 7일에는 사용이 없었는데 최근 7일 동안 33건 사용되었습니다." {
		t.Errorf("surge insight = %q", rising[0].Body)
	}
	if down := byKind[SignalDeclining][0]; !strings.Contains(down.Body, "53건") || !strings.Contains(down.Body, "118건") || !strings.Contains(down.Body, "55% 줄었습니다") {
		t.Errorf("declining insight = %q", down.Body)
	}
	if spike := byKind[SignalCostSpike][0]; spike.Severity != SeverityWarning || !strings.Contains(spike.Body, "31400원") || !strings.Contains(spike.Body, "10900원") || !strings.Contains(spike.Body, "188%") {
		t.Errorf("cost insight = %s %q", spike.Severity, spike.Body)
	}
	if dep := byKind[SignalModelDependence][0]; !strings.Contains(dep.Body, "104건 가운데 91건(88%)을 alpha 모델") || dep.Link["model"] != "alpha" {
		t.Errorf("model dependence insight = %q %v", dep.Body, dep.Link)
	}
	if mix := byKind["model_mix"][0]; !strings.Contains(mix.Body, "866건 가운데 612건(71%)을 alpha 모델") {
		t.Errorf("model mix insight = %q", mix.Body)
	}
	if cost := byKind["model_cost"][0]; !strings.Contains(cost.Title, "beta") || !strings.Contains(cost.Body, "요청의 28%") || !strings.Contains(cost.Body, "비용의 87%") {
		t.Errorf("model cost insight = %q %q", cost.Title, cost.Body)
	}

	auto := byKind["automation_candidate"]
	if len(auto) != 2 {
		t.Fatalf("automation insights = %d, want the two candidates that clear the thresholds", len(auto))
	}
	if !strings.Contains(auto[0].Body, "12명이 148회") || !strings.Contains(auto[0].Body, "프롬프트 템플릿") || auto[0].Link["candidate"] != "fp1:office.summary" {
		t.Errorf("automation insight = %q %v", auto[0].Body, auto[0].Link)
	}
	if auto[1].Severity != SeverityNotice || !strings.Contains(auto[1].Body, "승인") {
		t.Errorf("a high-risk candidate must mention approval: %s %q", auto[1].Severity, auto[1].Body)
	}

	t.Run("nothing below the thresholds", func(t *testing.T) {
		tiny := InsightInput{
			Period: "p", Compare: "c", CategoryNames: names,
			Signals: []Signal{
				{Kind: SignalRising7d, CategoryID: "dev.test", Current: 9, Previous: 1, ChangeAbs: 8, Sample: 9},
				{Kind: SignalModelDependence, CategoryID: "dev.test", Model: "alpha", Current: 5, Sample: 5},
				{Kind: "made_up_kind", CategoryID: "dev.test", Current: 500, Sample: 500},
				{Kind: SignalDeclining, CategoryID: "dev.test", Current: 50, Previous: 100, Sample: 100}, // no rate: unusable
			},
			Models:     []ModelUsage{{Model: "alpha", Requests: 9, CostKRW: 10}, {Model: "beta", Requests: 2, CostKRW: 900}},
			Automation: []AutomationSummary{{ID: "a", CategoryID: "dev.test", Repeats: 8, Users: 4, Recommended: AutomationSkill, Feasibility: 0.95}},
		}
		if out := BuildInsights(tiny); len(out) != 0 {
			t.Errorf("insights from samples below the thresholds: %+v", out)
		}
		if out := BuildInsights(InsightInput{}); out == nil || len(out) != 0 {
			t.Errorf("empty input gave %v", out)
		}
	})

	t.Run("at most three insights per kind", func(t *testing.T) {
		rate := 0.5
		var many []Signal
		for i := 0; i < 9; i++ {
			many = append(many, Signal{Kind: SignalRising30d, CategoryID: "dev.test", Current: 300, Previous: 200, ChangeAbs: 100, ChangeRate: &rate, Sample: 300})
		}
		if out := BuildInsights(InsightInput{Signals: many}); len(out) != 3 {
			t.Errorf("got %d insights", len(out))
		}
	})

	t.Run("an unnamed category falls back to its id", func(t *testing.T) {
		rate := 0.5
		out := BuildInsights(InsightInput{Signals: []Signal{{Kind: SignalRising30d, CategoryID: "custom.thing", Current: 300, Previous: 200, ChangeAbs: 100, ChangeRate: &rate, Sample: 300}}})
		if len(out) != 1 || !strings.HasPrefix(out[0].Title, "custom.thing ") {
			t.Errorf("got %+v", out)
		}
	})

	t.Run("JSON shape", func(t *testing.T) {
		raw, _ := json.Marshal(got[0])
		for _, key := range []string{`"kind"`, `"severity"`, `"title"`, `"body"`, `"evidence"`, `"period"`, `"compare"`, `"sample"`, `"metrics"`, `"link"`} {
			if !strings.Contains(string(raw), key) {
				t.Errorf("insight JSON lacks %s: %s", key, raw)
			}
		}
	})
}
