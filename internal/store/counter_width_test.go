package store

import (
	"context"
	"testing"
	"time"
)

// The behavioural version: a total past the four-byte ceiling has to survive a round trip.
// On SQLite it always would; on PostgreSQL an INTEGER column silently caps the type at
// about 2.1 billion, and the first write past it fails — inside the transaction that logs
// a request.
func TestDayTotalsHoldMoreThanFourBytes(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()
	now := time.Now().In(seoulZone)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, seoulZone)

	const huge = int64(3_000_000_000) // past int4, well inside int64
	if _, err := db.db.ExecContext(ctx, db.bind(
		`INSERT INTO usage_rollup (scope, scope_value, day, requests, tokens, cost)
		 VALUES ('api_key', 'k-big', ?, ?, ?, 0)`), kstDay(today), huge, huge); err != nil {
		t.Fatalf("a day total past the four-byte ceiling could not be stored: %v", err)
	}

	// And the next request still adds to it rather than failing the log transaction.
	logUsage(t, db, "next", "k-big", "10.0.0.1", 100, 1, today.Add(time.Hour))

	_, _, tokens, err := db.UsageForPeriod(ctx, UsageFilter{Scope: "api_key", ScopeValue: "k-big", Since: today})
	if err != nil {
		t.Fatal(err)
	}
	if tokens != huge+100 {
		t.Fatalf("total came back as %d, want %d", tokens, huge+100)
	}
}

// A quota limit is an operator-set ceiling and a monthly token budget can easily be larger
// than four bytes allow.
func TestQuotaLimitsHoldMoreThanFourBytes(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	const huge = int64(1) << 40
	if err := db.UpsertQuota(ctx, QuotaRecord{
		ID: "q-big", Scope: "global", ScopeValue: "*", Period: "monthly",
		TokenLimit: huge, Enabled: true, CreatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("a token limit past the four-byte ceiling was rejected: %v", err)
	}
	got, err := db.ActiveQuotasFor(ctx, "global", "*")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].TokenLimit != huge {
		t.Fatalf("limit round-tripped as %+v, want %d", got, huge)
	}
}

// Every column the widening list names has to exist, or the entry is a note about
// something that moved and the column it was protecting is unguarded.
func TestCounterWideningListMatchesTheSchema(t *testing.T) {
	tables := DeclaredTables()
	for _, c := range pgCounterColumns {
		decl, ok := tables[c.table]
		if !ok {
			t.Errorf("widening list names table %q, which the migrations do not create", c.table)
			continue
		}
		if !decl.HasColumn(c.column) {
			t.Errorf("widening list names %s.%s, which that table does not declare", c.table, c.column)
		}
		if c.why == "" {
			t.Errorf("%s.%s is widened with no reason recorded", c.table, c.column)
		}
	}
}

// The widening only does anything on a database an earlier version created, so that is the
// case worth testing: put the columns back to integer, migrate, and expect bigint.
func TestExistingIntegerCountersAreWidened(t *testing.T) {
	if !isPostgresTest() {
		t.Skip("PostgreSQL-specific: SQLite stores these at 64 bits whatever the declared type")
	}
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	dataTypeOf := func(table, column string) string {
		t.Helper()
		var dt string
		if err := db.db.QueryRowContext(ctx, `
			SELECT data_type FROM information_schema.columns
			WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
			table, column).Scan(&dt); err != nil {
			t.Fatalf("%s.%s: %v", table, column, err)
		}
		return dt
	}

	for _, c := range pgCounterColumns {
		if _, err := db.db.ExecContext(ctx,
			`ALTER TABLE `+quotePGIdentifier(c.table)+` ALTER COLUMN `+quotePGIdentifier(c.column)+` TYPE INTEGER`); err != nil {
			t.Fatalf("could not put %s.%s back to integer: %v", c.table, c.column, err)
		}
		if got := dataTypeOf(c.table, c.column); got != "integer" {
			t.Fatalf("%s.%s is %q after being set to integer", c.table, c.column, got)
		}
	}

	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("migrate over an older schema: %v", err)
	}

	for _, c := range pgCounterColumns {
		if got := dataTypeOf(c.table, c.column); got != "bigint" {
			t.Errorf("%s.%s is still %q after migrating; %s", c.table, c.column, got, c.why)
		}
	}

	// Migrating again must not fail on columns that are already wide.
	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("migrate is not idempotent: %v", err)
	}
}
