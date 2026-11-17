//go:build linux

package proxy

import (
	"encoding/json"
	"strings"
	"testing"
	"vibe-coders/internal/store"
)

func seedBrowserStageFixture(t *testing.T, db *store.SQLStore) {
	t.Helper()
	for _, name := range []string{"browser-stage-edit", "browser-stage-reader"} {
		if err := db.SetPromptStage(t.Context(), store.PromptPromotion{PromptName: name, PromptVersion: "v1", Stage: "experiment", Note: "private-stage-note", PromotedBy: "private-stage-actor"}); err != nil {
			t.Fatal("stage browser fixture could not be seeded")
		}
	}
}
func verifyBrowserStageFixture(t *testing.T, db *store.SQLStore) {
	t.Helper()
	ctx := t.Context()
	changed, err := db.GetPromptStageSnapshot(ctx, "browser-stage-edit", "v1")
	if err != nil || changed.Promotion.Stage != "validation" || changed.Promotion.Note != "브라우저 검증 완료" {
		t.Fatal("browser stage change missing")
	}
	reader, err := db.GetPromptStageSnapshot(ctx, "browser-stage-reader", "v1")
	if err != nil || reader.Promotion.Stage != "experiment" {
		t.Fatal("read-only browser changed a stage")
	}
	audits, err := db.ListAdminAudit(ctx, 1000)
	if err != nil {
		t.Fatal("stage audit unavailable")
	}
	count := 0
	for _, audit := range audits {
		if audit.Action != "prompt.promotion.set" {
			continue
		}
		count++
		var after struct {
			Stage     string `json:"stage"`
			Reason    string `json:"reason"`
			Reference string `json:"reference"`
		}
		if json.Unmarshal([]byte(audit.AfterValue), &after) != nil || after.Stage != "validation" || after.Reason != "브라우저 검증 완료" || len(after.Reference) != 43 || !strings.HasPrefix(audit.AdminID, "admin_") {
			t.Fatal("stage audit identity or reason mismatch")
		}
	}
	if count != 1 {
		t.Fatal("expected exactly one stage audit")
	}
}
