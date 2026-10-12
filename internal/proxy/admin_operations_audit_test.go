package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func TestOperationsFallbackPartialIsNotSuccess(t *testing.T) {
	ts, server, db := atomicSettingsServer(t)
	path := filepath.Join(t.TempDir(), "partial.ndjson")
	if err := os.WriteFile(path, []byte("{invalid-json\n"), 0o600); err != nil {
		t.Fatal("fallback fixture unavailable")
	}
	server.logger = store.NewAsyncLogger(db, 1, path)
	resp, _ := req(t, http.MethodPost, ts.URL+"/admin/fallback", `{"reason":"inspect partial replay"}`)
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("partial replay status=%d", resp.StatusCode)
	}
	stats, err := server.logger.FallbackStats()
	if err != nil || stats.Lines != 1 {
		t.Fatal("failed input must remain recoverable")
	}
	events, err := db.ListAdminAudit(t.Context(), 200)
	if err != nil {
		t.Fatal("audit unavailable")
	}
	for _, event := range events {
		if event.Action == "fallback.replay" {
			var detail map[string]any
			if json.Unmarshal([]byte(event.AfterValue), &detail) != nil || detail["status"] != "partial_or_failed" || detail["failed"] != float64(1) {
				t.Fatal("partial replay audit mismatch")
			}
			return
		}
	}
	t.Fatal("partial replay audit missing")
}

func TestOperationsReasonAudit(t *testing.T) {
	for _, operation := range []struct{ path, action string }{{"retention", "retention.run"}, {"fallback", "fallback.replay"}} {
		t.Run(operation.path, func(t *testing.T) {
			ts, server, db := atomicSettingsServer(t)
			server.retention = store.NewRetentionWorker(db, config.RetentionConfig{})
			resp, _ := req(t, http.MethodPost, ts.URL+"/admin/"+operation.path, `{"reason":"  운영 검토 완료  "}`)
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status=%d", resp.StatusCode)
			}
			events, err := db.ListAdminAudit(context.Background(), 200)
			if err != nil {
				t.Fatal("audit read failed")
			}
			found := map[string]bool{}
			for _, event := range events {
				if event.Action != operation.action && event.Action != operation.action+".requested" {
					continue
				}
				var detail map[string]any
				if json.Unmarshal([]byte(event.AfterValue), &detail) != nil || detail["reason"] != "운영 검토 완료" {
					t.Fatal("operation audit must carry the normalized reason")
				}
				found[event.Action] = true
			}
			if !found[operation.action] || !found[operation.action+".requested"] {
				t.Fatal("durable intent and completion audit are both required")
			}
		})
	}
}

func TestOperationsLegacyEmptyBody(t *testing.T) {
	for _, path := range []string{"retention", "fallback"} {
		t.Run(path, func(t *testing.T) {
			ts, server, db := atomicSettingsServer(t)
			server.retention = store.NewRetentionWorker(db, config.RetentionConfig{})
			resp, _ := req(t, http.MethodPost, ts.URL+"/admin/"+path, "")
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("legacy status=%d", resp.StatusCode)
			}
		})
	}
}

func TestOperationsRejectInvalidReasonBeforeExecuting(t *testing.T) {
	for _, path := range []string{"retention", "fallback"} {
		for i, body := range []string{`[]`, `null`, `{"reason":" "}`, `{"reason":7}`, `{"reason":"ok","extra":true}`, `{"reason":"ok"}{}`, `{"reason":"` + strings.Repeat("x", 1025) + `"}`, strings.Repeat("x", 8193)} {
			t.Run(path+"/"+string(rune('a'+i)), func(t *testing.T) {
				ts, server, db := atomicSettingsServer(t)
				server.retention = store.NewRetentionWorker(db, config.RetentionConfig{})
				resp, _ := req(t, http.MethodPost, ts.URL+"/admin/"+path, body)
				if resp.StatusCode != http.StatusBadRequest {
					t.Fatalf("invalid reason status=%d", resp.StatusCode)
				}
				if server.retention.LastRun() != "" {
					t.Fatal("validation must precede cleanup")
				}
				events, err := db.ListAdminAudit(context.Background(), 200)
				if err != nil || len(events) != 0 {
					t.Fatal("invalid operation must not create an execution audit")
				}
			})
		}
	}
}

func TestRetentionStatusDoesNotInventZeroCounts(t *testing.T) {
	ts, _, db := atomicSettingsServer(t)
	if err := db.Close(); err != nil {
		t.Fatal("close failed")
	}
	resp, out := req(t, http.MethodGet, ts.URL+"/admin/retention", "")
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("unavailable status=%d", resp.StatusCode)
	}
	if _, present := out["requests"]; present {
		t.Fatal("failed count must not be shown as zero")
	}
}

func TestRetentionStatusUsesRuntimeConfig(t *testing.T) {
	ts, server, db := atomicSettingsServer(t)
	server.retention = store.NewRetentionWorker(db, config.RetentionConfig{RequestDays: 7, PromptDays: 3, ResponseDays: 2})
	resp, out := req(t, http.MethodGet, ts.URL+"/admin/retention", "")
	if resp.StatusCode != http.StatusOK || out["request_days"] != float64(7) || out["prompt_days"] != float64(3) || out["response_days"] != float64(2) {
		t.Fatal("status must describe the worker's current configuration")
	}
}

func TestRetentionAuditFailurePreventsExecution(t *testing.T) {
	ts, server, db := atomicSettingsServer(t)
	server.retention = store.NewRetentionWorker(db, config.RetentionConfig{})
	if err := db.Close(); err != nil {
		t.Fatal("close failed")
	}
	resp, _ := req(t, http.MethodPost, ts.URL+"/admin/retention", `{"reason":"운영 확인"}`)
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("audit unavailable status=%d", resp.StatusCode)
	}
	if server.retention.LastRun() != "" {
		t.Fatal("cleanup must not start without a durable intent audit")
	}
}
