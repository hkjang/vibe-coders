package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

type personalizationCoachingItem struct {
	UserID   string         `json:"user_id"`
	Team     string         `json:"team"`
	Role     string         `json:"role"`
	Category string         `json:"category"`
	Severity string         `json:"severity"`
	Score    float64        `json:"score"`
	Title    string         `json:"title"`
	Detail   string         `json:"detail"`
	Reason   string         `json:"reason"`
	Metrics  map[string]any `json:"metrics"`
}

type personalizationModelAffinityItem struct {
	UserID      string  `json:"user_id"`
	Team        string  `json:"team"`
	Role        string  `json:"role"`
	Model       string  `json:"model"`
	Requests    int64   `json:"requests"`
	AvgCostKRW  float64 `json:"avg_cost_krw"`
	SuccessRate float64 `json:"success_rate"`
	Score       float64 `json:"score"`
	Reason      string  `json:"reason"`
}

type personalizationMCPAffinityItem struct {
	UserID              string  `json:"user_id"`
	Team                string  `json:"team"`
	Role                string  `json:"role"`
	ServerLabel         string  `json:"server_label"`
	ToolName            string  `json:"tool_name"`
	Ref                 string  `json:"ref"`
	Calls               int64   `json:"calls"`
	Errors              int64   `json:"errors"`
	SuccessRate         float64 `json:"success_rate"`
	AvgRequestLatencyMS float64 `json:"avg_request_latency_ms"`
	Score               float64 `json:"score"`
	Reason              string  `json:"reason"`
}

type personalizationText2SQLHintItem struct {
	UserID              string  `json:"user_id"`
	Team                string  `json:"team"`
	Role                string  `json:"role"`
	Fingerprint         string  `json:"fingerprint"`
	SchemaName          string  `json:"schema_name"`
	Count               int64   `json:"count"`
	SuccessRate         float64 `json:"success_rate"`
	AvgCostKRW          float64 `json:"avg_cost_krw"`
	EstimatedSavingsKRW float64 `json:"estimated_savings_krw"`
	LastSeen            string  `json:"last_seen"`
	RecommendedProduct  string  `json:"recommended_product"`
	HintType            string  `json:"hint_type"`
	Reason              string  `json:"reason"`
}

func text2SQLHintType(product string) string {
	switch strings.ToLower(strings.TrimSpace(product)) {
	case "dashboard":
		return "saved_dashboard"
	case "data_mart":
		return "data_mart_candidate"
	case "api":
		return "query_api_candidate"
	default:
		return "saved_report_candidate"
	}
}

func personalizationText2SQLHintItemsForUser(userID string, profile store.PersonalProfile, candidates []store.UserText2SQLReportCandidate) []personalizationText2SQLHintItem {
	items := make([]personalizationText2SQLHintItem, 0, len(candidates))
	for _, c := range candidates {
		savings := 0.0
		if c.Count > 1 {
			savings = float64(c.Count-1) * c.AvgCostKRW
		}
		items = append(items, personalizationText2SQLHintItem{
			UserID: userID, Team: profile.Team, Role: profile.Role,
			Fingerprint: c.Fingerprint, SchemaName: c.SchemaName, Count: c.Count,
			SuccessRate: c.SuccessRate, AvgCostKRW: c.AvgCostKRW, EstimatedSavingsKRW: savings,
			LastSeen: c.LastSeen, RecommendedProduct: c.RecommendedProduct, HintType: text2SQLHintType(c.RecommendedProduct),
			Reason: fmt.Sprintf("count=%d, success=%.0f%%, avg_cost=%.2f KRW, product=%s", c.Count, c.SuccessRate*100, c.AvgCostKRW, text2SQLProductLabel(c.RecommendedProduct)),
		})
	}
	return items
}

func modelAffinityScore(requests int64, successRate, avgCostKRW float64) float64 {
	volume := float64(requests)
	if volume > 20 {
		volume = 20
	}
	costPenalty := avgCostKRW
	if costPenalty > 20 {
		costPenalty = 20
	}
	score := successRate*80 + volume - costPenalty
	if score < 0 {
		return 0
	}
	return score
}

func mcpAffinityScore(calls int64, successRate, avgLatencyMS float64) float64 {
	volume := float64(calls)
	if volume > 20 {
		volume = 20
	}
	latencyPenalty := avgLatencyMS / 1000
	if latencyPenalty > 20 {
		latencyPenalty = 20
	}
	score := successRate*80 + volume - latencyPenalty
	if score < 0 {
		return 0
	}
	return score
}

