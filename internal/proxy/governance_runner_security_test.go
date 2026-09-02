package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

const (
	governanceUnsafeProvider = "sk-ant-governance-provider-secret"
	governanceBaseURLSecret  = "GOVERNANCE-BASE-URL-SECRET"
	governanceBodySecret     = "Bearer GOVERNANCE-UPSTREAM-BODY-SECRET"
)

func addGovernanceRunnerProvider(t *testing.T, server *Server, db *store.SQLStore, name, baseURL string) {
	t.Helper()
	encrypted, err := server.secrets.Load().Encrypt("governance-upstream-key")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertProvider(t.Context(), store.ProviderConfig{
		Name: name, BaseURL: baseURL, EncryptedAPIKey: encrypted, Enabled: true, TimeoutMS: 500,
	}); err != nil {
		t.Fatal(err)
	}
}

func runReplayForProvider(t *testing.T, gatewayURL, provider string) ([]byte, governanceRunResult) {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"prompt": "safe replay prompt", "models": []string{"gpt-4o"}, "execute": true,
	})
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, gatewayURL+"/admin/replay", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Proxy-Provider", provider)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("replay status=%d body=%s", resp.StatusCode, raw)
	}
	var decoded struct {
		Results []governanceRunResult `json:"results"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded.Results) != 1 {
		t.Fatalf("replay results=%+v", decoded.Results)
	}
	return raw, decoded.Results[0]
}

func assertGovernanceRunnerSecretsAbsent(t *testing.T, value string) {
	t.Helper()
	for _, secret := range []string{
		governanceUnsafeProvider, governanceBaseURLSecret, governanceBodySecret,
		"GOVERNANCE-TRANSPORT-URL-SECRET", "GOVERNANCE-READ-SECRET",
	} {
		if strings.Contains(value, secret) {
			t.Fatalf("governance result leaked %q: %s", secret, value)
		}
	}
}

func assertStoredReplaySafe(t *testing.T, db *store.SQLStore) {
	t.Helper()
	jobs, err := db.ListReplayJobs(t.Context(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 {
		t.Fatalf("stored replay jobs=%+v", jobs)
	}
	assertGovernanceRunnerSecretsAbsent(t, jobs[0].Results)
}

func TestGovernanceApprovalPayloadBoundsLegacyUnsafeProvider(t *testing.T) {
	server, db, gateway := newAdminModelsTestServer(t, "")
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	allowed, approvalID, _ := server.governanceApprovalGate(request, governanceContext{
		RequestID: "req_approval_boundary", SubjectType: "openai_request", SubjectID: "subject",
		Model: "gpt-4o", Provider: governanceUnsafeProvider,
	}, "review required for "+governanceUnsafeProvider)
	if allowed || approvalID == "" {
		t.Fatalf("approval gate allowed=%v id=%q", allowed, approvalID)
	}
	approval, found, err := db.GetApproval(t.Context(), approvalID)
	if err != nil || !found {
		t.Fatalf("approval found=%v err=%v", found, err)
	}
	if strings.Contains(approval.Payload+approval.Reason, governanceUnsafeProvider) || !strings.Contains(approval.Payload, boundedModelsProviderLabel(governanceUnsafeProvider)) {
		t.Fatalf("approval payload/reason was not bounded: payload=%s reason=%s", approval.Payload, approval.Reason)
	}
	resp, err := http.Get(gateway.URL + "/admin/approvals?status=pending")
	if err != nil {
		t.Fatal(err)
	}
	apiBody, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || strings.Contains(string(apiBody), governanceUnsafeProvider) {
		t.Fatalf("approval API leaked provider: status=%d body=%s", resp.StatusCode, apiBody)
	}
}

func TestGovernanceRunnerPreservesSafeSuccessAndUsage(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"safe response"}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}`))
	}))
	defer upstream.Close()
	server, db, _ := newAdminModelsTestServer(t, "")
	addGovernanceRunnerProvider(t, server, db, "safe-provider", upstream.URL)
	request := httptest.NewRequest(http.MethodPost, "/admin/replay", nil)
	request.Header.Set("X-Proxy-Provider", "safe-provider")
	result := server.runGovernanceChat(context.Background(), request, "gpt-4o", "safe prompt")
	if result.Error != "" || result.StatusCode != http.StatusOK || result.Provider != "safe-provider" ||
		result.Response != "safe response" || result.PromptTokens != 3 || result.CompletionTokens != 2 || result.TotalTokens != 5 {
		t.Fatalf("successful governance run changed: %+v", result)
	}
}

