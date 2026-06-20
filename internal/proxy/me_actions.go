package proxy

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// actionCard is one actionable item in the personal action queue: a condition the user
// should act on now, with a one-click destination.
type actionCard struct {
	Type        string `json:"type"`
	Severity    string `json:"severity"` // high | medium | low
	Message     string `json:"message"`
	ButtonLabel string `json:"button_label"`
	ButtonHref  string `json:"button_href"`
}

// handleMeActions assembles the caller's personal action queue from their own signals:
// key expiry, cost spike, failure spike, model-switch savings, repeated questions, MCP
// affinity, rising risk, cache opportunity, and unreviewed recommendations.
// GET /me/actions
func (s *Server) handleMeActions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	userID, ok := s.meUserID(r)
	if !ok {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	ctx := r.Context()
	now := time.Now().UTC()
	monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	snoozed, _ := s.db.SnoozedActions(ctx, userID, now)
	actions := []actionCard{}

	// Key expiry (≤7 days) / expired.
	if alerts, err := s.db.KeyHealthAlerts(ctx, now, 30, 7, userID); err == nil {
		expiring := 0
		for _, a := range alerts {
			for _, f := range a.Flags {
				if f == "expiring_soon" || f == "expired" {
					expiring++
				}
			}
		}
		if expiring > 0 {
			actions = append(actions, actionCard{Type: "key_expiry", Severity: "high",
				Message: "곧 만료되는 API Key가 있습니다.", ButtonLabel: "키 회전", ButtonHref: "#/mykeys"})
		}
	}

	// Cost spike: this week ≥ 130% of last week.
	thisWeek, _ := s.db.UserUsageTotalsSince(ctx, userID, now.Add(-7*24*time.Hour))
	twoWeek, _ := s.db.UserUsageTotalsSince(ctx, userID, now.Add(-14*24*time.Hour))
	lastWeekCost := twoWeek.CostKRW - thisWeek.CostKRW
	if lastWeekCost > 0 && thisWeek.CostKRW >= lastWeekCost*1.3 {
		actions = append(actions, actionCard{Type: "cost_increase", Severity: "medium",
			Message: "이번 주 AI 비용이 평소보다 높습니다.", ButtonLabel: "절감 추천 보기", ButtonHref: "#/me"})
	}

	// Failure spike: last 24h errors > prior 24h errors.
	last24, _ := s.db.UserUsageTotalsSince(ctx, userID, now.Add(-24*time.Hour))
	last48, _ := s.db.UserUsageTotalsSince(ctx, userID, now.Add(-48*time.Hour))
	prev24Errors := last48.Errors - last24.Errors
	if last24.Errors > 0 && last24.Errors > prev24Errors {
		actions = append(actions, actionCard{Type: "failure_increase", Severity: "medium",
			Message: "최근 실패 요청이 늘었습니다.", ButtonLabel: "실패 원인 보기", ButtonHref: "#/me"})
	}

	// Model switch: a cheaper adequate model exists for this month's mix.
	month, _ := s.db.UserUsageTotalsSince(ctx, userID, monthStart)
	models, _ := s.db.UserModelCosts(ctx, userID, monthStart)
	if savings, cheap := potentialSavingsKRW(month, models); savings > 0 && cheap != "" {
		actions = append(actions, actionCard{Type: "model_switch", Severity: "low",
			Message: "이 작업은 더 저렴한 모델로 처리 가능해 보입니다.", ButtonLabel: "전환 가이드", ButtonHref: "#/me"})
	}

	// Repeated Text2SQL questions → report candidate.
	cands, _ := s.db.UserText2SQLReportCandidates(ctx, userID, now.Add(-30*24*time.Hour), 3, 5)
	if len(cands) > 0 {
		actions = append(actions, actionCard{Type: "repeat_question", Severity: "low",
			Message: "반복되는 질문을 저장 리포트로 만들 수 있습니다.", ButtonLabel: "리포트 만들기", ButtonHref: "#/me"})
	}

	// MCP affinity.
	if aff, _ := s.db.UserMCPAffinities(ctx, userID, now.Add(-30*24*time.Hour), 2, 5); len(aff) > 0 {
		actions = append(actions, actionCard{Type: "mcp_recommend", Severity: "low",
			Message: "자주 하는 작업에 맞는 MCP 도구가 있습니다.", ButtonLabel: "도구 보기", ButtonHref: "#/me"})
	}

	// Rising personal risk + cache opportunity (both from the profile).
	profile, _ := s.db.BuildPersonalProfile(ctx, userID, now.Add(-30*24*time.Hour))
	if profile.RiskScore >= 30 {
		actions = append(actions, actionCard{Type: "safety_warning", Severity: "high",
			Message: "민감정보 포함 가능성이 있는 요청이 증가했습니다.", ButtonLabel: "안전 가이드", ButtonHref: "#/me"})
	}
	if len(cands) >= 2 && profile.CacheRate < 0.2 {
		actions = append(actions, actionCard{Type: "cache_improve", Severity: "low",
			Message: "유사 질문 재사용으로 응답 속도를 개선할 수 있습니다.", ButtonLabel: "템플릿 만들기", ButtonHref: "#/me"})
	}

	// Unreviewed recommendations.
	if recs, _ := s.db.ListUserRecommendations(ctx, userID); len(recs) > 0 {
		actions = append(actions, actionCard{Type: "unreviewed_recommendations", Severity: "low",
			Message: "확인하지 않은 개인화 추천이 있습니다.", ButtonLabel: "추천 보기", ButtonHref: "#/me"})
	}

	// Drop snoozed action types.
	if len(snoozed) > 0 {
		kept := actions[:0]
		for _, a := range actions {
			if !snoozed[a.Type] {
				kept = append(kept, a)
			}
		}
		actions = kept
	}
	// Highest severity first.
	rank := map[string]int{"high": 0, "medium": 1, "low": 2}
	sort.SliceStable(actions, func(i, j int) bool { return rank[actions[i].Severity] < rank[actions[j].Severity] })
	writeJSON(w, http.StatusOK, map[string]any{"user_id": userID, "actions": actions, "count": len(actions)})
}

