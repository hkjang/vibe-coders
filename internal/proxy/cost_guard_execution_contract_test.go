package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// Configuration safety must not change the existing priced-chat gate, its
// explicit approval exception, or the earlier independent API-key budget gate.
func TestCostGuardContractAuthenticatedExecutionBoundaries(t *testing.T) {
	const pricedBody = `{"model":"test-model","max_tokens":100,"messages":[{"role":"user","content":"synthetic cost request"}]}`
	_, _, prompts, _ := extractAudit([]byte(pricedBody), "/v1/chat/completions", true)
	estimate := predictCost("test-model", promptTokenEstimate(prompts), 100,
		&costSnapshot{byModel: map[string]store.ModelStat{}}, testConfig("", "").Pricing).CostKRW
	if estimate <= 0 {
		t.Fatal("cost boundary fixture requires a priced positive estimate")
	}
	for _, tc := range []struct {
		name, approval, code                     string
		enabled, unpriced, unmatched, limitedKey bool
		threshold                                float64
		status                                   int
	}{
		{name: "exceeded priced chat", enabled: true, threshold: estimate / 2,
			status: http.StatusPaymentRequired, code: "cost_threshold_exceeded"},
		{name: "explicit approval", enabled: true, threshold: estimate / 2,
			approval: " 1 ", status: http.StatusOK},
		{name: "disabled", threshold: estimate / 2, status: http.StatusOK},
		{name: "zero means no gate", enabled: true, status: http.StatusOK},
		{name: "unpriced is not blocked", enabled: true, unpriced: true,
			threshold: estimate / 2, status: http.StatusOK},
		{name: "unmatched model can still use fallback pricing", enabled: true, unmatched: true,
			threshold: estimate / 2, status: http.StatusPaymentRequired, code: "cost_threshold_exceeded"},
		{name: "equal threshold is allowed", enabled: true, threshold: estimate, status: http.StatusOK},
		{name: "below threshold is allowed", enabled: true, threshold: estimate * 2, status: http.StatusOK},
		{name: "approval does not bypass key budget", enabled: true, limitedKey: true,
			threshold: estimate / 2, approval: "1", status: http.StatusPaymentRequired, code: "budget_denied"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newCostGuardExecutionContractFixture(t)
			config, err := json.Marshal(map[string]any{"enabled": tc.enabled, "threshold_krw": tc.threshold})
			if err != nil {
				t.Fatal("cost execution fixture config encoding failed")
			}
			f.config(t, http.MethodPost, string(config), tc.enabled, tc.threshold)
			if tc.unpriced {
				// The normal seed includes a fallback price for unknown models.
				// This server-local fixture represents no applicable fallback price;
				// do not mutate audit's process-global fallback model for the test.
				f.server.priceCache.Store(&pricingSnapshot{
					prices: testConfig("", "").Pricing, fetchedAt: time.Now(),
				})
			}
			// Management uses a session JWT; /v1 uses a persisted gateway API key.
			token := "vc_sk_synthetic_cost_execution"
			key := store.APIKeyRecord{
				ID: "cost-execution-key", Name: "Synthetic cost execution", KeyHash: hashProxyKey(token),
				Role: "developer", Status: "active", Scopes: []string{"chat:completion"},
			}
			if tc.limitedKey {
				key.BudgetLimitKRW = estimate / 2
			}
			if err := f.db.UpsertAPIKey(t.Context(), key); err != nil {
				t.Fatal("cost execution key fixture seed failed")
			}
			body := pricedBody
			if tc.unpriced || tc.unmatched {
				body = strings.Replace(body, "test-model", "synthetic-unpriced", 1)
			}
			request, err := http.NewRequestWithContext(t.Context(), http.MethodPost,
				f.gateway.URL+"/v1/chat/completions", strings.NewReader(body))
			if err != nil {
				t.Fatal("cost execution fixture request failed")
			}
			request.Header.Set("Authorization", "Bearer "+token)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-Cost-Approve", tc.approval)
			response, err := f.gateway.Client().Do(request)
			if err != nil {
				t.Fatal("cost execution fixture transport failed")
			}
			defer response.Body.Close()
			data, err := io.ReadAll(response.Body)
			if err != nil || response.StatusCode != tc.status {
				t.Fatalf("authenticated cost execution status=%d want=%d read-error=%v", response.StatusCode, tc.status, err != nil)
			}
			wantCalls := int64(0)
			if tc.status == http.StatusOK {
				wantCalls = 1
			} else {
				var result struct {
					Error struct {
						Code string `json:"code"`
					} `json:"error"`
				}
				if json.Unmarshal(data, &result) != nil || result.Error.Code != tc.code {
					t.Fatal("cost execution changed the independent denial reason")
				}
			}
			if f.upstreamCalls.Load() != wantCalls {
				t.Fatal("cost execution reached the model on a blocked request or skipped an allowed request")
			}
			if (response.Header.Get("X-Cost-Guard") == "blocked") != (tc.code == "cost_threshold_exceeded") {
				t.Fatal("only the global cost guard denial may set its blocked response header")
			}
		})
	}
}

func newCostGuardExecutionContractFixture(t *testing.T) *costGuardContractFixture {
	t.Helper()
	f := &costGuardContractFixture{apiKeyScopeContractFixture: &apiKeyScopeContractFixture{}}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		f.upstreamCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"synthetic response"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`)
	}))
	t.Cleanup(upstream.Close)
	f.gateway, f.server, f.db = scopedSettingsSecurityServer(t, upstream.URL)
	f.adminToken = f.token(t, "cost-admin", "super_admin", []string{"admin:read", "admin:write"})
	return f
}
