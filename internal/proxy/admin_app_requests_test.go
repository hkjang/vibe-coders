package proxy

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/secret"
	"vibe-coders/internal/store"
)

func insertAppRequestTestRow(t *testing.T, db *store.SQLStore, id, provider string, status int, createdAt time.Time) {
	insertAppRequestTestRowWithIP(t, db, id, provider, status, "192.0.2.10", createdAt)
}

func insertAppRequestTestRowWithIP(t *testing.T, db *store.SQLStore, id, provider string, status int, clientIP string, createdAt time.Time) {
	t.Helper()
	err := db.InsertLogRecord(t.Context(), store.LogRecord{Request: store.RequestLog{
		ID: id, TraceID: "trace-" + id, APIKeyID: "key-" + id, Method: http.MethodPost,
		ClientIP: clientIP, UserAgent: "raw-secret-user-agent", Model: "test-model",
		Endpoint: "/v1/chat/completions", Provider: provider, StatusCode: status,
		LatencyMS: 123, Error: "raw-secret-provider-error", SessionID: "session-" + id,
		CreatedAt: createdAt,
	}, Usage: &store.TokenUsage{ID: "usage-" + id, RequestID: id, PromptTokens: 3,
		CompletionTokens: 4, TotalTokens: 7, EstimatedCost: 1.25, Currency: "KRW", CreatedAt: createdAt}})
	if err != nil {
		t.Fatal(err)
	}
}

func TestAppRequestsIPFilterPreservesValidLegacySpelling(t *testing.T) {
	_, db, gateway := newAdminModelsTestServer(t, "")
	legacyIP := "2001:0db8::1"
	canonicalIP := "2001:db8::1"
	createdAt := time.Date(2026, 9, 4, 1, 2, 3, 0, time.UTC)
	insertAppRequestTestRowWithIP(t, db, "req-legacy-ip", "provider-a", http.StatusOK, legacyIP, createdAt)
	insertAppRequestTestRowWithIP(t, db, "req-canonical-ip", "provider-a", http.StatusOK, canonicalIP, createdAt.Add(-time.Second))

	legacy := readAppRequestPage(t, providerAppRequest(t, http.MethodGet,
		gateway.URL+"/admin/requests?ip="+url.QueryEscape(legacyIP), nil))
	if len(legacy.Requests) != 1 || legacy.Requests[0].RequestID != "req-legacy-ip" || legacy.Requests[0].IP != legacyIP {
		t.Fatalf("legacy IPv6 filter = %+v", legacy)
	}

	canonical := readAppRequestPage(t, providerAppRequest(t, http.MethodGet,
		gateway.URL+"/admin/requests?ip="+url.QueryEscape(canonicalIP), nil))
	if len(canonical.Requests) != 1 || canonical.Requests[0].RequestID != "req-canonical-ip" || canonical.Requests[0].IP != canonicalIP {
		t.Fatalf("canonical IPv6 filter = %+v", canonical)
	}
}

