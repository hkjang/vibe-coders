package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestProviderConnectionTestCancelsUpstreamHeadersAndBody(t *testing.T) {
	for _, withHeaders := range []bool{false, true} {
		t.Run(map[bool]string{false: "headers", true: "body"}[withHeaders], func(t *testing.T) {
			cancelled := make(chan struct{})
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if withHeaders {
					w.WriteHeader(200)
					_, _ = io.WriteString(w, `{"data":[`)
					w.(http.Flusher).Flush()
				}
				<-r.Context().Done()
				close(cancelled)
			}))
			t.Cleanup(upstream.Close)
			_, _, gateway := newConnectionTestServer(t)
			status, result, raw := connectionPost(t, gateway.URL, "", map[string]any{"name": "new", "base_url": upstream.URL, "credential_mode": "none", "timeout_ms": 100})
			if status != 200 || result.Outcome != "timeout" || result.ModelCount != nil || result.TimeoutMS != 100 {
				t.Fatalf("timeout misclassified: status=%d body=%s", status, raw)
			}
			select {
			case <-cancelled:
			case <-time.After(time.Second):
				t.Fatal("upstream request survived the probe deadline")
			}
		})
	}
}

func TestProviderConnectionTestSharesGlobalCatalogueSlotsAndQueueDeadline(t *testing.T) {
	var calls atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	t.Cleanup(upstream.Close)
	server, _, gateway := newConnectionTestServer(t)
	for range cap(server.adminModels.semaphore) {
		server.adminModels.semaphore <- struct{}{}
	}
	t.Cleanup(func() {
		for range cap(server.adminModels.semaphore) {
			<-server.adminModels.semaphore
		}
	})
	status, result, raw := connectionPost(t, gateway.URL, "", map[string]any{"name": "new", "base_url": upstream.URL, "credential_mode": "none", "timeout_ms": 40})
	if status != 200 || result.Outcome != "timeout" || calls.Load() != 0 || result.UpstreamStatus != nil || result.ModelCount != nil {
		t.Fatalf("queue did not share existing catalogue capacity/deadline: status=%d body=%s", status, raw)
	}
}

func TestProviderConnectionTestParentCancellationReleasesCapacityAndAudits(t *testing.T) {
	entered, cancelled := make(chan struct{}), make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-r.Context().Done()
		close(cancelled)
	}))
	t.Cleanup(upstream.Close)
	server, db, _ := newConnectionTestServer(t)
	body, _ := json.Marshal(map[string]any{"name": "new", "base_url": upstream.URL, "credential_mode": "none"})
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	req := httptest.NewRequest(http.MethodPost, connectionTestPath, strings.NewReader(string(body))).WithContext(ctx)
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { defer close(done); server.Routes().ServeHTTP(response, req) }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("probe did not enter local upstream")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("parent cancellation did not stop handler")
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("parent cancellation did not reach upstream")
	}
	var result connectionTestResult
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || response.Code != 200 || result.Outcome != "cancelled" || len(server.adminModels.semaphore) != 0 {
		t.Fatalf("cancelled result/capacity wrong: status=%d body=%s", response.Code, response.Body)
	}
	audits, err := db.ListAdminAudit(t.Context(), 10)
	if err != nil || len(audits) != 1 || !strings.Contains(audits[0].AfterValue, `"outcome":"cancelled"`) {
		t.Fatal("cancelled action lost its bounded independent audit")
	}
}

type connectionEOFBarrier struct {
	reader io.Reader
	ready  chan struct{}
	resume chan struct{}
	once   sync.Once
}

func (body *connectionEOFBarrier) Read(bytes []byte) (int, error) {
	n, err := body.reader.Read(bytes)
	if err == io.EOF {
		body.once.Do(func() { close(body.ready); <-body.resume })
	}
	return n, err
}

func TestProviderConnectionTestRechecksFeatureBeforeOutbound(t *testing.T) {
	var calls atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	t.Cleanup(upstream.Close)
	server, _, _ := newConnectionTestServer(t)
	encoded, _ := json.Marshal(map[string]any{"name": "new", "base_url": upstream.URL, "credential_mode": "none"})
	body := &connectionEOFBarrier{reader: strings.NewReader(string(encoded)), ready: make(chan struct{}), resume: make(chan struct{})}
	req := httptest.NewRequest(http.MethodPost, connectionTestPath, body)
	response, done := httptest.NewRecorder(), make(chan struct{})
	go func() { defer close(done); server.Routes().ServeHTTP(response, req) }()
	select {
	case <-body.ready: // Decoding follows the first successful access check.
	case <-time.After(time.Second):
		t.Fatal("request did not reach its validated-body boundary")
	}
	setAppUITelemetryTestSetting(t, server, "ui.app.feature.gateway.providers.readonly", "true")
	close(body.resume)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("changed feature check did not finish")
	}
	if response.Code != 403 || calls.Load() != 0 || len(server.adminModels.semaphore) != 0 {
		t.Fatal("stale feature decision triggered outbound request")
	}
}

func TestProviderConnectionTestDoesNotForwardCookies(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
			t.Error("keyless probe leaked ambient credentials")
		}
		_, _ = io.WriteString(w, `{"data":[]}`)
	}))
	t.Cleanup(upstream.Close)
	server, _, gateway := newConnectionTestServer(t)
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	target, _ := url.Parse(upstream.URL)
	jar.SetCookies(target, []*http.Cookie{{Name: "ambient", Value: "private-cookie"}})
	server.client.Jar = jar
	status, result, _ := connectionPost(t, gateway.URL, "", map[string]any{"name": "new", "base_url": upstream.URL, "credential_mode": "none"})
	if status != 200 || result.Outcome != "catalog_available" || len(jar.Cookies(target)) != 1 || server.client.Jar != jar {
		t.Fatal("probe altered the existing cookie client")
	}
}

func TestProviderConnectionTestExplicitTimeoutUsesContextWithoutChangingSharedClient(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(25 * time.Millisecond):
			_, _ = io.WriteString(w, `{"data":[]}`)
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(upstream.Close)
	server, _, gateway := newConnectionTestServer(t)
	server.cfg.Upstream.Timeout = 5 * time.Millisecond
	server.client.Timeout = 5 * time.Millisecond
	status, result, raw := connectionPost(t, gateway.URL, "", map[string]any{"name": "new", "base_url": upstream.URL, "credential_mode": "none", "timeout_ms": 1000})
	if status != 200 || result.Outcome != "catalog_available" || result.TimeoutMS != 1000 || server.client.Timeout != 5*time.Millisecond {
		t.Fatalf("explicit timeout was silently capped by shared client: status=%d body=%s", status, raw)
	}
	status, result, raw = connectionPost(t, gateway.URL, "", map[string]any{"name": "new", "base_url": upstream.URL, "credential_mode": "none", "timeout_ms": 0})
	if status != 200 || result.Outcome != "timeout" || result.TimeoutMS != 5 {
		t.Fatalf("default timeout no longer respected configured budget: status=%d body=%s", status, raw)
	}
}
