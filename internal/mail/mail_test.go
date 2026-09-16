package mail

import (
	"bufio"
	"context"
	"errors"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeRelay is a minimal SMTP server. It records the conversation so a test
// can assert what the gateway actually said, including whether it tried to
// authenticate.
type fakeRelay struct {
	address   string
	offerAuth bool
	rejectAll bool
	mu        sync.Mutex
	commands  []string
	bodies    []string
	listener  net.Listener
}

func startRelay(t *testing.T, offerAuth bool) *fakeRelay {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	relay := &fakeRelay{address: listener.Addr().String(), offerAuth: offerAuth, listener: listener}
	go relay.serve()
	t.Cleanup(func() { _ = listener.Close() })
	return relay
}

func (f *fakeRelay) config() Config {
	host, port, _ := net.SplitHostPort(f.address)
	number, _ := strconv.Atoi(port)
	return Config{Enabled: true, Host: host, Port: number, FromAddress: "gateway@corp.example", Security: SecurityNone, Timeout: 2 * time.Second, BaseURL: "https://gateway.corp.example/"}
}

func (f *fakeRelay) transcript() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.commands...)
}

func (f *fakeRelay) mails() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.bodies...)
}

func (f *fakeRelay) serve() {
	for {
		connection, err := f.listener.Accept()
		if err != nil {
			return
		}
		go f.handle(connection)
	}
}

func (f *fakeRelay) handle(connection net.Conn) {
	defer connection.Close()
	reader := bufio.NewReader(connection)
	write := func(line string) { _, _ = connection.Write([]byte(line + "\r\n")) }
	write("220 relay.internal ESMTP test")
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return
		}
		command := strings.TrimSpace(line)
		f.mu.Lock()
		f.commands = append(f.commands, command)
		f.mu.Unlock()
		upper := strings.ToUpper(command)
		switch {
		case strings.HasPrefix(upper, "EHLO"):
			write("250-relay.internal")
			if f.offerAuth {
				write("250-AUTH PLAIN LOGIN")
			}
			write("250 SIZE 35882577")
		case strings.HasPrefix(upper, "AUTH"):
			write("235 2.7.0 Authentication successful")
		case strings.HasPrefix(upper, "MAIL FROM"):
			if f.rejectAll {
				write("550 5.7.1 Sender rejected")
				continue
			}
			write("250 2.1.0 Ok")
		case strings.HasPrefix(upper, "RCPT TO"):
			write("250 2.1.5 Ok")
		case upper == "DATA":
			write("354 End data with <CR><LF>.<CR><LF>")
			var body strings.Builder
			for {
				dataLine, err := reader.ReadString('\n')
				if err != nil {
					return
				}
				if strings.TrimRight(dataLine, "\r\n") == "." {
					break
				}
				body.WriteString(dataLine)
			}
			f.mu.Lock()
			f.bodies = append(f.bodies, body.String())
			f.mu.Unlock()
			write("250 2.0.0 Ok: queued")
		case upper == "QUIT":
			write("221 2.0.0 Bye")
			return
		default:
			write("250 Ok")
		}
	}
}

// memoryLedger is the in-memory stand-in for the store.
type memoryLedger struct {
	mu         sync.Mutex
	deliveries map[string]*Delivery
	order      []string
}

func newMemoryLedger() *memoryLedger { return &memoryLedger{deliveries: map[string]*Delivery{}} }

func (m *memoryLedger) RecordMailDelivery(_ context.Context, delivery Delivery) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	copied := delivery
	m.deliveries[delivery.ID] = &copied
	m.order = append(m.order, delivery.ID)
	return nil
}

func (m *memoryLedger) CompleteMailDelivery(_ context.Context, id, status string, attempts int, errorMessage string, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delivery := m.deliveries[id]
	delivery.Status, delivery.Attempts, delivery.ErrorMessage, delivery.UpdatedAt = status, attempts, errorMessage, at
	return nil
}

func (m *memoryLedger) MailDeliveryAttemptedSince(_ context.Context, event, recipient, subjectID string, since time.Time) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, delivery := range m.deliveries {
		if delivery.Event == event && strings.EqualFold(delivery.Recipient, recipient) && delivery.SubjectID == subjectID && !delivery.CreatedAt.Before(since) {
			return true, nil
		}
	}
	return false, nil
}

func (m *memoryLedger) list() []Delivery {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Delivery, 0, len(m.order))
	for _, id := range m.order {
		out = append(out, *m.deliveries[id])
	}
	return out
}

type staticDirectory map[string]string

