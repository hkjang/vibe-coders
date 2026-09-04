package proxy

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"vibe-coders/internal/store"
)

const (
	appRequestValueRedacted   = "[값 비공개]"
	appRequestValueOmitted    = "[값 생략]"
	appRequestProviderOmitted = "공급자 이름 비공개"

	appRequestIDMaxBytes           = 512
	appRequestIPMaxBytes           = 128
	appRequestMethodMaxBytes       = 32
	appRequestModelMaxBytes        = 256
	appRequestProviderMaxBytes     = 256
	appRequestEndpointMaxBytes     = 512
	appRequestCurrencyMaxBytes     = 16
	appRequestFinishReasonMaxBytes = 256
	appRequestMaxCount             = 2_147_483_647
	appRequestMaxSafeInteger       = int64(1<<53 - 1)
	appRequestMaxCost              = 1_000_000_000_000_000.0
	appRequestTimestampLayout      = "2006-01-02T15:04:05.000000000Z"
	appRequestCursorMaxBytes       = 4096
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

func (s *Server) encodeAppRequestCursor(cursor appRequestCursor) (string, error) {
	return s.appRequestCursorEncoderSnapshot()(cursor)
}

func (s *Server) appRequestCursorEncoderSnapshot() func(appRequestCursor) (string, error) {
	cipher := s.secrets.Load()
	return func(cursor appRequestCursor) (string, error) {
		if err := normalizeAppRequestCursor(&cursor); err != nil {
			return "", err
		}
		payload, _ := json.Marshal(cursor)
		sealed, err := cipher.Encrypt(string(payload))
		if err != nil {
			return "", fmt.Errorf("encrypt app request cursor: %w", err)
		}
		encoded := base64.RawURLEncoding.EncodeToString([]byte(sealed))
		signature := cipher.OpaqueReference("app-request-page-signature", "request-page:"+encoded)
		result := encoded + "." + signature
		if len(result) > appRequestCursorMaxBytes {
			return "", fmt.Errorf("app request cursor exceeds encoded limit")
		}
		return result, nil
	}
}

func (s *Server) decodeAppRequestCursor(value, filterHash string) (appRequestCursor, error) {
	var cursor appRequestCursor
	parts := strings.Split(value, ".")
	if len(value) > appRequestCursorMaxBytes || len(parts) != 2 || len(parts[1]) != 43 {
		return cursor, fmt.Errorf("invalid cursor")
	}
	cipher := s.secrets.Load()
	want := cipher.OpaqueReference("app-request-page-signature", "request-page:"+parts[0])
	if subtle.ConstantTimeCompare([]byte(want), []byte(parts[1])) != 1 {
		return cursor, fmt.Errorf("invalid cursor")
	}
	sealed, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return cursor, fmt.Errorf("invalid cursor")
	}
	payload, err := cipher.Decrypt(string(sealed))
	if err != nil || json.Unmarshal([]byte(payload), &cursor) != nil || cursor.FilterHash != filterHash {
		return appRequestCursor{}, fmt.Errorf("invalid cursor")
	}
	if err := normalizeAppRequestCursor(&cursor); err != nil {
		return appRequestCursor{}, fmt.Errorf("invalid cursor")
	}
	return cursor, nil
}

func normalizeAppRequestCursor(cursor *appRequestCursor) error {
	if cursor.Version != 1 || (cursor.Direction != "older" && cursor.Direction != "newer") ||
		cursor.RequestID == "" || len(cursor.RequestID) > appRequestIDMaxBytes ||
		strings.ToValidUTF8(cursor.RequestID, "") != cursor.RequestID ||
		strings.IndexFunc(cursor.RequestID, unicode.IsControl) >= 0 || len(cursor.FilterHash) != 43 {
		return fmt.Errorf("invalid app request cursor fields")
	}
	parsedAt, err := time.Parse(time.RFC3339Nano, cursor.CreatedAt)
	if err != nil {
		return fmt.Errorf("invalid app request cursor time: %w", err)
	}
	cursor.CreatedAt = parsedAt.UTC().Format(appRequestTimestampLayout)
	return nil
}

func (s *Server) appRequestTextHasCredential(value string) bool {
	if providerURLComponentHasCredential(value) {
		return true
	}
	lower := strings.ToLower(value)
	if strings.Contains(lower, "vc_sk_") || strings.Contains(lower, "vc_sa_") {
		return true
	}
	for _, prefix := range []string{s.cfg.Auth.APIKeyPrefix, s.cfg.Auth.ServiceKeyPrefix} {
		if len(prefix) >= 4 && strings.Contains(value, prefix) {
			return true
		}
	}
	return false
}

func (s *Server) projectAppRequestText(value string, maxBytes int) string {
	if len(value) > maxBytes {
		// Inspect only the bounded prefix before omitting an oversized value. This
		// preserves the explicit redaction signal for normal key prefixes without
		// allowing an attacker-controlled database value to trigger unbounded URL
		// decoding or regular-expression work.
		probe := strings.ToValidUTF8(value[:maxBytes], "")
		if s.appRequestTextHasCredential(probe) {
			return appRequestValueRedacted
		}
		return appRequestValueOmitted
	}
	value = strings.ToValidUTF8(value, "�")
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return '�'
		}
		return r
	}, value)
	if len(value) > maxBytes {
		return appRequestValueOmitted
	}
	if s.appRequestTextHasCredential(value) {
		return appRequestValueRedacted
	}
	return value
}

