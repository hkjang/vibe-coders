package store

import (
	"context"
	"testing"
	"time"
)

func TestAPIKeyProviderAndAdminAuditLifecycle(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().UTC()

	active := APIKeyRecord{
		ID: "key_lifecycle", Name: "dev", KeyHash: "hash-active", Owner: "alice", Team: "platform",
		UserID: "usr_alice", Role: "developer", Status: "active",
		Scopes: []string{"chat:completion", "models:read"}, AllowedIPs: []string{"127.0.0.1/32"},
		AllowedModels: []string{"gpt-4.1-mini"}, DeniedModels: []string{"o3"},
		AllowedProviders: []string{"openai"}, DeniedProviders: []string{"slow"},
		BudgetLimitKRW: 1234.5, ExpiresAt: now.Add(time.Hour), CreatedAt: now.Add(-time.Minute),
	}
	if err := db.UpsertAPIKey(ctx, active); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertAPIKey(ctx, APIKeyRecord{
		ID: "key_inactive", Name: "inactive", KeyHash: "hash-inactive", Status: "revoked", CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if has, err := db.HasActiveAPIKeys(ctx); err != nil || !has {
		t.Fatalf("expected active api keys, has=%v err=%v", has, err)
	}
	found, ok, err := db.FindActiveAPIKeyByHash(ctx, "hash-active")
	if err != nil || !ok {
		t.Fatalf("active key lookup ok=%v err=%v", ok, err)
	}
	if found.ID != active.ID || found.Scopes[0] != "chat:completion" || found.AllowedProviders[0] != "openai" || found.ExpiresAt.IsZero() {
		t.Fatalf("active key metadata mismatch: %+v", found)
	}
	if _, ok, err := db.FindActiveAPIKeyByHash(ctx, "hash-inactive"); err != nil || ok {
		t.Fatalf("inactive key must not be returned by active lookup, ok=%v err=%v", ok, err)
	}
	public, err := db.ListAPIKeys(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(public) != 2 || public[0].ID != "key_inactive" || public[1].AllowedModels[0] != "gpt-4.1-mini" {
		t.Fatalf("public api key listing mismatch: %+v", public)
	}
	if err := db.SetAPIKeyStatus(ctx, "key_lifecycle", "revoked"); err != nil {
		t.Fatal(err)
	}
	updated, ok, err := db.GetAPIKey(ctx, "key_lifecycle")
	if err != nil || !ok {
		t.Fatalf("get updated key ok=%v err=%v", ok, err)
	}
	if updated.Status != "revoked" || updated.KeyHash != "hash-active" {
		t.Fatalf("status update should preserve key hash and metadata, got %+v", updated)
	}
	if err := db.EnsureExternalAPIKey(ctx, APIKeyRecord{ID: "key_external", Name: "first", KeyHash: "hash-ext", Team: "external"}); err != nil {
		t.Fatal(err)
	}
	if err := db.EnsureExternalAPIKey(ctx, APIKeyRecord{ID: "key_external", Name: "second", KeyHash: "hash-other", Team: "mutated"}); err != nil {
		t.Fatal(err)
	}
	external, ok, err := db.GetAPIKey(ctx, "key_external")
	if err != nil || !ok {
		t.Fatalf("external key lookup ok=%v err=%v", ok, err)
	}
	if external.Name != "first" || external.KeyHash != "hash-ext" || external.Status != "external" {
		t.Fatalf("external key should not be clobbered by EnsureExternalAPIKey, got %+v", external)
	}
	if err := db.DeleteAPIKey(ctx, "key_inactive"); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := db.GetAPIKey(ctx, "key_inactive"); err != nil || ok {
		t.Fatalf("deleted key lookup ok=%v err=%v", ok, err)
	}

	if err := db.UpsertProvider(ctx, ProviderConfig{
		Name: "openai", BaseURL: "http://openai.local", EncryptedAPIKey: "enc-openai",
		TimeoutMS: 1000, Enabled: true, ModelPatterns: "gpt-*", CreatedAt: now.Add(-time.Minute),
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertProvider(ctx, ProviderConfig{
		Name: "disabled", BaseURL: "http://disabled.local", EncryptedAPIKey: "", TimeoutMS: 2000, Enabled: false,
	}); err != nil {
		t.Fatal(err)
	}
	provider, ok, err := db.GetProvider(ctx, "openai")
	if err != nil || !ok {
		t.Fatalf("provider lookup ok=%v err=%v", ok, err)
	}
	if provider.BaseURL != "http://openai.local" || provider.ModelPatterns != "gpt-*" || !provider.Enabled {
		t.Fatalf("provider detail mismatch: %+v", provider)
	}
	publicProviders, err := db.ListProviders(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(publicProviders) != 2 || publicProviders[1].Name != "openai" || !publicProviders[1].APIKeyConfigured {
		t.Fatalf("public provider listing mismatch: %+v", publicProviders)
	}
	configs, err := db.ListProviderConfigs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(configs) != 1 || configs[0].Name != "openai" {
		t.Fatalf("provider configs should include enabled providers only, got %+v", configs)
	}
	deleted, err := db.DeleteProvider(ctx, "disabled")
	if err != nil || !deleted {
		t.Fatalf("delete provider deleted=%v err=%v", deleted, err)
	}
	deleted, err = db.DeleteProvider(ctx, "missing")
	if err != nil || deleted {
		t.Fatalf("delete missing provider deleted=%v err=%v", deleted, err)
	}

	if err := db.InsertAdminAudit(ctx, AdminAuditLog{ID: "audit_old", AdminID: "adm", Action: "provider.upsert", CreatedAt: now.Add(-time.Minute)}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertAdminAudit(ctx, AdminAuditLog{ID: "audit_new", AdminID: "adm", Action: "api_key.update", BeforeValue: "before", AfterValue: "after", CreatedAt: now}); err != nil {
		t.Fatal(err)
	}
	audits, err := db.ListAdminAudit(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(audits) < 2 || audits[0].ID != "audit_new" || audits[0].BeforeValue != "before" {
		t.Fatalf("admin audit listing mismatch: %+v", audits)
	}
}
