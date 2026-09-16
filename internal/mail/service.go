package mail

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"strings"
	"sync"
	"time"
)

// Delivery is one attempt to send one mail: who, what, and whether it went.
// The body is deliberately absent — a log that carried bodies would itself be
// a leak. Subject and recipient are enough to answer "did it go?".
type Delivery struct {
	ID           string    `json:"id"`
	Event        string    `json:"event"`
	Recipient    string    `json:"recipient"`
	Subject      string    `json:"subject"`
	SubjectID    string    `json:"subject_id,omitempty"`
	ActorID      string    `json:"actor_id,omitempty"`
	Status       string    `json:"status"` // queued | sent | failed
	Attempts     int       `json:"attempts"`
	ErrorMessage string    `json:"error_message,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

const (
	StatusQueued = "queued"
	StatusSent   = "sent"
	StatusFailed = "failed"
)

// Ledger records deliveries. The store implements it; nil means "do not record".
type Ledger interface {
	RecordMailDelivery(ctx context.Context, delivery Delivery) error
	CompleteMailDelivery(ctx context.Context, id, status string, attempts int, errorMessage string, at time.Time) error
	// MailDeliveryAttemptedSince reports whether any delivery (sent or not) for
	// the same event, recipient and subject was recorded after since.
	MailDeliveryAttemptedSince(ctx context.Context, event, recipient, subjectID string, since time.Time) (bool, error)
}

// Directory resolves account identifiers to addresses. The gateway already
// knows its users; mail borrows that lookup rather than keeping a second list.
type Directory interface {
	LookupEmails(ctx context.Context, ids []string) (map[string]string, error)
}

// Service sends event notifications in the background and records each one.
type Service struct {
	config    func() Config
	ledger    Ledger
	directory Directory
	logger    *slog.Logger
	send      func(context.Context, Config, Message) error
	now       func() time.Time
	// window is how long a first notification waits for companions before it
	// is sent. A single approval decision that parks three requests becomes
	// one mail per approver instead of three.
	window  time.Duration
	mu      sync.Mutex
	pending map[string]*batch
	// recent remembers what RepeatAfter has already let through, so two
	// refusals a millisecond apart cannot both read "nothing yet" from the
	// ledger and both go.
	recent map[string]time.Time
	wg     sync.WaitGroup
}

type batch struct {
	address string
	config  Config
	items   []Notification
}

// DefaultBatchWindow is short enough that an approver still sees the mail
// promptly and long enough to fold a burst into one message.
const DefaultBatchWindow = 15 * time.Second

// NewService wires the mail service. config is read on every notification so
// a settings change applies without a restart.
func NewService(config func() Config, ledger Ledger, directory Directory, logger *slog.Logger) *Service {
	if logger == nil {
		logger = slog.Default()
	}
	if config == nil {
		config = DefaultConfig
	}
	return &Service{
		config: config, ledger: ledger, directory: directory, logger: logger,
		send: Deliver, now: func() time.Time { return time.Now().UTC() },
		window: DefaultBatchWindow, pending: map[string]*batch{}, recent: map[string]time.Time{},
	}
}

// SetSender replaces the transport, which lets tests drive the service without
// a real relay.
func (s *Service) SetSender(sender func(context.Context, Config, Message) error) { s.send = sender }

// SetBatchWindow changes how long notifications wait for companions; zero
// sends each one immediately.
func (s *Service) SetBatchWindow(window time.Duration) { s.window = window }

// Wait blocks until every background delivery has finished. Tests and a
// graceful shutdown use it; request handlers never do.
func (s *Service) Wait() { s.wg.Wait() }

// Notify resolves the recipients and sends in the background, so no request
// waits on a mail server and a dead relay is a line in the delivery log, not
// an error for the caller. The actor never hears about their own action;
// recipients without an address are skipped quietly.
func (s *Service) Notify(ctx context.Context, notification Notification, actorID string, recipients []string) {
	config := s.config().Normalized()
	if !config.Enabled || !config.Allows(notification.Event) || len(recipients) == 0 {
		return
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		// Detached from the request: the caller's context ends with its response.
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), config.Timeout+5*time.Second)
		defer cancel()
		s.dispatch(ctx, config, notification, actorID, recipients)
	}()
}

func (s *Service) dispatch(ctx context.Context, config Config, notification Notification, actorID string, recipients []string) {
	addresses := s.resolve(ctx, recipients, actorID)
	if len(addresses) == 0 {
		return
	}
	invalid := config.Validate()
	for _, address := range addresses {
		if s.attemptedRecently(ctx, notification, address) {
			continue
		}
		if invalid != nil {
			// The event happened and the mail did not go: the log says why, so
			// the administrator learns it from the delivery screen rather than
			// from a colleague asking where the mail is.
			delivery := s.record(ctx, notification, address, actorID)
			s.complete(ctx, delivery, invalid)
			continue
		}
		s.enqueue(ctx, config, notification, address, actorID)
	}
}

// SendNow delivers immediately and reports the outcome, which is what the
// administrator's test button needs. It goes even when the event switch for
// its kind is off, but never when mail as a whole is off or incomplete.
func (s *Service) SendNow(ctx context.Context, notification Notification, actorID, recipient string) error {
	config := s.config().Normalized()
	if err := config.Ready(); err != nil {
		return err
	}
	recipient = strings.TrimSpace(recipient)
	delivery := s.record(ctx, notification, recipient, actorID)
	sendContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), config.Timeout+5*time.Second)
	defer cancel()
	delivery.Attempts = 1
	err := s.send(sendContext, config, Message{To: recipient, Subject: notification.Subject, Body: notification.Render(config)})
	s.complete(sendContext, delivery, err)
	return err
}

func (s *Service) attemptedRecently(ctx context.Context, notification Notification, address string) bool {
	if notification.RepeatAfter <= 0 || notification.SubjectID == "" {
		return false
	}
	now := s.now()
	key := notification.Event + "\n" + strings.ToLower(address) + "\n" + notification.SubjectID
	s.mu.Lock()
	defer s.mu.Unlock()
	for other, expiry := range s.recent {
		if !expiry.After(now) {
			delete(s.recent, other)
		}
	}
	if expiry, ok := s.recent[key]; ok && expiry.After(now) {
		return true
	}
	if s.ledger != nil {
		seen, err := s.ledger.MailDeliveryAttemptedSince(ctx, notification.Event, address, notification.SubjectID, now.Add(-notification.RepeatAfter))
		if err != nil {
			s.logger.Warn("mail delivery history was not read", "error", err)
		} else if seen {
			s.recent[key] = now.Add(notification.RepeatAfter)
			return true
		}
	}
	s.recent[key] = now.Add(notification.RepeatAfter)
	return false
}

// enqueue holds a notification for a short window so companions for the same
// recipient and event travel in one mail.
func (s *Service) enqueue(ctx context.Context, config Config, notification Notification, address, actorID string) {
	if s.window <= 0 {
		s.flush(ctx, config, address, actorID, []Notification{notification})
		return
	}
	key := notification.Event + "\n" + strings.ToLower(address) + "\n" + actorID
	s.mu.Lock()
	defer s.mu.Unlock()
	if pending, ok := s.pending[key]; ok {
		pending.items = append(pending.items, notification)
		return
	}
	s.pending[key] = &batch{address: address, config: config, items: []Notification{notification}}
	s.wg.Add(1)
	time.AfterFunc(s.window, func() {
		defer s.wg.Done()
		s.mu.Lock()
		pending := s.pending[key]
		delete(s.pending, key)
		s.mu.Unlock()
		if pending == nil {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*pending.config.Timeout+20*time.Second)
		defer cancel()
		s.flush(ctx, pending.config, pending.address, actorID, pending.items)
	})
}

func (s *Service) flush(ctx context.Context, config Config, address, actorID string, items []Notification) {
	notification := merge(items)
	delivery := s.record(ctx, notification, address, actorID)
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*config.Timeout+20*time.Second)
		defer cancel()
		s.deliver(ctx, delivery, config, Message{To: address, Subject: notification.Subject, Body: notification.Render(config)})
	}()
}

// deliver retries once, because a relay that briefly refuses a connection is
// common and losing the notification is worse than a short wait.
func (s *Service) deliver(ctx context.Context, delivery Delivery, config Config, message Message) {
	var err error
	for attempt := 1; attempt <= 2; attempt++ {
		delivery.Attempts = attempt
		if err = s.send(ctx, config, message); err == nil {
			break
		}
		if attempt == 1 {
			select {
			case <-ctx.Done():
			case <-time.After(2 * time.Second):
			}
		}
	}
	s.complete(ctx, delivery, err)
}

func (s *Service) record(ctx context.Context, notification Notification, address, actorID string) Delivery {
	now := s.now()
	delivery := Delivery{
		ID: newID(), Event: notification.Event, Recipient: address, Subject: trim(headerText(notification.Subject), 300),
		SubjectID: notification.SubjectID, ActorID: actorID, Status: StatusQueued, CreatedAt: now, UpdatedAt: now,
	}
	if s.ledger == nil {
		return delivery
	}
	if err := s.ledger.RecordMailDelivery(ctx, delivery); err != nil {
		s.logger.Warn("mail delivery was not recorded", "error", err)
	}
	return delivery
}

func (s *Service) complete(ctx context.Context, delivery Delivery, cause error) {
	status, message := StatusSent, ""
	if cause != nil {
		status, message = StatusFailed, cause.Error()
		// The recipient and event are enough to find the row; the password is
		// never part of an error and the body is never logged.
		s.logger.Warn("notification mail failed", "event", delivery.Event, "recipient", delivery.Recipient, "error", cause)
	}
	if s.ledger == nil {
		return
	}
	if err := s.ledger.CompleteMailDelivery(ctx, delivery.ID, status, max(delivery.Attempts, 1), trim(message, 1000), s.now()); err != nil {
		s.logger.Warn("mail delivery status was not recorded", "error", err)
	}
}

// resolve turns account identifiers into unique addresses, dropping the actor
// so nobody is told about their own action — by identifier and, once the
// directory has answered, by address too.
func (s *Service) resolve(ctx context.Context, recipients []string, actorID string) []string {
	actor := strings.ToLower(strings.TrimSpace(actorID))
	wanted := make([]string, 0, len(recipients)+1)
	for _, recipient := range recipients {
		trimmed := strings.TrimSpace(recipient)
		if trimmed == "" || strings.ToLower(trimmed) == actor {
			continue
		}
		wanted = append(wanted, trimmed)
	}
	if len(wanted) == 0 {
		return nil
	}
	emails := map[string]string{}
	if s.directory != nil {
		lookup := wanted
		if actor != "" {
			lookup = append(append([]string{}, wanted...), actorID)
		}
		resolved, err := s.directory.LookupEmails(ctx, lookup)
		if err != nil {
			s.logger.Warn("mail recipients were not resolved", "error", err)
			return nil
		}
		for id, email := range resolved {
			emails[strings.ToLower(strings.TrimSpace(id))] = strings.TrimSpace(email)
		}
	}
	actorAddress := strings.ToLower(emails[actor])
	if actorAddress == "" && strings.Contains(actor, "@") {
		actorAddress = actor
	}
	seen, addresses := map[string]struct{}{}, make([]string, 0, len(wanted))
	for _, recipient := range wanted {
		address := emails[strings.ToLower(recipient)]
		if address == "" && validAddress(recipient) {
			// An identifier that is already an address needs no directory entry.
			address = recipient
		}
		if !validAddress(address) {
			continue
		}
		key := strings.ToLower(address)
		if key == actorAddress {
			continue
		}
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		addresses = append(addresses, address)
	}
	return addresses
}

func newID() string {
	var raw [12]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "mail_" + hex.EncodeToString([]byte(time.Now().UTC().Format(time.RFC3339Nano)))
	}
	return "mail_" + hex.EncodeToString(raw[:])
}

func trim(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}
