package workintel

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

// LatencyBounds are the upper bounds, in milliseconds, of the first seven
// latency histogram buckets (lat_b0…lat_b6). The eighth bucket holds
// everything slower.
var LatencyBounds = []int64{500, 1000, 2000, 5000, 10000, 30000, 60000}

// LatencyBuckets is the number of latency histogram buckets.
const LatencyBuckets = 8

// LatencyBucket returns the histogram bucket (0..7) for a latency. Bounds are
// inclusive, as in a Prometheus "le" histogram.
func LatencyBucket(ms int64) int {
	for i, b := range LatencyBounds {
		if ms <= b {
			return i
		}
	}
	return len(LatencyBounds)
}

// ConfidenceLabels names the confidence buckets (conf_b0…conf_b4).
var ConfidenceLabels = []string{"<0.5", "0.5-0.6", "0.6-0.75", "0.75-0.9", ">=0.9"}

var confidenceBounds = []float64{0.5, 0.6, 0.75, 0.9}

// ConfidenceBucket returns the bucket (0..4) of a confidence value.
func ConfidenceBucket(c float64) int {
	for i, b := range confidenceBounds {
		if c < b {
			return i
		}
	}
	return len(confidenceBounds)
}

// Percentile estimates the p-quantile (p in 0..1) of a latency histogram
// laid out like LatencyBounds. It interpolates linearly inside the bucket
// the quantile falls in. The last bucket has no upper bound, so a quantile
// that lands there is reported as that bucket's lower bound: an honest
// "at least this much" rather than an invented figure.
func Percentile(counts []int64, p float64) float64 {
	var total int64
	for _, c := range counts {
		if c > 0 {
			total += c
		}
	}
	if total == 0 {
		return 0
	}
	rank := clamp01(p) * float64(total)
	var seen float64
	for i, c := range counts {
		if c <= 0 {
			continue
		}
		if seen+float64(c) < rank {
			seen += float64(c)
			continue
		}
		lower := 0.0
		if i > 0 {
			lower = float64(LatencyBounds[min(i-1, len(LatencyBounds)-1)])
		}
		if i >= len(LatencyBounds) {
			return lower
		}
		upper := float64(LatencyBounds[i])
		return lower + (rank-seen)/float64(c)*(upper-lower)
	}
	return float64(LatencyBounds[len(LatencyBounds)-1])
}

// Diversity is the normalised Shannon entropy of a distribution: 0 when
// everything falls into one entry, 1 when all entries are equal. It is
// normalised by the number of entries given, zeros included, so pass one
// value per category of the comparison set to keep teams comparable.
func Diversity(values []float64) float64 {
	if len(values) < 2 {
		return 0
	}
	var total float64
	for _, v := range values {
		if v > 0 {
			total += v
		}
	}
	if total <= 0 {
		return 0
	}
	var h float64
	for _, v := range values {
		if v > 0 {
			p := v / total
			h -= p * math.Log(p)
		}
	}
	return clamp01(h / math.Log(float64(len(values))))
}

// ---- Trend signals ----

// Signal kinds.
const (
	SignalRising7d         = "rising_7d"
	SignalRising30d        = "rising_30d"
	SignalNew              = "new"
	SignalDeclining        = "declining"
	SignalCostSpike        = "cost_spike"
	SignalModelDependence  = "model_dependence"
	SignalTeamConcentrated = "team_concentrated"
	SignalSpreading        = "spreading"
)

const (
	// modelDependenceShare and teamConcentrationShare are the shares from
	// which one model or team is considered to dominate a category.
	modelDependenceShare   = 0.8
	teamConcentrationShare = 0.7
	// minTeamsForConcentration: with fewer teams in the organisation,
	// "concentrated in one team" says nothing.
	minTeamsForConcentration = 3
	// spreadingMinTeams and spreadingMinGain define adoption across teams.
	spreadingMinTeams = 3
	spreadingMinGain  = 2
)

// SignalThresholds keep noise out of the trend list. A change is only a
// signal when it is large in absolute terms, large in relative terms and
// backed by enough volume; any one of them alone flags blips of small
// categories.
type SignalThresholds struct {
	MinSample     int64   `json:"min_sample"`
	MinChangeAbs  float64 `json:"min_change_abs"`
	MinChangeRate float64 `json:"min_change_rate"`
}

// DefaultSignalThresholds returns the thresholds used when none are configured.
func DefaultSignalThresholds() SignalThresholds {
	return SignalThresholds{MinSample: 20, MinChangeAbs: 10, MinChangeRate: 0.3}
}

func (th SignalThresholds) withDefaults() SignalThresholds {
	def := DefaultSignalThresholds()
	if th.MinSample <= 0 {
		th.MinSample = def.MinSample
	}
	if th.MinChangeAbs <= 0 {
		th.MinChangeAbs = def.MinChangeAbs
	}
	if th.MinChangeRate <= 0 {
		th.MinChangeRate = def.MinChangeRate
	}
	return th
}

