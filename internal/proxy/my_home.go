package proxy

import (
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
		"user_id":                  userID,
		"today":                    today,
		"month":                    month,
		"frequent_models":          topModels,
		"recent_failures":          failures,
		"potential_savings_krw":    savings,
		"potential_savings_model":  cheapModel,
		"recommended_templates":    templates,
		"recent_prompt_products":   products,
	})
}

// handleMyRecommendations generates, persists, and returns actionable recommendations for
// the calling user (cheaper-model switch, template adoption), derived from their own usage.
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
			ID:   newID("rec"),
			Kind: "model_switch",
			Title: fmt.Sprintf("자주 쓰는 %s 대신 %s 사용 고려", models[0].Model, cheapModel),
			Detail: fmt.Sprintf("이번 달 사용 패턴 기준 %s로 전환 시 약 %.0f KRW 절감 가능 (성공률 유지).", cheapModel, savings),
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
			ID:    newID("rec"),
			Kind:  "template",
			Title: "추천 템플릿: " + t.Name,
			Detail: fmt.Sprintf("표준 템플릿(%s)을 사용하면 일관된 결과와 비용 예측에 도움이 됩니다.", t.Category),
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
