package proxy

import (
	"fmt"
	"net/http"
	"strings"
	"time"
)

var chargebackKST = time.FixedZone("KST", 9*3600)

// chargebackDimension is one dimension's allocation within the pack.
type chargebackDimension struct {
	Dimension    string         `json:"dimension"`
	Rows         []chargebackRow `json:"rows"`
	TotalCostKRW float64        `json:"total_cost_krw"`
	TotalReqs    int64          `json:"total_requests"`
}

type chargebackRow struct {
	Key      string  `json:"key"`
	Requests int64   `json:"requests"`
	Tokens   int64   `json:"tokens"`
	CostKRW  float64 `json:"cost_krw"`
	Errors   int64   `json:"errors"`
}

// handleChargebackPack assembles a monthly cost-allocation pack across multiple dimensions
// (cost_center, project, team by default) for internal billing. Admin only. ?format=csv flattens
// all dimensions into one CSV. GET /admin/cost/chargeback-pack?month=YYYY-MM&dimensions=...
func (s *Server) handleChargebackPack(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	ctx := r.Context()

	// Month window in KST (matches budget/quota boundaries). Default = current month-to-date.
	now := time.Now().In(chargebackKST)
	monthStr := strings.TrimSpace(r.URL.Query().Get("month"))
	var start, until time.Time
	if monthStr != "" {
		t, err := time.ParseInLocation("2006-01", monthStr, chargebackKST)
		if err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "month must be YYYY-MM", "invalid_request_error", "bad_month")
			return
		}
		start = t
		until = t.AddDate(0, 1, 0)
	} else {
		start = time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, chargebackKST)
		until = start.AddDate(0, 1, 0)
		monthStr = start.Format("2006-01")
	}

	dims := []string{"cost_center", "project", "team"}
	if q := strings.TrimSpace(r.URL.Query().Get("dimensions")); q != "" {
		dims = splitCSV(q)
	}

	pack := []chargebackDimension{}
	for _, dim := range dims {
		rows, err := s.db.CostAllocationWindow(ctx, dim, start, until, 200)
		if err != nil {
			writeOpenAIError(w, http.StatusBadRequest, err.Error(), "invalid_request_error", "bad_dimension")
			return
		}
		cd := chargebackDimension{Dimension: dim}
		for _, row := range rows {
			cd.Rows = append(cd.Rows, chargebackRow{
				Key: row.Key, Requests: row.Requests, Tokens: row.Tokens,
				CostKRW: round1(row.CostKRW), Errors: row.Errors,
			})
			cd.TotalCostKRW += row.CostKRW
			cd.TotalReqs += row.Requests
		}
		cd.TotalCostKRW = round1(cd.TotalCostKRW)
		pack = append(pack, cd)
	}

	if strings.EqualFold(r.URL.Query().Get("format"), "csv") {
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", "attachment; filename=chargeback-"+monthStr+".csv")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "month,dimension,key,requests,tokens,cost_krw,errors")
		for _, cd := range pack {
			for _, row := range cd.Rows {
				fmt.Fprintf(w, "%s,%s,%s,%d,%d,%.1f,%d\n",
					monthStr, cd.Dimension, csvEscapeField(row.Key), row.Requests, row.Tokens, row.CostKRW, row.Errors)
			}
		}
		return
	}

	s.auditAdmin(r, "cost_chargeback_pack", monthStr, "")
	writeJSON(w, http.StatusOK, map[string]any{
		"month":        monthStr,
		"period_start": start.UTC().Format(time.RFC3339),
		"period_end":   until.UTC().Format(time.RFC3339),
		"dimensions":   pack,
		"generated_at": time.Now().UTC().Format(time.RFC3339),
		"note":         "월별 비용 배부 패키지입니다. cost_center·project·team 등 차원별 비용/요청을 한 번에 산출합니다. ?format=csv로 전체 차원을 한 CSV로 받습니다.",
	})
}
