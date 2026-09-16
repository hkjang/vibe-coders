package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/mail"
	"vibe-coders/internal/store"
)

// Mail notifications: the gateway tells the one person who is waiting — an
// approver, a requester, a key owner, a report author — through the company
// SMTP relay. Everything is sent in the background and recorded; see
// internal/mail. Settings live in the "mail" category so the ordinary settings
// screen edits them; this file adds the runtime snapshot, the delivery log and
// test-send endpoints, and the event hooks the handlers call.

func mailSettingDefs() []settingDef {
	constant := func(value string) func(config.Config) string {
		return func(config.Config) string { return value }
	}
	port := func(value string) error {
		n, err := strconv.Atoi(strings.TrimSpace(value))
		if err != nil || n < 1 || n > 65535 {
			return fmt.Errorf("must be a port between 1 and 65535")
		}
		return nil
	}
	seconds := func(value string) error {
		n, err := strconv.Atoi(strings.TrimSpace(value))
		if err != nil || n < 1 || n > 300 {
			return fmt.Errorf("must be between 1 and 300 seconds")
		}
		return nil
	}
	security := func(value string) error {
		value = strings.ToLower(strings.TrimSpace(value))
		for _, option := range mail.Securities {
			if value == option {
				return nil
			}
		}
		return fmt.Errorf("must be one of %s", strings.Join(mail.Securities, "|"))
	}
	optionalAddress := func(value string) error {
		if strings.TrimSpace(value) == "" || mail.ValidAddress(value) {
			return nil
		}
		return fmt.Errorf("must be an email address")
	}
	optionalURL := func(value string) error {
		value = strings.TrimSpace(value)
		if value == "" {
			return nil
		}
		parsed, err := url.Parse(value)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return fmt.Errorf("must be an http(s) URL")
		}
		return nil
	}
	defs := []settingDef{
		{Key: mail.KeyEnabled, Category: "mail", Type: stBool, envValue: constant("false")},
		{Key: mail.KeySMTPHost, Category: "mail", Type: stString, envValue: constant("")},
		{Key: mail.KeySMTPPort, Category: "mail", Type: stInt, validate: port, envValue: constant(strconv.Itoa(mail.DefaultPort))},
		{Key: mail.KeySecurity, Category: "mail", Type: stString, validate: security, envValue: constant(mail.DefaultSecurity)},
		{Key: mail.KeySkipTLSVerify, Category: "mail", Type: stBool, envValue: constant("false")},
		{Key: mail.KeyUsername, Category: "mail", Type: stString, envValue: constant("")},
		{Key: mail.KeyPassword, Category: "mail", Type: stString, Secret: true, envValue: constant("")},
		{Key: mail.KeyFromAddress, Category: "mail", Type: stString, validate: optionalAddress, envValue: constant("")},
		{Key: mail.KeyFromName, Category: "mail", Type: stString, envValue: constant(mail.DefaultFromName)},
		{Key: mail.KeyBaseURL, Category: "mail", Type: stString, validate: optionalURL, envValue: constant("")},
		{Key: mail.KeyTimeoutSeconds, Category: "mail", Type: stInt, validate: seconds, envValue: constant(strconv.Itoa(int(mail.DefaultTimeout / time.Second)))},
	}
	for _, event := range mail.EventSwitches {
		defs = append(defs, settingDef{Key: event.Key, Category: "mail", Type: stBool, envValue: constant("true")})
	}
	return defs
}

