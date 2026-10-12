package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

// Real storage fault injection in an isolated SQLite DB or PostgreSQL schema.
// This covers handler/worker behavior, not a browser or deployment operation.
func TestRetentionOperationStorageFailures(t *testing.T) {
	for _, mode := range []string{"intent_audit", "partial_cleanup", "completion_audit"} {
		t.Run(mode, func(t *testing.T) {
			db, raw := impactFailureStore(t)
			ctx := t.Context()
			if err := db.InsertLogRecord(ctx, store.LogRecord{Request: store.RequestLog{
				ID: "expired-operation", TraceID: "expired-operation", Endpoint: "/v1/chat/completions",
				StatusCode: 200, CreatedAt: time.Now().UTC().Add(-96 * time.Hour),
			}}); err != nil {
				t.Fatal("seed failed")
			}
			worker := store.NewRetentionWorker(db, config.RetentionConfig{RequestDays: 1})
			server := &Server{db: db, retention: worker}
			statement := "ALTER TABLE chat_semantic_cache RENAME TO unavailable_chat_semantic_cache"
			if mode != "partial_cleanup" {
				action := "retention.run"
				if mode == "intent_audit" {
					action += ".requested"
				}
				statement = "CREATE TRIGGER operation_audit_fault BEFORE INSERT ON admin_audit_logs WHEN NEW.action = '" + action + "' BEGIN SELECT RAISE(FAIL, 'private-operation-fault'); END"
				if os.Getenv("TEST_POSTGRES_DSN") != "" {
					statement = "ALTER TABLE admin_audit_logs ADD CONSTRAINT private_operation_fault CHECK (action <> '" + action + "')"
				}
			}
			if _, err := raw.ExecContext(ctx, statement); err != nil {
				t.Fatal("fixture fault setup failed")
			}
			r := httptest.NewRequest(http.MethodPost, "/admin/retention", strings.NewReader(`{"reason":"검토한 정리 작업"}`)).WithContext(ctx)
			w := httptest.NewRecorder()
			server.handleRetention(w, r)
			if w.Code != http.StatusServiceUnavailable {
				t.Fatalf("fault status=%d", w.Code)
			}
			if strings.Contains(w.Body.String(), "private-operation-fault") || strings.Contains(w.Body.String(), "chat_semantic_cache") {
				t.Fatal("public error exposed storage details")
			}
			requests, _, _, err := db.Counts(ctx)
			if err != nil {
				t.Fatal("count failed")
			}
			wantRequests := int64(0)
			if mode == "intent_audit" {
				wantRequests = 1
				if worker.LastRun() != "" {
					t.Fatal("intent audit failure must prevent execution")
				}
			}
			if requests != wantRequests {
				t.Fatal("operation side effects did not match the failure boundary")
			}
			events, err := db.ListAdminAudit(ctx, 20)
			if err != nil {
				t.Fatal("audit read failed")
			}
			wantEvents := map[string]int{"intent_audit": 0, "partial_cleanup": 2, "completion_audit": 1}[mode]
			if len(events) != wantEvents {
				t.Fatalf("audit count=%d want=%d", len(events), wantEvents)
			}
			for _, event := range events {
				if event.Action != "retention.run" {
					continue
				}
				var detail map[string]any
				if json.Unmarshal([]byte(event.AfterValue), &detail) != nil || detail["status"] != "partial_or_failed" || detail["reason"] != "검토한 정리 작업" {
					t.Fatal("partial completion must remain distinguishable from success in audit")
				}
			}
		})
	}
}
