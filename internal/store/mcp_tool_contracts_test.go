package store

import (
	"context"
	"testing"
)

func TestMCPToolContractsRoundtrip(t *testing.T) {
	ctx := context.Background()
	db := openStoreForTest(t)
	defer db.Close()

	c := MCPToolContract{
		ID: "mtc1", Namespace: "gateway", Name: "gateway_chat", Title: "Chat",
		InputSchema: `{"type":"object","properties":{"model":{"type":"string"}}}`,
		RiskLevel:   "medium", TimeoutMS: 5000, AllowedRoles: "admin,dev", Owner: "platform", Enabled: true,
	}
	if err := db.UpsertMCPToolContract(ctx, c); err != nil {
		t.Fatal(err)
	}
	got, found, err := db.GetMCPToolContract(ctx, "mtc1")
	if err != nil || !found || got.Name != "gateway_chat" || got.RiskLevel != "medium" || got.TimeoutMS != 5000 || !got.Enabled {
		t.Fatalf("get = %+v found=%v err=%v", got, found, err)
	}

	// Second contract in a different namespace + disabled.
	if err := db.UpsertMCPToolContract(ctx, MCPToolContract{ID: "mtc2", Namespace: "custom", Name: "x", RiskLevel: "low"}); err != nil {
		t.Fatal(err)
	}
	all, _ := db.ListMCPToolContracts(ctx, "", false)
	if len(all) != 2 {
		t.Fatalf("expected 2 contracts, got %d", len(all))
	}
	gw, _ := db.ListMCPToolContracts(ctx, "gateway", false)
	if len(gw) != 1 || gw[0].ID != "mtc1" {
		t.Fatalf("namespace filter wrong: %+v", gw)
	}
	onlyEnabled, _ := db.ListMCPToolContracts(ctx, "", true)
	if len(onlyEnabled) != 1 {
		t.Fatalf("enabled filter wrong: %+v", onlyEnabled)
	}

	if err := db.DeleteMCPToolContract(ctx, "mtc1"); err != nil {
		t.Fatal(err)
	}
	if _, found, _ := db.GetMCPToolContract(ctx, "mtc1"); found {
		t.Fatal("deleted contract should not be found")
	}
}