func coachingSeverity(score float64) string {
	switch {
	case score >= 85:
		return "critical"
	case score >= 70:
		return "high"
	case score >= 45:
		return "medium"
	default:
		return "low"
	}
}

func personalizationCoachingItemsForProfile(p store.PersonalProfile) []personalizationCoachingItem {
	base := func(category, title, detail, reason string, score float64, metrics map[string]any) personalizationCoachingItem {
		return personalizationCoachingItem{
			UserID: p.UserID, Team: p.Team, Role: p.Role,
			Category: category, Severity: coachingSeverity(score), Score: score,
			Title: title, Detail: detail, Reason: reason, Metrics: metrics,
		}
	}
	items := []personalizationCoachingItem{}
	if p.Requests == 0 {
		return items
	}
	if p.RiskScore >= 35 {
		items = append(items, base(
			"security",
			"민감정보·정책 위험 패턴 점검",
			"최근 요청에서 secret/policy/Text2SQL/MCP 위험 신호가 누적되었습니다. 샘플 데이터 사용과 정책 안내가 필요합니다.",
			fmt.Sprintf("risk_score=%d", p.RiskScore),
			float64(p.RiskScore),
			map[string]any{"risk_score": p.RiskScore, "requests": p.Requests},
		))
	}
	if p.Requests >= 3 && p.ErrorRate >= 0.25 {
		score := p.ErrorRate * 100
		items = append(items, base(
			"quality",
			"오류율 높은 사용 패턴 코칭",
			"최근 실패 비중이 높습니다. 템플릿 사용, 더 명확한 컨텍스트, 모델 선택 점검을 권장합니다.",
			fmt.Sprintf("error_rate=%.0f%%", p.ErrorRate*100),
			score,
			map[string]any{"error_rate": p.ErrorRate, "requests": p.Requests},
		))
	}
	if p.Requests >= 10 && p.CacheRate < 0.05 {
		items = append(items, base(
			"reuse",
			"캐시·템플릿 재사용 기회",
			"요청량은 충분하지만 캐시 적중률이 낮습니다. 반복 프롬프트를 Prompt Product나 템플릿으로 승격할 후보를 확인하세요.",
			fmt.Sprintf("cache_rate=%.0f%%", p.CacheRate*100),
			55,
			map[string]any{"cache_rate": p.CacheRate, "requests": p.Requests, "distinct_prompt_fingerprints": p.DistinctFingerprints},
		))
	}
	if p.TotalCostKRW >= 100 && p.AvgCostPerRequest >= 5 {
		score := 45 + p.AvgCostPerRequest
		if score > 90 {
			score = 90
		}
		items = append(items, base(
			"cost",
			"고비용 모델 사용 점검",
			"월 비용과 요청당 평균 비용이 높습니다. 모델 전환 추천과 routing preview로 저비용 대안을 검토하세요.",
			fmt.Sprintf("avg_cost=%.2f KRW, total_cost=%.0f KRW", p.AvgCostPerRequest, p.TotalCostKRW),
			score,
			map[string]any{"avg_cost_per_request": p.AvgCostPerRequest, "total_cost_krw": p.TotalCostKRW, "top_models": p.TopModels},
		))
	}
	if p.Text2SQLUsageRate >= 0.3 {
		items = append(items, base(
			"text2sql",
			"반복 Text2SQL 리포트화 후보",
			"Text2SQL 사용 비중이 높습니다. 반복 질문을 저장 리포트나 대시보드 후보로 승격하면 비용과 대기시간을 줄일 수 있습니다.",
			fmt.Sprintf("text2sql_usage_rate=%.0f%%", p.Text2SQLUsageRate*100),
			50+p.Text2SQLUsageRate*30,
			map[string]any{"text2sql_usage_rate": p.Text2SQLUsageRate, "requests": p.Requests},
		))
	}
	if p.MCPUsageRate >= 0.3 && len(p.TopMCPTools) > 0 {
		items = append(items, base(
			"mcp",
			"MCP 도구 사용 표준화 후보",
			"특정 MCP 도구 사용 비중이 높습니다. 팀 표준 workflow나 tool risk profile 안내로 재현성과 안전성을 높일 수 있습니다.",
			fmt.Sprintf("mcp_usage_rate=%.0f%%", p.MCPUsageRate*100),
			45+p.MCPUsageRate*25,
			map[string]any{"mcp_usage_rate": p.MCPUsageRate, "top_mcp_tools": p.TopMCPTools},
		))
	}
	return items
}