func init() {
	settingDescriptions[mail.KeyEnabled] = "메일 알림 발송 여부. 기본 꺼짐. 켜도 아래 relay 설정이 완성되기 전에는 보내지 않고 발송 기록에 이유만 남깁니다."
	settingDescriptions[mail.KeySMTPHost] = "사내 SMTP 릴레이 주소(예: relay.corp.example 또는 postra)."
	settingDescriptions[mail.KeySMTPPort] = "릴레이 포트. 사내 릴레이는 대개 25, 제출 포트는 587, 암시적 TLS 는 465."
	settingDescriptions[mail.KeySecurity] = "auto(서버가 STARTTLS 를 알리면 사용)·none·starttls(필수)·tls(암시적 TLS). 포트 465 는 auto 에서 tls 로 취급."
	settingDescriptions[mail.KeySkipTLSVerify] = "릴레이 인증서 검증 생략. 사내 인증서가 사설일 때만 켭니다."
	settingDescriptions[mail.KeyUsername] = "SMTP 인증 사용자 이름. 인증 없는 릴레이가 흔하므로 비워 두면 인증하지 않습니다."
	settingDescriptions[mail.KeyPassword] = "SMTP 인증 비밀번호. 저장 뒤에는 '설정됨'만 보이고 API 도 돌려주지 않습니다."
	settingDescriptions[mail.KeyFromAddress] = "보내는 사람 주소. 비우면 vibe-coders@<smtp_host>."
	settingDescriptions[mail.KeyFromName] = "보내는 사람 표시 이름."
	settingDescriptions[mail.KeyBaseURL] = "메일 속 '바로 열기' 링크가 가리킬 이 게이트웨이의 주소(예: https://gateway.corp.example). 비우면 링크를 넣지 않습니다."
	settingDescriptions[mail.KeyTimeoutSeconds] = "릴레이 연결·발송 제한 시간(초)."
	for _, event := range mail.EventSwitches {
		settingDescriptions[event.Key] = event.Description
	}
}

// mailConf returns the runtime mail snapshot; off until the first settings reload.
func (s *Server) mailConf() mail.Config {
	if value := s.mailRuntime.Load(); value != nil {
		return *value
	}
	return mail.DefaultConfig()
}

func (s *Server) reloadMailRuntime(stored map[string]store.AdminSetting) {
	get := func(key string) string {
		def, ok := settingDefByKey(key)
		if !ok {
			return ""
		}
		value, _, _ := s.effectiveSettingValue(stored, def)
		return strings.TrimSpace(value)
	}
	boolValue := func(key string, fallback bool) bool {
		value, err := strconv.ParseBool(get(key))
		if err != nil {
			return fallback
		}
		return value
	}
	intValue := func(key string, fallback int) int {
		value, err := strconv.Atoi(get(key))
		if err != nil {
			return fallback
		}
		return value
	}
	conf := mail.Config{
		Enabled:     boolValue(mail.KeyEnabled, false),
		Host:        get(mail.KeySMTPHost),
		Port:        intValue(mail.KeySMTPPort, mail.DefaultPort),
		Security:    get(mail.KeySecurity),
		SkipVerify:  boolValue(mail.KeySkipTLSVerify, false),
		Username:    get(mail.KeyUsername),
		Password:    get(mail.KeyPassword),
		FromAddress: get(mail.KeyFromAddress),
		FromName:    get(mail.KeyFromName),
		BaseURL:     get(mail.KeyBaseURL),
		Timeout:     time.Duration(intValue(mail.KeyTimeoutSeconds, int(mail.DefaultTimeout/time.Second))) * time.Second,
		Events:      map[string]bool{},
	}
	for _, event := range mail.EventSwitches {
		enabled := boolValue(event.Key, true)
		for _, name := range event.Events {
			conf.Events[name] = enabled
		}
	}
	conf = conf.Normalized()
	s.mailRuntime.Store(&conf)
}

// mailDirectory adapts the users table for the mail service.
type mailDirectory struct{ db *store.SQLStore }

func (d mailDirectory) LookupEmails(ctx context.Context, ids []string) (map[string]string, error) {
	return d.db.LookupUserEmails(ctx, ids)
}

// notifyMail sends one event mail. Every caller is on a request path or a
// worker tick, so nothing here returns an error to them.
func (s *Server) notifyMail(ctx context.Context, notification mail.Notification, actorID string, recipients []string) {
	if s.mailer == nil || len(recipients) == 0 {
		return
	}
	s.mailer.Notify(ctx, notification, actorID, recipients)
}

