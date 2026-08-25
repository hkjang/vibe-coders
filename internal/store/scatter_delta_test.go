package store

import (
	"context"
	"strings"
	"testing"
	"time"
)

func insertScatterDeltaRecord(t *testing.T, db *SQLStore, id, model, endpoint string, createdAt time.Time) {
	t.Helper()
	if err := db.InsertLogRecord(context.Background(), LogRecord{Request: RequestLog{
		ID: id, TraceID: "trace_" + id, APIKeyID: "key_delta", Model: model,
		Endpoint: endpoint, Provider: "test", StatusCode: 200, LatencyMS: 10,
		CreatedAt: createdAt,
	}}); err != nil {
		t.Fatal(err)
	}
}

func TestScatterDeltaUsesIngestionOrderForLateCommit(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { _ = db.Close() })
	now := time.Now().UTC()

	insertScatterDeltaRecord(t, db, "req_a_fast", "fast-model", "/v1/chat/completions", now)
	start, err := db.LatestScatterCursor(context.Background(), ScatterFilter{})
	if err != nil {
		t.Fatal(err)
	}
	after, err := time.Parse(time.RFC3339Nano, start.IngestedAt)
	if err != nil {
		t.Fatalf("invalid stored cursor %q: %v", start.IngestedAt, err)
	}

	// This request started much earlier but was persisted after the cursor was taken. A
	// created_at cursor would lose it; the ingestion cursor must return it.
	insertScatterDeltaRecord(t, db, "req_z_slow", "slow-model", "/v1/chat/completions", now.Add(-30*time.Minute))
	points, cursor, hasMore, err := db.ScatterDelta(context.Background(), ScatterFilter{
		Since: now.Add(-time.Hour), Limit: 10,
	}, after, start.RequestID, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if hasMore {
		t.Fatal("one late row should fit in a single delta page")
	}
	if len(points) != 1 || points[0].RequestID != "req_z_slow" {
		t.Fatalf("late commit delta = %+v, want req_z_slow", points)
	}
	if points[0].IngestedAt == "" || cursor.RequestID != "req_z_slow" || cursor.IngestedAt != points[0].IngestedAt {
		t.Fatalf("delta cursor did not advance to returned row: point=%+v cursor=%+v", points[0], cursor)
	}
}

func TestScatterDeltaCompositeCursorPaginatesTimestampTies(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { _ = db.Close() })
	now := time.Now().UTC()
	for _, id := range []string{"req_a", "req_b", "req_c"} {
		insertScatterDeltaRecord(t, db, id, "same-model", "/v1/chat/completions", now)
	}

	tiedAt := time.Date(2026, 8, 25, 1, 2, 3, 456789000, time.UTC)
	if _, err := db.db.ExecContext(context.Background(), db.bind(`
		UPDATE request_logs SET ingested_at = ? WHERE id IN (?, ?, ?)`),
		formatXViewIngestedAt(tiedAt), "req_a", "req_b", "req_c"); err != nil {
		t.Fatal(err)
	}

	filter := ScatterFilter{Since: now.Add(-time.Hour), Limit: 1}
	first, cursor, hasMore, err := db.ScatterDelta(context.Background(), filter, tiedAt, "req_a", false, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 1 || first[0].RequestID != "req_b" || !hasMore {
		t.Fatalf("first tied page = %+v has_more=%v, want req_b and more", first, hasMore)
	}
	after, err := time.Parse(time.RFC3339Nano, cursor.IngestedAt)
	if err != nil {
		t.Fatal(err)
	}
	second, cursor, hasMore, err := db.ScatterDelta(context.Background(), filter, after, cursor.RequestID, false, false)
	if err != nil {
		t.Fatal(err)
	}
	foundC := false
	for _, point := range second {
		foundC = foundC || point.RequestID == "req_c"
	}
	if !foundC || hasMore {
		t.Fatalf("second tied page = %+v has_more=%v, want reconciled rows plus req_c and done", second, hasMore)
	}
	if cursor.RequestID != "req_c" {
		t.Fatalf("final cursor = %+v", cursor)
	}
}

