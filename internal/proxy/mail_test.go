package proxy

import (
	"bufio"
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"vibe-coders/internal/mail"
	"vibe-coders/internal/store"
)

// fakeRelay accepts everything so the gateway's whole path — settings, service,
// delivery log — can be exercised against a real SMTP conversation.
type fakeRelay struct {
	host string
	port int
	mu   sync.Mutex
	to   []string
}

func startFakeRelay(t *testing.T) *fakeRelay {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	host, port, _ := net.SplitHostPort(listener.Addr().String())
	number, _ := strconv.Atoi(port)
	relay := &fakeRelay{host: host, port: number}
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go relay.handle(connection)
		}
	}()
	return relay
}

func (f *fakeRelay) handle(connection net.Conn) {
	defer connection.Close()
	reader := bufio.NewReader(connection)
	write := func(line string) { _, _ = connection.Write([]byte(line + "\r\n")) }
	write("220 relay ESMTP")
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return
		}
		upper := strings.ToUpper(strings.TrimSpace(line))
		switch {
		case strings.HasPrefix(upper, "EHLO"):
			write("250-relay")
			write("250 SIZE 1000000")
		case strings.HasPrefix(upper, "RCPT TO"):
			f.mu.Lock()
			f.to = append(f.to, strings.TrimSpace(line))
			f.mu.Unlock()
			write("250 Ok")
		case upper == "DATA":
			write("354 go")
			for {
				dataLine, err := reader.ReadString('\n')
				if err != nil || strings.TrimRight(dataLine, "\r\n") == "." {
					break
				}
			}
			write("250 queued")
		case upper == "QUIT":
			write("221 bye")
			return
		default:
			write("250 Ok")
		}
	}
}

func (f *fakeRelay) recipients() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.to...)
}