// mailWants reports whether an event would be sent at all, so callers skip the
// directory lookups that assemble recipients when nobody would get a mail.
func (s *Server) mailWants(event string) bool {
	if s.mailer == nil {
		return false
	}
	conf := s.mailConf()
	return conf.Enabled && conf.Allows(event)
}

// mailUserLabel is the name people recognise, falling back to the readable
// part of an address so a mail never shows a bare id when it can help it.
func (s *Server) mailUserLabel(ctx context.Context, userID, fallback string) string {
	if id := strings.TrimSpace(userID); id != "" {
		if user, found, err := s.db.AuthUserByID(ctx, id); err == nil && found {
			if name := strings.TrimSpace(user.Name); name != "" {
				return name
			}
			if at := strings.Index(user.Email, "@"); at > 0 {
				return user.Email[:at]
			}
		}
		return id
	}
	return strings.TrimSpace(fallback)
}

// mailApprovalRequested tells the approvers a request is parked. The
// requester is the actor, so they are never among the recipients.
func (s *Server) mailApprovalRequested(ctx context.Context, approval store.Approval) {
	if !s.mailWants(mail.EventApprovalRequested) {
		return
	}
	var payload struct {
		Model string `json:"model"`
	}
	_ = json.Unmarshal([]byte(approval.Payload), &payload)
	requester := s.mailUserLabel(ctx, approval.UserID, "API 키 "+approval.APIKeyID)
	s.notifyMail(ctx, mail.ApprovalRequested(approval.ID, requester, payload.Model, approval.Reason, approval.CostKRW), approval.UserID, s.mailApprovers(ctx))
}

// mailApprovalDecided tells the requester what was decided. An approval made
// by an API key without a user behind it has nobody to tell.
func (s *Server) mailApprovalDecided(r *http.Request, approval store.Approval) {
	if approval.UserID == "" || !s.mailWants(mail.EventApprovalDecided) {
		return
	}
	var payload struct {
		Model string `json:"model"`
	}
	_ = json.Unmarshal([]byte(approval.Payload), &payload)
	s.notifyMail(r.Context(), mail.ApprovalDecided(approval.ID, approval.Status, payload.Model), s.mailActorID(r), []string{approval.UserID})
}

// mailKeyBlocked tells a key's owner that the gateway has started refusing
// the key's calls. The notification itself limits this to one mail per key
// per day, so a client retrying in a loop produces one mail, not thousands.
func (s *Server) mailKeyBlocked(ctx context.Context, authCtx *store.AuthContext, reason string) {
	if authCtx == nil || authCtx.UserID == "" || !s.mailWants(mail.EventKeyBlocked) {
		return
	}
	name := ""
	if key, found, err := s.db.GetAPIKey(ctx, authCtx.APIKeyID); err == nil && found {
		name = key.Name
	}
	s.notifyMail(ctx, mail.KeyBlocked(authCtx.APIKeyID, name, reason), "", []string{authCtx.UserID})
}

// mailReportFailed tells a scheduled report's author that it produced nothing.
func (s *Server) mailReportFailed(ctx context.Context, report store.Text2SQLSavedReport, reason string) {
	if report.CreatedBy == "" || !s.mailWants(mail.EventReportFailed) {
		return
	}
	s.notifyMail(ctx, mail.ReportFailed(report.ID, report.Name, reason), "", []string{report.CreatedBy})
}

// mailApprovers is everyone who can decide a governance approval: active
// operators with the admin role. Team-scoped approvers would be a refinement;
// today every approval is decided from the operator console.
func (s *Server) mailApprovers(ctx context.Context) []string {
	users, err := s.db.ListAuthUsers(ctx)
	if err != nil {
		return nil
	}
	ids := make([]string, 0, len(users))
	for _, user := range users {
		if user.Status != "active" {
			continue
		}
		switch user.Role {
		case "super_admin", "admin":
			ids = append(ids, user.ID)
		}
	}
	return ids
}

