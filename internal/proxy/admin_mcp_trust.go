package proxy

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// mcpTrustScore computes a 0–100 trust score for a tool from its error rate and risk level.
// Returns (score, grade). Low call volume is reflected as low confidence by the caller.
func mcpTrustScore(errorRate float64, riskLevel string) (float64, string) {
	score := 100.0
	score -= errorRate * 50 // 100% errors → −50
	switch strings.ToLower(riskLevel) {
	case "critical":
		score -= 35
	case "high":
		score -= 25
	case "medium":
		score -= 10
	}
	if score < 0 {
		score = 0
	}
	score = round1(score)
	grade := "D"
	switch {
	case score >= 85:
		grade = "A"
	case score >= 70:
		grade = "B"
	case score >= 50:
		grade = "C"
	}
	return score, grade
}

// handleMCPTrustScores ranks MCP tools by a trust score derived from recent success/error rate
// and the configured risk level. GET /admin/mcp/trust-scores?days=
func (s *Server) handleMCPTrustScores(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	days := 30
	if d := strings.TrimSpace(r.URL.Query().Get("days")); d != "" {
		if n, err := strconv.Atoi(d); err == nil && n > 0 && n <= 365 {
			days = n
		}
	}
	tools, err := s.db.ListMCPTools(r.Context(), store.ToolFilter{MCPOnly: true, Since: time.Now().UTC().AddDate(0, 0, -days), Limit: 1000})
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "tools_failed")
		return
	}
	// Risk level lookup by server/tool.
	riskByKey := map[string]string{}
	if profiles, err := s.db.ListToolRiskProfiles(r.Context()); err == nil {
		for _, p := range profiles {
			riskByKey[p.ServerLabel+"/"+p.ToolName] = p.RiskLevel
		}
	}
	out := make([]map[string]any, 0, len(tools))
	for _, t := range tools {
		risk := riskByKey[t.ServerLabel+"/"+t.ToolName]
		if risk == "" {
			risk = "unrated"
		}
		score, grade := mcpTrustScore(t.ErrorRate, risk)
		confidence := "ok"
		if t.Calls < 10 {
			confidence = "low" // 표본 부족
		}
		out = append(out, map[string]any{
			"server": t.ServerLabel, "tool": t.ToolName, "ref": t.ServerLabel + "/" + t.ToolName,
			"trust_score": score, "grade": grade, "risk_level": risk,
			"calls": t.Calls, "errors": t.Errors, "error_rate_pct": round1(t.ErrorRate * 100),
			"distinct_users": t.DistinctKeys, "confidence": confidence, "last_seen": t.LastSeen,
		})
	}
	// Lowest trust first (most attention needed).
	sort.SliceStable(out, func(i, j int) bool {
		return out[i]["trust_score"].(float64) < out[j]["trust_score"].(float64)
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"window_days": days, "tools": out, "count": len(out),
		"note": "신뢰 점수 = 100 − 오류율×50 − 위험도 패널티(critical −35/high −25/medium −10). 호출<10건은 confidence=low(표본 부족). 등급 A≥85·B≥70·C≥50·D.",
	})
}