func TestAppRequestsContractNegotiationPreservesRollingCompatibility(t *testing.T) {
	_, db, gateway := newAdminModelsTestServer(t, "")
	createdAt := time.Date(2026, 9, 4, 1, 2, 3, 0, time.UTC)
	insertAppRequestTestRow(t, db, "req-compatible", "provider-a", http.StatusOK, createdAt)
	insertAppRequestTestRow(t, db, "req-compatible-older", "provider-a", http.StatusOK, createdAt.Add(-time.Second))

	requestPage := func(testingT *testing.T, values ...string) (*http.Response, []byte) {
		testingT.Helper()
		request, err := http.NewRequest(http.MethodGet, gateway.URL+"/admin/requests?limit=1", nil)
		if err != nil {
			testingT.Fatal(err)
		}
		request.Header.Set("X-Vibe-UI", "app")
		for _, value := range values {
			request.Header.Add(appRequestContractHeader, value)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			testingT.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			testingT.Fatal(err)
		}
		return response, body
	}
	assertFieldSet := func(testingT *testing.T, label string, body []byte, want []string) {
		testingT.Helper()
		var envelope map[string]json.RawMessage
		if err := json.Unmarshal(body, &envelope); err != nil {
			testingT.Fatalf("%s response decode=%v body=%s", label, err, body)
		}
		for _, field := range []string{"requests", "limit", "next_cursor", "generated_at"} {
			if _, exists := envelope[field]; !exists {
				testingT.Fatalf("%s response omitted top-level %s: %s", label, field, body)
			}
		}
		if len(envelope) != 4 {
			testingT.Fatalf("%s top-level fields=%v body=%s", label, envelope, body)
		}
		var requests []map[string]json.RawMessage
		if err := json.Unmarshal(envelope["requests"], &requests); err != nil || len(requests) != 1 {
			testingT.Fatalf("%s requests decode=%v requests=%v body=%s", label, err, requests, body)
		}
		if len(requests[0]) != len(want) {
			testingT.Fatalf("%s fields=%v want=%v body=%s", label, requests[0], want, body)
		}
		for _, field := range want {
			if _, exists := requests[0][field]; !exists {
				testingT.Fatalf("%s response omitted %s: %s", label, field, body)
			}
		}
	}
	v1Fields := []string{"request_id", "trace_id", "session_id", "api_key_id", "ip", "method", "model",
		"provider_ref", "provider_display", "endpoint", "stream", "status_code", "latency_ms", "first_chunk_ms",
		"prompt_tokens", "completion_tokens", "total_tokens", "cached_tokens", "reasoning_tokens", "estimated_cost",
		"currency", "finish_reason", "created_at"}
	v2Fields := append(append([]string{}, v1Fields...), "request_ref", "request_filterable", "trace_filterable")

	for _, test := range []struct {
		name   string
		values []string
		want   string
		fields []string
	}{
		{name: "header omitted", want: appRequestContractV1, fields: v1Fields},
		{name: "explicit v1", values: []string{appRequestContractV1}, want: appRequestContractV1, fields: v1Fields},
		{name: "explicit v2", values: []string{appRequestContractV2}, want: appRequestContractV2, fields: v2Fields},
	} {
		t.Run(test.name, func(t *testing.T) {
			response, body := requestPage(t, test.values...)
			if response.StatusCode != http.StatusOK || response.Header.Get(appRequestContractHeader) != test.want {
				t.Fatalf("negotiation status=%d headers=%v body=%s", response.StatusCode, response.Header, body)
			}
			if !headerListContains(response.Header.Values("Vary"), "X-Vibe-UI") ||
				!headerListContains(response.Header.Values("Vary"), appRequestContractHeader) {
				t.Fatalf("request contract cache boundary missing: %v", response.Header)
			}
			assertFieldSet(t, test.name, body, test.fields)
		})
	}

	for _, test := range []struct {
		name   string
		values []string
	}{
		{name: "empty", values: []string{""}},
		{name: "unsupported", values: []string{"3"}},
		{name: "combined", values: []string{"1, 2"}},
		{name: "duplicate", values: []string{"1", "2"}},
	} {
		t.Run("invalid "+test.name, func(t *testing.T) {
			response, body := requestPage(t, test.values...)
			if response.StatusCode != http.StatusBadRequest || response.Header.Get(appRequestContractHeader) != "" {
				t.Fatalf("invalid contract status=%d headers=%v body=%s", response.StatusCode, response.Header, body)
			}
			var envelope struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			if err := json.Unmarshal(body, &envelope); err != nil || envelope.Error.Code != "invalid_requests_contract" {
				t.Fatalf("invalid contract response=%s decode=%v", body, err)
			}
		})
	}

	legacyRequest, err := http.NewRequest(http.MethodGet, gateway.URL+"/admin/requests?limit=1", nil)
	if err != nil {
		t.Fatal(err)
	}
	legacyRequest.Header.Set(appRequestContractHeader, appRequestContractV2)
	legacyResponse, err := http.DefaultClient.Do(legacyRequest)
	if err != nil {
		t.Fatal(err)
	}
	legacyBody, err := io.ReadAll(legacyResponse.Body)
	legacyResponse.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if legacyResponse.StatusCode != http.StatusOK || legacyResponse.Header.Get(appRequestContractHeader) != "" ||
		!strings.Contains(string(legacyBody), `"user_agent"`) {
		t.Fatalf("legacy caller contract changed: status=%d headers=%v body=%s", legacyResponse.StatusCode, legacyResponse.Header, legacyBody)
	}
}

