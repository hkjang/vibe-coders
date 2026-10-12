package store

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestResourceSearchMetadata(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := t.Context()
	for i := 0; i < 13; i++ {
		id, title := fmt.Sprintf("wf-%02d", i), fmt.Sprintf("정산 Search %02d", i)
		if err := db.UpsertWorkflow(ctx, Workflow{ID: id, Name: title, Description: "private-description", Steps: []WorkflowStep{{Type: "chat", Note: "private-body"}}}); err != nil {
			t.Fatal(err)
		}
	}
	items, more, err := db.SearchResourceMetadata(ctx, "workflow", "search", 10)
	if err != nil || !more || len(items) != 10 || items[0].ID != "wf-00" || items[9].ID != "wf-09" {
		t.Fatalf("page shape: count=%d more=%v err=%v", len(items), more, err)
	}
	items, more, err = db.SearchResourceMetadata(ctx, "workflow", "정산", 50)
	if err != nil || more || len(items) != 13 {
		t.Fatal("Korean name search failed")
	}
	items, _, err = db.SearchResourceMetadata(ctx, "workflow", "private-body", 10)
	if err != nil || len(items) != 0 {
		t.Fatal("search must not inspect definitions")
	}
	for _, query := range []string{"%_", "' OR 1=1 --", "absent"} {
		items, _, err = db.SearchResourceMetadata(ctx, "workflow", query, 10)
		if err != nil || len(items) != 0 {
			t.Fatal("literal query was interpreted as syntax")
		}
	}
	if err := db.UpsertWorkflow(ctx, Workflow{ID: "literal", Name: "100%_! literal"}); err != nil {
		t.Fatal(err)
	}
	items, _, err = db.SearchResourceMetadata(ctx, "workflow", "%_!", 10)
	if err != nil || len(items) != 1 || items[0].ID != "literal" {
		t.Fatal("literal wildcard escaping failed")
	}
	if err := db.UpsertWorkflow(ctx, Workflow{ID: "long", Name: strings.Repeat("x", 257)}); err != nil {
		t.Fatal(err)
	}
	items, _, err = db.SearchResourceMetadata(ctx, "workflow", "xx", 10)
	if err != nil || len(items) != 0 {
		t.Fatal("oversized titles should not be selected")
	}
	for _, input := range []struct {
		kind, query string
		limit       int
	}{{"unknown", "query", 10}, {"workflow", "x", 10}, {"workflow", strings.Repeat("x", 129), 10}, {"workflow", "query", 0}, {"workflow", "query", 51}} {
		if _, _, err := db.SearchResourceMetadata(ctx, input.kind, input.query, input.limit); err == nil {
			t.Fatal("invalid bounds accepted")
		}
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, _, err := db.SearchResourceMetadata(cancelled, "workflow", "search", 10); err == nil {
		t.Fatal("cancelled request queried storage")
	}
}

func TestResourceSearchMetadataKinds(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := t.Context()
	queries := []string{
		`INSERT INTO provider_configs(name,base_url,timeout_ms,enabled,created_at) VALUES ('search-provider','https://invalid.example',100,1,'now')`,
		`INSERT INTO skills(name,instructions,created_at,updated_at) VALUES ('search-skill','private-body','now','now')`,
		`INSERT INTO work_apps(id,title,components,created_at,updated_at) VALUES ('app-id','search-app','private-body','now','now')`,
	}
	for _, query := range queries {
		if _, err := db.db.ExecContext(ctx, query); err != nil {
			t.Fatal(err)
		}
	}
	for _, kind := range []string{"provider", "skill", "app"} {
		items, more, err := db.SearchResourceMetadata(ctx, kind, "search", 10)
		if err != nil || more || len(items) != 1 || items[0].Title != "search-"+kind {
			t.Fatalf("metadata kind %s failed", kind)
		}
	}
}

func TestResourceSearchMetadataBoundsEmbeddedNUL(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	err := db.UpsertWorkflow(t.Context(), Workflow{ID: "oversized-nul", Name: "bounded\x00" + strings.Repeat("x", 64<<10)})
	if db.dialect == "postgres" {
		if err == nil {
			t.Fatal("PostgreSQL accepted embedded NUL text")
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	items, _, err := db.SearchResourceMetadata(t.Context(), "workflow", "bounded", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatal("metadata query selected oversized NUL-bearing storage text")
	}
}
