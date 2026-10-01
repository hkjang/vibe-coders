package proxy

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestProviderConnectionTestStrictCatalogueAndSafeFailures(t *testing.T) {
	for _, tc := range []struct {
		name, body, outcome string
		status, count       int
	}{
		{"empty", `{"data":[]}`, "catalog_available", 200, 0},
		{"created catalogue", `{"data":[{"id":"a"}]}`, "catalog_available", 201, 1},
		{"multiple", `{"data":[{"id":"a"},{"id":"b","extra":"secret"}]}`, "catalog_available", 200, 2},
		{"rejected auth", `{"error":"private-upstream-secret"}`, "authentication_rejected", 401, -1},
		{"forbidden auth", "private-upstream-secret", "authentication_rejected", 403, -1},
		{"upstream rate limit", "private-upstream-secret", "upstream_rejected", 429, -1},
		{"upstream error", "private-upstream-secret", "upstream_rejected", 500, -1},
		{"no content", "", "invalid_response", 204, -1},
		{"HTML", "<h1>private-upstream-secret</h1>", "invalid_response", 200, -1},
		{"top null", "null", "invalid_response", 200, -1},
		{"top array", "[]", "invalid_response", 200, -1},
		{"missing data", `{}`, "invalid_response", 200, -1},
		{"null data", `{"data":null}`, "invalid_response", 200, -1},
		{"case data", `{"Data":[]}`, "invalid_response", 200, -1},
		{"duplicate data", `{"data":[],"data":[]}`, "invalid_response", 200, -1},
		{"trailing", `{"data":[]} {}`, "invalid_response", 200, -1},
		{"row null", `{"data":[null]}`, "invalid_response", 200, -1},
		{"row array", `{"data":[[]]}`, "invalid_response", 200, -1},
		{"row string", `{"data":["secret"]}`, "invalid_response", 200, -1},
		{"missing id", `{"data":[{}]}`, "invalid_response", 200, -1},
		{"null id", `{"data":[{"id":null}]}`, "invalid_response", 200, -1},
		{"number id", `{"data":[{"id":123}]}`, "invalid_response", 200, -1},
		{"blank id", `{"data":[{"id":"  "}]}`, "invalid_response", 200, -1},
		{"case id", `{"data":[{"ID":"secret"}]}`, "invalid_response", 200, -1},
		{"duplicate id key", `{"data":[{"id":"a","id":"b"}]}`, "invalid_response", 200, -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("X-Secret", "private-upstream-secret")
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			t.Cleanup(upstream.Close)
			_, _, gateway := newConnectionTestServer(t)
			status, result, body := connectionPost(t, gateway.URL, "", map[string]any{"name": "new", "base_url": upstream.URL, "credential_mode": "none"})
			if status != 200 || result.Outcome != tc.outcome || result.UpstreamStatus == nil || *result.UpstreamStatus != tc.status {
				t.Fatalf("unexpected result: status=%d body=%s", status, body)
			}
			if tc.count < 0 && result.ModelCount != nil || tc.count >= 0 && (result.ModelCount == nil || *result.ModelCount != tc.count) {
				t.Fatal("failed catalogue reported a measured model count")
			}
			if strings.Contains(body, "private-upstream-secret") || strings.Contains(body, upstream.URL) {
				t.Fatal("raw upstream metadata escaped the fixed response")
			}
		})
	}
}

func TestProviderConnectionTestBlocksAllRedirectsWithoutChangingSharedClient(t *testing.T) {
	for _, redirectStatus := range []int{301, 302, 303, 307, 308} {
		t.Run(http.StatusText(redirectStatus), func(t *testing.T) {
			var nextCalls atomic.Int64
			next := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { nextCalls.Add(1) }))
			t.Cleanup(next.Close)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Location", next.URL+"/private-secret")
				w.WriteHeader(redirectStatus)
			}))
			t.Cleanup(upstream.Close)
			server, _, gateway := newConnectionTestServer(t)
			status, result, _ := connectionPost(t, gateway.URL, "", map[string]any{"name": "new", "base_url": upstream.URL, "credential_mode": "draft", "api_key": "draft-secret"})
			if status != 200 || result.Outcome != "redirect_blocked" || nextCalls.Load() != 0 || server.client.CheckRedirect != nil {
				t.Fatal("probe followed a redirect or modified the shared HTTP client")
			}
		})
	}
}

func TestProviderConnectionTestResponseLimits(t *testing.T) {
	for _, tc := range []struct {
		name, body, outcome string
		gzip                bool
	}{
		{"byte cap", `{"data":[],"extra":"` + strings.Repeat("a", maxModelsResponseBytes) + `"}`, "response_too_large", false},
		{"gzip decoded cap", `{"data":[],"extra":"` + strings.Repeat("a", maxModelsResponseBytes) + `"}`, "response_too_large", true},
		{"model count cap", `{"data":[` + strings.Repeat(`{"id":"model"},`, maxModelsPerProvider) + `{"id":"last"}]}`, "model_limit_exceeded", false},
		{"valid gzip", `{"data":[{"id":"gzip-model"}]}`, "catalog_available", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.gzip {
					w.Header().Set("Content-Encoding", "gzip")
					zipper := gzip.NewWriter(w)
					_, _ = io.WriteString(zipper, tc.body)
					_ = zipper.Close()
				} else {
					_, _ = io.WriteString(w, tc.body)
				}
			}))
			t.Cleanup(upstream.Close)
			_, _, gateway := newConnectionTestServer(t)
			status, result, body := connectionPost(t, gateway.URL, "", map[string]any{"name": "new", "base_url": upstream.URL, "credential_mode": "none"})
			if status != 200 || result.Outcome != tc.outcome {
				t.Fatalf("response bounds failed: status=%d body=%s", status, body)
			}
		})
	}
}