func (d staticDirectory) LookupEmails(_ context.Context, ids []string) (map[string]string, error) {
	out := map[string]string{}
	for _, id := range ids {
		if email, ok := d[id]; ok {
			out[id] = email
		}
	}
	return out, nil
}

var users = staticDirectory{"u_alice": "alice@corp.example", "u_bob": "bob@corp.example", "u_carol": "carol@corp.example"}

func newTestService(config Config, ledger *memoryLedger) *Service {
	service := NewService(func() Config { return config }, ledger, users, nil)
	service.SetBatchWindow(0)
	return service
}

func TestDeliverTalksPlainSMTPToAnUnauthenticatedRelay(t *testing.T) {
	relay := startRelay(t, false)
	config := relay.config()
	config.FromName = "게이트웨이"
	err := Deliver(context.Background(), config, Message{To: "alice@corp.example", Subject: "승인 대기", Body: "첫 줄\n.둘째 줄은 점으로 시작"})
	if err != nil {
		t.Fatalf("deliver: %v", err)
	}
	transcript := strings.Join(relay.transcript(), "\n")
	if !strings.Contains(transcript, "EHLO corp.example") || strings.Contains(transcript, "AUTH") || strings.Contains(transcript, "STARTTLS") {
		t.Fatalf("relay conversation = %q; want plain EHLO without AUTH/STARTTLS", transcript)
	}
	mails := relay.mails()
	if len(mails) != 1 {
		t.Fatalf("relay received %d mails, want 1", len(mails))
	}
	mail := mails[0]
	for _, want := range []string{"From: =?utf-8?q?", "<gateway@corp.example>", "To: alice@corp.example", "Subject: =?utf-8?q?", "Auto-Submitted: auto-generated", "\r\n..\xeb\x91\x98\xec\xa7\xb8"} {
		if !strings.Contains(mail, want) {
			t.Errorf("mail lacks %q:\n%s", want, mail)
		}
	}
}

func TestDeliverAuthenticatesOnlyWhenAUsernameIsSet(t *testing.T) {
	relay := startRelay(t, true)
	config := relay.config()
	if err := Deliver(context.Background(), config, Message{To: "alice@corp.example", Subject: "x", Body: "y"}); err != nil {
		t.Fatalf("deliver without credentials: %v", err)
	}
	if transcript := strings.Join(relay.transcript(), "\n"); strings.Contains(transcript, "AUTH") {
		t.Fatalf("no username configured but the client authenticated:\n%s", transcript)
	}
	config.Username, config.Password = "svc", "secret"
	if err := Deliver(context.Background(), config, Message{To: "alice@corp.example", Subject: "x", Body: "y"}); err != nil {
		t.Fatalf("deliver with credentials: %v", err)
	}
	transcript := strings.Join(relay.transcript(), "\n")
	if !strings.Contains(transcript, "AUTH PLAIN") {
		t.Fatalf("username configured but no AUTH PLAIN:\n%s", transcript)
	}
	if strings.Contains(transcript, "secret") {
		t.Fatalf("password appeared in clear in the transcript")
	}
}

func TestDeliverRejectsAnIncompleteConfiguration(t *testing.T) {
	cases := map[string]Config{
		"no host":       {Enabled: true, FromAddress: "a@b"},
		"bad from":      {Enabled: true, Host: "relay", FromAddress: "nobody"},
		"bad security":  {Enabled: true, Host: "relay", FromAddress: "a@b", Security: "ssl"},
		"bad port":      {Enabled: true, Host: "relay", FromAddress: "a@b", Port: 70000},
		"bad recipient": {Enabled: true, Host: "relay", FromAddress: "a@b"},
	}
	for name, config := range cases {
		to := "alice@corp.example"
		if name == "bad recipient" {
			to = "alice"
		}
		err := Deliver(context.Background(), config, Message{To: to})
		if !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: err = %v, want ErrInvalid", name, err)
		}
	}
}

func TestNormalizedFillsInternalRelayDefaults(t *testing.T) {
	config := Config{Host: " relay.corp ", Security: " STARTTLS "}.Normalized()
	if config.Port != 25 || config.Security != SecurityStartTLS || config.Timeout != DefaultTimeout || config.FromAddress != "vibe-coders@relay.corp" || config.FromName != DefaultFromName {
		t.Fatalf("normalized = %+v", config)
	}
	if implicit := (Config{Host: "relay", Port: 465}).Normalized(); implicit.Security != SecurityTLS {
		t.Fatalf("port 465 should imply tls, got %s", implicit.Security)
	}
}

