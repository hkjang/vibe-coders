// Package mail delivers event notifications through a company SMTP relay.
//
// Internal relays commonly accept mail on port 25 with no credentials and no
// TLS, so authentication and encryption are optional and the transport adapts
// to whatever the server advertises. Nothing here blocks a request: sending
// happens in the background and every attempt is recorded so an administrator
// can see what left the building. The setting names follow MAIL-STANDARD so an
// operator who has configured one internal service has configured them all.
package mail

import (
	"errors"
	"fmt"
	"net"
	"strings"
	"time"
)

var (
	ErrDisabled = errors.New("mail is disabled")
	ErrInvalid  = errors.New("invalid mail configuration")
)

// Events this gateway sends. Each one is something a person is actually
// waiting for: an approver who does not know a request is parked, a requester
// whose call is locked until somebody decides, a key owner whose calls have
// started failing, a report author whose scheduled report silently stopped.
// A plain "something changed" is deliberately not on this list.
const (
	EventApprovalRequested = "approval.requested"
	EventApprovalDecided   = "approval.decided"
	EventKeyBlocked        = "key.blocked"
	EventReportFailed      = "report.failed"
	EventTest              = "test"
)

// Setting keys, named exactly as the standard's table.
const (
	KeyEnabled        = "mail.enabled"
	KeySMTPHost       = "mail.smtp_host"
	KeySMTPPort       = "mail.smtp_port"
	KeySecurity       = "mail.security"
	KeySkipTLSVerify  = "mail.skip_tls_verify"
	KeyUsername       = "mail.username"
	KeyPassword       = "mail.password"
	KeyFromAddress    = "mail.from_address"
	KeyFromName       = "mail.from_name"
	KeyBaseURL        = "mail.base_url"
	KeyTimeoutSeconds = "mail.timeout_seconds"
	KeyNotifyApproval = "mail.notify_approval"
	KeyNotifyKey      = "mail.notify_key_blocked"
	KeyNotifyReport   = "mail.notify_report"
)

// Defaults aim at the common case: an internal relay on port 25 that accepts
// mail from the network without credentials.
const (
	DefaultPort     = 25
	DefaultSecurity = SecurityAuto
	DefaultTimeout  = 10 * time.Second
	DefaultFromName = "vibe-coders"
)

const (
	SecurityAuto     = "auto"
	SecurityNone     = "none"
	SecurityStartTLS = "starttls"
	SecurityTLS      = "tls"
)

// Securities lists the accepted mail.security values, in the order the
// settings screen shows them.
var Securities = []string{SecurityAuto, SecurityNone, SecurityStartTLS, SecurityTLS}

// EventSwitch is one administrator-facing switch and the events it governs.
type EventSwitch struct {
	Key         string
	Events      []string
	Description string
}

// EventSwitches lists the per-event switches. Two sides of one approval share
// a switch: an operator who wants no approval mail wants neither.
var EventSwitches = []EventSwitch{
	{Key: KeyNotifyApproval, Events: []string{EventApprovalRequested, EventApprovalDecided},
		Description: "거버넌스 승인 알림: 승인 대기가 생기면 관리자에게, 결정되면 요청자에게 보냅니다."},
	{Key: KeyNotifyKey, Events: []string{EventKeyBlocked},
		Description: "API 키 차단 알림: 예산·쿼터 때문에 키 호출이 막히기 시작하면 키 소유자에게 보냅니다(키마다 하루 한 통)."},
	{Key: KeyNotifyReport, Events: []string{EventReportFailed},
		Description: "예약 리포트 실패 알림: Text2SQL 예약 리포트가 검증·실행에 실패하면 작성자에게 보냅니다(리포트마다 하루 한 통)."},
}

// Config is one snapshot of the mail settings. Username and Password never
// leave this package in a serialised form.
type Config struct {
	Enabled     bool
	Host        string
	Port        int
	Security    string
	SkipVerify  bool
	Username    string
	Password    string
	FromAddress string
	FromName    string
	BaseURL     string
	Timeout     time.Duration
	// Events holds the per-event switches. An event with no entry is sent, so
	// adding a notification never requires a settings change first.
	Events map[string]bool
}

