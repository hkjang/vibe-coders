package proxy

import (
	"context"
	"net/http"
	"time"
)

const committedSettingAuditTimeout = 2 * time.Second

func committedSettingAuditRequest(r *http.Request) (*http.Request, context.CancelFunc) {
	// The write already committed. Preserve trace/actor values while giving its
	// best-effort audit a separate bounded cancellation budget, even after a
	// browser disconnect. Drivers still control how promptly cancellation returns.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), committedSettingAuditTimeout)
	return r.WithContext(ctx), cancel
}

// auditCommittedSetting records an already committed write using the existing
// best-effort audit path. This is not an atomic database audit transaction.
func (s *Server) auditCommittedSetting(r *http.Request, action, before, after string) {
	auditRequest, cancel := committedSettingAuditRequest(r)
	defer cancel()
	s.auditAdmin(auditRequest, action, before, after)
}