func TestAppRequestCredentialProjectionUsesHistoricalPrefixes(t *testing.T) {
	server := &Server{cfg: config.Config{Auth: config.AuthConfig{
		APIKeyPrefix: "corp_", ServiceKeyPrefix: "svc_",
		HistoricalKeyPrefixes: []string{"legacy"},
	}}}
	oldKey := "legacy" + strings.Repeat("A", 43)
	if !server.appRequestTextHasCredential(oldKey) {
		t.Fatal("historical generated key was not detected")
	}
	if got := server.projectAppRequestText(oldKey, appRequestIDMaxBytes); got != appRequestValueRedacted {
		t.Fatalf("historical generated key projection = %q", got)
	}
	if server.appRequestTextHasCredential("model-" + strings.Repeat("A", 43)) {
		t.Fatal("ordinary long model identifier was treated as a credential")
	}
	for name, test := range map[string]struct {
		raw       string
		projected string
		want      bool
	}{
		"safe":               {raw: "req-safe", projected: "req-safe", want: true},
		"empty":              {raw: "", projected: "", want: false},
		"leading space":      {raw: " req-safe", projected: " req-safe", want: false},
		"trailing space":     {raw: "req-safe ", projected: "req-safe ", want: false},
		"changed projection": {raw: oldKey, projected: appRequestValueRedacted, want: false},
	} {
		t.Run(name, func(t *testing.T) {
			if got := appRequestTextFilterable(test.raw, test.projected); got != test.want {
				t.Fatalf("appRequestTextFilterable(%q, %q) = %v, want %v", test.raw, test.projected, got, test.want)
			}
		})
	}
}

func TestAppRequestsUseDistinctOpaqueRefsForProjectedIdentifiers(t *testing.T) {
	server, db, gateway := newAdminModelsTestServer(t, "")
	requestA := "vc_sk_" + strings.Repeat("a", 43)
	requestB := "vc_sk_" + strings.Repeat("b", 43)
	createdAt := time.Date(2026, 9, 4, 1, 2, 3, 0, time.UTC)
	insertAppRequestTestRow(t, db, requestA, "provider-a", http.StatusOK, createdAt)
	insertAppRequestTestRow(t, db, requestB, "provider-a", http.StatusOK, createdAt.Add(-time.Second))

	page := readAppRequestPage(t, providerAppRequest(t, http.MethodGet, gateway.URL+"/admin/requests?limit=2", nil))
	if len(page.Requests) != 2 {
		t.Fatalf("projected request page = %+v", page)
	}
	refs := make(map[string]bool, len(page.Requests))
	for _, item := range page.Requests {
		if item.RequestID != appRequestValueRedacted || item.RequestFilterable {
			t.Fatalf("credential-shaped request ID remained filterable: %+v", item)
		}
		if item.TraceID != appRequestValueRedacted || item.TraceFilterable {
			t.Fatalf("credential-shaped trace ID remained filterable: %+v", item)
		}
		if matched := regexp.MustCompile(`^req_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{21}$`).MatchString(item.RequestRef); len(item.RequestRef) != appRequestRefLength || !matched {
			t.Fatalf("opaque request ref has invalid shape: %q", item.RequestRef)
		}
		refs[item.RequestRef] = true
	}
	if len(refs) != 2 {
		t.Fatalf("distinct projected request IDs shared an opaque ref: %+v", page.Requests)
	}
	ref := server.appRequestRefSnapshot()
	if !refs[ref(requestA)] || !refs[ref(requestB)] || ref(requestA) == server.providerRef(requestA) {
		t.Fatalf("request refs are unstable or share the Provider namespace: %+v", refs)
	}
}

func readAppRequestPage(t *testing.T, response *http.Response) appRequestsResponse {
	t.Helper()
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	var page appRequestsResponse
	if err := json.Unmarshal(body, &page); err != nil {
		t.Fatal(err)
	}
	return page
}