// CategorySeries is the aggregated usage of one category in the windows the
// trend detection compares. Values are in the caller's metric (sessions by
// default); Requests are always request counts and serve as the sample size
// for cost and share signals.
type CategorySeries struct {
	CategoryID string
	// Current7/Previous7 are the last seven days and the seven before them.
	Current7, Previous7 float64
	// Current30/Previous30 are the last thirty days and the thirty before them.
	Current30, Previous30 float64
	// UsersCurrent/UsersPrevious are distinct users in the thirty-day
	// windows; negative means unknown or suppressed.
	UsersCurrent, UsersPrevious int64
	// CostCurrent/CostPrevious are KRW in the thirty-day windows.
	CostCurrent, CostPrevious float64
	// RequestsCurrent/RequestsPrevious are request counts in the thirty-day windows.
	RequestsCurrent, RequestsPrevious int64
	// FirstSeenDay is the first day (YYYY-MM-DD) the category was ever used.
	FirstSeenDay string
	// TeamValues and ModelValues split Current30 by team and by model.
	TeamValues  map[string]float64
	ModelValues map[string]float64
	// TeamsCurrent/TeamsPrevious are the numbers of teams using the category.
	TeamsCurrent, TeamsPrevious int
}

// SignalInput is what DetectSignals looks at.
type SignalInput struct {
	// WindowStart is the first day (YYYY-MM-DD) of the current thirty-day
	// window; a category first seen on or after it is new.
	WindowStart string
	// TotalTeams is the number of teams active in the window.
	TotalTeams int
	Series     []CategorySeries
}

// Signal is one detected trend. Team and Model are set for the kinds that
// are about one team or model. ChangeRate is nil when there is no previous
// value to compare against, and the user counts are nil when unknown.
type Signal struct {
	Kind          string   `json:"kind"`
	CategoryID    string   `json:"category_id"`
	Team          string   `json:"team"`
	Model         string   `json:"model"`
	Current       float64  `json:"current"`
	Previous      float64  `json:"previous"`
	ChangeAbs     float64  `json:"change_abs"`
	ChangeRate    *float64 `json:"change_rate"`
	UsersCurrent  *int64   `json:"users_current"`
	UsersPrevious *int64   `json:"users_previous"`
	// Share is the share of the category held by Team or Model, for the two
	// concentration kinds.
	Share  *float64 `json:"share,omitempty"`
	Sample int64    `json:"sample"`
	Note   string   `json:"note"`
}

var signalOrder = map[string]int{
	SignalNew: 0, SignalRising7d: 1, SignalRising30d: 2, SignalCostSpike: 3,
	SignalDeclining: 4, SignalSpreading: 5, SignalModelDependence: 6, SignalTeamConcentrated: 7,
}

