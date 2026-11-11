package proxy

import (
	"encoding/csv"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

func (s *Server) handleExportCSV(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	teams, teamScoped, scopeErr := requestTeamScopeForCallerChecked(s, r)
	if scopeErr != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "prompt export scope could not be resolved", "server_error", "prompt_scope_failed")
		return
	}
	limit := exportLimit(r)
	filter := store.PromptSearch{
		Keyword:            strings.TrimSpace(r.URL.Query().Get("q")),
		APIKeyID:           strings.TrimSpace(r.URL.Query().Get("api_key_id")),
		IP:                 strings.TrimSpace(r.URL.Query().Get("ip")),
		Language:           strings.TrimSpace(r.URL.Query().Get("language")),
		Since:              strings.TrimSpace(r.URL.Query().Get("since")),
		Limit:              limit,
		Teams:              teams,
		TeamScoped:         teamScoped,
		SearchRedactedOnly: !s.canViewRawPrompts(r),
	}
	rows, err := s.db.SearchPrompts(r.Context(), filter)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "prompt export could not be completed", "server_error", "export_failed")
		return
	}
	s.maskRecentRequests(r, rows)

	stamp := time.Now().UTC().Format("20060102-150405")
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=requests-%s.csv", stamp))

	// BOM so Excel opens UTF-8 CSV with Korean text correctly.
	_, _ = w.Write([]byte{0xEF, 0xBB, 0xBF})

	wr := csv.NewWriter(w)
	_ = wr.Write([]string{
		"created_at", "trace_id", "request_id", "endpoint", "provider", "model",
		"api_key_id", "client_ip", "status_code", "first_chunk_ms", "latency_ms",
		"prompt_tokens", "completion_tokens", "cached_tokens", "reasoning_tokens", "total_tokens",
		"cost_krw", "token_source", "stream", "languages", "error",
	})
	for _, row := range rows {
		languages := make([]string, 0, len(row.Languages))
		for _, l := range row.Languages {
			languages = append(languages, l.Language)
		}
		_ = wr.Write([]string{
			csvTextCell(row.CreatedAt),
			csvTextCell(row.TraceID),
			csvTextCell(row.ID),
			csvTextCell(row.Endpoint),
			csvTextCell(row.Provider),
			csvTextCell(row.Model),
			csvTextCell(row.APIKeyID),
			csvTextCell(row.ClientIP),
			strconv.Itoa(row.StatusCode),
			strconv.FormatInt(row.FirstChunkMS, 10),
			strconv.FormatInt(row.LatencyMS, 10),
			strconv.Itoa(row.PromptTokens),
			strconv.Itoa(row.CompletionTokens),
			strconv.Itoa(row.CachedTokens),
			strconv.Itoa(row.ReasoningTokens),
			strconv.Itoa(row.TotalTokens),
			strconv.FormatFloat(row.EstimatedCost, 'f', 2, 64),
			csvTextCell(row.TokenSource),
			strconv.FormatBool(row.Stream),
			csvTextCell(strings.Join(languages, "|")),
			csvTextCell(row.Error),
		})
	}
	wr.Flush()
}

func exportLimit(r *http.Request) int {
	value := strings.TrimSpace(r.URL.Query().Get("limit"))
	if value == "" {
		return 1000
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return 1000
	}
	if parsed > 10000 {
		return 10000
	}
	return parsed
}