func TestGovernanceRunnerFailureResultsNeverPersistUpstreamSecrets(t *testing.T) {
	tests := []struct {
		name       string
		baseURL    func(*testing.T) string
		configure  func(*Server)
		wantError  string
		wantStatus int
	}{
		{
			name: "non success body",
			baseURL: func(t *testing.T) string {
				upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					w.WriteHeader(http.StatusUnauthorized)
					_, _ = w.Write([]byte(governanceBodySecret))
				}))
				t.Cleanup(upstream.Close)
				return upstream.URL + "/proxy?api_key=" + governanceBaseURLSecret
			},
			wantError: governanceRunErrStatus, wantStatus: http.StatusUnauthorized,
		},
		{
			name: "transport URL",
			baseURL: func(*testing.T) string {
				return "https://legacy.invalid/proxy?api_key=" + governanceBaseURLSecret
			},
			configure: func(server *Server) {
				server.client.Transport = modelsRoundTripFunc(func(req *http.Request) (*http.Response, error) {
					return nil, &url.Error{Op: "Post", URL: req.URL.String() + "?token=GOVERNANCE-TRANSPORT-URL-SECRET", Err: errors.New("dial failed")}
				})
			},
			wantError: governanceRunErrTransport,
		},
		{
			name: "transport timeout",
			baseURL: func(*testing.T) string {
				return "https://legacy.invalid/proxy?api_key=" + governanceBaseURLSecret
			},
			configure: func(server *Server) {
				server.client.Transport = modelsRoundTripFunc(func(*http.Request) (*http.Response, error) {
					return nil, context.DeadlineExceeded
				})
			},
			wantError: governanceRunErrTimeout,
		},
		{
			name: "response read error",
			baseURL: func(*testing.T) string {
				return "https://legacy.invalid/proxy?api_key=" + governanceBaseURLSecret
			},
			configure: func(server *Server) {
				server.client.Transport = modelsRoundTripFunc(func(req *http.Request) (*http.Response, error) {
					return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: governanceErrorReadCloser{}}, nil
				})
			},
			wantError: governanceRunErrResponseRead, wantStatus: http.StatusOK,
		},
		{
			name: "invalid upstream URL",
			baseURL: func(*testing.T) string {
				return "http://[::1?api_key=" + governanceBaseURLSecret
			},
			wantError: governanceRunErrUpstreamURL,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server, db, gateway := newAdminModelsTestServer(t, "")
			addGovernanceRunnerProvider(t, server, db, governanceUnsafeProvider, test.baseURL(t))
			if test.configure != nil {
				test.configure(server)
			}
			apiBody, result := runReplayForProvider(t, gateway.URL, governanceUnsafeProvider)
			if result.Error != test.wantError || result.StatusCode != test.wantStatus || result.Provider != boundedModelsProviderLabel(governanceUnsafeProvider) {
				t.Fatalf("result=%+v want error=%q status=%d", result, test.wantError, test.wantStatus)
			}
			assertGovernanceRunnerSecretsAbsent(t, string(apiBody))
			assertStoredReplaySafe(t, db)
		})
	}
}

func requestAnalyzeForProvider(t *testing.T, gatewayURL, provider string) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, gatewayURL+"/admin/requests/req-analyze-boundary/analyze", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Proxy-Provider", provider)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, body
}

func addAnalyzeSourceRequest(t *testing.T, db *store.SQLStore) {
	t.Helper()
	if err := db.InsertLogRecord(t.Context(), store.LogRecord{Request: store.RequestLog{
		ID: "req-analyze-boundary", TraceID: "trace-analyze-boundary", Endpoint: "/v1/chat/completions",
		Model: "gpt-4o", Provider: "safe-source", StatusCode: http.StatusOK,
	}}); err != nil {
		t.Fatal(err)
	}
}