func TestAppRequestsSafeProjectionAndStableCursor(t *testing.T) {
	server, db, gateway := newAdminModelsTestServer(t, "")
	unsafeProvider := "sk-ant-request-provider-secret"
	if err := db.UpsertProvider(t.Context(), store.ProviderConfig{
		Name: unsafeProvider, BaseURL: "https://provider.invalid", Enabled: false,
	}); err != nil {
		t.Fatal(err)
	}
	tiedAt := time.Date(2026, 9, 3, 1, 2, 3, 456, time.UTC)
	insertAppRequestTestRow(t, db, "req-a", unsafeProvider, 200, tiedAt)
	insertAppRequestTestRow(t, db, "req-c", unsafeProvider, 200, tiedAt)
	insertAppRequestTestRow(t, db, "req-b", unsafeProvider, 500, tiedAt)

	legacy, err := http.Get(gateway.URL + "/admin/requests?limit=1")
	if err != nil {
		t.Fatal(err)
	}
	legacyBody, _ := io.ReadAll(legacy.Body)
	legacy.Body.Close()
	if legacy.StatusCode != http.StatusOK || !strings.Contains(string(legacyBody), unsafeProvider) ||
		!strings.Contains(string(legacyBody), `"user_agent"`) || !strings.Contains(string(legacyBody), `"error"`) {
		t.Fatalf("legacy response contract changed: status=%d body=%s", legacy.StatusCode, legacyBody)
	}
	if legacy.Header.Get("Cache-Control") != "no-store" || !strings.Contains(legacy.Header.Get("Vary"), "X-Vibe-UI") {
		t.Fatalf("legacy variant cache headers missing: %v", legacy.Header)
	}

	firstResponse := providerAppRequest(t, http.MethodGet, gateway.URL+"/admin/requests?limit=1", nil)
	firstBody, _ := io.ReadAll(firstResponse.Body)
	firstResponse.Body.Close()
	if firstResponse.StatusCode != http.StatusOK {
		t.Fatalf("status=%d body=%s", firstResponse.StatusCode, firstBody)
	}
	if firstResponse.Header.Get(appRequestContractHeader) != appRequestContractV2 ||
		!headerListContains(firstResponse.Header.Values("Vary"), appRequestContractHeader) {
		t.Fatalf("v2 request contract headers missing: %v", firstResponse.Header)
	}
	visible := string(firstBody)
	for _, forbidden := range []string{unsafeProvider, "raw-secret-user-agent", "raw-secret-provider-error", `"user_agent"`, `"error"`, `"prompts"`} {
		if strings.Contains(visible, forbidden) {
			t.Fatalf("app request projection leaked %q: %s", forbidden, visible)
		}
	}
	if !strings.Contains(visible, appRequestProviderOmitted) || !strings.Contains(visible, server.providerRef(unsafeProvider)) {
		t.Fatalf("safe provider identity missing: %s", visible)
	}
	var first appRequestsResponse
	if err := json.Unmarshal(firstBody, &first); err != nil {
		t.Fatal(err)
	}
	if len(first.Requests) != 1 || first.Requests[0].RequestID != "req-c" || first.NextCursor == "" || first.PreviousCursor != "" {
		t.Fatalf("first page = %+v", first)
	}
	if first.Requests[0].RequestRef != server.appRequestRefSnapshot()("req-c") ||
		!first.Requests[0].RequestFilterable || !first.Requests[0].TraceFilterable {
		t.Fatalf("safe request identity contract = %+v", first.Requests[0])
	}
	sealedCursor, err := base64.RawURLEncoding.DecodeString(strings.Split(first.NextCursor, ".")[0])
	if err != nil || strings.Contains(string(sealedCursor), "req-c") {
		t.Fatalf("cursor exposed its keyset identity: %q err=%v", sealedCursor, err)
	}
	maxCursorID := strings.Repeat("x", appRequestIDMaxBytes)
	maxCursor, err := server.encodeAppRequestCursor(appRequestCursor{
		Version: 1, CreatedAt: tiedAt.Format(time.RFC3339Nano), RequestID: maxCursorID,
		Direction: "older", FilterHash: strings.Repeat("f", 43),
	})
	if err != nil || len(maxCursor) > appRequestCursorMaxBytes {
		t.Fatalf("maximum cursor length=%d err=%v", len(maxCursor), err)
	}
	decodedMax, err := server.decodeAppRequestCursor(maxCursor, strings.Repeat("f", 43))
	if err != nil || decodedMax.RequestID != maxCursorID {
		t.Fatalf("maximum cursor round trip id=%d err=%v", len(decodedMax.RequestID), err)
	}

	second := readAppRequestPage(t, providerAppRequest(t, http.MethodGet, gateway.URL+"/admin/requests?limit=1&cursor="+url.QueryEscape(first.NextCursor), nil))
	if len(second.Requests) != 1 || second.Requests[0].RequestID != "req-b" || second.NextCursor == "" || second.PreviousCursor == "" {
		t.Fatalf("second page = %+v", second)
	}
	previous := readAppRequestPage(t, providerAppRequest(t, http.MethodGet, gateway.URL+"/admin/requests?limit=1&cursor="+url.QueryEscape(second.PreviousCursor), nil))
	if len(previous.Requests) != 1 || previous.Requests[0].RequestID != "req-c" || previous.PreviousCursor != "" {
		t.Fatalf("previous page = %+v", previous)
	}

	filtered := readAppRequestPage(t, providerAppRequest(t, http.MethodGet, gateway.URL+"/admin/requests?status=error&provider_ref="+url.QueryEscape(server.providerRef(unsafeProvider)), nil))
	if len(filtered.Requests) != 1 || filtered.Requests[0].RequestID != "req-b" {
		t.Fatalf("filtered page = %+v", filtered)
	}

	for name, requestURL := range map[string]string{
		"tampered":     gateway.URL + "/admin/requests?limit=1&cursor=" + url.QueryEscape(first.NextCursor[:len(first.NextCursor)-1]+"x"),
		"other filter": gateway.URL + "/admin/requests?limit=1&status=error&cursor=" + url.QueryEscape(first.NextCursor),
		"invalid ref":  gateway.URL + "/admin/requests?provider_ref=prv_" + strings.Repeat("a", 43),
		"unconfigured provider": gateway.URL + "/admin/requests?provider_ref=" +
			url.QueryEscape(server.providerRef("provider-found-only-in-request-logs")),
	} {
		t.Run(name, func(t *testing.T) {
			response := providerAppRequest(t, http.MethodGet, requestURL, nil)
			defer response.Body.Close()
			if response.StatusCode != http.StatusBadRequest {
				body, _ := io.ReadAll(response.Body)
				t.Fatalf("status=%d body=%s", response.StatusCode, body)
			}
		})
	}

	rotated, err := secret.New("rotated-request-cursor-secret")
	if err != nil {
		t.Fatal(err)
	}
	server.secrets.Store(rotated)
	stale := providerAppRequest(t, http.MethodGet, gateway.URL+"/admin/requests?limit=1&cursor="+url.QueryEscape(first.NextCursor), nil)
	defer stale.Body.Close()
	if stale.StatusCode != http.StatusBadRequest {
		body, _ := io.ReadAll(stale.Body)
		t.Fatalf("rotated-secret cursor status=%d body=%s", stale.StatusCode, body)
	}
}