func TestNotifyDoesNothingWhileDisabled(t *testing.T) {
	relay := startRelay(t, false)
	config := relay.config()
	config.Enabled = false
	ledger := newMemoryLedger()
	service := newTestService(config, ledger)
	service.Notify(context.Background(), TestMessage(), "", []string{"u_alice"})
	service.Wait()
	if len(ledger.list()) != 0 || len(relay.mails()) != 0 {
		t.Fatalf("disabled mail produced deliveries=%v mails=%d", ledger.list(), len(relay.mails()))
	}
	if err := service.SendNow(context.Background(), TestMessage(), "", "alice@corp.example"); !errors.Is(err, ErrDisabled) {
		t.Fatalf("SendNow while disabled = %v, want ErrDisabled", err)
	}
}

func TestNotifyRecordsWhyAnIncompleteConfigurationSentNothing(t *testing.T) {
	config := Config{Enabled: true, Host: "", FromAddress: "gateway@corp.example"}
	ledger := newMemoryLedger()
	service := newTestService(config, ledger)
	sent := 0
	service.SetSender(func(context.Context, Config, Message) error { sent++; return nil })
	service.Notify(context.Background(), ApprovalRequested("appr_1", "alice", "gpt", "policy", 0), "", []string{"u_bob"})
	service.Wait()
	deliveries := ledger.list()
	if sent != 0 || len(deliveries) != 1 || deliveries[0].Status != StatusFailed || !strings.Contains(deliveries[0].ErrorMessage, KeySMTPHost) {
		t.Fatalf("sent=%d deliveries=%+v", sent, deliveries)
	}
}

func TestNotifyNeverBlocksOnADeadRelay(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close() // nothing listens here any more
	host, port, _ := net.SplitHostPort(address)
	number, _ := strconv.Atoi(port)
	config := Config{Enabled: true, Host: host, Port: number, FromAddress: "gateway@corp.example", Security: SecurityNone, Timeout: time.Second}
	ledger := newMemoryLedger()
	service := newTestService(config, ledger)

	started := time.Now()
	service.Notify(context.Background(), ApprovalRequested("appr_1", "alice", "gpt", "policy", 0), "", []string{"u_bob"})
	if elapsed := time.Since(started); elapsed > 200*time.Millisecond {
		t.Fatalf("Notify took %s; it must return immediately", elapsed)
	}
	service.Wait()
	deliveries := ledger.list()
	if len(deliveries) != 1 || deliveries[0].Status != StatusFailed || deliveries[0].Attempts != 2 || deliveries[0].ErrorMessage == "" {
		t.Fatalf("dead relay delivery = %+v; want failed after 2 attempts with a reason", deliveries)
	}
}

func TestNotifySkipsTheActorAndDuplicates(t *testing.T) {
	relay := startRelay(t, false)
	ledger := newMemoryLedger()
	service := newTestService(relay.config(), ledger)
	// alice acted; she is listed by id, by address, and bob twice.
	service.Notify(context.Background(), ApprovalRequested("appr_1", "alice", "gpt", "policy", 0), "u_alice",
		[]string{"u_alice", "alice@corp.example", "u_bob", "bob@corp.example", "U_BOB", "u_nobody", ""})
	service.Wait()
	deliveries := ledger.list()
	if len(deliveries) != 1 || deliveries[0].Recipient != "bob@corp.example" || deliveries[0].Status != StatusSent || deliveries[0].ActorID != "u_alice" {
		t.Fatalf("deliveries = %+v; want exactly one sent mail to bob", deliveries)
	}
	if mails := relay.mails(); len(mails) != 1 || !strings.Contains(mails[0], "To: bob@corp.example") {
		t.Fatalf("relay mails = %v", mails)
	}
}

func TestNotifyHonoursEventSwitches(t *testing.T) {
	relay := startRelay(t, false)
	config := relay.config()
	config.Events = map[string]bool{EventApprovalRequested: false}
	ledger := newMemoryLedger()
	service := newTestService(config, ledger)
	service.Notify(context.Background(), ApprovalRequested("appr_1", "alice", "gpt", "policy", 0), "", []string{"u_bob"})
	service.Notify(context.Background(), ReportFailed("rep_1", "일간 매출", "syntax error"), "", []string{"u_bob"})
	service.Wait()
	deliveries := ledger.list()
	if len(deliveries) != 1 || deliveries[0].Event != EventReportFailed {
		t.Fatalf("deliveries = %+v; want only the report mail", deliveries)
	}
}

