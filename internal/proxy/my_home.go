package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// meUserID resolves the calling user's id from a JWT access token (preferred) or from a
// proxy API key. Returns false when the caller cannot be identified as a user.
func (s *Server) meUserID(r *http.Request) (string, bool) {
	if claims, ok := s.currentAccessClaims(r); ok && strings.TrimSpace(claims.Subject) != "" {
		return claims.Subject, true
	}
	if _, authCtx, ok := s.authenticateProxyContext(r); ok && authCtx != nil && strings.TrimSpace(authCtx.UserID) != "" {
		return authCtx.UserID, true
	}
	return "", false
}

// cheapestAdequateModel returns the cheapest model whose success rate is within 5pp of the
// best observed, among the user's models — the cost-optimal-but-still-good choice.
func cheapestAdequateModel(models []store.UserModelCost) (model string, avgCost float64, ok bool) {
	var best float64
	for _, m := range models {
		if m.SuccessRate > best {
			best = m.SuccessRate
		}
	}
	for _, m := range models {
		if m.Requests == 0 || m.SuccessRate+0.05 < best {
			continue
		}
		if !ok || m.AvgCostKRW < avgCost {
			avgCost, model, ok = m.AvgCostKRW, m.Model, true
		}
	}
	return model, avgCost, ok
}

// potentialSavingsKRW estimates what the user could save this period by consolidating onto
// their cheapest adequate model: month cost minus (requests × cheapest adequate avg cost).
func potentialSavingsKRW(month store.UserUsageTotals, models []store.UserModelCost) (float64, string) {
	cheapModel, cheapAvg, ok := cheapestAdequateModel(models)
	if !ok || month.Requests == 0 {
		return 0, ""
	}
	saved := month.CostKRW - cheapAvg*float64(month.Requests)
	if saved < 0 {
		saved = 0
	}
	return saved, cheapModel
}

// handleMyDashboard renders the calling user's "My AI Home" dashboard: today's usage,
// month-to-date cost, frequent models, recent failures, potential savings, recommended
// templates, and recent prompt products. Read-only, scoped to the caller.
// GET /me/dashboard
func (s *Server) handleMyDashboard(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.meUserID(r)
	if !ok {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	ctx := r.Context()
	now := time.Now().UTC()
	startToday := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	startMonth := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)

	today, err := s.db.UserUsageTotalsSince(ctx, userID, startToday)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "dashboard_failed")
		return
	}
	month, err := s.db.UserUsageTotalsSince(ctx, userID, startMonth)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "dashboard_failed")
		return
	}
	models, err := s.db.UserModelCosts(ctx, userID, startMonth)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "dashboard_failed")
		return
	}
	profile, err := s.db.BuildPersonalProfile(ctx, userID, startMonth)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "dashboard_failed")
		return
	}
	failures, err := s.db.UserRecentFailures(ctx, userID, 5)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "dashboard_failed")
		return
	}
	templates, err := s.db.ListPromptTemplates(ctx, true)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "dashboard_failed")
		return
	}
	products, err := s.db.ListPromptProducts(ctx)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "dashboard_failed")
		return
	}

	keyAlerts, err := s.db.KeyHealthAlerts(ctx, time.Now().UTC(), 30, 7, userID)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "dashboard_failed")
		return
	}

	savings, cheapModel := potentialSavingsKRW(month, models)
	topModels := models
	if len(topModels) > 5 {
		topModels = topModels[:5]
	}
	if len(templates) > 3 {
		templates = templates[:3]
	}
	if len(products) > 5 {
		products = products[:5]
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"user_id":                 userID,
		"today":                   today,
		"month":                   month,
		"profile":                 profile,
		"frequent_models":         topModels,
		"recent_failures":         failures,
		"potential_savings_krw":   savings,
		"potential_savings_model": cheapModel,
		"recommended_templates":   templates,
		"recent_prompt_products":  products,
		"key_alerts":              keyAlerts,
	})
}

func text2SQLProductLabel(kind string) string {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "dashboard":
		return "대시보드"
	case "data_mart":
		return "데이터마트"
	case "api":
		return "조회 API"
	default:
		return "저장 리포트"
	}
}

func (s *Server) mcpAffinityAllowedForRecommendation(ctx context.Context, serverLabel, toolName string) bool {
	profile, found, err := s.db.ToolRiskProfile(ctx, serverLabel, toolName)
	if err != nil || !found {
		return true
	}
	action := normalizeToolRiskAction(profile.Action, "allow")
	return action == "allow"
}

