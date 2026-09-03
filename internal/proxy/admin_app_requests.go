package proxy

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

type appRequestCursor struct {
	Version    int    `json:"v"`
	CreatedAt  string `json:"at"`
	RequestID  string `json:"id"`
	Direction  string `json:"direction"`
	FilterHash string `json:"filter"`
}

type appRequestItem struct {
	RequestID        string  `json:"request_id"`
	TraceID          string  `json:"trace_id"`
	SessionID        string  `json:"session_id"`
	APIKeyID         string  `json:"api_key_id"`
	IP               string  `json:"ip"`
	Method           string  `json:"method"`
	Model            string  `json:"model"`
	ProviderRef      string  `json:"provider_ref"`
	ProviderDisplay  string  `json:"provider_display"`
	Endpoint         string  `json:"endpoint"`
	Stream           bool    `json:"stream"`
	StatusCode       int     `json:"status_code"`
	LatencyMS        int64   `json:"latency_ms"`
	FirstChunkMS     int64   `json:"first_chunk_ms"`
	PromptTokens     int     `json:"prompt_tokens"`
	CompletionTokens int     `json:"completion_tokens"`
	TotalTokens      int     `json:"total_tokens"`
	CachedTokens     int     `json:"cached_tokens"`
	ReasoningTokens  int     `json:"reasoning_tokens"`
	EstimatedCost    float64 `json:"estimated_cost"`
	Currency         string  `json:"currency"`
	FinishReason     string  `json:"finish_reason"`
	CreatedAt        string  `json:"created_at"`
}

type appRequestsResponse struct {
	Requests       []appRequestItem `json:"requests"`
	Limit          int              `json:"limit"`
	NextCursor     string           `json:"next_cursor,omitempty"`
	PreviousCursor string           `json:"previous_cursor,omitempty"`
	GeneratedAt    string           `json:"generated_at"`
}

func singleAppRequestParam(values map[string][]string, key string, max int) (string, error) {
	all, ok := values[key]
	if !ok {
		return "", nil
	}
	if len(all) != 1 {
		return "", fmt.Errorf("%s must be provided once", key)
	}
	value := all[0]
	if strings.TrimSpace(value) != value || len(value) > max || strings.IndexFunc(value, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
		return "", fmt.Errorf("invalid %s", key)
	}
	return value, nil
}

func parseAppRequestBound(value string, loc *time.Location, endOfDay bool) (time.Time, error) {
	if value == "" {
		return time.Time{}, nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05", "2006-01-02T15:04", "2006-01-02 15:04:05", "2006-01-02 15:04"} {
		var parsed time.Time
		var err error
		if layout == time.RFC3339Nano || layout == time.RFC3339 {
			parsed, err = time.Parse(layout, value)
		} else {
			parsed, err = time.ParseInLocation(layout, value, loc)
		}
		if err == nil {
			return parsed, nil
		}
	}
	parsed, err := time.ParseInLocation("2006-01-02", value, loc)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid date-time")
	}
	if endOfDay {
		parsed = parsed.AddDate(0, 0, 1).Add(-time.Nanosecond)
	}
	return parsed, nil
}

func parseAppRequestStatus(value string, filter *store.AppRequestFilter) error {
	switch value {
	case "":
		return nil
	case "success":
		filter.StatusMin, filter.StatusMax = 200, 399
	case "error":
		filter.StatusMin, filter.StatusMax = 400, 599
	case "4xx":
		filter.StatusMin, filter.StatusMax = 400, 499
	case "5xx":
		filter.StatusMin, filter.StatusMax = 500, 599
	default:
		code, err := strconv.Atoi(value)
		if err != nil || code < 100 || code > 599 {
			return fmt.Errorf("invalid status")
		}
		filter.StatusCode = code
	}
	return nil
}

