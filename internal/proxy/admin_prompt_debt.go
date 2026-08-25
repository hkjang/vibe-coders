package proxy

import (
	"net/http"
	"sort"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// promptDebtItem is one recurring prompt cluster carrying "debt" — low quality, high cost,
// model waste, or sheer volume of a weak pattern — with a remediation hint.
type promptDebtItem struct {
	Fingerprint  string  `json:"fingerprint"`
	TaskType     string  `json:"task_type"`
	Requests     int64   `json:"requests"`
	SuccessRate  float64 `json:"success_rate"`
	AvgCostKRW   float64 `json:"avg_cost_krw"`
	TotalCostKRW float64 `json:"total_cost_krw"`
	TopModel     string  `json:"top_model"`
	CheaperModel string  `json:"cheaper_model"`
	DebtScore    float64 `json:"debt_score"` // 0..100, higher = more debt
	DebtType     string  `json:"debt_type"`  // failing | model_waste | expensive | high_volume | minor
	Action       string  `json:"action"`
	SamplePrompt string  `json:"sample_prompt"`
	LastSeen     string  `json:"last_seen"`
}

// handlePromptDebt ranks recurring prompt clusters by "prompt debt" so teams pay down the
// worst offenders (failing, expensive, model-wasteful, high-volume-weak). Read-only.
// GET /admin/prompts/debt?window=30d&min_requests=3&limit=50
func (s *Server) handlePromptDebt(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")
	minReq := int64(intQuery(r, "min_requests", 3))
	limit := intQuery(r, "limit", 50)

	stats, err := s.db.PromptFingerprints(r.Context(), since, 300)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "fingerprints_failed")
		return
	}
	// Fleet medians for normalization (only clusters meeting the volume floor).
	costs, reqs := []float64{}, []float64{}
	for _, st := range stats {
		if st.Requests < minReq {
			continue
		}
		costs = append(costs, st.AvgCostKRW)
		reqs = append(reqs, float64(st.Requests))
	}
	medCost := medianFloat(costs)
	medReqs := medianFloat(reqs)

	items := []promptDebtItem{}
	var totalDebtCost float64
	for _, st := range stats {
		if st.Requests < minReq {
			continue
		}
		score, debtType, action := promptDebtScore(st, medCost, medReqs)
		if debtType == "minor" {
			continue
		}
		cheaper := ""
		if st.CheapestModel != "" && !strings.EqualFold(st.CheapestModel, st.TopModel) {
			cheaper = st.CheapestModel
		}
		items = append(items, promptDebtItem{
			Fingerprint: st.Fingerprint, TaskType: st.TaskType, Requests: st.Requests,
			SuccessRate: round1(st.SuccessRate * 100), AvgCostKRW: round1(st.AvgCostKRW), TotalCostKRW: round1(st.TotalCostKRW),
			TopModel: st.TopModel, CheaperModel: cheaper, DebtScore: score, DebtType: debtType, Action: action,
			SamplePrompt: st.SamplePrompt, LastSeen: st.LastSeen,
		})
		totalDebtCost += st.TotalCostKRW
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].DebtScore > items[j].DebtScore })
	if limit > 0 && len(items) > limit {
		items = items[:limit]
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"since":               since.UTC().Format(time.RFC3339),
		"items":               items,
		"count":               len(items),
		"total_debt_cost_krw": round1(totalDebtCost),
		"note":                "반복 프롬프트 클러스터를 품질·비용·모델낭비·볼륨 기준으로 부채화한 목록입니다. 점수가 높을수록 우선 개선 대상입니다. 원문은 마스킹된 샘플만 제공합니다.",
	})
}

// promptDebtScore computes a 0..100 debt score and classifies the dominant debt type.
// Weights failure most, then relative cost, then volume; model waste adds a bump. Pure.
func promptDebtScore(st store.PromptFingerprintStat, medCost, medReqs float64) (score float64, debtType, action string) {
	failure := 1 - st.SuccessRate // 0..1
	if failure < 0 {
		failure = 0
	}
	costRel := 0.0
	if medCost > 0 {
		costRel = (st.AvgCostKRW - medCost) / medCost
	}
	if costRel < 0 {
		costRel = 0
	}
	if costRel > 2 {
		costRel = 2
	}
	volRel := 0.0
	if medReqs > 0 {
		volRel = float64(st.Requests) / medReqs
	}
	if volRel > 3 {
		volRel = 3
	}
	modelWaste := st.CheapestModel != "" && !strings.EqualFold(st.CheapestModel, st.TopModel)

	score = failure*55 + (costRel/2)*25 + (volRel/3)*10
	if modelWaste {
		score += 10
	}
	if score > 100 {
		score = 100
	}

	switch {
	case st.SuccessRate < 0.8:
		debtType, action = "failing", "실패 원인을 조사하고 프롬프트/모델을 교정하세요."
	case modelWaste:
		debtType, action = "model_waste", "더 저렴한 모델("+st.CheapestModel+")로 전환을 검토하세요."
	case medCost > 0 && st.AvgCostKRW >= medCost*1.5:
		debtType, action = "expensive", "고비용 프롬프트 — 토큰 절감·캐시·모델 다운시프트를 검토하세요."
	case medReqs > 0 && float64(st.Requests) >= medReqs*1.5:
		debtType, action = "high_volume", "반복 사용 — 템플릿/골든으로 표준화해 품질을 고정하세요."
	default:
		debtType, action = "minor", "모니터링"
	}
	return round1(score), debtType, action
}
