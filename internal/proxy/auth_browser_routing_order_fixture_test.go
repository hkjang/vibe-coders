//go:build linux

package proxy

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func seedBrowserRoutingOrderFixture(t *testing.T, db *store.SQLStore) {
	t.Helper()
	for i, id := range []string{"browser-order-a", "browser-order-b"} {
		if err := db.UpsertRoutingRule(t.Context(), store.RoutingRule{
			ID: id, Enabled: true, Priority: (i + 1) * 100,
			MatchPattern: "browser-order-request", MinComplexity: 0, MaxComplexity: 100,
			TargetModel: id, Note: "isolated browser order fixture",
			CreatedAt: time.Date(2026, 1, 1, 0, 0, i, 0, time.UTC),
		}); err != nil {
			t.Fatal("synthetic routing order could not be prepared")
		}
	}
}

func verifyBrowserRoutingOrderFixture(t *testing.T, db *store.SQLStore) {
	t.Helper()
	rules, err := db.ListRoutingRules(t.Context())
	if err != nil || len(rules) != 2 || rules[0].ID != "browser-order-b" || rules[1].ID != "browser-order-a" {
		t.Fatal("browser routing order did not persist")
	}
	for i, rule := range rules {
		if rule.Priority != i+1 || !rule.Enabled || rule.TargetModel != rule.ID || rule.MatchPattern != "browser-order-request" || rule.MinComplexity != 0 || rule.MaxComplexity != 100 || rule.Note != "isolated browser order fixture" {
			t.Fatal("browser routing change altered fields outside priority")
		}
	}
	audits, err := db.ListAdminAudit(t.Context(), 1000)
	if err != nil {
		t.Fatal("browser routing audit could not be read")
	}
	count := 0
	for _, record := range audits {
		if record.Action != "routing_rule.reorder" {
			continue
		}
		count++
		var payload struct {
			Reason string `json:"reason"`
			Rules  []struct {
				ID       string `json:"id"`
				Priority int    `json:"priority"`
			} `json:"rules"`
		}
		if json.Unmarshal([]byte(record.AfterValue), &payload) != nil || payload.Reason != "browser-routing-order-reviewed" || len(payload.Rules) != 2 || !strings.HasPrefix(record.AdminID, "admin_") || len(record.AdminID) != 18 {
			t.Fatal("browser routing audit actor or reason did not match")
		}
		for i, rule := range payload.Rules {
			if rule.ID != rules[i].ID || rule.Priority != rules[i].Priority {
				t.Fatal("browser routing audit differs from persisted priority")
			}
		}
	}
	if count != 1 {
		t.Fatal("browser routing save must produce exactly one audit")
	}
}
