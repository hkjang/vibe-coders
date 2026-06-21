package proxy

import (
	"encoding/json"
	"net/http"
	"path"
	"strings"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

// blendedKRWPer1M returns a rough blended (input+output average) price per 1M tokens.
func blendedKRWPer1M(p config.ModelPrice) float64 {
	return (p.InputKRWPer1M + p.OutputKRWPer1M) / 2
}

// matchModelGlob reports whether a model matches a comma-separated glob list (e.g. "gpt-4*,claude-*").
func matchModelGlob(patterns, model string) bool {
	for _, p := range strings.Split(patterns, ",") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if ok, _ := path.Match(p, model); ok || p == model {
			return true
		}
	}
	return false
}

// handleChangeImpactSimulate replays a proposed change against historical per-model daily
// rollups and projects its impact (affected requests, cost delta) WITHOUT executing anything.
// Returns metadata only — no prompt/SQL/tool-arg content.
// POST /admin/change-impact/simulate {change_type, params, days}
func (s *Server) handleChangeImpactSimulate(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var p struct {
		ChangeType string         `json:"change_type"`
		Days       int            `json:"days"`
		Params     map[string]any `json:"params"`
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "bad_request")
		return
	}
	if p.Days <= 0 || p.Days > 90 {
		p.Days = 7
	}
	sinceDay := time.Now().UTC().AddDate(0, 0, -p.Days).Format("2006-01-02")
	rollups, err := s.db.ListDailyRollups(r.Context(), "model", sinceDay, 5000)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "rollup_failed")
		return
	}
	// Aggregate per model over the window.
	type mAgg struct {
		requests, errors int64
		cost             float64
	}
	models := map[string]*mAgg{}
	var totalReq int64
	var totalCost float64
	for _, row := range rollups {
		a := models[row.DimValue]
		if a == nil {
			a = &mAgg{}
			models[row.DimValue] = a
		}
		a.requests += row.Requests
		a.errors += row.Errors
		a.cost += row.CostKRW
		totalReq += row.Requests
		totalCost += row.CostKRW
	}
	pricing := s.pricingMap(r.Context())
	getStr := func(k string) string { v, _ := p.Params[k].(string); return strings.TrimSpace(v) }
	getNum := func(k string) float64 { v, _ := p.Params[k].(float64); return v }

	resp := map[string]any{
		"change_type": p.ChangeType, "window_days": p.Days,
		"baseline": map[string]any{"requests": totalReq, "cost_krw": round1(totalCost), "models": len(models)},
	}

	switch p.ChangeType {
	case "block_model":
		pattern := getStr("pattern")
		if pattern == "" {
			writeOpenAIError(w, http.StatusBadRequest, "params.pattern is required", "invalid_request_error", "bad_params")
			return
		}
		var bReq, bErr int64
		var bCost float64
		matched := []map[string]any{}
		for m, a := range models {
			if matchModelGlob(pattern, m) {
				bReq += a.requests
				bErr += a.errors
				bCost += a.cost
				matched = append(matched, map[string]any{"model": m, "requests": a.requests, "cost_krw": round1(a.cost)})
			}
		}
		resp["impact"] = map[string]any{
			"would_block_requests": bReq, "removed_cost_krw": round1(bCost),
			"block_rate": pctOf(bReq, totalReq), "matched_models": matched,
		}
		resp["note"] = "패턴에 매칭된 모델 호출이 모두 차단된다고 가정한 상한 추정입니다(실제 정책 phase/예외 미반영)."

	case "model_price":
		model := getStr("model")
		a := models[model]
		if a == nil {
			resp["impact"] = map[string]any{"affected_requests": 0, "note": "해당 모델의 최근 사용 기록이 없습니다"}
			break
		}
		cur, has := lookupModelPrice(model, pricing)
		newBlended := (getNum("input_krw_per_1m") + getNum("output_krw_per_1m")) / 2
		projected := a.cost
		if has && blendedKRWPer1M(cur) > 0 && newBlended > 0 {
			projected = a.cost * (newBlended / blendedKRWPer1M(cur))
		}
		resp["impact"] = map[string]any{
			"model": model, "affected_requests": a.requests,
			"baseline_cost_krw": round1(a.cost), "projected_cost_krw": round1(projected),
			"cost_delta_krw": round1(projected - a.cost),
		}
		resp["note"] = "blended(입력·출력 평균) 단가 비율로 추정합니다. 토큰 입출력 분리·캐시 단가는 미반영(근사)."

	case "route_remap":
		from, to := getStr("from"), getStr("to")
		if from == "" || to == "" {
			writeOpenAIError(w, http.StatusBadRequest, "params.from and params.to are required", "invalid_request_error", "bad_params")
			return
		}
		a := models[from]
		if a == nil {
			resp["impact"] = map[string]any{"affected_requests": 0, "note": "원본 모델의 최근 사용 기록이 없습니다"}
			break
		}
		fp, fok := lookupModelPrice(from, pricing)
		tp, tok := lookupModelPrice(to, pricing)
		projected := a.cost
		if fok && tok && blendedKRWPer1M(fp) > 0 {
			projected = a.cost * (blendedKRWPer1M(tp) / blendedKRWPer1M(fp))
		}
		resp["impact"] = map[string]any{
			"from": from, "to": to, "affected_requests": a.requests,
			"baseline_cost_krw": round1(a.cost), "projected_cost_krw": round1(projected),
			"cost_delta_krw": round1(projected - a.cost),
		}
		resp["note"] = from + " 트래픽을 " + to + "로 재라우팅했다고 가정한 비용 추정(blended 단가 비율, 품질 차이 미반영)."

	default:
		writeOpenAIError(w, http.StatusBadRequest, "unsupported change_type (block_model|model_price|route_remap)", "invalid_request_error", "bad_change_type")
		return
	}

	// A small, content-free sample of recent matching requests for the affected model(s).
	if model := getStr("model"); model != "" || getStr("from") != "" {
		if model == "" {
			model = getStr("from")
		}
		if recent, err := s.db.RecentRequests(r.Context(), store.RequestFilter{Model: model, Limit: 5}); err == nil {
			ids := make([]string, 0, len(recent))
			for _, rq := range recent {
				ids = append(ids, rq.ID)
			}
			resp["sample_request_ids"] = ids
		}
	}
	s.auditAdmin(r, "change_impact.simulate", p.ChangeType, auditJSON(map[string]any{"days": p.Days}))
	writeJSON(w, http.StatusOK, resp)
}

func pctOf(n, total int64) float64 {
	if total <= 0 {
		return 0
	}
	return round1(float64(n) / float64(total) * 100)
}
