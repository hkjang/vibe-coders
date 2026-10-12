package store

import (
	"fmt"
	"testing"
)

func TestResourceSearchMCPStoredNamesOnly(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	for i := 0; i < 13; i++ {
		if err := db.UpsertMCPUpstream(t.Context(), MCPUpstream{
			ID: fmt.Sprintf("server-%02d", i), Name: fmt.Sprintf("검색 Search %02d", i),
			URL: "https://private-endpoint.invalid", EncryptedAuth: "private-auth",
			Metadata: MCPUpstreamMetadata{Description: "private-description"},
		}); err != nil {
			t.Fatal(err)
		}
	}
	rows, more, err := db.SearchResourceMetadata(t.Context(), "mcp_upstream", "search", 10)
	if err != nil || !more || len(rows) != 10 || rows[0].ID != "server-00" || rows[9].ID != "server-09" {
		t.Fatal("bounded MCP name search failed")
	}
	for _, query := range []string{"private-endpoint", "private-auth", "private-description", "server-", "' OR 1=1 --", "%_!"} {
		rows, _, err := db.SearchResourceMetadata(t.Context(), "mcp_upstream", query, 10)
		if err != nil || len(rows) != 0 {
			t.Fatal("MCP search inspected configuration or interpreted query syntax")
		}
	}
	if err := db.UpsertMCPUpstream(t.Context(), MCPUpstream{ID: "literal", Name: "검색 %_!"}); err != nil {
		t.Fatal(err)
	}
	rows, more, err = db.SearchResourceMetadata(t.Context(), "mcp_upstream", "%_!", 10)
	if err != nil || more || len(rows) != 1 || rows[0].ID != "literal" {
		t.Fatal("MCP literal search failed")
	}
}
