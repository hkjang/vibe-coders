package store

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestResourceSearchMCPToolCatalogIdentityAndBounds(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { db.Close() })
	insert := func(server, tool string, mcp int) {
		t.Helper()
		_, err := db.db.ExecContext(t.Context(), db.bind(`INSERT INTO mcp_tool_catalog
			(server_label, tool_name, is_mcp, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)`), server, tool, mcp, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
		if err != nil {
			t.Fatal(err)
		}
	}
	for i := range 13 {
		insert(fmt.Sprintf("server-%02d", i), "정산 Search", 1)
	}
	insert("excluded", "정산 Search", 0)
	insert("", "정산 Search", 1)
	items, more, err := db.SearchMCPToolMetadata(t.Context(), "search", 10)
	if err != nil || !more || len(items) != 10 || items[0].ServerLabel != "server-00" || items[9].ServerLabel != "server-09" {
		t.Fatal("bounded deterministic server-tool identity failed")
	}
	for _, item := range items {
		catalog, err := db.MCPCatalog(t.Context(), item.ServerLabel, time.Hour, time.Hour)
		if err != nil || len(catalog) != 1 || catalog[0].ToolName != item.ToolName || !catalog[0].IsMCP {
			t.Fatal("navigation metadata and existing observed catalog disagree")
		}
	}
	insert("literal", "정산 %_!", 1)
	insert("unicode", "ÄPFEL ΣΥΝΟΛΟ 도구", 1)
	insert(strings.Repeat("s", 513), "oversized server", 1)
	insert("long-tool", "oversized "+strings.Repeat("가", 256), 1)
	insert(strings.Repeat("😀", 512), "boundary tool", 1)
	if db.dialect == "sqlite" {
		insert("nul", "oversized\x00"+strings.Repeat("x", 64<<10), 1)
	}
	for _, tc := range []struct{ query, server string }{
		{"%_!", "literal"}, {"äpfel συνολο", "unicode"}, {"oversized", ""},
		{"boundary", strings.Repeat("😀", 512)}, {"server-", ""}, {"' OR 1=1 --", ""},
	} {
		rows, _, err := db.SearchMCPToolMetadata(t.Context(), tc.query, 10)
		if err != nil || (tc.server == "" && len(rows) != 0) || (tc.server != "" && (len(rows) != 1 || rows[0].ServerLabel != tc.server)) {
			t.Fatal("literal tool-name matching, Unicode or size bounds failed")
		}
	}
	for _, tc := range []struct {
		q     string
		limit int
	}{
		{"x", 10}, {strings.Repeat("가", 129), 10}, {"\xffbad", 10}, {"정산", 0}, {"정산", 51},
	} {
		if _, _, err := db.SearchMCPToolMetadata(t.Context(), tc.q, tc.limit); err == nil {
			t.Fatal("invalid bounds accepted")
		}
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, _, err := db.SearchMCPToolMetadata(cancelled, "정산", 10); err == nil {
		t.Fatal("cancelled search succeeded")
	}
}
