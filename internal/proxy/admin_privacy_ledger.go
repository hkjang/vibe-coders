package proxy

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// handlePrivacyLedger reports the privacy/data-egress ledger by dimension — sensitive-data
// detect/mask/block counts and external-provider egress (requests/tokens) per team/model/provider.
// GET /admin/privacy-ledger?dimension=team&days=30
func (s *Server) handlePrivacyLedger(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	dimension := strings.TrimSpace(r.URL.Query().Get("dimension"))
	if dimension == "" {
		dimension = "team"
	}
	days := 30
	if v := strings.TrimSpace(r.URL.Query().Get("days")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 365 {
			days = n
		}
	}
	since := time.Now().UTC().AddDate(0, 0, -days)
	rows, err := s.db.PrivacyLedger(r.Context(), dimension, since)
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, err.Error(), "invalid_request_error", "privacy_ledger_failed")
		return
	}
	// Rank by sensitivity exposure (detections+masked+blocked) then egress volume.
	sort.SliceStable(rows, func(i, j int) bool {
		si := rows[i].Detections + rows[i].Masked + rows[i].Blocked
		sj := rows[j].Detections + rows[j].Masked + rows[j].Blocked
		if si != sj {
			return si > sj
		}
		return rows[i].EgressRequests > rows[j].EgressRequests
	})
	var totDet, totMask, totBlock, totReq, totTok int64
	for _, x := range rows {
		totDet += x.Detections
		totMask += x.Masked
		totBlock += x.Blocked
		totReq += x.EgressRequests
		totTok += x.EgressTokens
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"dimension": dimension,
		"days":      days,
		"rows":      rows,
		"totals": map[string]int64{
			"detections": totDet, "masked": totMask, "blocked": totBlock,
			"egress_requests": totReq, "egress_tokens": totTok,
		},
		"note": "민감정보 탐지/마스킹/차단량과 외부 provider 전송량(요청·토큰)을 차원별로 집계한 감사 원장입니다. 원문은 포함되지 않습니다.",
	})
}