// handleMeActionSnooze defers an action-queue card type for the caller (default 7 days), so
// a handled action stops re-appearing. POST /me/actions/snooze {type, days}
func (s *Server) handleMeActionSnooze(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	userID, ok := s.meUserID(r)
	if !ok {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	var p struct {
		Type string `json:"type"`
		Days int    `json:"days"`
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	actionType := strings.TrimSpace(p.Type)
	if actionType == "" {
		writeOpenAIError(w, http.StatusBadRequest, "type is required", "invalid_request_error", "missing_type")
		return
	}
	days := p.Days
	if days <= 0 || days > 90 {
		days = 7
	}
	until := time.Now().UTC().Add(time.Duration(days) * 24 * time.Hour)
	if err := s.db.SnoozeAction(r.Context(), userID, actionType, until); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "snooze_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"type": actionType, "snoozed_until": until.Format(time.RFC3339)})
}

// meNotification is one entry in the unified personal notification center.
type meNotification struct {
	Category  string `json:"category"` // recommendation | key | failure | policy | secret
	Level     string `json:"level"`    // info | warning | critical
	Title     string `json:"title"`
	Detail    string `json:"detail"`
	CreatedAt string `json:"created_at"`
	Href      string `json:"href"`
}

// handleMeNotifications unifies the caller's scattered alerts — recommendations, key
// health, recent failures, and per-user policy/secret events — into one feed.
// GET /me/notifications
func (s *Server) handleMeNotifications(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	userID, ok := s.meUserID(r)
	if !ok {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	ctx := r.Context()
	now := time.Now().UTC()
	since := now.Add(-7 * 24 * time.Hour)
	out := []meNotification{}

	if recs, _ := s.db.ListUserRecommendations(ctx, userID); len(recs) > 0 {
		for _, rec := range recs {
			out = append(out, meNotification{Category: "recommendation", Level: "info",
				Title: rec.Title, Detail: rec.Detail, CreatedAt: rec.CreatedAt, Href: "#/me"})
		}
	}
	if alerts, _ := s.db.KeyHealthAlerts(ctx, now, 30, 7, userID); len(alerts) > 0 {
		for _, a := range alerts {
			level := "warning"
			if a.Severity == "high" {
				level = "critical"
			}
			out = append(out, meNotification{Category: "key", Level: level,
				Title: "API Key 주의: " + a.Name, Detail: strings.Join(a.Flags, ", "), CreatedAt: a.LastUsedAt, Href: "#/mykeys"})
		}
	}
	if fails, _ := s.db.UserRecentFailures(ctx, userID, 5); len(fails) > 0 {
		for _, f := range fails {
			out = append(out, meNotification{Category: "failure", Level: "warning",
				Title: "실패 요청 (" + f.Model + ")", Detail: "HTTP " + itoa64(int64(f.StatusCode)) + " " + f.Error, CreatedAt: f.CreatedAt, Href: "#/me"})
		}
	}
	if decisions, _ := s.db.ListPolicyDecisionEventsFiltered(ctx, store.PolicyDecisionFilter{UserID: userID, Since: since, Limit: 20}); len(decisions) > 0 {
		for _, d := range decisions {
			if strings.EqualFold(d.Decision, "allow") {
				continue
			}
			level := "warning"
			if strings.EqualFold(d.Decision, "block") {
				level = "critical"
			}
			out = append(out, meNotification{Category: "policy", Level: level,
				Title: "정책 " + d.Decision, Detail: d.Reason, CreatedAt: d.CreatedAt.UTC().Format(time.RFC3339), Href: "#/me"})
		}
	}
	if secrets, _ := s.db.ListSecretEventsFiltered(ctx, store.SecretEventFilter{UserID: userID, Since: since, Limit: 20}); len(secrets) > 0 {
		for _, e := range secrets {
			out = append(out, meNotification{Category: "secret", Level: "critical",
				Title: "Secret 탐지: " + e.SecretType, Detail: e.Action, CreatedAt: e.CreatedAt.UTC().Format(time.RFC3339), Href: "#/me"})
		}
	}

	// Newest first (string RFC3339 compare is chronological).
	sort.SliceStable(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	critical := 0
	for _, n := range out {
		if n.Level == "critical" {
			critical++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user_id": userID, "notifications": out, "count": len(out), "critical_count": critical,
	})
}

// handleMeReport generates a personal weekly/monthly usage report so a user can understand
// their own AI usage and its trend. GET /me/report?window=weekly|monthly
func (s *Server) handleMeReport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	userID, ok := s.meUserID(r)
	if !ok {
		writeOpenAIError(w, http.StatusUnauthorized, "could not identify caller", "invalid_request_error", "invalid_api_key")
		return
	}
	ctx := r.Context()
	now := time.Now().UTC()
	window := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("window")))
	span := 7 * 24 * time.Hour
	if window == "monthly" {
		span = 30 * 24 * time.Hour
	} else {
		window = "weekly"
	}
	since := now.Add(-span)
	prior := now.Add(-2 * span)

	cur, _ := s.db.UserUsageTotalsSince(ctx, userID, since)
	wide, _ := s.db.UserUsageTotalsSince(ctx, userID, prior)
	priorCost := wide.CostKRW - cur.CostKRW
	priorReq := wide.Requests - cur.Requests
	costDelta := 0.0
	if priorCost > 0 {
		costDelta = (cur.CostKRW - priorCost) / priorCost
	}

	models, _ := s.db.UserModelCosts(ctx, userID, since)
	if len(models) > 5 {
		models = models[:5]
	}
	profile, _ := s.db.BuildPersonalProfile(ctx, userID, since)
	savings, cheap := potentialSavingsKRW(cur, models)
	recCount := 0
	if recs, _ := s.db.ListUserRecommendations(ctx, userID); recs != nil {
		recCount = len(recs)
	}
	successRate := profile.SuccessRate
	if cur.Requests > 0 {
		successRate = float64(cur.Requests-cur.Errors) / float64(cur.Requests)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"user_id":              userID,
		"window":               window,
		"since":                since.UTC().Format(time.RFC3339),
		"requests":             cur.Requests,
		"tokens":               cur.Tokens,
		"cost_krw":             cur.CostKRW,
		"errors":               cur.Errors,
		"success_rate":         successRate,
		"prior_cost_krw":       priorCost,
		"prior_requests":       priorReq,
		"cost_delta_ratio":     costDelta, // vs prior equal window
		"avg_latency_ms":       profile.AvgLatencyMS,
		"cache_rate":           profile.CacheRate,
		"risk_score":           profile.RiskScore,
		"top_models":           models,
		"top_task_types":       profile.TopTaskTypes,
		"potential_savings_krw": savings,
		"potential_savings_model": cheap,
		"recommendation_count": recCount,
	})
}
