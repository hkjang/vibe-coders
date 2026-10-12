package proxy

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func seedBrowserOperationsFixture(t *testing.T, db *store.SQLStore, fallbackPath string) {
	t.Helper()
	ctx := t.Context()
	if err := db.InsertLogRecord(ctx, store.LogRecord{Request: store.RequestLog{
		ID: "browser-retention-expired", TraceID: "browser-retention-expired", Endpoint: "/v1/chat/completions",
		StatusCode: 200, CreatedAt: time.Now().UTC().AddDate(-3, 0, 0),
	}}); err != nil {
		t.Fatal("operation fixture seed failed")
	}
	encoded, err := json.Marshal(store.LogRecord{Request: store.RequestLog{
		ID: "browser-replay-imported", TraceID: "browser-replay-imported", Endpoint: "/v1/chat/completions",
		StatusCode: 200, CreatedAt: time.Now().UTC(),
	}})
	if err != nil || os.WriteFile(fallbackPath, append(encoded, '\n'), 0o600) != nil {
		t.Fatal("operation fallback fixture seed failed")
	}
}

func verifyBrowserOperationsFixture(t *testing.T, db *store.SQLStore) {
	t.Helper()
	ctx := t.Context()
	if _, err := db.RequestDetail(ctx, "browser-retention-expired"); !errors.Is(err, store.ErrNotFound) {
		t.Fatal("browser retention must remove the expired synthetic request")
	}
	if _, err := db.RequestDetail(ctx, "browser-replay-imported"); err != nil {
		t.Fatal("browser replay must import the synthetic request despite the lost response")
	}
	events, err := db.ListAdminAudit(ctx, 200)
	if err != nil {
		t.Fatal("operation audit verification unavailable")
	}
	for action, reason := range map[string]string{"retention.run": "browser-retention-reviewed", "fallback.replay": "browser-replay-reviewed"} {
		seen := map[string]string{}
		for _, event := range events {
			if event.Action != action && event.Action != action+".requested" {
				continue
			}
			var detail map[string]any
			if json.Unmarshal([]byte(event.AfterValue), &detail) != nil || detail["reason"] != reason || !strings.HasPrefix(event.AdminID, "admin_") {
				t.Fatal("browser operation audit reason or actor mismatch")
			}
			if _, duplicate := seen[event.Action]; duplicate {
				t.Fatal("browser operation must not execute twice")
			}
			id, ok := detail["operation_id"].(string)
			if !ok || id == "" || event.BeforeValue != id {
				t.Fatal("operation intent and completion require a shared ID")
			}
			seen[event.Action] = id
			wantStatus := "requested"
			if event.Action == action {
				wantStatus = "completed"
			}
			if detail["status"] != wantStatus {
				t.Fatal("operation audit status mismatch")
			}
		}
		if len(seen) != 2 || seen[action] != seen[action+".requested"] {
			t.Fatal("browser operation audit pair missing")
		}
	}
}
