package store

import (
	"fmt"
	"testing"
)

func TestResourceSearchPolicyMetadata(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	for i := 0; i < 12; i++ {
		if err := db.UpsertPolicyWithRules(t.Context(), Policy{ID: fmt.Sprintf("policy-%02d", i), Name: fmt.Sprintf("정산 %%_! %02d", i), Description: "private-description"}, nil); err != nil {
			t.Fatal("policy fixture failed")
		}
	}
	rows, more, err := db.SearchResourceMetadata(t.Context(), "policy", "%_!", 10)
	if err != nil || !more || len(rows) != 10 || rows[0].ID != "policy-00" || rows[9].ID != "policy-09" {
		t.Fatal("bounded literal policy search failed")
	}
	rows, _, err = db.SearchResourceMetadata(t.Context(), "policy", "private-description", 10)
	if err != nil || len(rows) != 0 {
		t.Fatal("policy descriptions were searched")
	}
}
