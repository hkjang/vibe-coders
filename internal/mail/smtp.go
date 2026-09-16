package mail

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/smtp"
	"strings"
	"time"
)

// Message is one mail as handed to the relay.
type Message struct {
	To      string
	Subject string
	Body    string
}

// Deliver opens a connection and sends one message. It is exported so the
// settings screen can prove the relay works before anything depends on it.
func Deliver(ctx context.Context, config Config, message Message) error {
	config = config.Normalized()
	if err := config.Validate(); err != nil {
		return err
	}
	to := strings.TrimSpace(message.To)
	if !validAddress(to) {
		return fmt.Errorf("%w: recipient must be an email address", ErrInvalid)
	}
	client, err := dial(ctx, config)
	if err != nil {
		return err
	}
	defer func() { _ = client.Close() }()
	if err := startSession(client, config); err != nil {
		return err
	}
	if err := client.Mail(config.FromAddress); err != nil {
		return fmt.Errorf("MAIL FROM 실패: %w", err)
	}
	if err := client.Rcpt(to); err != nil {
		return fmt.Errorf("RCPT TO 실패: %w", err)
	}
	writer, err := client.Data()
	if err != nil {
		return fmt.Errorf("DATA 실패: %w", err)
	}
	if _, err := writer.Write([]byte(compose(config, message, time.Now()))); err != nil {
		return fmt.Errorf("본문 전송 실패: %w", err)
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("본문 종료 실패: %w", err)
	}
	return client.Quit()
}

func dial(ctx context.Context, config Config) (*smtp.Client, error) {
	dialer := &net.Dialer{Timeout: config.Timeout}
	var connection net.Conn
	var err error
	if config.Security == SecurityTLS {
		connection, err = (&tls.Dialer{NetDialer: dialer, Config: config.tlsConfig()}).DialContext(ctx, "tcp", config.endpoint())
		if err != nil {
			return nil, fmt.Errorf("SMTP TLS 연결 실패: %w", err)
		}
	} else {
		connection, err = dialer.DialContext(ctx, "tcp", config.endpoint())
		if err != nil {
			return nil, fmt.Errorf("SMTP 연결 실패: %w", err)
		}
	}
	// The relay conversation has no context of its own; a deadline on the
	// socket is what keeps a relay that accepts the connection and then goes
	// quiet from holding a goroutine forever.
	if deadline, ok := ctx.Deadline(); ok {
		_ = connection.SetDeadline(deadline)
	} else {
		_ = connection.SetDeadline(time.Now().Add(config.Timeout))
	}
	client, err := smtp.NewClient(connection, config.Host)
	if err != nil {
		_ = connection.Close()
		return nil, fmt.Errorf("SMTP 세션 시작 실패: %w", err)
	}
	return client, nil
}

// startSession upgrades and authenticates only as far as the relay allows, so
// an unauthenticated internal relay works with the same settings as a hosted
// provider that demands both.
func startSession(client *smtp.Client, config Config) error {
	if err := client.Hello(helloName(config)); err != nil {
		return fmt.Errorf("EHLO 실패: %w", err)
	}
	if config.Security == SecurityStartTLS || config.Security == SecurityAuto {
		if supported, _ := client.Extension("STARTTLS"); supported {
			if err := client.StartTLS(config.tlsConfig()); err != nil {
				return fmt.Errorf("STARTTLS 실패: %w", err)
			}
		} else if config.Security == SecurityStartTLS {
			return fmt.Errorf("%w: 서버가 STARTTLS 를 지원하지 않습니다", ErrInvalid)
		}
	}
	if config.Username == "" {
		return nil
	}
	supported, mechanisms := client.Extension("AUTH")
	if !supported {
		return fmt.Errorf("%w: 서버가 인증을 지원하지 않습니다. %s 를 비우고 사용하세요", ErrInvalid, KeyUsername)
	}
	upper := strings.ToUpper(mechanisms)
	var auth smtp.Auth
	switch {
	case strings.Contains(upper, "PLAIN"):
		auth = smtp.PlainAuth("", config.Username, config.Password, config.Host)
	case strings.Contains(upper, "LOGIN"):
		auth = loginAuth{username: config.Username, password: config.Password, host: config.Host}
	default:
		auth = smtp.CRAMMD5Auth(config.Username, config.Password)
	}
	if err := client.Auth(auth); err != nil {
		return fmt.Errorf("SMTP 인증 실패: %w", err)
	}
	return nil
}

func (c Config) tlsConfig() *tls.Config {
	return &tls.Config{ServerName: c.Host, MinVersion: tls.VersionTLS12, InsecureSkipVerify: c.SkipVerify} //nolint:gosec // opt-in for internal relays with private certificates
}

// helloName keeps the EHLO name to the sender domain, which relays that check
// the greeting are happier with than a container hostname.
func helloName(config Config) string {
	if index := strings.LastIndex(config.FromAddress, "@"); index >= 0 && index+1 < len(config.FromAddress) {
		return config.FromAddress[index+1:]
	}
	return "localhost"
}

// loginAuth implements the LOGIN mechanism that several corporate relays use
// instead of PLAIN. The standard library only ships PLAIN and CRAM-MD5.
type loginAuth struct{ username, password, host string }

func (a loginAuth) Start(server *smtp.ServerInfo) (string, []byte, error) {
	if !server.TLS && server.Name != a.host {
		return "", nil, errors.New("LOGIN 인증은 신뢰할 수 있는 서버에서만 사용합니다")
	}
	return "LOGIN", nil, nil
}

func (a loginAuth) Next(fromServer []byte, more bool) ([]byte, error) {
	if !more {
		return nil, nil
	}
	switch strings.ToLower(strings.TrimRight(string(fromServer), ": ")) {
	case "username":
		return []byte(a.username), nil
	case "password":
		return []byte(a.password), nil
	}
	return nil, fmt.Errorf("알 수 없는 LOGIN 요청: %s", fromServer)
}