// handleMyRecommendations generates, persists, and returns actionable recommendations for
// the calling user (model switch, template adoption, Text2SQL report candidates, MCP tool
// affinity), derived from their own usage.
// GET /me/recommendations
func (s *Server) handleMyRecommendations(w http.ResponseWriter, r *http.Request) {
	userID, ok := s.meUserID(r)
	if !ok {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	ctx := r.Context()
	startMonth := time.Now().UTC()
	startMonth = time.Date(startMonth.Year(), startMonth.Month(), 1, 0, 0, 0, 0, time.UTC)
	recommendationSince := time.Now().UTC().Add(-30 * 24 * time.Hour)

	month, err := s.db.UserUsageTotalsSince(ctx, userID, startMonth)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "recommendations_failed")
		return
	}
	models, err := s.db.UserModelCosts(ctx, userID, startMonth)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "recommendations_failed")
		return
	}
	recs := []store.PersonalRecommendation{}

	// Model-switch recommendation: cheaper adequate model than the busiest one.
	savings, cheapModel := potentialSavingsKRW(month, models)
	if len(models) > 0 && cheapModel != "" && cheapModel != models[0].Model && savings > 0 {
		recs = append(recs, store.PersonalRecommendation{
			ID:            newID("rec"),
			Kind:          "model_switch",
			Ref:           cheapModel,
			Title:         fmt.Sprintf("자주 쓰는 %s 대신 %s 사용 고려", models[0].Model, cheapModel),
			Detail:        fmt.Sprintf("이번 달 사용 패턴 기준 %s로 전환 시 약 %.0f KRW 절감 가능 (성공률 유지).", cheapModel, savings),
			EstSavingsKRW: savings,
		})
	}

	// Template adoption recommendations: a couple of enabled standard templates.
	templates, err := s.db.ListPromptTemplates(ctx, true)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "recommendations_failed")
		return
	}
	for i, t := range templates {
		if i >= 2 {
			break
		}
		recs = append(recs, store.PersonalRecommendation{
			ID:     newID("rec"),
			Kind:   "template",
			Ref:    t.ID,
			Title:  "추천 템플릿: " + t.Name,
			Detail: fmt.Sprintf("표준 템플릿(%s)을 사용하면 일관된 결과와 비용 예측에 도움이 됩니다.", t.Category),
		})
	}

	text2sqlCandidates, err := s.db.UserText2SQLReportCandidates(ctx, userID, recommendationSince, 3, 2)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "recommendations_failed")
		return
	}
	for _, c := range text2sqlCandidates {
		schema := ""
		if strings.TrimSpace(c.SchemaName) != "" {
			schema = fmt.Sprintf(" schema=%s,", c.SchemaName)
		}
		product := text2SQLProductLabel(c.RecommendedProduct)
		recs = append(recs, store.PersonalRecommendation{
			ID:            newID("rec"),
			Kind:          "text2sql_report_candidate",
			Ref:           c.Fingerprint,
			Title:         "반복 Text2SQL 질문을 " + product + " 후보로 검토",
			Detail:        fmt.Sprintf("최근 30일%s %d회 반복, 성공률 %.0f%%, 평균 %.2f KRW. 원문 질문/SQL은 추천에 저장하지 않습니다.", schema, c.Count, c.SuccessRate*100, c.AvgCostKRW),
			EstSavingsKRW: float64(c.Count-1) * c.AvgCostKRW,
		})
	}

	mcpAffinities, err := s.db.UserMCPAffinities(ctx, userID, recommendationSince, 2, 3)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "recommendations_failed")
		return
	}
	for _, a := range mcpAffinities {
		if a.SuccessRate < 0.7 || !s.mcpAffinityAllowedForRecommendation(ctx, a.ServerLabel, a.ToolName) {
			continue
		}
		recs = append(recs, store.PersonalRecommendation{
			ID:     newID("rec"),
			Kind:   "mcp_tool",
			Ref:    a.Ref,
			Title:  "자주 쓰는 MCP 도구: " + a.Ref,
			Detail: fmt.Sprintf("최근 30일 %d회 사용, 성공률 %.0f%%, 평균 요청 지연 %.0fms. 차단/승인필요 정책 도구는 추천에서 제외됩니다.", a.Calls, a.SuccessRate*100, a.AvgRequestLatencyMS),
		})
	}

	if err := s.db.ReplaceUserRecommendations(ctx, userID, recs); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "recommendations_failed")
		return
	}
	stored, err := s.db.ListUserRecommendations(ctx, userID)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "recommendations_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user_id": userID, "recommendations": stored})
}

// handleMyRecommendationFeedback records the calling user's action on a recommendation
// (adopt/dismiss), keyed to the recommendation's kind/ref for adoption-rate tracking.
// POST /me/recommendations/feedback {id, action}
func (s *Server) handleMyRecommendationFeedback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	userID, ok := s.meUserID(r)
	if !ok {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	var payload struct {
		ID     string `json:"id"`
		Action string `json:"action"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	action := strings.ToLower(strings.TrimSpace(payload.Action))
	if action != "adopted" && action != "dismissed" {
		writeOpenAIError(w, http.StatusBadRequest, "action must be 'adopted' or 'dismissed'", "invalid_request_error", "invalid_action")
		return
	}
	rec, found, err := s.db.GetUserRecommendation(r.Context(), userID, strings.TrimSpace(payload.ID))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "feedback_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "recommendation not found (it may have been regenerated; refetch)", "invalid_request_error", "recommendation_not_found")
		return
	}
	if err := s.db.InsertRecommendationFeedback(r.Context(), store.RecommendationFeedback{
		ID: newID("rfb"), UserID: userID, Kind: rec.Kind, Ref: rec.Ref, Title: rec.Title, Action: action,
	}); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "feedback_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "recorded", "kind": rec.Kind, "action": action})
}

// handleRecommendationAdoption returns adoption-rate aggregates per recommendation kind
// over a window (admin). Read-only.
// GET /admin/recommendations/adoption?window=30d
func (s *Server) handleRecommendationAdoption(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	since := parseWindow(r.URL.Query().Get("window"), 30*24*time.Hour, "day")
	byKind, err := s.db.RecommendationAdoption(r.Context(), since)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "adoption_failed")
		return
	}
	var adopted, dismissed int64
	for _, k := range byKind {
		adopted += k.Adopted
		dismissed += k.Dismissed
	}
	overall := 0.0
	if total := adopted + dismissed; total > 0 {
		overall = float64(adopted) / float64(total)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"by_kind": byKind, "total_adopted": adopted, "total_dismissed": dismissed, "overall_adoption_rate": overall,
	})
}
