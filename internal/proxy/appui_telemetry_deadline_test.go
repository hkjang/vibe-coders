package proxy

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAppUITelemetrySlowBodiesReleaseIntakeSlots(t *testing.T) {
	s := newAppUITelemetryTestServer(t)
	server := httptest.NewServer(s.Routes())
	defer server.Close()
	var connections []net.Conn
	defer func() {
		for _, conn := range connections {
			_ = conn.Close()
		}
	}()
	started := time.Now()
	for i := 0; i < 4; i++ {
		conn, err := net.DialTimeout("tcp", strings.TrimPrefix(server.URL, "http://"), time.Second)
		if err != nil {
			t.Fatal(err)
		}
		connections = append(connections, conn)
		if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
			t.Fatal(err)
		}
		// Send headers and start a JSON body without ever completing it. A context
		// deadline by itself leaves Decoder.Token/Decode blocked on these sockets.
		if _, err := fmt.Fprint(conn, "POST /admin/ui-telemetry/events HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 200\r\n\r\n{\"feature_id\":\""); err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.Now().Add(time.Second)
	for {
		s.appUITelemetryGate.mu.Lock()
		inFlight := s.appUITelemetryGate.inFlight
		s.appUITelemetryGate.mu.Unlock()
		if inFlight == 4 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("slow bodies did not occupy four intake slots: %d", inFlight)
		}
		time.Sleep(5 * time.Millisecond)
	}
	for _, conn := range connections {
		response, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil {
			t.Fatalf("slow-body response not bounded: %v", err)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("slow body returned %d", response.StatusCode)
		}
	}
	if elapsed := time.Since(started); elapsed > 4*time.Second {
		t.Fatalf("slow intake exceeded its two-second budget: %s", elapsed)
	}
	s.appUITelemetryGate.mu.Lock()
	inFlight := s.appUITelemetryGate.inFlight
	s.appUITelemetryGate.mu.Unlock()
	if inFlight != 0 {
		t.Fatalf("slow intake still occupies %d slots", inFlight)
	}
	w := appUITelemetryRequest(t, s, http.MethodPost, "/admin/ui-telemetry/events", "", appUITelemetryPayload("overview", "visit"))
	if w.Code != http.StatusNoContent || telemetryStoredCount(t, s) != 1 {
		t.Fatalf("normal intake did not recover: status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestAppUITelemetryCallerQuotaDroppedSlowBodiesRemainBounded(t *testing.T) {
	s := newAppUITelemetryTestServer(t)
	s.cfg.Auth.Enabled = true
	now := time.Now()
	token := issueLLMScopedTestToken(t, s.db, s, "spent-private-user", "viewer", "", scopesForRole("viewer"), now)
	otherToken := issueLLMScopedTestToken(t, s.db, s, "other-private-user", "viewer", "", scopesForRole("viewer"), now)
	spendAppUITelemetryQuota(t, s.appUITelemetryCallerQuota, "spent-private-user", appUITelemetryCallerDailyLimit, now)
	server := httptest.NewServer(s.Routes())
	defer server.Close()
	var connections []net.Conn
	defer func() {
		for _, conn := range connections {
			_ = conn.Close()
		}
	}()
	started := time.Now()
	for range 4 {
		conn, err := net.DialTimeout("tcp", strings.TrimPrefix(server.URL, "http://"), time.Second)
		if err != nil {
			t.Fatal(err)
		}
		connections = append(connections, conn)
		if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
			t.Fatal(err)
		}
		// A quota drop returns before decoding. net/http must not drain this
		// incomplete body indefinitely after the handler sends its empty 204.
		if _, err := fmt.Fprintf(conn, "POST /admin/ui-telemetry/events HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\nContent-Length: 200\r\n\r\n{\"feature_id\":\"", token); err != nil {
			t.Fatal(err)
		}
	}
	for _, conn := range connections {
		response, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil {
			t.Fatalf("quota-dropped slow-body response not bounded: %v", err)
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusNoContent {
			t.Fatalf("quota drop returned %d", response.StatusCode)
		}
	}
	if elapsed := time.Since(started); elapsed > 4*time.Second {
		t.Fatalf("quota-dropped bodies exceeded their read budget: %s", elapsed)
	}
	if telemetryStoredCount(t, s) != 0 {
		t.Fatal("quota-dropped slow request wrote telemetry")
	}
	w := appUITelemetryRequest(t, s, http.MethodPost, "/admin/ui-telemetry/events", otherToken, appUITelemetryPayload("overview", "visit"))
	if w.Code != http.StatusNoContent || telemetryStoredCount(t, s) != 1 {
		t.Fatalf("other caller did not recover: status=%d body=%s", w.Code, w.Body.String())
	}
}
