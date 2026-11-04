package proxy

import (
	"encoding/json"
	"testing"
	"vibe-coders/internal/store"
)

func assertBrowserMCPContract(t *testing.T, db *store.SQLStore) {
	t.Helper()
	audits, err := db.ListAdminAudit(t.Context(), 1000)
	if err != nil {
		t.Fatal("MCP contract audit lookup failed")
	}
	ids := map[string]int{}
	for _, audit := range audits {
		if audit.Action != "mcp_tool_contract_upsert" {
			continue
		}
		var after struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		if json.Unmarshal([]byte(audit.AfterValue), &after) != nil {
			t.Fatal("MCP contract audit shape mismatch")
		}
		if after.Name == "browser_contract" {
			ids[after.ID]++
		}
	}
	if len(ids) != 1 {
		t.Fatal("MCP contract browser identity mismatch")
	}
	for id, count := range ids {
		if id == "" || count != 2 {
			t.Fatal("MCP contract browser save count mismatch")
		}
		_, found, err := db.GetMCPToolContract(t.Context(), id)
		if err != nil || found {
			t.Fatal("MCP contract browser deletion mismatch")
		}
		deletes := 0
		for _, audit := range audits {
			if audit.Action == "mcp_tool_contract_delete" && audit.BeforeValue == id {
				deletes++
			}
		}
		if deletes != 1 {
			t.Fatal("MCP contract browser delete audit mismatch")
		}
	}
}
