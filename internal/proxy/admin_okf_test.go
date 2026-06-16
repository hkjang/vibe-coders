package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"vibe-coders/internal/store"
)

func TestOKFGraphSync(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "g.ndjson"))
	logger.Start()
	defer logger.Stop(context.Background())
	server, err := NewServer(testConfig("http://upstream.invalid", "secret"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(server.Routes())
	defer srv.Close()

	ctx := context.Background()
	if err := db.UpsertAPIKey(ctx, store.APIKeyRecord{ID: "key_a", Name: "svc", KeyHash: "h", Team: "team_pay", UserID: "user_1", Role: "developer", Status: "active"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertProvider(ctx, store.ProviderConfig{Name: "openai", BaseURL: "http://oai.local", ModelPatterns: "gpt-*", Enabled: true}); err != nil {
		t.Fatal(err)
	}

	resp, err := http.Post(srv.URL+"/admin/okf/graph/sync", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("graph sync = %d", resp.StatusCode)
	}

	// api_key → team / user edges.
	links, err := db.ListOKFLinks(ctx, "api_key:key_a", "", "", 50)
	if err != nil {
		t.Fatal(err)
	}
	rels := map[string]string{}
	for _, l := range links {
		rels[l.Relation] = l.ToSubject
	}
	if rels["in_team"] != "team:team_pay" || rels["owned_by"] != "user:user_1" {
		t.Fatalf("expected key→team/user edges, got %+v", rels)
	}
	// model glob → upstream edge (explains routing target).
	served, err := db.ListOKFLinks(ctx, "model:gpt-*", "", "served_by", 50)
	if err != nil || len(served) != 1 || served[0].ToSubject != "upstream:openai" {
		t.Fatalf("expected model→upstream edge, got %v %+v", err, served)
	}
}

func TestOKFDocumentsLinksExportImport(t *testing.T) {
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

	// Create a table doc.
	resp := postJSON(t, srv.URL+"/admin/okf/documents", "", map[string]any{
		"kind": "table", "subject": "table:orders", "title": "Orders",
		"body": "주문 원장. 결제 완료 주문만.", "attributes": map[string]any{"columns": []string{"id", "amount"}},
		"tags": "payments", "status": "active",
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create doc = %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Re-upsert same (kind,subject) → version bumps, no duplicate.
	resp = postJSON(t, srv.URL+"/admin/okf/documents", "", map[string]any{
		"kind": "table", "subject": "table:orders", "title": "Orders v2", "body": "updated",
	})
	var created struct {
		Document store.OKFDocument `json:"document"`
	}
	json.NewDecoder(resp.Body).Decode(&created)
	resp.Body.Close()
	if created.Document.Version != 2 {
		t.Fatalf("expected version 2 after re-upsert, got %d", created.Document.Version)
	}

	// A join-path link.
	resp = postJSON(t, srv.URL+"/admin/okf/links", "", map[string]any{
		"from_subject": "table:orders", "relation": "joins", "to_subject": "table:customers",
		"attributes": map[string]any{"on": "orders.customer_id = customers.id"},
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create link = %d", resp.StatusCode)
	}
	resp.Body.Close()

	// List documents.
	listResp, _ := http.Get(srv.URL + "/admin/okf/documents?kind=table")
	var list struct {
		Documents []store.OKFDocument `json:"documents"`
	}
	json.NewDecoder(listResp.Body).Decode(&list)
	listResp.Body.Close()
	if len(list.Documents) != 1 {
		t.Fatalf("expected 1 table doc, got %d", len(list.Documents))
	}

	// Export.
	expResp, _ := http.Get(srv.URL + "/admin/okf/export?kind=table")
	var bundle okfBundle
	json.NewDecoder(expResp.Body).Decode(&bundle)
	expResp.Body.Close()
	if len(bundle.Documents) != 1 || len(bundle.Links) != 1 {
		t.Fatalf("export bundle = %d docs / %d links, want 1/1", len(bundle.Documents), len(bundle.Links))
	}

	// Import into a fresh store via a second server.
	db2 := openTestStore(t)
	defer db2.Close()
	logger2 := store.NewAsyncLogger(db2, 8, filepath.Join(t.TempDir(), "f2.ndjson"))
	logger2.Start()
	defer logger2.Stop(context.Background())
	server2, err := NewServer(testConfig("http://upstream.invalid", "secret"), db2, logger2, nil)
	if err != nil {
		t.Fatal(err)
	}
	srv2 := httptest.NewServer(server2.Routes())
	defer srv2.Close()

	body, _ := json.Marshal(bundle)
	impResp, err := http.Post(srv2.URL+"/admin/okf/import", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	var imp struct {
		ImportedDocuments int `json:"imported_documents"`
		ImportedLinks     int `json:"imported_links"`
	}
	json.NewDecoder(impResp.Body).Decode(&imp)
	impResp.Body.Close()
	if imp.ImportedDocuments != 1 || imp.ImportedLinks != 1 {
		t.Fatalf("import = %d docs / %d links, want 1/1", imp.ImportedDocuments, imp.ImportedLinks)
	}

	// The imported doc is retrievable in store 2.
	got, err := db2.ListOKFDocuments(context.Background(), store.OKFFilter{Subject: "table:orders"})
	if err != nil || len(got) != 1 || got[0].Title != "Orders v2" {
		t.Fatalf("imported doc not found/incorrect: %v %+v", err, got)
	}
}