func TestScatterDeltaBootstrapPaginatesBurstAfterEmptySnapshot(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { _ = db.Close() })
	now := time.Now().UTC()
	for _, id := range []string{"burst-a", "burst-b", "burst-c"} {
		insertScatterDeltaRecord(t, db, id, "burst-model", "/v1/chat/completions", now)
	}

	filter := ScatterFilter{Since: now.Add(-time.Hour), Model: "burst-model", Limit: 2}
	first, cursor, hasMore, err := db.ScatterDelta(context.Background(), filter, time.Time{}, "", false, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 2 || !hasMore {
		t.Fatalf("bootstrap page = %+v has_more=%v, want two rows and another page", first, hasMore)
	}
	after, err := time.Parse(time.RFC3339Nano, cursor.IngestedAt)
	if err != nil {
		t.Fatal(err)
	}
	second, _, hasMore, err := db.ScatterDelta(context.Background(), filter, after, cursor.RequestID, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(second) != 1 || second[0].RequestID != "burst-c" || hasMore {
		t.Fatalf("bootstrap second page = %+v has_more=%v, want burst-c and done", second, hasMore)
	}
}

func TestScatterDeltaReconcilesOutOfOrderCommitVisibility(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { _ = db.Close() })
	now := time.Now().UTC()
	insertScatterDeltaRecord(t, db, "cursor-row", "wanted", "/v1/chat/completions", now)
	start, err := db.LatestScatterCursor(context.Background(), ScatterFilter{})
	if err != nil {
		t.Fatal(err)
	}
	after, err := time.Parse(time.RFC3339Nano, start.IngestedAt)
	if err != nil {
		t.Fatal(err)
	}

	// Simulate transaction A receiving its timestamp first, transaction B committing and
	// advancing the cursor, then A becoming visible afterwards with the older timestamp.
	// Twenty seconds also locks in coverage for a 15-second reconciliation cadence plus the
	// async writer's five-second timeout; the production window retains additional jitter room.
	insertScatterDeltaRecord(t, db, "late-visible", "wanted", "/v1/chat/completions", now)
	if _, err := db.db.ExecContext(context.Background(), db.bind(`UPDATE request_logs SET ingested_at = ? WHERE id = ?`),
		formatXViewIngestedAt(after.Add(-20*time.Second)), "late-visible"); err != nil {
		t.Fatal(err)
	}

	filter := ScatterFilter{
		Since: now.Add(-time.Hour), Model: "wanted", Limit: 10,
	}
	points, cursor, hasMore, err := db.ScatterDelta(context.Background(), filter, after, start.RequestID, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if hasMore || len(points) != 0 || cursor != start {
		t.Fatalf("forward-only delta = %+v cursor=%+v has_more=%v, want no behind-cursor rows", points, cursor, hasMore)
	}

	points, cursor, hasMore, err = db.ScatterDelta(context.Background(), filter, after, start.RequestID, true, false)
	if err != nil {
		t.Fatal(err)
	}
	if hasMore || len(points) != 1 || points[0].RequestID != "late-visible" {
		t.Fatalf("reconciled delta = %+v has_more=%v", points, hasMore)
	}
	if cursor != start {
		t.Fatalf("reconciliation row behind cursor must not move it backwards: got %+v want %+v", cursor, start)
	}
}

func TestScatterDeltaReconcilesRowsFromOlderPodsDuringRollingUpgrade(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { _ = db.Close() })
	now := time.Now().UTC()
	insertScatterDeltaRecord(t, db, "rolling-cursor", "wanted", "/v1/chat/completions", now)
	start, err := db.LatestScatterCursor(context.Background(), ScatterFilter{})
	if err != nil {
		t.Fatal(err)
	}
	after, err := time.Parse(time.RFC3339Nano, start.IngestedAt)
	if err != nil {
		t.Fatal(err)
	}

	insertScatterDeltaRecord(t, db, "old-pod-row", "wanted", "/v1/chat/completions", now)
	if _, err := db.db.ExecContext(context.Background(), db.bind(`UPDATE request_logs SET ingested_at = '' WHERE id = ?`), "old-pod-row"); err != nil {
		t.Fatal(err)
	}
	filter := ScatterFilter{Since: now.Add(-time.Hour), Model: "wanted", Limit: 10}
	points, _, _, err := db.ScatterDelta(context.Background(), filter, after, start.RequestID, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 0 {
		t.Fatalf("forward poll unexpectedly returned legacy row: %+v", points)
	}
	points, cursor, hasMore, err := db.ScatterDelta(context.Background(), filter, after, start.RequestID, true, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 1 || points[0].RequestID != "old-pod-row" || hasMore {
		t.Fatalf("rolling-upgrade reconciliation = %+v has_more=%v", points, hasMore)
	}
	if cursor != start {
		t.Fatalf("legacy row must not move the cursor: got %+v want %+v", cursor, start)
	}
}

func TestScatterDeltaReconcilesOlderPodRowsBeforeFirstModernCursor(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { _ = db.Close() })
	now := time.Now().UTC()
	insertScatterDeltaRecord(t, db, "only-old-pod-row", "wanted", "/v1/chat/completions", now)
	if _, err := db.db.ExecContext(context.Background(), db.bind(`UPDATE request_logs SET ingested_at = '' WHERE id = ?`), "only-old-pod-row"); err != nil {
		t.Fatal(err)
	}

	points, cursor, hasMore, err := db.ScatterDelta(context.Background(), ScatterFilter{
		Since: now.Add(-time.Hour), Model: "wanted", Limit: 10,
	}, time.Time{}, "", true, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 1 || points[0].RequestID != "only-old-pod-row" || hasMore {
		t.Fatalf("empty-cursor rolling reconciliation = %+v has_more=%v", points, hasMore)
	}
	if cursor != (ScatterCursor{}) {
		t.Fatalf("legacy-only rows cannot advance the ingestion cursor: %+v", cursor)
	}
}

func TestScatterDeltaRefreshReprojectsMutableApprovalOutsideOverlap(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	now := time.Now().UTC()
	insertScatterDeltaRecord(t, db, "mutable-request", "wanted", "/v1/chat/completions", now)
	if err := db.InsertApproval(ctx, Approval{
		ID: "mutable-approval", RequestID: "mutable-request", Status: "pending", CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	insertScatterDeltaRecord(t, db, "refresh-cursor", "wanted", "/v1/chat/completions", now)
	start, err := db.LatestScatterCursor(ctx, ScatterFilter{})
	if err != nil {
		t.Fatal(err)
	}
	after, err := time.Parse(time.RFC3339Nano, start.IngestedAt)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.db.ExecContext(ctx, db.bind(`UPDATE request_logs SET ingested_at = ? WHERE id = ?`),
		formatXViewIngestedAt(after.Add(-time.Minute)), "mutable-request"); err != nil {
		t.Fatal(err)
	}
	if err := db.SetApprovalStatus(ctx, "mutable-approval", "approved", "reviewer"); err != nil {
		t.Fatal(err)
	}

	filter := ScatterFilter{Since: now.Add(-time.Hour), Model: "wanted", Limit: 10}
	points, _, _, err := db.ScatterDelta(ctx, filter, after, start.RequestID, true, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, point := range points {
		if point.RequestID == "mutable-request" {
			t.Fatalf("bounded compatibility reconcile unexpectedly returned old mutable request: %+v", point)
		}
	}

	points, cursor, hasMore, err := db.ScatterDelta(ctx, filter, after, start.RequestID, false, true)
	if err != nil {
		t.Fatal(err)
	}
	if hasMore || cursor != start {
		t.Fatalf("refresh changed forward pagination: cursor=%+v has_more=%v", cursor, hasMore)
	}
	found := false
	for _, point := range points {
		if point.RequestID == "mutable-request" {
			found = true
			if point.ApprovalStatus != "approved" {
				t.Fatalf("refreshed approval status = %q, want approved", point.ApprovalStatus)
			}
		}
	}
	if !found {
		t.Fatalf("full refresh did not reproject the mutable request: %+v", points)
	}
}

func TestScatterDeltaReusesSnapshotFilters(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { _ = db.Close() })
	now := time.Now().UTC()
	insertScatterDeltaRecord(t, db, "matching", "wanted", "/v1/chat/completions", now)
	insertScatterDeltaRecord(t, db, "wrong-model", "other", "/v1/chat/completions", now)
	insertScatterDeltaRecord(t, db, "wrong-endpoint", "wanted", "/v1/embeddings", now)

	points, cursor, hasMore, err := db.ScatterDelta(context.Background(), ScatterFilter{
		Since: now.Add(-time.Hour), Models: []string{"wanted"}, Endpoint: "/v1/chat/completions", APIKeyID: "key_delta", Limit: 10,
	}, time.Time{}, "", false, false)
	if err != nil {
		t.Fatal(err)
	}
	if hasMore || len(points) != 1 || points[0].RequestID != "matching" {
		t.Fatalf("filtered baseline = %+v has_more=%v", points, hasMore)
	}
	if cursor.IngestedAt == "" || cursor.RequestID == "" {
		t.Fatalf("baseline cursor must establish a high-water mark: %+v", cursor)
	}
}

func TestScopedUnassignedIdentityDoesNotIncludeSyntheticTraffic(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	now := time.Now().UTC()
	if err := db.UpsertAPIKey(ctx, APIKeyRecord{
		ID: "literal-unassigned-key", Name: "literal", KeyHash: "literal-unassigned-hash",
		Team: "unassigned", Status: "active",
	}); err != nil {
		t.Fatal(err)
	}
	for _, request := range []RequestLog{
		{ID: "literal-team-request", TraceID: "literal-team-request", APIKeyID: "literal-unassigned-key"},
		{ID: "synthetic-unassigned-request", TraceID: "synthetic-unassigned-request", APIKeyID: "missing-key"},
	} {
		request.Model = "wanted"
		request.Endpoint = "/v1/chat/completions"
		request.Provider = "test"
		request.StatusCode = 200
		request.CreatedAt = now
		if err := db.InsertLogRecord(ctx, LogRecord{Request: request}); err != nil {
			t.Fatal(err)
		}
	}

	scoped := ScatterFilter{
		Since: now.Add(-time.Hour), Teams: []string{"unassigned"}, TeamScoped: true, Limit: 10,
	}
	points, _, err := db.ScatterPoints(ctx, scoped)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 1 || points[0].RequestID != "literal-team-request" {
		t.Fatalf("scoped literal unassigned team leaked synthetic traffic: %+v", points)
	}
	cursor, err := db.LatestScatterCursor(ctx, scoped)
	if err != nil {
		t.Fatal(err)
	}
	if cursor.RequestID != "literal-team-request" {
		t.Fatalf("scoped cursor crossed into synthetic traffic: %+v", cursor)
	}
	recent, err := db.RecentRequests(ctx, RequestFilter{
		Teams: []string{"unassigned"}, TeamScoped: true, Limit: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(recent) != 1 || recent[0].ID != "literal-team-request" {
		t.Fatalf("scoped request list leaked synthetic traffic: %+v", recent)
	}

	// The operator-facing unscoped filter retains its historical synthetic meaning.
	unscoped, err := db.RecentRequests(ctx, RequestFilter{Team: "unassigned", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(unscoped) != 2 {
		t.Fatalf("unscoped unassigned filter returned %d rows, want both literal and synthetic", len(unscoped))
	}
}

func TestScatterDeltaAdvancesPastNonMatchingRows(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { _ = db.Close() })
	now := time.Now().UTC()
	insertScatterDeltaRecord(t, db, "req_a_match", "wanted", "/v1/chat/completions", now)
	start, err := db.LatestScatterCursor(context.Background(), ScatterFilter{})
	if err != nil {
		t.Fatal(err)
	}
	after, err := time.Parse(time.RFC3339Nano, start.IngestedAt)
	if err != nil {
		t.Fatal(err)
	}

	insertScatterDeltaRecord(t, db, "req_b_other", "other", "/v1/chat/completions", now)
	insertScatterDeltaRecord(t, db, "req_c_other", "other", "/v1/embeddings", now)
	global, err := db.LatestScatterCursor(context.Background(), ScatterFilter{})
	if err != nil {
		t.Fatal(err)
	}

	filter := ScatterFilter{Since: now.Add(-time.Hour), Model: "wanted", Endpoint: "/v1/chat/completions", Limit: 10}
	points, cursor, hasMore, err := db.ScatterDelta(context.Background(), filter, after, start.RequestID, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 0 || hasMore {
		t.Fatalf("non-matching delta = %+v has_more=%v, want empty exhausted page", points, hasMore)
	}
	if cursor != global {
		t.Fatalf("cursor did not advance across non-matching rows: got %+v want %+v", cursor, global)
	}

	advancedAt, err := time.Parse(time.RFC3339Nano, cursor.IngestedAt)
	if err != nil {
		t.Fatal(err)
	}
	insertScatterDeltaRecord(t, db, "req_z_match", "wanted", "/v1/chat/completions", now)
	points, _, _, err = db.ScatterDelta(context.Background(), filter, advancedAt, cursor.RequestID, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 1 || points[0].RequestID != "req_z_match" {
		t.Fatalf("matching row after advanced cursor = %+v", points)
	}
}

func TestRequestLogIngestionUsesFixedWidthMonotonicClockAndIndexes(t *testing.T) {
	db := openStoreForTest(t)
	t.Cleanup(func() { _ = db.Close() })
	createdAt := time.Date(2026, 8, 25, 2, 3, 4, 0, time.UTC)
	insertScatterDeltaRecord(t, db, "clock-first", "clock", "/v1/chat/completions", createdAt)
	var ingestedAt string
	if err := db.db.QueryRowContext(context.Background(), db.bind(`SELECT ingested_at FROM request_logs WHERE id = ?`), "clock-first").Scan(&ingestedAt); err != nil {
		t.Fatal(err)
	}
	parsed, err := time.Parse(time.RFC3339Nano, ingestedAt)
	if err != nil || ingestedAt != formatXViewIngestedAt(parsed) {
		t.Fatalf("ingested_at is not fixed-width RFC3339: %q err=%v", ingestedAt, err)
	}

	// Simulate a pod whose wall clock is behind a value already issued by another pod.
	// The shared clock must still advance by one nanosecond rather than moving backwards.
	future := time.Now().UTC().Add(time.Hour)
	if _, err := db.db.ExecContext(context.Background(), db.bind(`UPDATE xview_ingest_clock SET tick = ? WHERE id = 1`), future.UnixNano()); err != nil {
		t.Fatal(err)
	}
	insertScatterDeltaRecord(t, db, "clock-second", "clock", "/v1/chat/completions", createdAt)
	var second string
	if err := db.db.QueryRowContext(context.Background(), db.bind(`SELECT ingested_at FROM request_logs WHERE id = ?`), "clock-second").Scan(&second); err != nil {
		t.Fatal(err)
	}
	if second <= formatXViewIngestedAt(future) {
		t.Fatalf("serialized ingestion clock moved backwards: future=%q second=%q", formatXViewIngestedAt(future), second)
	}

	// The remaining assertions inspect SQLite's catalogue/plan. PostgreSQL coverage runs the
	// same migrations but exposes those details through different system views.
	if db.dialect != "sqlite" {
		return
	}
	var indexCount int
	if err := db.db.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_request_logs_ingested_cursor'`).Scan(&indexCount); err != nil {
		t.Fatal(err)
	}
	if indexCount != 1 {
		t.Fatalf("ingestion cursor index count = %d, want 1", indexCount)
	}
	if err := db.db.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_request_logs_xview_legacy'`).Scan(&indexCount); err != nil {
		t.Fatal(err)
	}
	if indexCount != 1 {
		t.Fatalf("legacy XView index count = %d, want 1", indexCount)
	}
	if err := db.db.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_secret_events_request'`).Scan(&indexCount); err != nil {
		t.Fatal(err)
	}
	if indexCount != 1 {
		t.Fatalf("secret-event request index count = %d, want 1", indexCount)
	}
	planRows, err := db.db.QueryContext(context.Background(), `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM secret_events WHERE request_id = ?`, "req-plan")
	if err != nil {
		t.Fatal(err)
	}
	defer planRows.Close()
	usesRequestIndex := false
	for planRows.Next() {
		var id, parent, notUsed int
		var detail string
		if err := planRows.Scan(&id, &parent, &notUsed, &detail); err != nil {
			t.Fatal(err)
		}
		usesRequestIndex = usesRequestIndex || strings.Contains(detail, "idx_secret_events_request")
	}
	if err := planRows.Err(); err != nil {
		t.Fatal(err)
	}
	if !usesRequestIndex {
		t.Fatal("secret-event request lookup does not use idx_secret_events_request")
	}
	legacyPlan, err := db.db.QueryContext(context.Background(), `EXPLAIN QUERY PLAN
		SELECT id FROM request_logs WHERE ingested_at = '' AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT 6000`,
		formatTime(time.Now().Add(-time.Hour)))
	if err != nil {
		t.Fatal(err)
	}
	defer legacyPlan.Close()
	usesLegacyIndex := false
	for legacyPlan.Next() {
		var id, parent, notUsed int
		var detail string
		if err := legacyPlan.Scan(&id, &parent, &notUsed, &detail); err != nil {
			t.Fatal(err)
		}
		usesLegacyIndex = usesLegacyIndex || strings.Contains(detail, "idx_request_logs_xview_legacy")
	}
	if err := legacyPlan.Err(); err != nil {
		t.Fatal(err)
	}
	if !usesLegacyIndex {
		t.Fatal("legacy XView reconciliation does not use idx_request_logs_xview_legacy")
	}
	teamPlan, err := db.db.QueryContext(context.Background(), `EXPLAIN QUERY PLAN
		SELECT ingested_at, id FROM request_logs r
		WHERE r.ingested_at <> '' AND r.created_at >= ?
		  AND r.api_key_id IN (SELECT k.id FROM api_keys k WHERE k.team IN (?, ?))
		ORDER BY r.ingested_at DESC, r.id DESC LIMIT 1`, formatTime(time.Now().Add(-time.Hour)), "team-plan-id", "team-plan-name")
	if err != nil {
		t.Fatal(err)
	}
	defer teamPlan.Close()
	usesTeamCursorIndex := false
	for teamPlan.Next() {
		var id, parent, notUsed int
		var detail string
		if err := teamPlan.Scan(&id, &parent, &notUsed, &detail); err != nil {
			t.Fatal(err)
		}
		usesTeamCursorIndex = usesTeamCursorIndex || strings.Contains(detail, "idx_request_logs_xview_team_cursor")
	}
	if err := teamPlan.Err(); err != nil {
		t.Fatal(err)
	}
	if !usesTeamCursorIndex {
		t.Fatal("team-scoped XView cursor lookup does not use idx_request_logs_xview_team_cursor")
	}
}

func TestPostgresXViewIndexesAreBuiltWithoutBlockingWriters(t *testing.T) {
	checked := 0
	for _, statement := range migrationStatements() {
		if !strings.Contains(statement, "idx_request_logs_ingested_cursor") && !strings.Contains(statement, "idx_request_logs_xview_legacy") && !strings.Contains(statement, "idx_request_logs_xview_team_cursor") && !strings.Contains(statement, "idx_secret_events_request") {
			continue
		}
		rendered := renderForDialect(statement, "postgres")
		if !strings.Contains(rendered, "CREATE INDEX CONCURRENTLY IF NOT EXISTS") {
			t.Fatalf("PostgreSQL XView index is not concurrent: %s", rendered)
		}
		if strings.Contains(renderForDialect(statement, "sqlite"), "CONCURRENTLY") {
			t.Fatalf("SQLite XView index unexpectedly uses PostgreSQL syntax: %s", statement)
		}
		checked++
	}
	if checked != 4 {
		t.Fatalf("checked %d XView indexes, want 4", checked)
	}
}