func appRequestFilterFingerprint(filter store.AppRequestFilter, providerRef string) string {
	teams := append([]string(nil), filter.Teams...)
	sort.Strings(teams)
	payload, _ := json.Marshal([]any{filter.Limit, filter.IP, filter.Model, providerRef, filter.RequestID,
		filter.TraceID, filter.SessionID, filter.APIKeyID, filter.Language, filter.StatusMin,
		filter.StatusMax, filter.StatusCode, teams, filter.TeamScoped,
		filter.From.UTC().Format(time.RFC3339Nano), filter.To.UTC().Format(time.RFC3339Nano)})
	digest := sha256.Sum256(payload)
	return base64.RawURLEncoding.EncodeToString(digest[:])
}

func (s *Server) encodeAppRequestCursor(cursor appRequestCursor) string {
	payload, _ := json.Marshal(cursor)
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	signature := strings.TrimPrefix(s.providerRef("request-page:"+encoded), providerRefPrefix)
	return encoded + "." + signature
}

func (s *Server) decodeAppRequestCursor(value, filterHash string) (appRequestCursor, error) {
	var cursor appRequestCursor
	parts := strings.Split(value, ".")
	if len(parts) != 2 || len(parts[0]) > 2048 || len(parts[1]) != 43 {
		return cursor, fmt.Errorf("invalid cursor")
	}
	want := strings.TrimPrefix(s.providerRef("request-page:"+parts[0]), providerRefPrefix)
	if subtle.ConstantTimeCompare([]byte(want), []byte(parts[1])) != 1 {
		return cursor, fmt.Errorf("invalid cursor")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || json.Unmarshal(payload, &cursor) != nil || cursor.Version != 1 ||
		(cursor.Direction != "older" && cursor.Direction != "newer") || cursor.RequestID == "" ||
		len(cursor.RequestID) > 512 || cursor.FilterHash != filterHash {
		return appRequestCursor{}, fmt.Errorf("invalid cursor")
	}
	if _, err := time.Parse(time.RFC3339Nano, cursor.CreatedAt); err != nil {
		return appRequestCursor{}, fmt.Errorf("invalid cursor")
	}
	return cursor, nil
}

func (s *Server) handleAppRequests(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "GET 요청만 허용됩니다.", "invalid_request_error", "method_not_allowed")
		return
	}
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	values := r.URL.Query()
	allowed := map[string]int{"limit": 3, "from": 64, "to": 64, "tz": 64, "status": 16,
		"model": 256, "provider_ref": providerRefLength, "request_id": 512, "trace_id": 512,
		"session_id": 512, "api_key_id": 512, "ip": 128, "language": 64, "cursor": 4096}
	params := map[string]string{}
	for key := range values {
		max, ok := allowed[key]
		if !ok {
			writeOpenAIError(w, http.StatusBadRequest, "지원하지 않는 필터입니다: "+key, "invalid_request_error", "invalid_requests_filter")
			return
		}
		value, err := singleAppRequestParam(values, key, max)
		if err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "필터 값이 올바르지 않습니다: "+key, "invalid_request_error", "invalid_requests_filter")
			return
		}
		params[key] = value
	}
	limit := 50
	if params["limit"] != "" {
		parsed, err := strconv.Atoi(params["limit"])
		if err != nil || parsed < 1 || parsed > 200 {
			writeOpenAIError(w, http.StatusBadRequest, "limit은 1~200이어야 합니다.", "invalid_request_error", "invalid_requests_limit")
			return
		}
		limit = parsed
	}
	loc := time.FixedZone("Asia/Seoul", 9*60*60)
	if params["tz"] != "" {
		var err error
		loc, err = time.LoadLocation(params["tz"])
		if err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "tz가 올바르지 않습니다.", "invalid_request_error", "invalid_requests_timezone")
			return
		}
	}
	from, fromErr := parseAppRequestBound(params["from"], loc, false)
	to, toErr := parseAppRequestBound(params["to"], loc, true)
	if fromErr != nil || toErr != nil || (!from.IsZero() && !to.IsZero() && to.Before(from)) {
		writeOpenAIError(w, http.StatusBadRequest, "조회 기간이 올바르지 않습니다.", "invalid_request_error", "invalid_requests_range")
		return
	}
	teams, teamScoped := requestTeamScopeForCaller(s, r)
	filter := store.AppRequestFilter{Limit: limit, IP: params["ip"], Model: params["model"],
		RequestID: params["request_id"], TraceID: params["trace_id"], SessionID: params["session_id"],
		APIKeyID: params["api_key_id"], Language: params["language"], Teams: teams,
		TeamScoped: teamScoped, From: from, To: to}
	if err := parseAppRequestStatus(params["status"], &filter); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "status가 올바르지 않습니다.", "invalid_request_error", "invalid_requests_status")
		return
	}
	providerRef := params["provider_ref"]
	refs := s.providerRefsSnapshot()
	if providerRef != "" {
		if len(providerRef) != providerRefLength || !strings.HasPrefix(providerRef, providerRefPrefix) {
			writeOpenAIError(w, http.StatusBadRequest, "provider_ref가 올바르지 않습니다.", "invalid_request_error", "invalid_provider_ref")
			return
		}
		providers, err := s.db.AppRequestProviderNames(r.Context(), teams, teamScoped)
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, "요청 공급자를 불러오지 못했습니다.", "server_error", "requests_failed")
			return
		}
		if len(providers) > 10_000 {
			providers = providers[:10_000]
		}
		found := false
		for _, provider := range providers {
			if subtle.ConstantTimeCompare([]byte(refs.physical(provider)), []byte(providerRef)) == 1 {
				filter.Provider, filter.ProviderSet, found = provider, true, true
				break
			}
		}
		if !found {
			writeOpenAIError(w, http.StatusBadRequest, "provider_ref가 올바르지 않습니다.", "invalid_request_error", "invalid_provider_ref")
			return
		}
	}
	fingerprint := appRequestFilterFingerprint(filter, providerRef)
	if params["cursor"] != "" {
		cursor, err := s.decodeAppRequestCursor(params["cursor"], fingerprint)
		if err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "cursor가 올바르지 않습니다.", "invalid_request_error", "invalid_requests_cursor")
			return
		}
		filter.CursorAt, filter.CursorID, filter.Direction = cursor.CreatedAt, cursor.RequestID, cursor.Direction
	}
	rows, hasMore, err := s.db.AppRecentRequests(r.Context(), filter)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "요청 목록을 불러오지 못했습니다.", "server_error", "requests_failed")
		return
	}
	response := appRequestsResponse{Requests: make([]appRequestItem, 0, len(rows)), Limit: limit, GeneratedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	for _, row := range rows {
		display := boundedModelsProviderLabelOrEmpty(row.Provider)
		if display == "" {
			display = "공급자 미확인"
		}
		response.Requests = append(response.Requests, appRequestItem{RequestID: row.RequestID, TraceID: row.TraceID,
			SessionID: row.SessionID, APIKeyID: row.APIKeyID, IP: row.IP, Method: row.Method, Model: row.Model,
			ProviderRef: refs.physical(row.Provider), ProviderDisplay: display, Endpoint: row.Endpoint,
			Stream: row.Stream, StatusCode: row.StatusCode, LatencyMS: row.LatencyMS, FirstChunkMS: row.FirstChunkMS,
			PromptTokens: row.PromptTokens, CompletionTokens: row.CompletionTokens, TotalTokens: row.TotalTokens,
			CachedTokens: row.CachedTokens, ReasoningTokens: row.ReasoningTokens, EstimatedCost: row.EstimatedCost,
			Currency: row.Currency, FinishReason: row.FinishReason, CreatedAt: row.CreatedAt})
	}
	if len(rows) > 0 {
		first, last := rows[0], rows[len(rows)-1]
		if params["cursor"] != "" && (filter.Direction == "older" || (filter.Direction == "newer" && hasMore)) {
			response.PreviousCursor = s.encodeAppRequestCursor(appRequestCursor{Version: 1, CreatedAt: first.CreatedAt, RequestID: first.RequestID, Direction: "newer", FilterHash: fingerprint})
		}
		if hasMore || filter.Direction == "newer" {
			response.NextCursor = s.encodeAppRequestCursor(appRequestCursor{Version: 1, CreatedAt: last.CreatedAt, RequestID: last.RequestID, Direction: "older", FilterHash: fingerprint})
		}
	}
	writeJSON(w, http.StatusOK, response)
}