// handlePersonalProfiles lists per-user AI profiles for the most active users over a
// window (computed live). Read-only.
// GET /admin/personalization/profiles?window=30d&limit=25
func (s *Server) handlePersonalProfiles(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")
	limit := recentLimit(r)
	users, err := s.db.PersonalProfileActiveUsers(r.Context(), since, limit)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "profiles_failed")
		return
	}
	profiles := make([]store.PersonalProfile, 0, len(users))
	for _, uid := range users {
		p, err := s.db.BuildPersonalProfile(r.Context(), uid, since)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "profiles_failed")
			return
		}
		profiles = append(profiles, p)
	}
	writeJSON(w, http.StatusOK, map[string]any{"profiles": profiles})
}

// handlePersonalizationCoaching returns read-only coaching candidates derived from
// Personal AI Profile metrics. It never inspects raw prompts, SQL, or responses.
// GET /admin/personalization/coaching?window=30d&limit=50
func (s *Server) handlePersonalizationCoaching(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")
	limit := recentLimit(r)
	users, err := s.db.PersonalProfileActiveUsers(r.Context(), since, limit)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "coaching_failed")
		return
	}
	items := []personalizationCoachingItem{}
	for _, uid := range users {
		p, err := s.db.BuildPersonalProfile(r.Context(), uid, since)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "coaching_failed")
			return
		}
		items = append(items, personalizationCoachingItemsForProfile(p)...)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Score != items[j].Score {
			return items[i].Score > items[j].Score
		}
		if items[i].UserID != items[j].UserID {
			return items[i].UserID < items[j].UserID
		}
		return items[i].Category < items[j].Category
	})
	if len(items) > limit {
		items = items[:limit]
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "count": len(items)})
}

// handlePersonalizationModelAffinity returns per-user model affinity rows from usage,
// reliability, and cost. Read-only and derived from aggregate logs.
// GET /admin/personalization/model-affinity?window=30d&limit=50
func (s *Server) handlePersonalizationModelAffinity(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")
	limit := recentLimit(r)
	users, err := s.db.PersonalProfileActiveUsers(r.Context(), since, limit)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "model_affinity_failed")
		return
	}
	items := []personalizationModelAffinityItem{}
	for _, uid := range users {
		profile, err := s.db.BuildPersonalProfile(r.Context(), uid, since)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "model_affinity_failed")
			return
		}
		models, err := s.db.UserModelCosts(r.Context(), uid, since)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "model_affinity_failed")
			return
		}
		for _, m := range models {
			score := modelAffinityScore(m.Requests, m.SuccessRate, m.AvgCostKRW)
			items = append(items, personalizationModelAffinityItem{
				UserID: uid, Team: profile.Team, Role: profile.Role,
				Model: m.Model, Requests: m.Requests, AvgCostKRW: m.AvgCostKRW, SuccessRate: m.SuccessRate,
				Score:  score,
				Reason: fmt.Sprintf("requests=%d, success=%.0f%%, avg_cost=%.2f KRW", m.Requests, m.SuccessRate*100, m.AvgCostKRW),
			})
		}
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Score != items[j].Score {
			return items[i].Score > items[j].Score
		}
		if items[i].UserID != items[j].UserID {
			return items[i].UserID < items[j].UserID
		}
		return items[i].Model < items[j].Model
	})
	if len(items) > limit {
		items = items[:limit]
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "count": len(items)})
}