func mailServer(t *testing.T) (*httptest.Server, *Server, *store.SQLStore) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{}`)) }))
	t.Cleanup(upstream.Close)
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	server, err := NewServer(testConfig(upstream.URL, "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	server.mailer.SetBatchWindow(0)
	ts := httptest.NewServer(server.Routes())
	t.Cleanup(ts.Close)
	return ts, server, db
}

func configureRelay(t *testing.T, base string, relay *fakeRelay) {
	t.Helper()
	putSetting(t, base, mail.KeySMTPHost, relay.host)
	putSetting(t, base, mail.KeySMTPPort, strconv.Itoa(relay.port))
	putSetting(t, base, mail.KeySecurity, mail.SecurityNone)
	putSetting(t, base, mail.KeyFromAddress, "gateway@corp.example")
	putSetting(t, base, mail.KeyPassword, "relay-secret-value")
	putSetting(t, base, mail.KeyEnabled, "true")
}

func mailDeliveries(t *testing.T, base string) (map[string]any, []map[string]any) {
	t.Helper()
	_, status := req(t, http.MethodGet, base+"/admin/mail/deliveries", "")
	items, _ := status["deliveries"].([]any)
	deliveries := make([]map[string]any, 0, len(items))
	for _, item := range items {
		m, _ := item.(map[string]any)
		deliveries = append(deliveries, m)
	}
	return status, deliveries
}

func TestMailIsOffByDefaultAndTellsWhy(t *testing.T) {
	ts, _, _ := mailServer(t)
	status, deliveries := mailDeliveries(t, ts.URL)
	if status["enabled"] != false || status["ready"] != false || status["password_set"] != false || len(deliveries) != 0 {
		t.Fatalf("default mail status = %v", status)
	}
	if status["smtp_port"] != float64(mail.DefaultPort) || status["security"] != mail.SecurityAuto {
		t.Fatalf("defaults should be an internal relay: %v", status)
	}
	resp, out := req(t, http.MethodPost, ts.URL+"/admin/mail/test", `{"recipient":"alice@corp.example"}`)
	if resp.StatusCode != http.StatusBadRequest || out["sent"] != false || !strings.Contains(out["error"].(string), "disabled") {
		t.Fatalf("test send while off = %d %v", resp.StatusCode, out)
	}

	// Turned on without a host: still nothing goes, and the status says which key is missing.
	putSetting(t, ts.URL, mail.KeyEnabled, "true")
	status, _ = mailDeliveries(t, ts.URL)
	if status["enabled"] != true || status["ready"] != false || !strings.Contains(status["error"].(string), mail.KeySMTPHost) {
		t.Fatalf("incomplete mail status = %v", status)
	}
}

func TestMailPasswordIsNeverReturned(t *testing.T) {
	ts, server, _ := mailServer(t)
	relay := startFakeRelay(t)
	configureRelay(t, ts.URL, relay)

	if got := server.mailConf().Password; got != "relay-secret-value" {
		t.Fatalf("runtime config should hold the decrypted password, got %q", got)
	}
	_, list := req(t, http.MethodGet, ts.URL+"/admin/settings/mail", "")
	items, _ := list["settings"].([]any)
	found := false
	for _, item := range items {
		m, _ := item.(map[string]any)
		if m["key"] != mail.KeyPassword {
			continue
		}
		found = true
		if m["is_secret"] != true || m["is_set"] != true || strings.Contains(m["value"].(string), "relay-secret") {
			t.Fatalf("password setting view = %v", m)
		}
	}
	if !found {
		t.Fatal("mail.password missing from the mail category")
	}
	status, _ := mailDeliveries(t, ts.URL)
	if status["password_set"] != true {
		t.Fatalf("status should say the password is set: %v", status)
	}
	for key, value := range status {
		if text, ok := value.(string); ok && strings.Contains(text, "relay-secret") {
			t.Fatalf("status field %s leaks the password", key)
		}
	}
}

func TestMailTestSendReachesTheRelayAndIsRecorded(t *testing.T) {
	ts, _, _ := mailServer(t)
	relay := startFakeRelay(t)
	configureRelay(t, ts.URL, relay)

	resp, out := req(t, http.MethodPost, ts.URL+"/admin/mail/test", `{"recipient":"alice@corp.example"}`)
	if resp.StatusCode != http.StatusOK || out["sent"] != true {
		t.Fatalf("test send = %d %v", resp.StatusCode, out)
	}
	if to := relay.recipients(); len(to) != 1 || !strings.Contains(to[0], "alice@corp.example") {
		t.Fatalf("relay saw recipients %v", to)
	}
	status, deliveries := mailDeliveries(t, ts.URL)
	if len(deliveries) != 1 || deliveries[0]["event"] != mail.EventTest || deliveries[0]["status"] != mail.StatusSent || deliveries[0]["recipient"] != "alice@corp.example" {
		t.Fatalf("deliveries = %v", deliveries)
	}
	if counts, _ := status["counts"].(map[string]any); counts[mail.StatusSent] != float64(1) {
		t.Fatalf("counts = %v", status["counts"])
	}
	if resp, out := req(t, http.MethodPost, ts.URL+"/admin/mail/test", `{"recipient":"not-an-address"}`); resp.StatusCode != http.StatusBadRequest || out["sent"] != nil {
		t.Fatalf("bad recipient = %d %v", resp.StatusCode, out)
	}
}

func TestMailTestSendReportsADeadRelayWithoutBreakingAnything(t *testing.T) {
	ts, _, _ := mailServer(t)
	relay := startFakeRelay(t)
	configureRelay(t, ts.URL, relay)
	// Point at a port nobody listens on.
	listener, _ := net.Listen("tcp", "127.0.0.1:0")
	_, port, _ := net.SplitHostPort(listener.Addr().String())
	_ = listener.Close()
	putSetting(t, ts.URL, mail.KeySMTPPort, port)
	putSetting(t, ts.URL, mail.KeyTimeoutSeconds, "1")

	resp, out := req(t, http.MethodPost, ts.URL+"/admin/mail/test", `{"recipient":"alice@corp.example"}`)
	if resp.StatusCode != http.StatusBadGateway || out["sent"] != false || out["error"] == "" {
		t.Fatalf("dead relay test send = %d %v", resp.StatusCode, out)
	}
	_, deliveries := mailDeliveries(t, ts.URL)
	if len(deliveries) != 1 || deliveries[0]["status"] != mail.StatusFailed || deliveries[0]["error_message"] == "" {
		t.Fatalf("deliveries = %v; want one failed attempt with its reason", deliveries)
	}
	if resp, _ := req(t, http.MethodGet, ts.URL+"/health", ""); resp.StatusCode != http.StatusOK {
		t.Fatalf("health after a failed mail = %d", resp.StatusCode)
	}
}

func TestApprovalDecisionMailsTheRequesterOnly(t *testing.T) {
	ts, server, db := mailServer(t)
	relay := startFakeRelay(t)
	configureRelay(t, ts.URL, relay)
	ctx := context.Background()
	if err := db.CreateAuthUser(ctx, store.AuthUser{ID: "u_alice", Email: "alice@corp.example", Name: "Alice", Role: "developer", Status: "active"}); err != nil {
		t.Fatal(err)
	}
	approval := store.Approval{ID: "appr_mail_1", RequestID: "req_1", APIKeyID: "key_1", UserID: "u_alice", SubjectType: "openai_request",
		Status: "pending", Reason: "cost above policy", Payload: `{"model":"gpt-4o"}`, ExpiresAt: time.Now().Add(time.Hour), CreatedAt: time.Now()}
	if err := db.InsertApproval(ctx, approval); err != nil {
		t.Fatal(err)
	}

	resp, _ := req(t, http.MethodPost, ts.URL+"/admin/approvals/appr_mail_1/approve", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("approve = %d", resp.StatusCode)
	}
	server.mailer.Wait()
	_, deliveries := mailDeliveries(t, ts.URL)
	if len(deliveries) != 1 || deliveries[0]["event"] != mail.EventApprovalDecided || deliveries[0]["recipient"] != "alice@corp.example" ||
		deliveries[0]["status"] != mail.StatusSent || deliveries[0]["subject_id"] != "appr_mail_1" || !strings.Contains(deliveries[0]["subject"].(string), "approved") {
		t.Fatalf("deliveries after approval = %v", deliveries)
	}
	if to := relay.recipients(); len(to) != 1 {
		t.Fatalf("relay saw %v", to)
	}

	// The switch for approval mail stops exactly that kind and nothing else.
	putSetting(t, ts.URL, mail.KeyNotifyApproval, "false")
	second := approval
	second.ID, second.RequestID = "appr_mail_2", "req_2"
	if err := db.InsertApproval(ctx, second); err != nil {
		t.Fatal(err)
	}
	if resp, _ := req(t, http.MethodPost, ts.URL+"/admin/approvals/appr_mail_2/reject", ""); resp.StatusCode != http.StatusOK {
		t.Fatalf("reject = %d", resp.StatusCode)
	}
	server.mailer.Wait()
	if _, deliveries := mailDeliveries(t, ts.URL); len(deliveries) != 1 {
		t.Fatalf("approval switch off but deliveries = %v", deliveries)
	}
	if resp, out := req(t, http.MethodPost, ts.URL+"/admin/mail/test", `{"recipient":"bob@corp.example"}`); resp.StatusCode != http.StatusOK || out["sent"] != true {
		t.Fatalf("test send must ignore event switches: %d %v", resp.StatusCode, out)
	}
}

func TestApprovalRequestMailsActiveAdminsButNotTheRequester(t *testing.T) {
	ts, server, db := mailServer(t)
	relay := startFakeRelay(t)
	configureRelay(t, ts.URL, relay)
	ctx := context.Background()
	for _, user := range []store.AuthUser{
		{ID: "u_alice", Email: "alice@corp.example", Name: "Alice", Role: "admin", Status: "active"},
		{ID: "u_ops", Email: "ops@corp.example", Name: "Ops", Role: "super_admin", Status: "active"},
		{ID: "u_left", Email: "left@corp.example", Name: "Left", Role: "admin", Status: "disabled"},
		{ID: "u_dev", Email: "dev@corp.example", Name: "Dev", Role: "developer", Status: "active"},
	} {
		if err := db.CreateAuthUser(ctx, user); err != nil {
			t.Fatal(err)
		}
	}
	// Alice, an admin herself, triggers an approval: she must not be told about her own request.
	approval := store.Approval{ID: "appr_req_1", RequestID: "req_1", APIKeyID: "key_1", UserID: "u_alice", SubjectType: "openai_request",
		Status: "pending", Reason: "risk", Payload: `{"model":"gpt-4o"}`, CostKRW: 1500, ExpiresAt: time.Now().Add(time.Hour), CreatedAt: time.Now()}
	if err := db.InsertApproval(ctx, approval); err != nil {
		t.Fatal(err)
	}
	server.mailApprovalRequested(ctx, approval)
	server.mailer.Wait()
	_, deliveries := mailDeliveries(t, ts.URL)
	if len(deliveries) != 1 || deliveries[0]["recipient"] != "ops@corp.example" || deliveries[0]["event"] != mail.EventApprovalRequested || deliveries[0]["actor_id"] != "u_alice" {
		t.Fatalf("deliveries = %v; want exactly one mail to the other active admin", deliveries)
	}
}

func TestKeyBlockedMailsTheOwnerOncePerDay(t *testing.T) {
	ts, server, db := mailServer(t)
	relay := startFakeRelay(t)
	configureRelay(t, ts.URL, relay)
	ctx := context.Background()
	if err := db.CreateAuthUser(ctx, store.AuthUser{ID: "u_alice", Email: "alice@corp.example", Name: "Alice", Role: "developer", Status: "active"}); err != nil {
		t.Fatal(err)
	}
	authCtx := &store.AuthContext{UserID: "u_alice", APIKeyID: "key_roo"}
	for range 5 {
		server.mailKeyBlocked(ctx, authCtx, "quota exceeded: daily token limit")
		server.mailer.Wait()
	}
	server.mailKeyBlocked(ctx, &store.AuthContext{UserID: "u_alice", APIKeyID: "key_cursor"}, "budget")
	server.mailer.Wait()
	_, deliveries := mailDeliveries(t, ts.URL)
	if len(deliveries) != 2 || deliveries[0]["subject_id"] != "key_cursor" || deliveries[1]["subject_id"] != "key_roo" {
		t.Fatalf("deliveries = %v; want one per key however often it is refused", deliveries)
	}
	// A key with no user behind it has nobody to tell.
	server.mailKeyBlocked(ctx, &store.AuthContext{APIKeyID: "key_service"}, "quota")
	server.mailer.Wait()
	if _, deliveries := mailDeliveries(t, ts.URL); len(deliveries) != 2 {
		t.Fatalf("service key produced a delivery: %v", deliveries)
	}
}

func TestReportFailureMailsTheAuthor(t *testing.T) {
	ts, server, db := mailServer(t)
	relay := startFakeRelay(t)
	configureRelay(t, ts.URL, relay)
	ctx := context.Background()
	if err := db.CreateAuthUser(ctx, store.AuthUser{ID: "u_alice", Email: "alice@corp.example", Name: "Alice", Role: "developer", Status: "active"}); err != nil {
		t.Fatal(err)
	}
	report := store.Text2SQLSavedReport{ID: "rep_1", Name: "일간 매출", CreatedBy: "u_alice"}
	server.mailReportFailed(ctx, report, "relation \"sales\" does not exist")
	server.mailReportFailed(ctx, report, "relation \"sales\" does not exist")
	server.mailer.Wait()
	_, deliveries := mailDeliveries(t, ts.URL)
	if len(deliveries) != 1 || deliveries[0]["event"] != mail.EventReportFailed || deliveries[0]["recipient"] != "alice@corp.example" || !strings.Contains(deliveries[0]["subject"].(string), "일간 매출") {
		t.Fatalf("deliveries = %v", deliveries)
	}
}