func clampAppRequestInt(value int) int {
	if value < 0 {
		return 0
	}
	if value > appRequestMaxCount {
		return appRequestMaxCount
	}
	return value
}

func clampAppRequestInt64(value int64) int64 {
	if value < 0 {
		return 0
	}
	if value > appRequestMaxSafeInteger {
		return appRequestMaxSafeInteger
	}
	return value
}

func clampAppRequestStatus(value int) int {
	if value < 0 || value > 999 {
		return 0
	}
	return value
}

func clampAppRequestCost(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
		return 0
	}
	if value > appRequestMaxCost {
		return appRequestMaxCost
	}
	return value
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
			writeOpenAIError(w, http.StatusBadRequest, "지원하지 않는 요청 필터입니다.", "invalid_request_error", "invalid_requests_filter")
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
	teams, teamScoped, err := requestTeamScopeForCallerChecked(s, r)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "요청 목록을 불러오지 못했습니다.", "server_error", "requests_failed")
		return
	}
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
		providers, unsafeOrTruncated, err := s.db.AppRequestProviderCandidates(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, "요청 공급자를 불러오지 못했습니다.", "server_error", "requests_failed")
			return
		}
		if unsafeOrTruncated {
			writeOpenAIError(w, http.StatusBadRequest, "provider_ref가 올바르지 않습니다.", "invalid_request_error", "invalid_provider_ref")
			return
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
		providerRefValue := refs.physical(row.Provider)
		if display == "" {
			display = "공급자 미확인"
		} else if len(row.Provider) > appRequestProviderMaxBytes {
			display = appRequestProviderOmitted
			providerRefValue = refs.system("request-provider-omitted")
		} else if display == providerNameOmitted || s.appRequestTextHasCredential(row.Provider) {
			display = appRequestProviderOmitted
		}
		response.Requests = append(response.Requests, appRequestItem{
			RequestID:        s.projectAppRequestText(row.RequestID, appRequestIDMaxBytes),
			TraceID:          s.projectAppRequestText(row.TraceID, appRequestIDMaxBytes),
			SessionID:        s.projectAppRequestText(row.SessionID, appRequestIDMaxBytes),
			APIKeyID:         s.projectAppRequestText(row.APIKeyID, appRequestIDMaxBytes),
			IP:               s.projectAppRequestText(row.IP, appRequestIPMaxBytes),
			Method:           s.projectAppRequestText(row.Method, appRequestMethodMaxBytes),
			Model:            s.projectAppRequestText(row.Model, appRequestModelMaxBytes),
			ProviderRef:      providerRefValue,
			ProviderDisplay:  display,
			Endpoint:         s.projectAppRequestText(row.Endpoint, appRequestEndpointMaxBytes),
			Stream:           row.Stream,
			StatusCode:       clampAppRequestStatus(row.StatusCode),
			LatencyMS:        clampAppRequestInt64(row.LatencyMS),
			FirstChunkMS:     clampAppRequestInt64(row.FirstChunkMS),
			PromptTokens:     clampAppRequestInt(row.PromptTokens),
			CompletionTokens: clampAppRequestInt(row.CompletionTokens),
			TotalTokens:      clampAppRequestInt(row.TotalTokens),
			CachedTokens:     clampAppRequestInt(row.CachedTokens),
			ReasoningTokens:  clampAppRequestInt(row.ReasoningTokens),
			EstimatedCost:    clampAppRequestCost(row.EstimatedCost),
			Currency:         s.projectAppRequestText(row.Currency, appRequestCurrencyMaxBytes),
			FinishReason:     s.projectAppRequestText(row.FinishReason, appRequestFinishReasonMaxBytes),
			CreatedAt:        row.CreatedAt,
		})
	}
	if len(rows) > 0 {
		first, last := rows[0], rows[len(rows)-1]
		encodeCursor := s.appRequestCursorEncoderSnapshot()
		if params["cursor"] != "" && (filter.Direction == "older" || (filter.Direction == "newer" && hasMore)) {
			response.PreviousCursor, err = encodeCursor(appRequestCursor{Version: 1, CreatedAt: first.CreatedAt, RequestID: first.RequestID, Direction: "newer", FilterHash: fingerprint})
			if err != nil {
				writeOpenAIError(w, http.StatusInternalServerError, "요청 페이지 정보를 만들지 못했습니다.", "server_error", "requests_cursor_failed")
				return
			}
		}
		if hasMore || filter.Direction == "newer" {
			response.NextCursor, err = encodeCursor(appRequestCursor{Version: 1, CreatedAt: last.CreatedAt, RequestID: last.RequestID, Direction: "older", FilterHash: fingerprint})
			if err != nil {
				writeOpenAIError(w, http.StatusInternalServerError, "요청 페이지 정보를 만들지 못했습니다.", "server_error", "requests_cursor_failed")
				return
			}
		}
	}
	writeJSON(w, http.StatusOK, response)
}
