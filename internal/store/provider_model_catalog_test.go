package store

import (
	"context"
	"strings"
	"testing"
)

func TestListProviderModelCatalogConfigsIsBoundedAndNarrow(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	for _, provider := range []ProviderConfig{
		{Name: "charlie", BaseURL: "https://charlie.example", EncryptedAPIKey: "cipher-c", TimeoutMS: 300, Enabled: true, ModelPatterns: strings.Repeat("sensitive-pattern,", 1_000), FailoverGroup: "private-group", Priority: 30},
		{Name: "alpha", BaseURL: "https://alpha.example", EncryptedAPIKey: "cipher-a", TimeoutMS: 100, Enabled: true, ModelPatterns: "private-*", FailoverGroup: "private-group", Priority: 10},
		{Name: "bravo", BaseURL: "https://bravo.example", EncryptedAPIKey: "cipher-b", TimeoutMS: 200, Enabled: true, ModelPatterns: "secret-*", Priority: 20},
		{Name: "disabled", BaseURL: "https://disabled.example", EncryptedAPIKey: "cipher-d", Enabled: false, Priority: 1},
	} {
		if err := db.UpsertProvider(ctx, provider); err != nil {
			t.Fatal(err)
		}
	}

	configs, truncated, err := db.ListProviderModelCatalogConfigs(ctx, "", 2)
	if err != nil {
		t.Fatal(err)
	}
	if !truncated || len(configs) != 2 || configs[0].Name != "alpha" || configs[1].Name != "bravo" {
		t.Fatalf("bounded projection = %#v truncated=%v", configs, truncated)
	}
	for _, provider := range configs {
		if provider.ModelPatterns != "" || provider.FailoverGroup != "" || !provider.CreatedAt.IsZero() || !provider.Enabled {
			t.Fatalf("catalog projection materialized unrelated fields: %#v", provider)
		}
	}

	exact, truncated, err := db.ListProviderModelCatalogConfigs(ctx, "charlie", 1)
	if err != nil || truncated || len(exact) != 1 || exact[0].Name != "charlie" || exact[0].TimeoutMS != 300 {
		t.Fatalf("exact projection = %#v truncated=%v err=%v", exact, truncated, err)
	}

	// SQL LENGTH counts characters on both supported databases. The Go byte check
	// independently rejects a multi-byte legacy name that exceeds the byte contract.
	unicodeName := strings.Repeat("한", 100)
	if err := db.UpsertProvider(ctx, ProviderConfig{Name: unicodeName, BaseURL: "https://unicode.example", EncryptedAPIKey: "cipher", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	exact, truncated, err = db.ListProviderModelCatalogConfigs(ctx, unicodeName, 1)
	if err != nil || !truncated || len(exact) != 0 {
		t.Fatalf("multi-byte oversized projection = %#v truncated=%v err=%v", exact, truncated, err)
	}
}
