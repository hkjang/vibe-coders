package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

// clickhouseSink pushes daily rollup rows to ClickHouse via its HTTP interface as
// JSONEachRow. ClickHouse de-duplicates by (day, dimension, dim_value) when the
// target table uses a ReplacingMergeTree, so re-sending a backfilled window is safe.
// Returns the number of rows sent.
func clickhouseSink(ctx context.Context, client *http.Client, cfg config.ClickHouseConfig, rows []store.AnalyticsRollupRow) (int, error) {
	if cfg.URL == "" {
		return 0, fmt.Errorf("clickhouse URL not configured")
	}
	if len(rows) == 0 {
		return 0, nil
	}
	var body bytes.Buffer
	for _, row := range rows {
		line, err := json.Marshal(map[string]any{
			"day":       row.Day,
			"dimension": row.Dimension,
			"dim_value": row.DimValue,
			"requests":  row.Requests,
			"tokens":    row.Tokens,
			"cost_krw":  row.CostKRW,
			"errors":    row.Errors,
		})
		if err != nil {
			return 0, err
		}
		body.Write(line)
		body.WriteByte('\n')
	}

	table := cfg.Table
	if cfg.Database != "" {
		table = cfg.Database + "." + cfg.Table
	}
	q := "INSERT INTO " + table + " FORMAT JSONEachRow"
	endpoint := cfg.URL + "/?query=" + url.QueryEscape(q)

	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, &body)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/x-ndjson")
	if cfg.User != "" {
		req.Header.Set("X-ClickHouse-User", cfg.User)
		req.Header.Set("X-ClickHouse-Key", cfg.Password)
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return 0, fmt.Errorf("clickhouse insert failed: status %d", resp.StatusCode)
	}
	return len(rows), nil
}

// handleClickHouseSink rolls up the last N days and ships every dimension's daily
// aggregates to ClickHouse for long-term analysis.
// POST /admin/dw/clickhouse?days=30
func (s *Server) handleClickHouseSink(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if s.cfg.ClickHouse.URL == "" {
		writeOpenAIError(w, http.StatusBadRequest, "ClickHouse is not configured (CLICKHOUSE_URL)", "invalid_request_error", "no_clickhouse")
		return
	}
	days := 30
	if v := strings.TrimSpace(r.URL.Query().Get("days")); v != "" {
		if n := atoiDefault(v, 30); n > 0 && n <= 365 {
			days = n
		}
	}
	sinceDay := time.Now().UTC().AddDate(0, 0, -days).Format("2006-01-02")
	total := 0
	for _, dim := range []string{"all", "model", "provider", "project", "cost_center"} {
		rows, err := s.db.ListDailyRollups(r.Context(), dim, sinceDay, 5000)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "rollups_failed")
			return
		}
		n, err := clickhouseSink(r.Context(), s.client, s.cfg.ClickHouse, rows)
		if err != nil {
			writeOpenAIError(w, http.StatusBadGateway, "clickhouse sink failed: "+err.Error(), "server_error", "clickhouse_failed")
			return
		}
		total += n
	}
	s.auditAdmin(r, "dw.clickhouse.sink", "", auditJSON(map[string]any{"days": days, "rows": total}))
	writeJSON(w, http.StatusOK, map[string]any{"sent_rows": total, "since": sinceDay})
}

func atoiDefault(s string, def int) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return def
		}
		n = n*10 + int(c-'0')
	}
	return n
}