func TestAppRequestsProjectionBoundsAndRedactsUntrustedMetadata(t *testing.T) {
	_, db, gateway := newAdminModelsTestServer(t, "")
	provider := "configured-provider"
	if err := db.UpsertProvider(t.Context(), store.ProviderConfig{
		Name: provider, BaseURL: "https://provider.invalid", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	apiSecret := "vc_sk_" + strings.Repeat("s", 43)
	serviceSecret := "vc_sa_" + strings.Repeat("a", 43)
	currencyPII := "owner@evil.co"
	jwToken := "eyJabcde.eyJfghij.abcdefgh"
	huge := strings.Repeat("가", 300)
	now := time.Date(2026, 9, 3, 1, 2, 3, 0, time.UTC)
	maxDBInt := int(math.MaxInt32)
	if err := db.InsertLogRecord(t.Context(), store.LogRecord{
		Request: store.RequestLog{
			ID: "req-untrusted", TraceID: apiSecret, APIKeyID: serviceSecret,
			Method: http.MethodPost, ClientIP: huge, Model: huge,
			Endpoint: "/v1/chat/completions?client_secret=do-not-return", Provider: provider,
			StatusCode: 5000, LatencyMS: -1, FirstChunkMS: math.MaxInt32,
			SessionID: "Bearer abcdefghijklmnop", CreatedAt: now,
		},
		Response: &store.ResponseLog{
			ID: "resp-untrusted", RequestID: "req-untrusted", StatusCode: 5000,
			FinishReason: jwToken, CreatedAt: now,
		},
		Usage: &store.TokenUsage{
			ID: "usage-untrusted", RequestID: "req-untrusted", PromptTokens: -4,
			CompletionTokens: maxDBInt, TotalTokens: -1, CachedTokens: maxDBInt,
			ReasoningTokens: -1, EstimatedCost: -12.5, Currency: currencyPII, CreatedAt: now,
		},
	}); err != nil {
		t.Fatal(err)
	}

	response := providerAppRequest(t, http.MethodGet, gateway.URL+"/admin/requests?limit=1", nil)
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	visible := string(body)
	for _, forbidden := range []string{apiSecret, serviceSecret, currencyPII, "abcdefghijklmnop", jwToken, "do-not-return", huge} {
		if strings.Contains(visible, forbidden) {
			t.Fatalf("projection leaked untrusted value %q: %s", forbidden, visible)
		}
	}
	var page appRequestsResponse
	if err := json.Unmarshal(body, &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Requests) != 1 {
		t.Fatalf("page = %+v", page)
	}
	item := page.Requests[0]
	if item.TraceID != appRequestValueRedacted || item.APIKeyID != appRequestValueRedacted ||
		item.SessionID != appRequestValueRedacted || item.IP != externalIPUnknown ||
		item.Model != appRequestValueOmitted || item.Endpoint != appRequestValueRedacted ||
		item.Currency != appRequestValueRedacted || item.FinishReason != appRequestValueRedacted {
		t.Fatalf("untrusted strings were not projected safely: %+v", item)
	}
	if !item.RequestFilterable || item.TraceFilterable || len(item.RequestRef) != appRequestRefLength {
		t.Fatalf("request filterability/ref contract = %+v", item)
	}
	if item.StatusCode != 0 || item.LatencyMS != 0 || item.FirstChunkMS != math.MaxInt32 ||
		item.PromptTokens != 0 || item.CompletionTokens != appRequestMaxCount || item.TotalTokens != 0 ||
		item.CachedTokens != appRequestMaxCount || item.ReasoningTokens != 0 || item.EstimatedCost != 0 {
		t.Fatalf("untrusted numbers were not clamped: %+v", item)
	}
	if got := (&Server{}).projectAppRequestText("model-owner@example.com", appRequestModelMaxBytes); got != appRequestValueRedacted {
		t.Fatalf("PII-shaped app metadata projection = %q, want %q", got, appRequestValueRedacted)
	}
	for _, value := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), -1} {
		if got := clampAppRequestCost(value); got != 0 {
			t.Fatalf("clampAppRequestCost(%v) = %v", value, got)
		}
	}
	if got := clampAppRequestInt64(math.MaxInt64); got != appRequestMaxSafeInteger {
		t.Fatalf("clampAppRequestInt64(MaxInt64) = %d", got)
	}
}