// DefaultConfig is what a fresh installation runs with: off, and shaped for an
// internal relay should the administrator turn it on.
func DefaultConfig() Config {
	return Config{Port: DefaultPort, Security: DefaultSecurity, Timeout: DefaultTimeout, FromName: DefaultFromName, Events: map[string]bool{}}
}

// Normalized fills defaults and lower-cases the security mode so a value typed
// as "STARTTLS" still matches.
func (c Config) Normalized() Config {
	c.Host = strings.TrimSpace(c.Host)
	c.Security = strings.ToLower(strings.TrimSpace(c.Security))
	c.FromAddress = strings.TrimSpace(c.FromAddress)
	c.FromName = strings.TrimSpace(c.FromName)
	c.BaseURL = strings.TrimRight(strings.TrimSpace(c.BaseURL), "/")
	c.Username = strings.TrimSpace(c.Username)
	if c.Port <= 0 {
		c.Port = DefaultPort
	}
	if c.Security == "" {
		c.Security = DefaultSecurity
	}
	// A relay on the implicit TLS port needs no extra configuration.
	if c.Security == SecurityAuto && c.Port == 465 {
		c.Security = SecurityTLS
	}
	if c.Timeout <= 0 {
		c.Timeout = DefaultTimeout
	}
	if c.FromName == "" {
		c.FromName = DefaultFromName
	}
	if c.FromAddress == "" && c.Host != "" {
		c.FromAddress = "vibe-coders@" + c.Host
	}
	if c.Events == nil {
		c.Events = map[string]bool{}
	}
	return c
}

// Address is the RFC 5322 From header value.
func (c Config) Address() string {
	if c.FromName != "" {
		return fmt.Sprintf("%s <%s>", c.FromName, c.FromAddress)
	}
	return c.FromAddress
}

// PasswordSet reports whether a password is configured without revealing it.
func (c Config) PasswordSet() bool { return c.Password != "" }

func (c Config) endpoint() string { return net.JoinHostPort(c.Host, fmt.Sprint(c.Port)) }

// Allows reports whether an event should be delivered. Unknown events are sent.
func (c Config) Allows(event string) bool {
	if enabled, known := c.Events[event]; known {
		return enabled
	}
	return true
}

// Validate reports why the relay cannot be used yet. It is what the settings
// screen shows next to "켜졌지만 미완성".
func (c Config) Validate() error {
	if c.Host == "" {
		return fmt.Errorf("%w: %s is required", ErrInvalid, KeySMTPHost)
	}
	if c.Port < 1 || c.Port > 65535 {
		return fmt.Errorf("%w: %s must be between 1 and 65535", ErrInvalid, KeySMTPPort)
	}
	if !validAddress(c.FromAddress) {
		return fmt.Errorf("%w: %s must be an email address", ErrInvalid, KeyFromAddress)
	}
	switch c.Security {
	case SecurityAuto, SecurityNone, SecurityStartTLS, SecurityTLS:
	default:
		return fmt.Errorf("%w: %s must be one of %s", ErrInvalid, KeySecurity, strings.Join(Securities, ", "))
	}
	return nil
}

// Ready reports whether mail can be sent at all: on, and complete.
func (c Config) Ready() error {
	if !c.Enabled {
		return ErrDisabled
	}
	return c.Validate()
}

// validAddress is the minimum an SMTP relay needs: one local part, one domain,
// nothing that could smuggle a second header line.
func validAddress(address string) bool {
	at := strings.LastIndex(address, "@")
	if at <= 0 || at == len(address)-1 {
		return false
	}
	return !strings.ContainsAny(address, " \t\r\n<>,;")
}

// ValidAddress is validAddress for callers outside the package (the test-send
// endpoint validates its recipient the same way).
func ValidAddress(address string) bool { return validAddress(strings.TrimSpace(address)) }