func TestNotifyRecordsSuccessAndFailure(t *testing.T) {
	relay := startRelay(t, false)
	ledger := newMemoryLedger()
	service := newTestService(relay.config(), ledger)
	service.Notify(context.Background(), ApprovalDecided("appr_1", "approved", "gpt"), "u_admin", []string{"u_alice"})
	service.Wait()
	relay.rejectAll = true
	service.Notify(context.Background(), ApprovalDecided("appr_2", "rejected", "gpt"), "u_admin", []string{"u_alice"})
	service.Wait()
	deliveries := ledger.list()
	if len(deliveries) != 2 || deliveries[0].Status != StatusSent || deliveries[1].Status != StatusFailed || !strings.Contains(deliveries[1].ErrorMessage, "MAIL FROM") {
		t.Fatalf("deliveries = %+v", deliveries)
	}
	for _, delivery := range deliveries {
		if strings.Contains(delivery.Subject, "\n") || delivery.Subject == "" {
			t.Fatalf("subject not recorded cleanly: %q", delivery.Subject)
		}
	}
}

func TestNotifyRepeatsAtMostOncePerWindow(t *testing.T) {
	relay := startRelay(t, false)
	ledger := newMemoryLedger()
	service := newTestService(relay.config(), ledger)
	for range 3 {
		service.Notify(context.Background(), KeyBlocked("key_1", "roo", "quota exceeded"), "", []string{"u_alice"})
		service.Wait()
	}
	// A different key is different news.
	service.Notify(context.Background(), KeyBlocked("key_2", "cursor", "budget"), "", []string{"u_alice"})
	service.Wait()
	if deliveries := ledger.list(); len(deliveries) != 2 || deliveries[0].SubjectID != "key_1" || deliveries[1].SubjectID != "key_2" {
		t.Fatalf("deliveries = %+v; want one per key", deliveries)
	}
}

func TestNotifyBundlesABurstIntoOneMail(t *testing.T) {
	relay := startRelay(t, false)
	ledger := newMemoryLedger()
	service := NewService(func() Config { return relay.config() }, ledger, users, nil)
	service.SetBatchWindow(50 * time.Millisecond)
	for index := range 3 {
		service.Notify(context.Background(), ApprovalRequested("appr_"+strconv.Itoa(index), "alice", "gpt", "policy", 0), "u_alice", []string{"u_bob", "u_carol"})
	}
	service.Wait()
	deliveries := ledger.list()
	if len(deliveries) != 2 {
		t.Fatalf("deliveries = %+v; want one bundled mail per approver", deliveries)
	}
	for _, delivery := range deliveries {
		if delivery.Subject != "[vibe-coders] 승인 대기 3건" || delivery.Status != StatusSent {
			t.Fatalf("bundled delivery = %+v", delivery)
		}
	}
	mails := relay.mails()
	if len(mails) != 2 || strings.Count(mails[0], "appr_") != 3 {
		t.Fatalf("relay mails = %d, first body mentions %d approvals", len(mails), strings.Count(mails[0], "appr_"))
	}
}

func TestSendNowReportsTheOutcomeAndRecordsIt(t *testing.T) {
	relay := startRelay(t, false)
	ledger := newMemoryLedger()
	service := newTestService(relay.config(), ledger)
	if err := service.SendNow(context.Background(), TestMessage(), "u_admin", "alice@corp.example"); err != nil {
		t.Fatalf("SendNow: %v", err)
	}
	relay.rejectAll = true
	if err := service.SendNow(context.Background(), TestMessage(), "u_admin", "alice@corp.example"); err == nil {
		t.Fatal("SendNow against a rejecting relay returned nil")
	}
	deliveries := ledger.list()
	if len(deliveries) != 2 || deliveries[0].Status != StatusSent || deliveries[1].Status != StatusFailed || deliveries[0].Event != EventTest {
		t.Fatalf("deliveries = %+v", deliveries)
	}
	if body := relay.mails()[0]; !strings.Contains(body, "https://gateway.corp.example/app/system/settings?tab=mail") {
		t.Fatalf("test mail lacks the console link:\n%s", body)
	}
}

func TestRenderOmitsTheLinkWithoutABaseURL(t *testing.T) {
	body := ApprovalRequested("appr_1", "alice", "gpt-4o", "risk", 1234).Render(Config{})
	if strings.Contains(body, "바로 열기") || !strings.Contains(body, "예상 비용: 1234 KRW") {
		t.Fatalf("body = %q", body)
	}
	if !strings.Contains(KeyBlocked("k", "roo", "x").Render(Config{BaseURL: "https://g"}), "바로 열기: https://g/app/me") {
		t.Fatal("link missing")
	}
}
