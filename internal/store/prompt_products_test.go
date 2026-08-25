package store

import (
	"context"
	"testing"
	"time"
)

func TestPromptProductsPromoteAndReach(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	rec := func(id, fp, apiKey string) {
		if err := db.InsertLogRecord(ctx, LogRecord{
			Request: RequestLog{ID: id, TraceID: id, APIKeyID: apiKey, Endpoint: "/v1/chat/completions",
				Model: "gpt-4.1", StatusCode: 200, TaskType: "generate", PromptFingerprint: fp, CreatedAt: now},
			Usage: &TokenUsage{ID: id + "_u", RequestID: id, TotalTokens: 50, EstimatedCost: 1, Currency: "KRW", CreatedAt: now},
		}); err != nil {
			t.Fatal(err)
		}
	}
	// 3 requests on the same fingerprint from 2 distinct users.
	rec("r1", "fp_build", "u1")
	rec("r2", "fp_build", "u1")
	rec("r3", "fp_build", "u2")

	// Reach snapshot: 3 requests, 2 distinct users.
	reqs, users, err := db.PromptFingerprintReach(ctx, "fp_build", now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if reqs != 3 || users != 2 {
		t.Errorf("reach = %d reqs / %d users, want 3 / 2", reqs, users)
	}

	// Promote: create the backing template, then the product.
	if err := db.UpsertPromptTemplate(ctx, PromptTemplate{
		ID: "build-endpoint", Name: "Build Endpoint", Category: "product", Body: "Build a {{resource}} endpoint with validation.", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertPromptProduct(ctx, PromptProduct{
		ID: "pp1", Name: "Build Endpoint", Category: "product", SourceFingerprint: "fp_build",
		TemplateID: "build-endpoint", RequestCount: reqs, DistinctUsers: users, CreatedBy: "admin",
	}); err != nil {
		t.Fatal(err)
	}

	// List joins template adoption (use the template once first).
	if err := db.TouchPromptTemplate(ctx, "build-endpoint"); err != nil {
		t.Fatal(err)
	}
	products, err := db.ListPromptProducts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(products) != 1 {
		t.Fatalf("expected 1 product, got %d", len(products))
	}
	p := products[0]
	if p.SourceFingerprint != "fp_build" || p.TemplateID != "build-endpoint" {
		t.Errorf("provenance wrong: %+v", p)
	}
	if p.RequestCount != 3 || p.DistinctUsers != 2 {
		t.Errorf("snapshot = %d/%d, want 3/2", p.RequestCount, p.DistinctUsers)
	}
	if p.TemplateUseCount != 1 {
		t.Errorf("adoption use_count = %d, want 1", p.TemplateUseCount)
	}

	// Productized-fingerprint set marks the source fingerprint.
	fps, err := db.PromptProductFingerprints(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !fps["fp_build"] {
		t.Error("fp_build should be marked productized")
	}

	// Delete removes the product but leaves the template.
	if err := db.DeletePromptProduct(ctx, "pp1"); err != nil {
		t.Fatal(err)
	}
	products, _ = db.ListPromptProducts(ctx)
	if len(products) != 0 {
		t.Errorf("expected 0 products after delete, got %d", len(products))
	}
	if _, ok, _ := db.GetPromptTemplate(ctx, "build-endpoint"); !ok {
		t.Error("underlying template should survive product deletion")
	}
}
