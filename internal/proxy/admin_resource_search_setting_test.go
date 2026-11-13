package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func TestResourceSearchSettingDefinitionOnly(t *testing.T) {
	s := &Server{}
	defs := []settingDef{{Key: "cache.enabled", Category: "cache", envValue: func(config.Config) string { t.Fatal("search evaluated a value"); return "" }}}
	descriptions := map[string]string{"cache.enabled": "채팅 캐시 사용 여부"}
	for _, query := range []string{"CACHE", "채팅", "사용 여부"} {
		group := s.searchSettingNavigation(t.Context(), query, defs, descriptions)
		if group.Status != "ok" || group.Limited || len(group.Items) != 1 || group.Items[0].ID != "cache.enabled" || group.Items[0].Title != descriptions["cache.enabled"] {
			t.Fatalf("static key/category/description search failed: %q", query)
		}
	}
	if group := s.searchSettingNavigation(t.Context(), "unrelated-value", defs, descriptions); len(group.Items) != 0 {
		t.Fatal("matched a value")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if group := s.searchSettingNavigation(ctx, "cache", defs, descriptions); group.Status != "unavailable" || len(group.Items) != 0 {
		t.Fatal("cancelled search returned metadata")
	}
	for i := 12; i >= 0; i-- {
		defs = append(defs, settingDef{Key: fmt.Sprintf("cache.item_%02d", i)})
	}
	group := s.searchSettingNavigation(t.Context(), "cache", defs, descriptions)
	if !group.Limited || len(group.Items) != 10 || group.Items[0].ID != "cache.enabled" || group.Items[9].ID != "cache.item_08" {
		t.Fatal("bound or deterministic key order failed")
	}
	descriptions["cache.enabled"] = strings.Repeat("한", 257)
	if group := s.searchSettingNavigation(t.Context(), "enabled", defs, descriptions); group.Items[0].Title != "cache.enabled" {
		t.Fatal("oversized description exceeded contract")
	}
}

func TestResourceSearchSettingAuthorizationAndValues(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	s := &Server{db: db, cfg: config.Config{Auth: config.AuthConfig{AdminToken: "full", AdminReadonlyToken: "reader"}}}
	if err := db.UpsertAdminSetting(t.Context(), store.AdminSetting{Key: "cache.chat_enabled", ValueJSON: `"private-value-marker"`, ValueType: "string"}, "fixture", "private-audit-marker"); err != nil {
		t.Fatal(err)
	}
	search := func(query, token string) resourceSearchGroup {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"query": query, "kinds": []string{"setting"}})
		w := resourceSearchRequest(s, string(body), token)
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("read-only metadata status=%d", w.Code)
		}
		if strings.Contains(w.Body.String(), "private-") || strings.Contains(w.Body.String(), "can_write") || strings.Contains(w.Body.String(), "value") {
			t.Fatal("disclosed effective setting or history")
		}
		var out struct {
			Groups []resourceSearchGroup `json:"groups"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || len(out.Groups) != 1 {
			t.Fatal("invalid setting response")
		}
		return out.Groups[0]
	}
	for _, key := range []string{"cache.chat_enabled", "ui.app.enabled", "ui.app.feature.system.settings.rollout", "clickhouse.password"} {
		group := search(key, "reader")
		if group.Status != "ok" || len(group.Items) != 1 || group.Items[0].ID != key {
			t.Fatalf("missing registered setting %s", key)
		}
	}
	if group := search("private-value-marker", "reader"); len(group.Items) != 0 {
		t.Fatal("searched stored values")
	}
	if w := resourceSearchRequest(s, `{"query":"cache","kinds":["setting"]}`, ""); w.Code != 401 {
		t.Fatal("unauthenticated settings search")
	}
	for _, status := range []string{"hidden", "legacy"} {
		if err := db.UpsertAdminSetting(t.Context(), store.AdminSetting{Key: "ui.app.feature.system.settings.status", ValueJSON: `"` + status + `"`, ValueType: "string"}, "fixture", "feature boundary"); err != nil {
			t.Fatal(err)
		}
		if group := search("cache", "reader"); group.Status != "forbidden" || len(group.Items) != 0 || group.Limited {
			t.Fatal("hidden settings metadata leaked")
		}
	}
}
