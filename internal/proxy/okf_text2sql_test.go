package proxy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func TestOKFText2SQLSyncAndKnowledge(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(server.Routes())
	defer srv.Close()

	ctx := context.Background()
	// Seed the schema registry: two tables with descriptions + a column.
	_ = db.UpsertText2SQLTable(ctx, store.Text2SQLTable{SchemaName: "public", TableName: "orders", Description: "주문 원장", Enabled: true})
	_ = db.UpsertText2SQLTable(ctx, store.Text2SQLTable{SchemaName: "public", TableName: "secrets", Description: "민감 테이블", Enabled: true})
	_ = db.UpsertText2SQLColumn(ctx, store.Text2SQLColumn{SchemaName: "public", TableName: "orders", ColumnName: "amount", DataType: "numeric", Description: "주문 금액"})

	// Sync registry → OKF documents.
	resp, err := http.Post(srv.URL+"/admin/okf/text2sql/sync?schema=public", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("sync = %d", resp.StatusCode)
	}

	// A manually curated join path.
	if _, err := db.UpsertOKFDocument(ctx, store.OKFDocument{
		Kind: "join_path", Subject: "join:orders-customers", Title: "orders↔customers",
		Body: "orders.customer_id = customers.id", Status: "active",
	}, "tester"); err != nil {
		t.Fatal(err)
	}

	// Knowledge scoped to allowed table "orders" includes the orders note + join path,
	// and excludes the non-allowed "secrets" table note.
	k := server.okfText2SQLKnowledge(ctx, []string{"orders", "customers"})
	if !strings.Contains(k, "주문 원장") {
		t.Errorf("expected orders table note in knowledge, got: %s", k)
	}
	if !strings.Contains(k, "orders.customer_id = customers.id") {
		t.Errorf("expected join path in knowledge, got: %s", k)
	}
	if strings.Contains(k, "민감 테이블") {
		t.Errorf("non-allowed table 'secrets' must be excluded, got: %s", k)
	}

	// With no allowed-table filter, the scoped table notes are not constrained.
	all := server.okfText2SQLKnowledge(ctx, nil)
	if !strings.Contains(all, "민감 테이블") {
		t.Errorf("unscoped knowledge should include all table notes, got: %s", all)
	}
}
