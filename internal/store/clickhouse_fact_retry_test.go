package store

import (
	"fmt"
	"testing"
)

func TestListReplayableClickHouseFactRetriesSkipsQuarantineWindow(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()

	for index := 0; index < 501; index++ {
		if err := db.RecordClickHouseFactRetry(t.Context(), "old_fact", "{not-json}", 1, "old failure"); err != nil {
			t.Fatal(err)
		}
	}
	oldRows, err := db.ListClickHouseFactRetries(t.Context(), "old_fact", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if len(oldRows) != 501 {
		t.Fatalf("old retries=%d, want 501", len(oldRows))
	}
	for index, row := range oldRows {
		if err := db.QuarantineClickHouseFactRetry(t.Context(), row.ID, fmt.Sprintf("invalid_%d", index)); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.RecordClickHouseFactRetry(t.Context(), "safe_fact", `{"request_id":"safe"}`+"\n", 1, "temporary failure"); err != nil {
		t.Fatal(err)
	}

	replayable, err := db.ListReplayableClickHouseFactRetries(t.Context(), "", 500)
	if err != nil {
		t.Fatal(err)
	}
	if len(replayable) != 1 || replayable[0].TableName != "safe_fact" {
		t.Fatalf("replayable retries=%+v, want only safe row after 501 quarantined rows", replayable)
	}
	all, err := db.ListClickHouseFactRetries(t.Context(), "", 1000)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 502 {
		t.Fatalf("all retries=%d, want preserved 502", len(all))
	}
}
