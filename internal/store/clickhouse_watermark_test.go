package store

import (
	"context"
	"testing"
)

func TestClickHouseSinkWatermarkAndRetry(t *testing.T) {
	db := openAggTestStore(t)
	defer db.Close()
	ctx := context.Background()

	// A failure persists a retry entry and bumps attempts on repeat.
	if err := db.RecordClickHouseSinkFailure(ctx, "model", "2026-06-01", "status 502"); err != nil {
		t.Fatal(err)
	}
	if err := db.RecordClickHouseSinkFailure(ctx, "model", "2026-06-01", "status 503"); err != nil {
		t.Fatal(err)
	}
	retries, err := db.ListClickHouseSinkRetries(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(retries) != 1 || retries[0].Dimension != "model" {
		t.Fatalf("expected one retry for model, got %+v", retries)
	}
	if retries[0].Attempts != 2 {
		t.Errorf("attempts should accumulate, got %d", retries[0].Attempts)
	}
	if retries[0].Error != "status 503" {
		t.Errorf("latest error should win, got %q", retries[0].Error)
	}

	// A subsequent success advances the watermark and clears the retry.
	if err := db.RecordClickHouseSinkSuccess(ctx, "model", "2026-06-02", 42); err != nil {
		t.Fatal(err)
	}
	retries, _ = db.ListClickHouseSinkRetries(ctx)
	if len(retries) != 0 {
		t.Errorf("success should clear the retry queue, got %+v", retries)
	}
	state, err := db.ListClickHouseSinkState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(state) != 1 || state[0].Dimension != "model" || state[0].LastSyncedDay != "2026-06-02" || state[0].RowsSent != 42 {
		t.Fatalf("watermark not recorded correctly: %+v", state)
	}

	// Re-recording success updates the watermark in place (no duplicate row).
	if err := db.RecordClickHouseSinkSuccess(ctx, "model", "2026-06-03", 10); err != nil {
		t.Fatal(err)
	}
	state, _ = db.ListClickHouseSinkState(ctx)
	if len(state) != 1 || state[0].LastSyncedDay != "2026-06-03" {
		t.Fatalf("watermark should update in place: %+v", state)
	}
}