// handlePersonalizationMCPAffinity returns per-user MCP tool affinity rows from MCP
// invocation aggregates. Read-only and policy-neutral; blocked tools are still visible
// here for operators, while user recommendations filter them out.
// GET /admin/personalization/mcp-affinity?window=30d&limit=50
func (s *Server) handlePersonalizationMCPAffinity(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")
	limit := recentLimit(r)
	users, err := s.db.PersonalProfileActiveUsers(r.Context(), since, limit)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "mcp_affinity_failed")
		return
	}
	items := []personalizationMCPAffinityItem{}
	for _, uid := range users {
		profile, err := s.db.BuildPersonalProfile(r.Context(), uid, since)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "mcp_affinity_failed")
			return
		}
		affinities, err := s.db.UserMCPAffinities(r.Context(), uid, since, 1, 5)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "mcp_affinity_failed")
			return
		}
		for _, a := range affinities {
			score := mcpAffinityScore(a.Calls, a.SuccessRate, a.AvgRequestLatencyMS)
			items = append(items, personalizationMCPAffinityItem{
				UserID: uid, Team: profile.Team, Role: profile.Role,
				ServerLabel: a.ServerLabel, ToolName: a.ToolName, Ref: a.Ref,
				Calls: a.Calls, Errors: a.Errors, SuccessRate: a.SuccessRate, AvgRequestLatencyMS: a.AvgRequestLatencyMS,
				Score:  score,
				Reason: fmt.Sprintf("calls=%d, success=%.0f%%, avg_latency=%.0fms", a.Calls, a.SuccessRate*100, a.AvgRequestLatencyMS),
			})
		}
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Score != items[j].Score {
			return items[i].Score > items[j].Score
		}
		if items[i].UserID != items[j].UserID {
			return items[i].UserID < items[j].UserID
		}
		return items[i].Ref < items[j].Ref
	})
	if len(items) > limit {
		items = items[:limit]
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "count": len(items)})
}

// handlePersonalizationText2SQLHints returns per-user Text2SQL report/data-product
// hints. It uses only fingerprints and aggregate metrics in the response.
// GET /admin/personalization/text2sql-hints?window=30d&limit=50&min_count=3
func (s *Server) handlePersonalizationText2SQLHints(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")
	limit := recentLimit(r)
	minCount := atoiDefault(r.URL.Query().Get("min_count"), 3)
	if minCount < 2 {
		minCount = 3
	}
	users, err := s.db.PersonalProfileActiveUsers(r.Context(), since, limit)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "text2sql_hints_failed")
		return
	}
	items := []personalizationText2SQLHintItem{}
	for _, uid := range users {
		profile, err := s.db.BuildPersonalProfile(r.Context(), uid, since)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "text2sql_hints_failed")
			return
		}
		candidates, err := s.db.UserText2SQLReportCandidates(r.Context(), uid, since, minCount, 5)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "text2sql_hints_failed")
			return
		}
		items = append(items, personalizationText2SQLHintItemsForUser(uid, profile, candidates)...)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].EstimatedSavingsKRW != items[j].EstimatedSavingsKRW {
			return items[i].EstimatedSavingsKRW > items[j].EstimatedSavingsKRW
		}
		if items[i].Count != items[j].Count {
			return items[i].Count > items[j].Count
		}
		if items[i].UserID != items[j].UserID {
			return items[i].UserID < items[j].UserID
		}
		return items[i].Fingerprint < items[j].Fingerprint
	})
	if len(items) > limit {
		items = items[:limit]
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "count": len(items)})
}

// handlePersonalProfileDetail computes one user's profile live, caches it as the latest
// stored profile, and (with ?snapshot=1) records a point-in-time snapshot. Returns the
// profile plus the user's snapshot history.
// GET /admin/personalization/profiles/{user_id}?window=30d&snapshot=1
func (s *Server) handlePersonalProfileDetail(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	userID := strings.Trim(strings.TrimPrefix(r.URL.Path, "/admin/personalization/profiles/"), "/")
	if userID == "" {
		s.handlePersonalProfiles(w, r)
		return
	}
	// {user_id}/drift → return only the drift between the two latest snapshots.
	if strings.HasSuffix(userID, "/drift") {
		uid := strings.TrimSuffix(userID, "/drift")
		drift, err := s.db.ProfileDriftForUser(r.Context(), uid)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "drift_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"drift": drift})
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")
	p, err := s.db.BuildPersonalProfile(r.Context(), userID, since)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "profile_failed")
		return
	}
	encoded, err := json.Marshal(p)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "profile_failed")
		return
	}
	// Cache the latest profile; best-effort.
	_ = s.db.UpsertPersonalProfile(r.Context(), userID, string(encoded))
	if strings.TrimSpace(r.URL.Query().Get("snapshot")) == "1" {
		if err := s.db.InsertPersonalProfileSnapshot(r.Context(), newID("pps"), userID, string(encoded)); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "snapshot_failed")
			return
		}
		s.auditAdmin(r, "personalization.profile.snapshot", userID, "")
	}
	snapshots, err := s.db.ListPersonalProfileSnapshots(r.Context(), userID, 20)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "profile_failed")
		return
	}
	drift, err := s.db.ProfileDriftForUser(r.Context(), userID)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "profile_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"profile": p, "snapshots": snapshots, "drift": drift})
}
