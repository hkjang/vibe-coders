package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"vibe-coders/internal/store"
)

func newMethodGuardServer(t *testing.T) *httptest.Server {
	t.Helper()
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(server.Routes())
	t.Cleanup(proxy.Close)
	return proxy
}

func requestMethod(t *testing.T, method, url string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

// Clearing the DW dashboard cache writes an audit row, so it must take an explicit POST.
// Answering any verb meant a prefetch of the URL emptied the cache on its own.
func TestDWDashboardRefreshRequiresPost(t *testing.T) {
	proxy := newMethodGuardServer(t)
	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		resp := requestMethod(t, method, proxy.URL+"/admin/dw/dashboard/refresh")
		body, _ := json.Marshal(resp.StatusCode)
		resp.Body.Close()
		if resp.StatusCode != http.StatusMethodNotAllowed {
			t.Fatalf("%s /admin/dw/dashboard/refresh status = %s, want 405", method, body)
		}
	}
	resp := requestMethod(t, http.MethodPost, proxy.URL+"/admin/dw/dashboard/refresh")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /admin/dw/dashboard/refresh status = %d, want 200", resp.StatusCode)
	}
}

// The clear alias shares its handler with the list endpoint. Reading it used to answer with
// the error list, so a URL that reads like an action returned 200 to a GET.
func TestSystemErrorsClearAliasRejectsGet(t *testing.T) {
	proxy := newMethodGuardServer(t)
	resp := requestMethod(t, http.MethodGet, proxy.URL+"/admin/system-errors/clear")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET /admin/system-errors/clear status = %d, want 405", resp.StatusCode)
	}

	listed := requestMethod(t, http.MethodGet, proxy.URL+"/admin/system-errors")
	defer listed.Body.Close()
	if listed.StatusCode != http.StatusOK {
		t.Fatalf("GET /admin/system-errors status = %d, want 200", listed.StatusCode)
	}
	cleared := requestMethod(t, http.MethodPost, proxy.URL+"/admin/system-errors/clear")
	defer cleared.Body.Close()
	if cleared.StatusCode != http.StatusOK {
		t.Fatalf("POST /admin/system-errors/clear status = %d, want 200", cleared.StatusCode)
	}
}

// The handler has always served a GET that reports the current learning state, but the
// catalog documented only the POST, so no client could call it from the contract.
func TestRoutingLearningAutoDocumentsItsRead(t *testing.T) {
	proxy := newMethodGuardServer(t)
	resp := requestMethod(t, http.MethodGet, proxy.URL+"/admin/routing/learning/auto")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /admin/routing/learning/auto status = %d, want 200", resp.StatusCode)
	}
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if _, ok := body["enabled"]; !ok {
		t.Fatalf("GET /admin/routing/learning/auto returned no enabled flag: %v", body)
	}
	for _, ep := range apiEndpoints {
		if ep.path != "/admin/routing/learning/auto" {
			continue
		}
		var hasGet bool
		for _, m := range ep.methods {
			if m == "get" {
				hasGet = true
			}
		}
		if !hasGet {
			t.Fatalf("catalog methods for %s = %v, want the served GET documented", ep.path, ep.methods)
		}
		return
	}
	t.Fatal("/admin/routing/learning/auto is missing from the OpenAPI catalog")
}
