//go:build linux

package proxy

import (
	"encoding/json"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func verifyBrowserQuotaBudgetFixture(t *testing.T, db *store.SQLStore) {
	t.Helper()
	const target = "browser-quota-budget-safety"
	quotas, err := db.ListQuotas(t.Context())
	if err != nil {
		t.Fatal("browser quota verification unavailable")
	}
	for _, quota := range quotas {
		if quota.ScopeValue == target {
			t.Fatal("browser quota deletion not persisted")
		}
	}
	budgets, err := db.ListBudgets(t.Context())
	if err != nil {
		t.Fatal("browser budget verification unavailable")
	}
	for _, budget := range budgets {
		if budget.ScopeValue == target {
			t.Fatal("browser budget deletion not persisted")
		}
	}
	audits, err := db.ListAdminAudit(t.Context(), 1000)
	if err != nil {
		t.Fatal("browser quota audit unavailable")
	}
	ids := map[string]bool{}
	counts := map[string]int{}
	for _, audit := range audits {
		if audit.Action != "quota.create" && audit.Action != "budget.create" {
			continue
		}
		var id, scope string
		if audit.Action == "quota.create" {
			// Existing quota audit uses QuotaRecord's exported Go field names,
			// unlike the snake_case QuotaPublic response and Budget audit.
			var after store.QuotaRecord
			if json.Unmarshal([]byte(audit.AfterValue), &after) != nil || after.ScopeValue != target {
				continue
			}
			if after.TokenLimit != 500 {
				t.Fatal("browser quota initial limit invalid")
			}
			id, scope = after.ID, after.Scope
		} else {
			var after store.Budget
			if json.Unmarshal([]byte(audit.AfterValue), &after) != nil || after.ScopeValue != target {
				continue
			}
			if after.MonthlyKRW != 1000 {
				t.Fatal("browser budget initial limit invalid")
			}
			id, scope = after.ID, after.Scope
		}
		if id == "" || scope != "team" || !strings.HasPrefix(audit.AdminID, "admin_") {
			t.Fatal("browser quota create audit invalid")
		}
		ids[id] = true
		counts[audit.Action]++
	}
	for _, audit := range audits {
		if audit.Action == "quota.update" {
			var after store.QuotaRecord
			if json.Unmarshal([]byte(audit.AfterValue), &after) == nil && ids[after.ID] {
				if after.TokenLimit != 900 {
					t.Fatal("browser quota update value invalid")
				}
				if after.Enabled {
					counts["quota.edit"]++
				} else {
					counts["quota.stop"]++
				}
			}
		}
		if audit.Action == "quota.delete" || audit.Action == "budget.delete" {
			var before struct {
				ID string `json:"id"`
			}
			if json.Unmarshal([]byte(audit.BeforeValue), &before) == nil && ids[before.ID] {
				counts[audit.Action]++
			}
		}
	}
	for _, action := range []string{"quota.create", "quota.edit", "quota.stop", "quota.delete", "budget.create", "budget.delete"} {
		if counts[action] != 1 {
			t.Fatal("browser quota lifecycle audit must occur once per action")
		}
	}
}
