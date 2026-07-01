package proxy

import (
	"net/http"
	"sort"

	"vibe-coders/internal/store"
)

// Red Team Dashboard & Result Matrix (요건 §16, §26; 구현 우선순위 §7).
//
// A safe, read-only rollup over the case-result/run/target/pack tables. It never touches upstreams
// and never exposes prompt/response content — only decisions, categories, scores, and counts.
// This turns the raw run/result lists the UI already shows into the executive/security views the
// spec calls for: overall risk, pass/warn/fail/critical rollup, a target × probe-pack matrix,
// top failing targets, baseline drift (§27.10), and open remediation load.

// redTeamMatrixCell counts case decisions for one target-type × probe-pack-category bucket.
type redTeamMatrixCell struct {
	TargetType   string `json:"target_type"`
	PackCategory string `json:"pack_category"`
	Pass         int    `json:"pass"`
	Warning      int    `json:"warning"`
	Fail         int    `json:"fail"`
	Critical     int    `json:"critical"`
	Inconclusive int    `json:"inconclusive"`
	Total        int    `json:"total"`
}

// redTeamDashboardResult is the aggregated (content-free) view the dashboard endpoint returns.
type redTeamDashboardResult struct {
	TotalResults      int                 `json:"total_results"`
	ByDecision        map[string]int      `json:"by_decision"`
	Matrix            []redTeamMatrixCell `json:"matrix"`
	TopFailingTargets []map[string]any    `json:"top_failing_targets"`
	MaxRisk           int                 `json:"max_risk"`
}

// redTeamAggregate builds the decision rollup, target × pack matrix, and top failing targets from
// enriched case-result rows. Pure and deterministic (stable ordering) so it is unit-testable.
func redTeamAggregate(rows []store.RedTeamDashboardRow) redTeamDashboardResult {
	res := redTeamDashboardResult{
		ByDecision:        map[string]int{},
		Matrix:            []redTeamMatrixCell{},
		TopFailingTargets: []map[string]any{},
	}
	res.TotalResults = len(rows)

	cellIdx := map[string]*redTeamMatrixCell{}
	type failAgg struct {
		ref, targetType, owner  string
		fail, critical, warning int
		maxRisk                 int
	}
	failByTarget := map[string]*failAgg{}

	bump := func(cell *redTeamMatrixCell, decision string) {
		cell.Total++
		switch decision {
		case "pass":
			cell.Pass++
		case "warning":
			cell.Warning++
		case "fail":
			cell.Fail++
		case "critical":
			cell.Critical++
		default:
			cell.Inconclusive++
		}
	}

	for _, row := range rows {
		decision := row.Decision
		if decision == "" {
			decision = "inconclusive"
		}
		res.ByDecision[decision]++
		if row.RiskScore > res.MaxRisk {
			res.MaxRisk = row.RiskScore
		}

		cat := row.PackCategory
		if cat == "" {
			cat = "(uncategorized)"
		}
		key := row.TargetType + "|" + cat
		cell, ok := cellIdx[key]
		if !ok {
			cell = &redTeamMatrixCell{TargetType: row.TargetType, PackCategory: cat}
			cellIdx[key] = cell
		}
		bump(cell, decision)

		fa, ok := failByTarget[row.TargetID]
		if !ok {
			fa = &failAgg{ref: row.TargetRef, targetType: row.TargetType, owner: row.OwnerTeam}
			failByTarget[row.TargetID] = fa
		}
		if row.RiskScore > fa.maxRisk {
			fa.maxRisk = row.RiskScore
		}
		switch decision {
		case "critical":
			fa.critical++
		case "fail":
			fa.fail++
		case "warning":
			fa.warning++
		}
	}

	for _, cell := range cellIdx {
		res.Matrix = append(res.Matrix, *cell)
	}
	sort.SliceStable(res.Matrix, func(i, j int) bool {
		if res.Matrix[i].TargetType != res.Matrix[j].TargetType {
			return res.Matrix[i].TargetType < res.Matrix[j].TargetType
		}
		return res.Matrix[i].PackCategory < res.Matrix[j].PackCategory
	})

	for id, fa := range failByTarget {
		if fa.fail == 0 && fa.critical == 0 && fa.warning == 0 {
			continue
		}
		res.TopFailingTargets = append(res.TopFailingTargets, map[string]any{
			"target_id": id, "target_ref": fa.ref, "target_type": fa.targetType,
			"owner_team": fa.owner, "critical": fa.critical, "fail": fa.fail,
			"warning": fa.warning, "max_risk": fa.maxRisk,
		})
	}
	// Rank: critical desc, then fail desc, then max_risk desc, then ref for stability.
	sort.SliceStable(res.TopFailingTargets, func(i, j int) bool {
		a, b := res.TopFailingTargets[i], res.TopFailingTargets[j]
		if a["critical"].(int) != b["critical"].(int) {
			return a["critical"].(int) > b["critical"].(int)
		}
		if a["fail"].(int) != b["fail"].(int) {
			return a["fail"].(int) > b["fail"].(int)
		}
		if a["max_risk"].(int) != b["max_risk"].(int) {
			return a["max_risk"].(int) > b["max_risk"].(int)
		}
		return a["target_ref"].(string) < b["target_ref"].(string)
	})
	if len(res.TopFailingTargets) > 10 {
		res.TopFailingTargets = res.TopFailingTargets[:10]
	}
	return res
}