// DetectSignals derives trend signals from per-category series. Zero
// thresholds take their defaults. The result is ordered by kind and then by
// the size of the change, so it is stable for the same input.
func DetectSignals(in SignalInput, th SignalThresholds) []Signal {
	th = th.withDefaults()
	out := []Signal{}
	for _, s := range in.Series {
		users := func(sig *Signal) {
			if s.UsersCurrent >= 0 {
				v := s.UsersCurrent
				sig.UsersCurrent = &v
			}
			if s.UsersPrevious >= 0 {
				v := s.UsersPrevious
				sig.UsersPrevious = &v
			}
		}
		isNew := in.WindowStart != "" && s.FirstSeenDay != "" && s.FirstSeenDay >= in.WindowStart &&
			s.Previous30 == 0 && s.Current30 >= float64(th.MinSample)
		if isNew {
			sig := Signal{
				Kind: SignalNew, CategoryID: s.CategoryID, Current: s.Current30, ChangeAbs: s.Current30,
				Sample: int64(s.Current30),
				Note:   fmt.Sprintf("%s에 처음 나타나 최근 30일 동안 %s건 사용되었습니다.", s.FirstSeenDay, formatCount(s.Current30)),
			}
			users(&sig)
			out = append(out, sig)
		}

		// A category that is new is not also reported as rising: both would
		// describe the same fact.
		if !isNew {
			if sig, ok := risingSignal(SignalRising7d, "7일", s.CategoryID, s.Current7, s.Previous7, th); ok {
				users(&sig)
				out = append(out, sig)
			}
			if sig, ok := risingSignal(SignalRising30d, "30일", s.CategoryID, s.Current30, s.Previous30, th); ok {
				users(&sig)
				out = append(out, sig)
			}
		}

		if drop := s.Previous30 - s.Current30; s.Previous30 >= float64(th.MinSample) &&
			drop >= th.MinChangeAbs && drop/s.Previous30 >= th.MinChangeRate {
			rate := -drop / s.Previous30
			sig := Signal{
				Kind: SignalDeclining, CategoryID: s.CategoryID, Current: s.Current30, Previous: s.Previous30,
				ChangeAbs: -drop, ChangeRate: &rate, Sample: int64(s.Previous30),
				Note: fmt.Sprintf("최근 30일 %s건으로 이전 30일 %s건보다 %s%% 줄었습니다.",
					formatCount(s.Current30), formatCount(s.Previous30), formatPercent(drop/s.Previous30)),
			}
			users(&sig)
			out = append(out, sig)
		}

		// A cost spike is a rise in cost per request, not just in cost: more
		// usage costing more is already covered by the rising signals.
		if s.RequestsCurrent >= th.MinSample && s.RequestsPrevious >= th.MinSample && s.CostPrevious > 0 {
			costRate := (s.CostCurrent - s.CostPrevious) / s.CostPrevious
			unitNow := s.CostCurrent / float64(s.RequestsCurrent)
			unitBefore := s.CostPrevious / float64(s.RequestsPrevious)
			if costRate >= th.MinChangeRate && unitBefore > 0 && (unitNow-unitBefore)/unitBefore >= th.MinChangeRate {
				sig := Signal{
					Kind: SignalCostSpike, CategoryID: s.CategoryID, Current: s.CostCurrent, Previous: s.CostPrevious,
					ChangeAbs: s.CostCurrent - s.CostPrevious, ChangeRate: &costRate, Sample: s.RequestsCurrent,
					Note: fmt.Sprintf("최근 30일 비용이 %s원으로 이전 30일 %s원보다 %s%% 늘었고, 요청당 비용도 %s원에서 %s원으로 올랐습니다.",
						formatCount(s.CostCurrent), formatCount(s.CostPrevious), formatPercent(costRate),
						formatCount(unitBefore), formatCount(unitNow)),
				}
				users(&sig)
				out = append(out, sig)
			}
		}

		if s.TeamsCurrent >= spreadingMinTeams && s.TeamsCurrent-s.TeamsPrevious >= spreadingMinGain &&
			s.Current30 >= float64(th.MinSample) {
			sig := Signal{
				Kind: SignalSpreading, CategoryID: s.CategoryID,
				Current: float64(s.TeamsCurrent), Previous: float64(s.TeamsPrevious),
				ChangeAbs: float64(s.TeamsCurrent - s.TeamsPrevious), Sample: int64(s.Current30),
				Note: fmt.Sprintf("사용하는 팀이 %d개에서 %d개로 늘었습니다.", s.TeamsPrevious, s.TeamsCurrent),
			}
			if s.TeamsPrevious > 0 {
				rate := float64(s.TeamsCurrent-s.TeamsPrevious) / float64(s.TeamsPrevious)
				sig.ChangeRate = &rate
			}
			users(&sig)
			out = append(out, sig)
		}

		if name, value, total := dominant(s.ModelValues); total >= float64(th.MinSample) && len(s.ModelValues) > 0 {
			if share := value / total; share >= modelDependenceShare {
				sig := Signal{
					Kind: SignalModelDependence, CategoryID: s.CategoryID, Model: name,
					Current: value, Share: &share, Sample: int64(total),
					Note: fmt.Sprintf("최근 30일 %s건 중 %s건(%s%%)을 %s 모델이 처리했습니다.",
						formatCount(total), formatCount(value), formatPercent(share), name),
				}
				users(&sig)
				out = append(out, sig)
			}
		}

		if name, value, total := dominant(s.TeamValues); total >= float64(th.MinSample) &&
			in.TotalTeams >= minTeamsForConcentration {
			if share := value / total; share >= teamConcentrationShare {
				sig := Signal{
					Kind: SignalTeamConcentrated, CategoryID: s.CategoryID, Team: name,
					Current: value, Share: &share, Sample: int64(total),
					Note: fmt.Sprintf("최근 30일 %s건 중 %s건(%s%%)이 %s 팀에서 나왔습니다.",
						formatCount(total), formatCount(value), formatPercent(share), name),
				}
				users(&sig)
				out = append(out, sig)
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if signalOrder[a.Kind] != signalOrder[b.Kind] {
			return signalOrder[a.Kind] < signalOrder[b.Kind]
		}
		if math.Abs(a.ChangeAbs) != math.Abs(b.ChangeAbs) {
			return math.Abs(a.ChangeAbs) > math.Abs(b.ChangeAbs)
		}
		if a.Current != b.Current {
			return a.Current > b.Current
		}
		return a.CategoryID < b.CategoryID
	})
	return out
}

func risingSignal(kind, window, categoryID string, current, previous float64, th SignalThresholds) (Signal, bool) {
	gain := current - previous
	if current < float64(th.MinSample) || gain < th.MinChangeAbs {
		return Signal{}, false
	}
	sig := Signal{Kind: kind, CategoryID: categoryID, Current: current, Previous: previous, ChangeAbs: gain, Sample: int64(current)}
	if previous <= 0 {
		// No baseline to compute a rate from; the absolute gain and the
		// volume already cleared their thresholds.
		sig.Note = fmt.Sprintf("이전 %s에는 사용이 없었고 최근 %s 동안 %s건 사용되었습니다.", window, window, formatCount(current))
		return sig, true
	}
	rate := gain / previous
	if rate < th.MinChangeRate {
		return Signal{}, false
	}
	sig.ChangeRate = &rate
	sig.Note = fmt.Sprintf("최근 %s %s건으로 이전 %s %s건보다 %s%% 늘었습니다.",
		window, formatCount(current), window, formatCount(previous), formatPercent(rate))
	return sig, true
}

// dominant returns the largest entry of a split and the total. Ties resolve
// by name so the result does not depend on map order.
func dominant(values map[string]float64) (name string, value, total float64) {
	for k, v := range values {
		if v <= 0 {
			continue
		}
		total += v
		if v > value || (v == value && k < name) {
			name, value = k, v
		}
	}
	return name, value, total
}

// ---- Automation candidates ----

// Automation recommendation types.
const (
	AutomationPromptTemplate = "prompt_template"
	AutomationSkill          = "skill"
	AutomationMCPTool        = "mcp_tool"
	AutomationWorkflow       = "workflow"
	AutomationAgent          = "agent"
	AutomationBatch          = "batch"
)

// Risk levels of automating a pattern.
const (
	RiskLow    = "low"
	RiskMedium = "medium"
	RiskHigh   = "high"
)

// PatternStats describes one repeated request pattern (a prompt fingerprint
// within a category) over the observation window.
type PatternStats struct {
	CategoryID    string
	TopCategoryID string
	ActionType    string
	// Repeats is the number of requests with this fingerprint.
	Repeats  int64
	Users    int64
	Sessions int64
	// ActiveDays of WindowDays had at least one request.
	ActiveDays int64
	WindowDays int64
	// HourConcentration is the share of requests in the busiest hour of day
	// (0..1); high values with daily activity look like a schedule.
	HourConcentration float64
	// MCPCalls is the total number of tool calls; MCPTools the distinct
	// tools, most used first.
	MCPCalls int64
	MCPTools []string
	// SameToolSequence is the number of requests that used the most common
	// tool sequence.
	SameToolSequence int64
	// Sensitive marks patterns that triggered DLP or secret policies.
	Sensitive bool
}

// AutomationScore is the recommendation for one pattern.
type AutomationScore struct {
	Recommended   string   `json:"recommended"`
	Feasibility   float64  `json:"feasibility"`
	Risk          string   `json:"risk"`
	NeedsApproval bool     `json:"needs_approval"`
	MCPTools      []string `json:"mcp_tools"`
	Basis         string   `json:"basis"`
}

const (
	// scheduleDayShare and scheduleHourShare describe "runs like clockwork".
	scheduleDayShare  = 0.6
	scheduleHourShare = 0.6
	scheduleMaxUsers  = 2
	// agentMinTools and agentMinSteps describe open-ended multi-tool work.
	agentMinTools = 3
	agentMinSteps = 4.0
	skillMinSteps = 2.0
	// fixedSequenceShare is how often the same tool sequence must recur
	// before it is worth freezing into a workflow.
	fixedSequenceShare = 0.6
	maxAutomationTools = 8
)

// writeToolWords are name segments of tools that change something. "run" is
// deliberately absent: "run_query" reads, and tools that run arbitrary
// commands are caught by "command", "shell" and "exec".
var writeToolWords = []string{
	"create", "update", "delete", "remove", "apply", "exec", "execute", "command", "shell", "deploy", "restart",
	"scale", "send", "post", "write", "patch", "merge", "drop", "rollback", "transition", "put",
}

// ScoreAutomation recommends how a repeated pattern could be automated and
// how safe that would be. It only reads the statistics it is given; nothing
// is registered or executed on the strength of a score.
func ScoreAutomation(p PatternStats) AutomationScore {
	tools := capList(p.MCPTools, maxAutomationTools, 80)
	steps := 0.0
	if p.Sessions > 0 {
		steps = float64(p.Repeats) / float64(p.Sessions)
	}
	dayShare := 0.0
	if p.WindowDays > 0 {
		dayShare = clamp01(float64(p.ActiveDays) / float64(p.WindowDays))
	}
	sequenceShare := 0.0
	if p.Repeats > 0 {
		sequenceShare = clamp01(float64(p.SameToolSequence) / float64(p.Repeats))
	}
	hasTools := p.MCPCalls > 0 || len(tools) > 0

	out := AutomationScore{MCPTools: tools}
	consistency := 0.8 // the same fingerprint is the same prompt shape
	switch {
	case dayShare >= scheduleDayShare && p.HourConcentration >= scheduleHourShare && p.Users <= scheduleMaxUsers && p.Repeats > 0:
		out.Recommended = AutomationBatch
		consistency = math.Max(dayShare, p.HourConcentration)
		out.Basis = fmt.Sprintf("%d일 중 %d일 사용되었고 요청의 %s%%가 같은 시간대에 몰려 있어 정해진 시각에 실행하는 배치 작업으로 바꾸기 좋습니다.",
			p.WindowDays, p.ActiveDays, formatPercent(p.HourConcentration))
	case !hasTools && steps < skillMinSteps:
		out.Recommended = AutomationPromptTemplate
		out.Basis = fmt.Sprintf("%d명이 같은 형태의 요청을 %d회 반복했고 도구 호출이 없어 프롬프트 템플릿으로 만들기 좋습니다.",
			p.Users, p.Repeats)
	case !hasTools:
		out.Recommended = AutomationSkill
		out.Basis = fmt.Sprintf("%d명이 %d개 세션에서 같은 형태의 요청을 %d회 이어서 보냈고 도구 호출이 없어 여러 단계를 묶은 스킬로 만들기 좋습니다.",
			p.Users, p.Sessions, p.Repeats)
	case len(tools) >= agentMinTools && (steps >= agentMinSteps || sequenceShare < fixedSequenceShare):
		out.Recommended = AutomationAgent
		consistency = 0.5 + 0.5*sequenceShare
		out.Basis = fmt.Sprintf("%d개 세션에서 도구 %d종을 써서 %d회 반복되었고 호출 순서가 일정하지 않아 에이전트에 맡기기 좋습니다.",
			p.Sessions, len(tools), p.Repeats)
	case len(tools) <= 1:
		out.Recommended = AutomationMCPTool
		consistency = math.Max(sequenceShare, 0.6)
		out.Basis = fmt.Sprintf("%d회 반복되는 동안 도구 호출이 %d회 있었고 쓰인 도구가 한 종류라 전용 MCP 도구로 묶기 좋습니다.",
			p.Repeats, p.MCPCalls)
	default:
		out.Recommended = AutomationWorkflow
		consistency = math.Max(sequenceShare, 0.5)
		out.Basis = fmt.Sprintf("%d회 반복 가운데 %d회가 같은 순서로 도구 %d종을 호출해 워크플로로 고정하기 좋습니다.",
			p.Repeats, p.SameToolSequence, len(tools))
	}

	top := p.TopCategoryID
	if top == "" {
		top = topOfID(p.CategoryID)
	}
	operational := top == "infra" || top == "itsm" || top == "security"
	destructive := p.ActionType == "delete" || (p.ActionType == "modify" && (top == "infra" || top == "itsm"))
	writes := false
	for _, t := range tools {
		for _, tok := range splitLabel(nil, strings.ToLower(t)) {
			for _, w := range writeToolWords {
				if tok == w {
					writes = true
				}
			}
		}
	}
	switch {
	case destructive && operational:
		out.Risk = RiskHigh
	case destructive, writes, p.Sensitive:
		out.Risk = RiskMedium
	default:
		out.Risk = RiskLow
	}
	out.NeedsApproval = destructive || p.Sensitive || out.Risk == RiskHigh
	if out.NeedsApproval {
		out.Basis += " 다만 운영 중인 대상을 바꾸거나 민감한 정보가 얽혀 있어 실행 전에 사람의 승인이 필요합니다."
	}

	// 100 repeats saturate the volume term; five users the breadth term.
	volume := math.Min(1, math.Log10(1+float64(max(p.Repeats, 0)))/2)
	breadth := math.Min(1, float64(max(p.Users, 0))/5)
	f := 0.5*volume + 0.2*breadth + 0.3*clamp01(consistency)
	switch out.Risk {
	case RiskHigh:
		f *= 0.8
	case RiskMedium:
		f *= 0.9
	}
	out.Feasibility = math.Round(clamp01(f)*100) / 100
	return out
}

// ---- Productivity ----

// EstimateSavings estimates the time and cost saved in a category from its
// baseline and the number of sessions confirmed as completed. It returns nil
// estimates, with the reason, when there is nothing to base one on: an API
// call that succeeded is not evidence that the work got done.
func EstimateSavings(b *Baseline, confirmedSessions int64) (minutes, costKRW *float64, reason string) {
	if b == nil {
		return nil, nil, "이 업무의 기준값(수작업·AI 활용 소요 시간)이 등록되지 않아 추정하지 않습니다."
	}
	if confirmedSessions <= 0 {
		return nil, nil, "완료가 확인된 세션이 없어 추정하지 않습니다. 요청이 성공했다는 것만으로는 업무가 끝났다고 보지 않습니다."
	}
	if b.ManualMinutes <= 0 || b.AIMinutes < 0 {
		return nil, nil, "기준값이 올바르지 않아 추정하지 않습니다."
	}
	saved := (b.ManualMinutes - b.AIMinutes) * float64(confirmedSessions)
	if saved <= 0 {
		zero := 0.0
		zeroCost := 0.0
		return &zero, &zeroCost, fmt.Sprintf("기준값에서 AI 활용 시간(%s분)이 수작업 시간(%s분)보다 짧지 않아 절감 효과가 없습니다.",
			formatNumber(b.AIMinutes), formatNumber(b.ManualMinutes))
	}
	reason = fmt.Sprintf("완료가 확인된 세션 %d건에 건당 절감 시간(수작업 %s분 − AI 활용 %s분)을 곱한 추정치입니다.",
		confirmedSessions, formatNumber(b.ManualMinutes), formatNumber(b.AIMinutes))
	if b.HourlyCostKRW <= 0 {
		return &saved, nil, reason + " 시간당 비용이 등록되지 않아 금액은 추정하지 않습니다."
	}
	cost := saved / 60 * b.HourlyCostKRW
	return &saved, &cost, reason
}

// ---- Insights ----

// Insight severities.
const (
	SeverityInfo    = "info"
	SeverityNotice  = "notice"
	SeverityWarning = "warning"
)

// Insight is one generated observation. Every number in Title and Body is
// also in Evidence.Metrics, so a reader can check the sentence against the
// data it came from.
type Insight struct {
	Kind     string            `json:"kind"`
	Severity string            `json:"severity"`
	Title    string            `json:"title"`
	Body     string            `json:"body"`
	Evidence InsightEvidence   `json:"evidence"`
	Link     map[string]string `json:"link"`
}

// InsightEvidence is the data behind an insight.
type InsightEvidence struct {
	Period  string             `json:"period"`
	Compare string             `json:"compare"`
	Sample  int64              `json:"sample"`
	Metrics map[string]float64 `json:"metrics"`
}

// ModelUsage is the usage of one model over the period.
type ModelUsage struct {
	Model    string
	Requests int64
	CostKRW  float64
}

// AutomationSummary is an automation candidate as BuildInsights needs it.
type AutomationSummary struct {
	ID          string
	Title       string
	CategoryID  string
	Repeats     int64
	Users       int64
	Recommended string
	Feasibility float64
	Risk        string
}

// InsightInput is everything BuildInsights may talk about. It contains
// aggregates only; no prompt text reaches the insight sentences.
type InsightInput struct {
	// Period and Compare describe the two windows, e.g. "2026-10-28~2026-11-26".
	Period  string
	Compare string
	// CategoryNames maps category ids to display names.
	CategoryNames map[string]string
	Signals       []Signal
	Models        []ModelUsage
	Automation    []AutomationSummary
	Thresholds    SignalThresholds
}

const (
	// signalWindowDays is the long comparison window of CategorySeries.
	signalWindowDays         = 30.0
	maxInsightsPerKind       = 3
	modelMixShare            = 0.5
	modelCostGap             = 0.2
	automationMinFeasibility = 0.6
)

var automationNames = map[string]string{
	AutomationPromptTemplate: "프롬프트 템플릿",
	AutomationSkill:          "스킬",
	AutomationMCPTool:        "MCP 도구",
	AutomationWorkflow:       "워크플로",
	AutomationAgent:          "에이전트",
	AutomationBatch:          "배치 작업",
}

// BuildInsights writes grounded sentences from signals, model usage and
// automation candidates. It states only what the inputs say: every figure in
// the text is copied into Evidence.Metrics, and nothing is produced for an
// input whose sample is below the thresholds.
func BuildInsights(in InsightInput) []Insight {
	th := in.Thresholds.withDefaults()
	out := []Insight{}
	name := func(id string) string {
		if n := in.CategoryNames[id]; n != "" {
			return n
		}
		return id
	}
	evidence := func(sample int64, metrics map[string]float64) InsightEvidence {
		return InsightEvidence{Period: in.Period, Compare: in.Compare, Sample: sample, Metrics: metrics}
	}

	// The window lengths appear in the sentences, so they are evidence too.
	window30 := formatCount(signalWindowDays)
	perKind := map[string]int{}
	for _, s := range in.Signals {
		if s.Sample < th.MinSample || perKind[s.Kind] >= maxInsightsPerKind {
			continue
		}
		ins := Insight{Kind: s.Kind, Severity: SeverityInfo, Link: map[string]string{"tab": "trends", "category": s.CategoryID}}
		metrics := map[string]float64{"current": s.Current, "previous": s.Previous}
		cat := name(s.CategoryID)
		switch s.Kind {
		case SignalRising7d, SignalRising30d:
			days := 30.0
			if s.Kind == SignalRising7d {
				days = 7
			}
			metrics["window_days"] = days
			window := formatCount(days) + "일"
			ins.Title = fmt.Sprintf("%s 업무가 늘고 있습니다", cat)
			if s.ChangeRate != nil {
				metrics["change_rate"] = *s.ChangeRate
				ins.Body = fmt.Sprintf("최근 %s 동안 %s건으로, 이전 %s의 %s건보다 %s%% 늘었습니다.",
					window, formatCount(s.Current), window, formatCount(s.Previous), formatPercent(*s.ChangeRate))
				if *s.ChangeRate >= 1 {
					ins.Severity = SeverityNotice
				}
			} else {
				ins.Body = fmt.Sprintf("이전 %s에는 사용이 없었는데 최근 %s 동안 %s건 사용되었습니다.", window, window, formatCount(s.Current))
				ins.Severity = SeverityNotice
			}
		case SignalNew:
			ins.Severity = SeverityNotice
			ins.Title = fmt.Sprintf("%s 업무가 새로 나타났습니다", cat)
			ins.Body = fmt.Sprintf("이전 기간에는 없던 업무가 이번 기간에 %s건 사용되었습니다.", formatCount(s.Current))
		case SignalDeclining:
			if s.ChangeRate == nil {
				continue
			}
			ins.Severity = SeverityNotice
			metrics["change_rate"] = *s.ChangeRate
			metrics["window_days"] = signalWindowDays
			ins.Title = fmt.Sprintf("%s 업무가 줄었습니다", cat)
			ins.Body = fmt.Sprintf("최근 %s일 동안 %s건으로, 이전 %s일의 %s건보다 %s%% 줄었습니다.",
				window30, formatCount(s.Current), window30, formatCount(s.Previous), formatPercent(-*s.ChangeRate))
		case SignalCostSpike:
			if s.ChangeRate == nil {
				continue
			}
			ins.Severity = SeverityWarning
			metrics["change_rate"] = *s.ChangeRate
			metrics["window_days"] = signalWindowDays
			ins.Link["tab"] = "models"
			ins.Title = fmt.Sprintf("%s 업무의 비용이 크게 늘었습니다", cat)
			ins.Body = fmt.Sprintf("최근 %s일 비용이 %s원으로, 이전 %s일의 %s원보다 %s%% 늘었습니다. 요청당 비용도 함께 올랐으니 모델 선택과 입력 길이를 확인해 보세요.",
				window30, formatCount(s.Current), window30, formatCount(s.Previous), formatPercent(*s.ChangeRate))
		case SignalSpreading:
			ins.Title = fmt.Sprintf("%s 업무가 여러 팀으로 퍼지고 있습니다", cat)
			ins.Body = fmt.Sprintf("이 업무에 AI를 쓰는 팀이 %s개에서 %s개로 늘었습니다.", formatCount(s.Previous), formatCount(s.Current))
			ins.Link["tab"] = "teams"
		case SignalModelDependence:
			if s.Share == nil {
				continue
			}
			ins.Severity = SeverityNotice
			metrics["share"] = *s.Share
			metrics["sample"] = float64(s.Sample)
			metrics["window_days"] = signalWindowDays
			ins.Link["tab"] = "models"
			ins.Link["model"] = s.Model
			ins.Title = fmt.Sprintf("%s 업무가 한 모델에 의존합니다", cat)
			ins.Body = fmt.Sprintf("최근 %s일 %s건 가운데 %s건(%s%%)을 %s 모델이 처리했습니다. 이 모델에 장애가 나면 업무가 멈출 수 있으니 대체 모델을 정해 두세요.",
				window30, formatCount(float64(s.Sample)), formatCount(s.Current), formatPercent(*s.Share), s.Model)
		case SignalTeamConcentrated:
			if s.Share == nil {
				continue
			}
			metrics["share"] = *s.Share
			metrics["sample"] = float64(s.Sample)
			metrics["window_days"] = signalWindowDays
			ins.Link["tab"] = "teams"
			ins.Link["team"] = s.Team
			ins.Title = fmt.Sprintf("%s 업무는 한 팀이 주로 씁니다", cat)
			ins.Body = fmt.Sprintf("최근 %s일 %s건 가운데 %s건(%s%%)이 %s 팀에서 나왔습니다. 다른 팀에도 같은 업무가 있다면 활용 사례를 공유해 볼 만합니다.",
				window30, formatCount(float64(s.Sample)), formatCount(s.Current), formatPercent(*s.Share), s.Team)
		default:
			continue
		}
		perKind[s.Kind]++
		ins.Evidence = evidence(s.Sample, metrics)
		out = append(out, ins)
	}

	var totalRequests int64
	var totalCost float64
	for _, m := range in.Models {
		if m.Requests > 0 {
			totalRequests += m.Requests
		}
		if m.CostKRW > 0 {
			totalCost += m.CostKRW
		}
	}
	if totalRequests >= th.MinSample {
		models := append([]ModelUsage(nil), in.Models...)
		sort.SliceStable(models, func(i, j int) bool {
			if models[i].Requests != models[j].Requests {
				return models[i].Requests > models[j].Requests
			}
			return models[i].Model < models[j].Model
		})
		if top := models[0]; float64(top.Requests)/float64(totalRequests) >= modelMixShare && len(models) > 1 {
			share := float64(top.Requests) / float64(totalRequests)
			out = append(out, Insight{
				Kind: "model_mix", Severity: SeverityInfo,
				Title: "요청이 한 모델에 몰려 있습니다",
				Body: fmt.Sprintf("전체 %s건 가운데 %s건(%s%%)을 %s 모델이 처리했습니다.",
					formatCount(float64(totalRequests)), formatCount(float64(top.Requests)), formatPercent(share), top.Model),
				Evidence: evidence(totalRequests, map[string]float64{
					"requests": float64(top.Requests), "total_requests": float64(totalRequests), "share": share,
				}),
				Link: map[string]string{"tab": "models", "model": top.Model},
			})
		}
		// A model whose share of cost far exceeds its share of requests is
		// where a cheaper alternative would pay off first.
		if totalCost > 0 {
			var costly *ModelUsage
			gap := modelCostGap
			for i := range models {
				m := &models[i]
				if m.Requests < th.MinSample {
					continue
				}
				d := m.CostKRW/totalCost - float64(m.Requests)/float64(totalRequests)
				if d >= gap {
					costly, gap = m, d
				}
			}
			if costly != nil {
				costShare := costly.CostKRW / totalCost
				requestShare := float64(costly.Requests) / float64(totalRequests)
				out = append(out, Insight{
					Kind: "model_cost", Severity: SeverityNotice,
					Title: fmt.Sprintf("%s 모델이 요청 비중에 비해 비용을 많이 씁니다", costly.Model),
					Body: fmt.Sprintf("요청의 %s%%를 처리하면서 비용의 %s%%를 차지합니다. 단순한 업무는 더 가벼운 모델로 보낼 수 있는지 확인해 보세요.",
						formatPercent(requestShare), formatPercent(costShare)),
					Evidence: evidence(costly.Requests, map[string]float64{
						"request_share": requestShare, "cost_share": costShare,
						"requests": float64(costly.Requests), "cost_krw": costly.CostKRW,
					}),
					Link: map[string]string{"tab": "models", "model": costly.Model},
				})
			}
		}
	}

	candidates := append([]AutomationSummary(nil), in.Automation...)
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].Feasibility != candidates[j].Feasibility {
			return candidates[i].Feasibility > candidates[j].Feasibility
		}
		if candidates[i].Repeats != candidates[j].Repeats {
			return candidates[i].Repeats > candidates[j].Repeats
		}
		return candidates[i].ID < candidates[j].ID
	})
	shown := 0
	for _, c := range candidates {
		if shown >= maxInsightsPerKind {
			break
		}
		if c.Repeats < th.MinSample || c.Feasibility < automationMinFeasibility {
			continue
		}
		kind := automationNames[c.Recommended]
		if kind == "" {
			continue
		}
		shown++
		severity := SeverityInfo
		tail := ""
		if c.Risk == RiskHigh {
			severity = SeverityNotice
			tail = " 운영 대상을 바꾸는 작업이라 승인 절차를 함께 설계해야 합니다."
		}
		out = append(out, Insight{
			Kind: "automation_candidate", Severity: severity,
			Title: fmt.Sprintf("%s 업무에 자동화할 만한 반복 요청이 있습니다", name(c.CategoryID)),
			Body: fmt.Sprintf("같은 형태의 요청을 %s명이 %s회 반복했습니다. %s(으)로 만드는 것을 검토해 보세요.%s",
				formatCount(float64(c.Users)), formatCount(float64(c.Repeats)), kind, tail),
			Evidence: evidence(c.Repeats, map[string]float64{
				"repeats": float64(c.Repeats), "users": float64(c.Users), "feasibility": c.Feasibility,
			}),
			Link: map[string]string{"tab": "automation", "category": c.CategoryID, "candidate": c.ID},
		})
	}
	return out
}

// formatCount renders a count without grouping separators, so the digits in
// a sentence can be matched against the evidence.
func formatCount(v float64) string {
	return strconv.FormatFloat(math.Round(v), 'f', 0, 64)
}

// formatPercent renders a 0..1 ratio as a whole percentage.
func formatPercent(v float64) string {
	return strconv.FormatFloat(math.Round(v*100), 'f', 0, 64)
}

// formatNumber renders a number with at most one decimal.
func formatNumber(v float64) string {
	if v == math.Trunc(v) {
		return strconv.FormatFloat(v, 'f', 0, 64)
	}
	return strconv.FormatFloat(v, 'f', 1, 64)
}
