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

// Red Team ClickHouse fact sink (요건 §10, §19). Ships one content-free row per red-team case
// result to a long-term analytics table for team/provider/tool risk trend analysis. Only
// decisions, categories, and scores are exported — never prompt/response content. Gated entirely
// behind CLICKHOUSE_URL + CLICKHOUSE_REDTEAM_FACT_TABLE; a no-op when either is unset.

// redTeamFactRow builds the flat, content-free fact map for one case result. Pure and testable.
func redTeamFactRow(d store.RedTeamDashboardRow) map[string]any {
	ts := d.CreatedAt
	// Normalize to RFC3339 for ClickHouse best_effort DateTime parsing.
	if t, err := time.Parse(time.RFC3339Nano, d.CreatedAt); err == nil {
		ts = t.UTC().Format(time.RFC3339)
	}
	return map[string]any{
		"ts":            ts,
		"target_id":     d.TargetID,
		"target_type":   d.TargetType,
		"target_ref":    d.TargetRef,
		"owner_team":    d.OwnerTeam,
		"pack_id":       d.PackID,
		"pack_category": d.PackCategory,
		"decision":      d.Decision,
		"severity":      d.Severity,
		"risk_score":    d.RiskScore,
	}
}

func clickhouseRedTeamFactSink(ctx context.Context, client *http.Client, cfg config.ClickHouseConfig, rows []store.RedTeamDashboardRow) (int, error) {
	if cfg.URL == "" || cfg.RedTeamFactTable == "" || len(rows) == 0 {
		return 0, nil
	}
	var body bytes.Buffer
	for _, d := range rows {
		line, err := json.Marshal(redTeamFactRow(d))
		if err != nil {
			return 0, err
		}
		body.Write(line)
		body.WriteByte('\n')
	}
	table := cfg.RedTeamFactTable
	if cfg.Database != "" && !strings.Contains(table, ".") {
		table = cfg.Database + "." + table
	}
	q := "INSERT INTO " + table + " FORMAT JSONEachRow"
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	endpoint := cfg.URL + "/?query=" + url.QueryEscape(q) + "&date_time_input_format=best_effort"
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
		return 0, fmt.Errorf("clickhouse redteam fact insert failed: status %d", resp.StatusCode)
	}
	return len(rows), nil
}

// syncRedTeamFacts ships red-team case-result facts created since the stored watermark; first run
// backfills 7 days. Advances the "redteam_fact" watermark on success.
func (s *Server) syncRedTeamFacts(ctx context.Context) (int, error) {
	cfg := s.chConf()
	if cfg.URL == "" || cfg.RedTeamFactTable == "" {
		return 0, nil
	}
	since := time.Now().UTC().AddDate(0, 0, -7).Format(time.RFC3339Nano)
	if states, err := s.db.ListClickHouseSinkState(ctx); err == nil {
		for _, st := range states {
			if st.Dimension == "redteam_fact" && st.LastSyncedDay != "" {
				since = st.LastSyncedDay
			}
		}
	}
	rows, err := s.db.ListRedTeamCaseResultsSince(ctx, since, 5000)
	if err != nil {
		_ = s.db.RecordClickHouseSinkFailure(ctx, "redteam_fact", since, "result read: "+err.Error())
		return 0, err
	}
	if len(rows) == 0 {
		return 0, nil
	}
	n, err := clickhouseRedTeamFactSink(ctx, s.client, cfg, rows)
	if err != nil {
		_ = s.db.RecordClickHouseSinkFailure(ctx, "redteam_fact", since, err.Error())
		return 0, err
	}
	maxTS := rows[len(rows)-1].CreatedAt
	_ = s.db.RecordClickHouseSinkSuccess(ctx, "redteam_fact", maxTS, int64(n))
	return n, nil
}

// handleClickHouseRedTeamFact manually triggers the red-team fact sink.
// POST /admin/dw/redteam
func (s *Server) handleClickHouseRedTeamFact(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if s.chConf().URL == "" || s.chConf().RedTeamFactTable == "" {
		writeOpenAIError(w, http.StatusBadRequest, "fact sink not configured (CLICKHOUSE_URL + CLICKHOUSE_REDTEAM_FACT_TABLE)", "invalid_request_error", "no_fact_table")
		return
	}
	n, err := s.syncRedTeamFacts(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, "redteam fact sink failed: "+err.Error(), "server_error", "fact_sink_failed")
		return
	}
	s.auditAdmin(r, "dw.redteam_fact.sink", "", auditJSON(map[string]any{"rows": n}))
	writeJSON(w, http.StatusOK, map[string]any{"sent_rows": n, "table": s.chConf().RedTeamFactTable})
}