func TestRequestAnalyzeErrorsNeverReflectProviderURLOrUpstreamBody(t *testing.T) {
	t.Run("non success body", func(t *testing.T) {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(governanceBodySecret))
		}))
		defer upstream.Close()
		server, db, gateway := newAdminModelsTestServer(t, "")
		addAnalyzeSourceRequest(t, db)
		addGovernanceRunnerProvider(t, server, db, governanceUnsafeProvider, upstream.URL+"/proxy?api_key="+governanceBaseURLSecret)
		status, body := requestAnalyzeForProvider(t, gateway.URL, governanceUnsafeProvider)
		if status != http.StatusBadGateway || !strings.Contains(string(body), "upstream returned non-success status") {
			t.Fatalf("analyze status=%d body=%s", status, body)
		}
		assertGovernanceRunnerSecretsAbsent(t, string(body))
	})

	t.Run("transport URL", func(t *testing.T) {
		server, db, gateway := newAdminModelsTestServer(t, "")
		addAnalyzeSourceRequest(t, db)
		addGovernanceRunnerProvider(t, server, db, governanceUnsafeProvider, "https://legacy.invalid/proxy?api_key="+governanceBaseURLSecret)
		server.client.Transport = modelsRoundTripFunc(func(req *http.Request) (*http.Response, error) {
			return nil, &url.Error{Op: "Post", URL: req.URL.String() + "?token=GOVERNANCE-TRANSPORT-URL-SECRET", Err: errors.New("dial failed")}
		})
		status, body := requestAnalyzeForProvider(t, gateway.URL, governanceUnsafeProvider)
		if status != http.StatusBadGateway || !strings.Contains(string(body), "upstream request failed") {
			t.Fatalf("analyze status=%d body=%s", status, body)
		}
		assertGovernanceRunnerSecretsAbsent(t, string(body))
	})
}

type governanceErrorReadCloser struct{}

func (governanceErrorReadCloser) Read([]byte) (int, error) {
	return 0, errors.New("read failed: GOVERNANCE-READ-SECRET")
}

func (governanceErrorReadCloser) Close() error { return nil }

func TestVibeUIVariantHandlersDisableSharedCaching(t *testing.T) {
	_, db, gateway := newAdminModelsTestServer(t, "")
	if err := db.UpsertProvider(t.Context(), store.ProviderConfig{
		Name: governanceUnsafeProvider, BaseURL: "https://example.invalid", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertAgentRoute(t.Context(), store.AgentRoute{
		ID: "agr_cache_boundary", VirtualModel: "vibe/cache-boundary", Name: "cache boundary",
		Enabled: true, Provider: governanceUnsafeProvider, BackingModel: "gpt-4o",
	}); err != nil {
		t.Fatal(err)
	}

	paths := []string{
		"/admin/providers", "/admin/models?provider=missing", "/admin/providers/slo",
		"/admin/routing/health", "/admin/ops/status", "/admin/ops/risk",
		"/admin/agent-routes", "/admin/agent-routes/agr_cache_boundary",
	}
	for _, path := range paths {
		for _, app := range []bool{false, true} {
			req, err := http.NewRequest(http.MethodGet, gateway.URL+path, nil)
			if err != nil {
				t.Fatal(err)
			}
			if app {
				req.Header.Set("X-Vibe-UI", "app")
			}
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.Header.Get("Cache-Control") != "no-store" || !headerListContains(resp.Header.Values("Vary"), "X-Vibe-UI") {
				t.Errorf("%s app=%v cache headers: Cache-Control=%q Vary=%q", path, app, resp.Header.Get("Cache-Control"), resp.Header.Values("Vary"))
			}
			if strings.Contains(path, "agent-routes") {
				if app && strings.Contains(string(body), governanceUnsafeProvider) {
					t.Errorf("%s app response leaked legacy provider: %s", path, body)
				}
				if !app && !strings.Contains(string(body), governanceUnsafeProvider) {
					t.Errorf("%s legacy response lost edit identity: %s", path, body)
				}
			}
		}
	}
}

func headerListContains(values []string, want string) bool {
	for _, value := range values {
		for _, field := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(field), want) {
				return true
			}
		}
	}
	return false
}
