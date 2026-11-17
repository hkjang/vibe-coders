//go:build linux

package proxy

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
	"vibe-coders/internal/store"
)

func seedBrowserStageBulkFixture(t *testing.T, db *store.SQLStore) {
	t.Helper()
	for _, item := range []struct {
		name, stage string
		calls       int
	}{{"browser-bulk-alpha", "experiment", 20}, {"browser-bulk-beta", "validation", 50}} {
		if err := db.SetPromptStage(t.Context(), store.PromptPromotion{PromptName: item.name, PromptVersion: "v1", Stage: item.stage}); err != nil {
			t.Fatal("bulk fixture stage seed failed")
		}
		for i := range item.calls {
			if err := db.InsertLogRecord(t.Context(), store.LogRecord{Request: store.RequestLog{ID: fmt.Sprintf("%s-%d", item.name, i), PromptName: item.name, PromptVersion: "v1", StatusCode: 200, CreatedAt: time.Now().UTC().Add(-time.Minute)}}); err != nil {
				t.Fatal("bulk fixture observation seed failed")
			}
		}
	}
}
func verifyBrowserStageBulkFixture(t *testing.T, db *store.SQLStore) {
	t.Helper()
	for name, stage := range map[string]string{"browser-bulk-alpha": "validation", "browser-bulk-beta": "production"} {
		row, err := db.GetPromptStageSnapshot(t.Context(), name, "v1")
		if err != nil || row.Promotion.Stage != stage || row.Promotion.Note != "실제 브라우저 일괄 검토 완료" || !strings.HasPrefix(row.Promotion.PromotedBy, "admin_") {
			t.Fatal("bulk browser state or actor mismatch")
		}
	}
	audits, err := db.ListAdminAudit(t.Context(), 1000)
	if err != nil {
		t.Fatal("bulk audit unavailable")
	}
	count := 0
	for _, audit := range audits {
		if audit.Action != "prompt.promotion.auto" {
			continue
		}
		count++
		var data struct {
			Count    int    `json:"count"`
			Reason   string `json:"reason"`
			Versions []struct {
				Reference string `json:"reference"`
				Stage     string `json:"stage"`
			} `json:"versions"`
		}
		if json.Unmarshal([]byte(audit.AfterValue), &data) != nil || data.Count != 2 || len(data.Versions) != 2 || data.Reason != "실제 브라우저 일괄 검토 완료" || !strings.HasPrefix(audit.AdminID, "admin_") {
			t.Fatal("bulk audit projection mismatch")
		}
		for _, row := range data.Versions {
			if len(row.Reference) != 43 || (row.Stage != "validation" && row.Stage != "production") {
				t.Fatal("bulk audit target mismatch")
			}
		}
	}
	if count != 1 {
		t.Fatal("expected one atomic bulk audit")
	}
}
