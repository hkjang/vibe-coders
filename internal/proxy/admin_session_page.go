package proxy

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

type sessionPageItem struct {
	RowKey      string  `json:"row_key"`
	SessionID   *string `json:"session_id"`
	Requests    int     `json:"requests"`
	FirstSeen   string  `json:"first_seen"`
	LastSeen    string  `json:"last_seen"`
	Models      int     `json:"models"`
	APIKeys     int     `json:"api_keys"`
	Errors      int     `json:"errors"`
	TotalTokens int     `json:"total_tokens"`
	CostKRW     float64 `json:"cost_krw"`
	LastMessage string  `json:"last_message"`
}
type sessionPageSummary struct {
	Sessions int64   `json:"sessions"`
	Requests int64   `json:"requests"`
	Errors   int64   `json:"errors"`
	Tokens   int64   `json:"total_tokens"`
	Cost     float64 `json:"cost_krw"`
}
type sessionPageResponse struct {
	Version  int                `json:"session_page_version"`
	Days     int                `json:"days"`
	Limit    int                `json:"limit"`
	Offset   int                `json:"offset"`
	From     string             `json:"from"`
	To       string             `json:"to"`
	Sessions []sessionPageItem  `json:"sessions"`
	Summary  sessionPageSummary `json:"summary"`
}

func (s *Server) handleSessionPage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, 401, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeOpenAIError(w, 405, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	bad := func() {
		writeOpenAIError(w, 400, "invalid session query", "invalid_request_error", "invalid_session_query")
	}
	q, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		bad()
		return
	}
	for key, values := range q {
		if len(values) != 1 || (key != "days" && key != "q" && key != "limit" && key != "offset") {
			bad()
			return
		}
	}
	days, limit, offset := 7, 25, 0
	for key, target := range map[string]*int{"days": &days, "limit": &limit, "offset": &offset} {
		if !q.Has(key) {
			continue
		}
		value, err := strconv.Atoi(q.Get(key))
		if err != nil || strconv.Itoa(value) != q.Get(key) {
			bad()
			return
		}
		*target = value
	}
	search := q.Get("q")
	if days < 1 || days > 365 || (limit != 25 && limit != 50 && limit != 100) || offset < 0 || offset > 1_000_000 || offset%limit != 0 || len(search) > 256 || (search != "" && !s.safeResourceSearchText(search)) {
		bad()
		return
	}
	fail := func() {
		writeOpenAIError(w, 500, "session page could not be loaded", "server_error", "session_page_failed")
	}
	teams, scoped, err := requestTeamScopeForCallerChecked(s, r)
	if err != nil {
		fail()
		return
	}
	until := time.Now().UTC()
	since := until.AddDate(0, 0, -days)
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	rows, total, err := s.db.SessionPage(ctx, store.SessionPageQuery{Since: since, Until: until, Search: search, Limit: limit, Offset: offset, Teams: teams, TeamScoped: scoped})
	countOK := func(n int64) bool { return n >= 0 && n <= appRequestMaxSafeInteger }
	costOK := func(n float64) bool { return !math.IsNaN(n) && !math.IsInf(n, 0) && n >= 0 && n <= appRequestMaxCost }
	if err != nil || !countOK(total.Sessions) || !countOK(total.Requests) || !countOK(total.Errors) || !countOK(total.Tokens) || !costOK(total.Cost) {
		fail()
		return
	}
	result := sessionPageResponse{Version: 1, Days: days, Limit: limit, Offset: offset, From: since.Format(time.RFC3339Nano), To: until.Format(time.RFC3339Nano), Sessions: []sessionPageItem{}, Summary: sessionPageSummary{total.Sessions, total.Requests, total.Errors, total.Tokens, total.Cost}}
	projection := s.externalCredentialProjectionArgs()
	for index, row := range rows {
		for _, n := range []int{row.Requests, row.Models, row.APIKeys, row.Errors, row.TotalTokens} {
			if !countOK(int64(n)) {
				fail()
				return
			}
		}
		if !costOK(row.CostKRW) {
			fail()
			return
		}
		reference := "id:" + row.SessionID
		if row.SessionID == "" {
			reference = fmt.Sprintf("omitted:%d", offset+index)
		}
		item := sessionPageItem{RowKey: "session_" + s.secrets.Load().OpaqueReference("session-page", reference), Requests: row.Requests, FirstSeen: row.FirstSeen, LastSeen: row.LastSeen, Models: row.Models, APIKeys: row.APIKeys, Errors: row.Errors, TotalTokens: row.TotalTokens, CostKRW: row.CostKRW}
		if len(row.SessionID) <= 1024 && !strings.Contains(row.SessionID, "/") && s.safeResourceSearchText(row.SessionID) {
			value := row.SessionID
			item.SessionID = &value
		}
		// Always project stored redacted text, including for raw-prompt admins. Mask
		// before truncating so a credential cannot be cut into an unrecognized fragment.
		preview := []rune(strings.Join(strings.Fields(audit.Redact(boundedExternalProviderText(row.LastMessage, projection...))), " "))
		if len(preview) > 160 {
			// The ellipsis is part of the 160-code-point response contract.
			item.LastMessage = string(preview[:159]) + "…"
		} else {
			item.LastMessage = string(preview)
		}
		result.Sessions = append(result.Sessions, item)
	}
	writeJSON(w, 200, result)
}
