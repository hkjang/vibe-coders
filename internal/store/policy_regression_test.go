package store

import (
	"context"
	"testing"
)

func TestPolicyRegressionCaseRoundtrip(t *testing.T) {
	ctx := context.Background()
	db := openStoreForTest(t)
	defer db.Close()

	c := PolicyRegressionCase{
		ID: "preg_1", Name: "block gpt-4 high risk", Model: "gpt-4", Provider: "openai",
		TeamID: "t1", RiskScore: 80, ContainsSecret: true, SecretTypes: []string{"openai_api_key", "jwt"},
		Expect: "block", ExpectSecretAction: "block", Enabled: true, CreatedBy: "admin_x",
	}
	if err := db.UpsertPolicyRegressionCase(ctx, c); err != nil {
		t.Fatal(err)
	}

	got, ok, err := db.GetPolicyRegressionCase(ctx, "preg_1")
	if err != nil || !ok {
		t.Fatalf("get failed: ok=%v err=%v", ok, err)
	}
	if got.Name != c.Name || got.Model != "gpt-4" || got.Expect != "block" || got.ExpectSecretAction != "block" {
		t.Fatalf("roundtrip mismatch: %+v", got)
	}
	if !got.ContainsSecret || len(got.SecretTypes) != 2 || got.SecretTypes[0] != "openai_api_key" {
		t.Fatalf("secret fields not preserved: %+v", got)
	}
	if !got.Enabled {
		t.Fatal("enabled should be true")
	}

	// Update (disable) and verify enabled-only filter excludes it.
	got.Enabled = false
	if err := db.UpsertPolicyRegressionCase(ctx, got); err != nil {
		t.Fatal(err)
	}
	enabledOnly, err := db.ListPolicyRegressionCases(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(enabledOnly) != 0 {
		t.Fatalf("expected 0 enabled cases, got %d", len(enabledOnly))
	}
	all, err := db.ListPolicyRegressionCases(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 1 {
		t.Fatalf("expected 1 case total, got %d", len(all))
	}

	if err := db.DeletePolicyRegressionCase(ctx, "preg_1"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := db.GetPolicyRegressionCase(ctx, "preg_1"); ok {
		t.Fatal("case should be deleted")
	}
}
