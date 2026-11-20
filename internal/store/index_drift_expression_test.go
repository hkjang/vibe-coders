package store

import (
	"strings"
	"testing"
)

func TestIndexDriftLegacyTimePostgresExpression(t *testing.T) {
	// pg_get_indexdef puts the CASE's closing parenthesis outside concatenation.
	declared := legacyRequestCreatedAtExpr("created_at")
	postgres := "(" + strings.TrimSuffix(appRequestCreatedAtExpr("created_at"), ")") + " || ''))"
	if normalizeIndexColumn(declared) != normalizeIndexColumn(postgres) {
		t.Fatal("PostgreSQL's equivalent CASE grouping reports chronological index drift")
	}
}

func TestIndexDriftExpressionPreservesLiteralAndOperatorChanges(t *testing.T) {
	for _, pair := range [][2]string{
		{"lower('Upper')", "lower('upper')"},
		{"lower('a b')", "lower('ab')"},
		{"lower('a::text')", "lower('a')"},
		{"lower('it''s A')", "lower('it''s a')"},
		{"((latency_ms + first_chunk_ms) * 2)", "(latency_ms + (first_chunk_ms * 2))"},
		{legacyRequestCreatedAtExpr("created_at"), strings.ReplaceAll(legacyRequestCreatedAtExpr("created_at"), "'Z'", "'z'")},
	} {
		t.Run(pair[0], func(t *testing.T) {
			if normalizeIndexColumn(pair[0]) == normalizeIndexColumn(pair[1]) {
				t.Fatal("changed expression was hidden by normalization")
			}
		})
	}
	if normalizeIndexColumn("LOWER( 'Public Case'::text )") != normalizeIndexColumn("lower('Public Case')") {
		t.Fatal("SQL formatting and PostgreSQL literal type annotation report false drift")
	}
	if normalizeIndexColumn("MODEL TEXT_PATTERN_OPS DESC NULLS LAST") != "model" {
		t.Fatal("case-insensitive identifier decoration was not preserved")
	}
}

func TestIndexDriftLegacyTimeRejectsChangedLiteral(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := t.Context()
	if _, err := db.db.ExecContext(ctx, "DROP INDEX idx_request_logs_legacy_time"); err != nil {
		t.Fatal(err)
	}
	changed := strings.ReplaceAll(legacyRequestCreatedAtExpr("created_at"), "'Z'", "'z'")
	if _, err := db.db.ExecContext(ctx, "CREATE INDEX idx_request_logs_legacy_time ON request_logs("+changed+")"); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	report, err := db.IndexDrift(ctx)
	if err != nil {
		t.Fatal(err)
	}
	driftItem(t, report, "mismatched", "idx_request_logs_legacy_time")
}