func TestAppRequestsProviderRefFailsClosedWhenConfigurationExceedsBound(t *testing.T) {
	server, db, gateway := newAdminModelsTestServer(t, "")
	const candidateOverflow = 1025
	for index := 0; index < candidateOverflow; index++ {
		name := fmt.Sprintf("provider-%04d", index)
		if err := db.UpsertProvider(t.Context(), store.ProviderConfig{
			Name: name, BaseURL: "https://provider.invalid", Enabled: true,
		}); err != nil {
			t.Fatal(err)
		}
	}

	response := providerAppRequest(t, http.MethodGet, gateway.URL+"/admin/requests?provider_ref="+
		url.QueryEscape(server.providerRef("provider-0000")), nil)
	defer response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Code != "invalid_provider_ref" {
		t.Fatalf("error code = %q", body.Error.Code)
	}
}

func TestAppRequestsOversizedProviderUsesSentinelAndFailsRefResolutionClosed(t *testing.T) {
	server, db, gateway := newAdminModelsTestServer(t, "")
	if err := db.UpsertProvider(t.Context(), store.ProviderConfig{
		Name: "normal-provider", BaseURL: "https://provider.invalid", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	oversized := strings.Repeat("oversized-provider-", 700)
	if err := db.UpsertProvider(t.Context(), store.ProviderConfig{
		Name: oversized, BaseURL: "https://provider.invalid", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	insertAppRequestTestRow(t, db, "req-oversized-provider", oversized, 200, time.Now().UTC())

	page := readAppRequestPage(t, providerAppRequest(t, http.MethodGet, gateway.URL+"/admin/requests?limit=1", nil))
	if len(page.Requests) != 1 || page.Requests[0].ProviderDisplay != appRequestProviderOmitted ||
		page.Requests[0].ProviderRef != server.systemProviderRef("request-provider-omitted") {
		t.Fatalf("oversized provider projection = %+v", page)
	}

	response := providerAppRequest(t, http.MethodGet, gateway.URL+"/admin/requests?provider_ref="+
		url.QueryEscape(server.providerRef("normal-provider")), nil)
	defer response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("status=%d body=%s", response.StatusCode, body)
	}
}

func TestAppRequestsRejectsInvalidFilters(t *testing.T) {
	_, _, gateway := newAdminModelsTestServer(t, "")
	for name, query := range map[string]string{
		"limit": "limit=0", "timezone": "tz=Not%2FAZone", "range": "from=2026-09-04&to=2026-09-03",
		"duplicate": "model=a&model=b", "unknown": "ids=req-a", "status": "status=600", "ip": "ip=victim%40example.com",
	} {
		t.Run(name, func(t *testing.T) {
			response := providerAppRequest(t, http.MethodGet, gateway.URL+"/admin/requests?"+query, nil)
			defer response.Body.Close()
			if response.StatusCode != http.StatusBadRequest {
				body, _ := io.ReadAll(response.Body)
				t.Fatalf("status=%d body=%s", response.StatusCode, body)
			}
			if response.Header.Get("Cache-Control") != "no-store" || !strings.Contains(response.Header.Get("Vary"), "X-Vibe-UI") {
				t.Fatalf("variant cache headers missing: %v", response.Header)
			}
		})
	}
}

func TestAppRequestsUnknownQueryKeyDoesNotReflectInput(t *testing.T) {
	_, _, gateway := newAdminModelsTestServer(t, "")
	secretKey := "vc_sk_" + strings.Repeat("s", 43)
	for name, key := range map[string]string{
		"secret-shaped": secretKey,
		"oversized":     strings.Repeat("oversized-filter-key-", 600),
	} {
		t.Run(name, func(t *testing.T) {
			response := providerAppRequest(t, http.MethodGet, gateway.URL+"/admin/requests?"+
				url.QueryEscape(key)+"=value", nil)
			body, err := io.ReadAll(response.Body)
			response.Body.Close()
			if err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s", response.StatusCode, body)
			}
			if strings.Contains(string(body), key) || strings.Contains(string(body), secretKey) {
				t.Fatalf("unknown query key was reflected: %s", body)
			}
			var envelope struct {
				Error struct {
					Message string `json:"message"`
					Code    string `json:"code"`
				} `json:"error"`
			}
			if err := json.Unmarshal(body, &envelope); err != nil {
				t.Fatal(err)
			}
			if envelope.Error.Message != "지원하지 않는 요청 필터입니다." || envelope.Error.Code != "invalid_requests_filter" {
				t.Fatalf("unstable error envelope: %+v", envelope)
			}
		})
	}
}

func TestAppRequestsOpenAPIProjectionMatchesRuntimeFields(t *testing.T) {
	spec := buildOpenAPISpec()
	components := spec["components"].(map[string]any)
	schemas := components["schemas"].(map[string]any)
	summary := schemas["AppRequestSummary"].(map[string]any)
	properties := summary["properties"].(map[string]any)
	want := []string{"request_id", "request_ref", "request_filterable", "trace_id", "trace_filterable", "session_id", "api_key_id", "ip", "method", "model",
		"provider_ref", "provider_display", "endpoint", "stream", "status_code", "latency_ms",
		"first_chunk_ms", "prompt_tokens", "completion_tokens", "total_tokens", "cached_tokens",
		"reasoning_tokens", "estimated_cost", "currency", "finish_reason", "created_at"}
	if len(properties) != len(want) {
		t.Fatalf("AppRequestSummary fields = %v, want %v", properties, want)
	}
	for _, field := range want {
		if _, ok := properties[field]; !ok {
			t.Errorf("AppRequestSummary missing %q", field)
		}
	}
	for _, forbidden := range []string{"provider", "error", "user_agent", "prompts", "prompt"} {
		if _, ok := properties[forbidden]; ok {
			t.Errorf("AppRequestSummary documents forbidden field %q", forbidden)
		}
	}
	requestID := properties["request_id"].(map[string]any)
	if requestID["minLength"] != 1 || requestID["maxLength"] != appRequestIDMaxBytes {
		t.Fatalf("request_id OpenAPI bounds = %v", requestID)
	}
	createdAt := properties["created_at"].(map[string]any)
	if createdAt["maxLength"] != len(appRequestTimestampLayout) {
		t.Fatalf("created_at OpenAPI bounds = %v", createdAt)
	}
	responseSchema := schemas["AppRequestsResponse"].(map[string]any)
	responseProperties := responseSchema["properties"].(map[string]any)
	requests := responseProperties["requests"].(map[string]any)
	if requests["maxItems"] != 200 {
		t.Fatalf("requests OpenAPI bounds = %v", requests)
	}
	for _, field := range []string{"next_cursor", "previous_cursor"} {
		cursor := responseProperties[field].(map[string]any)
		if cursor["minLength"] != 1 || cursor["maxLength"] != appRequestCursorMaxBytes {
			t.Fatalf("%s OpenAPI bounds = %v", field, cursor)
		}
	}
	generatedAt := responseProperties["generated_at"].(map[string]any)
	if generatedAt["maxLength"] != len(appRequestTimestampLayout) {
		t.Fatalf("generated_at OpenAPI bounds = %v", generatedAt)
	}
	paths := spec["paths"].(map[string]any)
	operation := paths["/admin/requests"].(map[string]any)["get"].(map[string]any)
	parameters := operation["parameters"].([]any)
	header := parameters[0].(map[string]any)
	if header["name"] != "X-Vibe-UI" || header["required"] != false {
		t.Fatalf("X-Vibe-UI must remain optional for legacy callers: %v", header)
	}
	var contractHeader map[string]any
	for _, raw := range parameters {
		parameter := raw.(map[string]any)
		if parameter["name"] == appRequestContractHeader {
			contractHeader = parameter
			break
		}
	}
	if contractHeader == nil || contractHeader["required"] != false {
		t.Fatalf("request contract header must be optional for rolling compatibility: %v", contractHeader)
	}
	contractHeaderSchema := contractHeader["schema"].(map[string]any)
	contractVersions := contractHeaderSchema["enum"].([]string)
	if contractHeaderSchema["default"] != appRequestContractV1 || len(contractVersions) != 2 ||
		contractVersions[0] != appRequestContractV1 || contractVersions[1] != appRequestContractV2 {
		t.Fatalf("request contract header schema = %v", contractHeaderSchema)
	}
	wantQueryBounds := map[string]int{
		"from": 64, "to": 64, "tz": 64, "model": 256, "request_id": appRequestIDMaxBytes,
		"trace_id": appRequestIDMaxBytes, "session_id": appRequestIDMaxBytes,
		"api_key_id": appRequestIDMaxBytes, "ip": 128, "language": 64,
		"cursor": appRequestCursorMaxBytes,
	}
	seenQueryBounds := make(map[string]bool, len(wantQueryBounds))
	for _, raw := range parameters {
		parameter := raw.(map[string]any)
		name, _ := parameter["name"].(string)
		maximum, bounded := wantQueryBounds[name]
		if !bounded {
			continue
		}
		schema := parameter["schema"].(map[string]any)
		if schema["maxLength"] != maximum {
			t.Fatalf("%s query OpenAPI bounds = %v, want maxLength %d", name, schema, maximum)
		}
		seenQueryBounds[name] = true
	}
	if len(seenQueryBounds) != len(wantQueryBounds) {
		t.Fatalf("bounded query parameters = %v, want %v", seenQueryBounds, wantQueryBounds)
	}
	var cursorParameter map[string]any
	for _, raw := range parameters {
		parameter := raw.(map[string]any)
		if parameter["name"] == "cursor" {
			cursorParameter = parameter
			break
		}
	}
	if cursorParameter == nil {
		t.Fatal("cursor query parameter missing")
	}
	cursorSchema := cursorParameter["schema"].(map[string]any)
	if _, hasMin := cursorSchema["minLength"]; hasMin || cursorSchema["maxLength"] != appRequestCursorMaxBytes {
		t.Fatalf("cursor query OpenAPI bounds = %v", cursorSchema)
	}
	responses := operation["responses"].(map[string]any)
	encoded, err := json.Marshal(responses["200"])
	if err != nil {
		t.Fatal(err)
	}
	var responseContract map[string]any
	if err := json.Unmarshal(encoded, &responseContract); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(responseContract["description"].(string), "AppRequestsResponse") {
		t.Fatalf("/admin/requests response description lost version contract: %s", encoded)
	}
	responseHeaders := responseContract["headers"].(map[string]any)
	selectedVersion := responseHeaders[appRequestContractHeader].(map[string]any)["schema"].(map[string]any)
	versions := selectedVersion["enum"].([]any)
	if len(versions) != 2 || versions[0] != appRequestContractV1 || versions[1] != appRequestContractV2 {
		t.Fatalf("selected request contract response header = %v", selectedVersion)
	}
	if _, typed := responseContract["content"]; typed {
		t.Fatalf("/admin/requests must not replace the distinct legacy and app response bodies with one schema: %s", encoded)
	}
}