// redTeamBaselineDrift flags baselines whose target's latest run risk has climbed above the
// recorded baseline by more than its drift threshold (요건 §27.10).
func redTeamBaselineDrift(baselines []store.RedTeamBaseline, latestRiskByTarget map[string]int) []map[string]any {
	drift := []map[string]any{}
	for _, b := range baselines {
		current, ok := latestRiskByTarget[b.TargetID]
		if !ok {
			continue
		}
		delta := current - b.BaselineScore
		if delta > b.DriftThreshold {
			drift = append(drift, map[string]any{
				"target_id": b.TargetID, "pack_id": b.PackID,
				"baseline_score": b.BaselineScore, "current_score": current,
				"delta": delta, "threshold": b.DriftThreshold, "last_passed_at": b.LastPassedAt,
			})
		}
	}
	sort.SliceStable(drift, func(i, j int) bool {
		return drift[i]["delta"].(int) > drift[j]["delta"].(int)
	})
	return drift
}

// handleRedTeamDashboard returns the aggregate red-team risk view. GET /admin/redteam/dashboard?limit=
func (s *Server) handleRedTeamDashboard(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	ctx := r.Context()
	rows, err := s.db.RedTeamDashboardRows(ctx, 2000)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "redteam_dashboard_failed")
		return
	}
	agg := redTeamAggregate(rows)

	// Baseline drift: latest run risk per target vs recorded baseline.
	latestRiskByTarget := map[string]int{}
	seen := map[string]bool{}
	if runs, rerr := s.db.ListRedTeamRuns(ctx, 500); rerr == nil {
		for _, run := range runs { // newest first — first seen is latest
			if seen[run.TargetID] {
				continue
			}
			seen[run.TargetID] = true
			latestRiskByTarget[run.TargetID] = run.RiskScore
		}
	}
	drift := []map[string]any{}
	if baselines, berr := s.db.ListRedTeamBaselines(ctx); berr == nil {
		drift = redTeamBaselineDrift(baselines, latestRiskByTarget)
	}

	// Open remediation load.
	openRemediations := 0
	if rems, rerr := s.db.ListRedTeamRemediations(ctx, 500); rerr == nil {
		for _, rm := range rems {
			if rm.Status == "open" {
				openRemediations++
			}
		}
	}

	// External-target exposure (외부 egress 표시, §13).
	externalTargets := 0
	if targets, terr := s.db.ListRedTeamTargets(ctx, store.RedTeamTargetFilter{EnabledOnly: true, Limit: 1000}); terr == nil {
		for _, t := range targets {
			if redTeamExternalTarget(t) {
				externalTargets++
			}
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"summary": map[string]any{
			"total_results":     agg.TotalResults,
			"by_decision":       agg.ByDecision,
			"max_risk":          agg.MaxRisk,
			"open_remediations": openRemediations,
			"external_targets":  externalTargets,
			"drift_count":       len(drift),
		},
		"matrix":              agg.Matrix,
		"top_failing_targets": agg.TopFailingTargets,
		"drift":               drift,
		"note":                "최근 레드팀 실행 결과의 위험 롤업입니다. target×probe-pack 매트릭스, 상위 실패 대상, baseline drift, 미조치 remediation을 집계하며 프롬프트/응답 원문은 포함하지 않습니다.",
	})
}
