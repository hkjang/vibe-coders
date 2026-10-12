package proxy

import (
	"context"
	"net/http"
	"time"

	"vibe-coders/internal/store"
)

// Persist intent before the first side effect. The operation is deliberately
// not wrapped in a long audit transaction: cleanup and file replay can partially
// complete. A requested record is not evidence of successful completion.
func (s *Server) beginAdminOperation(r *http.Request, action, reason string) (string, error) {
	id := newID("operation")
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	err := s.db.InsertAdminAudit(ctx, store.AdminAuditLog{
		ID: newID("audit"), AdminID: adminID(r), Action: action + ".requested", BeforeValue: id,
		AfterValue: auditJSON(map[string]any{"reason": reason, "operation_id": id, "status": "requested"}),
	})
	return id, err
}

// A disconnected browser must not cancel the bounded completion audit. This
// does not make the operation and its audit atomic or provide retry idempotency.
func (s *Server) finishAdminOperation(r *http.Request, action, id, reason string, result map[string]any, failed bool) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 2*time.Second)
	defer cancel()
	result["reason"], result["operation_id"] = reason, id
	result["status"] = "completed"
	if failed {
		result["status"] = "partial_or_failed"
	}
	return s.db.InsertAdminAudit(ctx, store.AdminAuditLog{
		ID: newID("audit"), AdminID: adminID(r), Action: action, BeforeValue: id, AfterValue: auditJSON(result),
	})
}
