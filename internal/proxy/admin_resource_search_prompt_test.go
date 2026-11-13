package proxy

import (
	"encoding/json"
	"strings"
	"testing"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func TestResourceSearchPromptProjectionAndFeatureBoundary(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	s := &Server{db: db, cfg: config.Config{Auth: config.AuthConfig{AdminToken: "full", AdminReadonlyToken: "reader", APIKeyPrefix: "corp_"}}}
	for _, row := range []struct{ id, title string }{
		{"same-id", "정산 이름"},
		{"mail", "정산 person@example.com"},
		{"corp_" + strings.Repeat("x", 43), "정산 비밀 식별자"},
		{"long", "정산" + strings.Repeat("한", 256)},
	} {
		if err := db.UpsertPromptTemplate(t.Context(), store.PromptTemplate{ID: row.id, Name: row.title, Body: "private-body-marker", Description: "private-description-marker", Category: "custom"}); err != nil {
			t.Fatal(err)
		}
		if err := db.CreatePromptExperiment(t.Context(), store.PromptExperiment{ID: row.id, Title: row.title, Description: "private-description-marker", Owner: "private-owner-marker", Team: "private-team-marker"}); err != nil {
			t.Fatal(err)
		}
	}
	read := func() []resourceSearchGroup {
		t.Helper()
		w := resourceSearchRequest(s, `{"query":"정산","kinds":["prompt_asset","prompt_experiment"]}`, "reader")
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("read-only search status=%d", w.Code)
		}
		for _, forbidden := range []string{"private-", "person@example.com", "corp_"} {
			if strings.Contains(w.Body.String(), forbidden) {
				t.Fatal("search disclosed non-navigation content")
			}
		}
		var result struct {
			Groups []resourceSearchGroup `json:"groups"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || len(result.Groups) != 2 {
			t.Fatal("unexpected search response")
		}
		return result.Groups
	}
	for _, group := range read() {
		if group.Status != "ok" || len(group.Items) != 1 || group.Items[0].ID != "same-id" || group.Items[0].Kind != group.Kind {
			t.Fatal("name-only search did not preserve kind and identity")
		}
	}
	for _, status := range []string{"hidden", "legacy"} {
		if err := db.UpsertAdminSetting(t.Context(), store.AdminSetting{Key: "ui.app.feature.prompts.library.status", ValueJSON: `"` + status + `"`, ValueType: "string"}, "test", "search guard"); err != nil {
			t.Fatal(err)
		}
		groups := read()
		if groups[0].Status != "forbidden" || len(groups[0].Items) != 0 || groups[1].Status != "ok" || len(groups[1].Items) != 1 {
			t.Fatal("library rollout changed experiment authorization or leaked asset metadata")
		}
	}
}