// mailActorID is the signed-in account behind a request, or empty when the
// call carries an operator token rather than a user session.
func (s *Server) mailActorID(r *http.Request) string {
	if claims, ok := s.currentAccessClaims(r); ok {
		return strings.TrimSpace(claims.Subject)
	}
	return ""
}

// mailStatus is what the settings screen shows: whether mail is on, whether
// the relay settings are complete, and never the password itself.
func (s *Server) mailStatus(ctx context.Context) map[string]any {
	conf := s.mailConf()
	events := map[string]bool{}
	for _, event := range mail.EventSwitches {
		events[event.Key] = conf.Allows(event.Events[0])
	}
	status := map[string]any{
		"enabled":      conf.Enabled,
		"ready":        conf.Ready() == nil,
		"smtp_host":    conf.Host,
		"smtp_port":    conf.Port,
		"security":     conf.Security,
		"username_set": conf.Username != "",
		"password_set": conf.PasswordSet(),
		"from":         conf.Address(),
		"base_url":     conf.BaseURL,
		"events":       events,
	}
	if err := conf.Validate(); err != nil {
		status["error"] = strings.TrimPrefix(err.Error(), mail.ErrInvalid.Error()+": ")
	}
	if counts, err := s.db.MailDeliveryCounts(ctx); err == nil {
		total := 0
		for _, count := range counts {
			total += count
		}
		status["counts"] = counts
		status["total"] = total
	}
	return status
}

// handleMailDeliveries lists what was sent, newest first, with the current
// relay status so one screen answers both "is it on?" and "did it go?".
// GET /admin/mail/deliveries?status=failed&limit=100
func (s *Server) handleMailDeliveries(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	deliveries, err := s.db.ListMailDeliveries(r.Context(), r.URL.Query().Get("status"), limit)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, "mail deliveries could not be loaded", "server_error", "mail_deliveries_failed")
		return
	}
	status := s.mailStatus(r.Context())
	status["deliveries"] = deliveries
	writeJSON(w, http.StatusOK, status)
}

// handleMailTest sends one real mail with the saved settings and reports the
// outcome in place. Relay settings are rarely right the first time.
// POST /admin/mail/test {"recipient": "..."}
func (s *Server) handleMailTest(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var input struct {
		Recipient string `json:"recipient"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&input); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_json")
		return
	}
	recipient := strings.TrimSpace(input.Recipient)
	if recipient == "" {
		// The operator's own address is the natural default for "does it work?".
		if claims, ok := s.currentAccessClaims(r); ok {
			recipient = strings.TrimSpace(claims.Email)
		}
	}
	if !mail.ValidAddress(recipient) {
		writeOpenAIError(w, http.StatusBadRequest, "recipient must be an email address", "invalid_request_error", "invalid_recipient")
		return
	}
	if s.mailer == nil {
		writeOpenAIError(w, http.StatusServiceUnavailable, "mail service is not configured", "server_error", "mail_unavailable")
		return
	}
	err := s.mailer.SendNow(r.Context(), mail.TestMessage(), s.mailActorID(r), recipient)
	s.auditAdmin(r, "mail.test", "", auditJSON(map[string]any{"recipient": recipient, "sent": err == nil}))
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, map[string]any{"sent": true, "recipient": recipient})
	case errors.Is(err, mail.ErrDisabled), errors.Is(err, mail.ErrInvalid):
		writeJSON(w, http.StatusBadRequest, map[string]any{"sent": false, "recipient": recipient, "error": err.Error()})
	default:
		// The relay answered or did not; either way the message is the
		// diagnosis and never contains credentials.
		slog.Warn("mail test send failed", "recipient", recipient, "error", err)
		writeJSON(w, http.StatusBadGateway, map[string]any{"sent": false, "recipient": recipient, "error": err.Error()})
	}
}
