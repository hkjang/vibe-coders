package store

import (
	"context"
	"math"
	"os"
	"testing"
	"time"
)

// Driver portability.
//
// The product ships two drivers and recommends PostgreSQL for production, but every test
// ran on SQLite, so no query in this package had ever been executed against PostgreSQL.
// Three defects were sitting in that gap: REAL columns silently rounding money, an
// ORDER BY over select aliases, and an upsert reading its own row by a bare column name.
//
// Set TEST_POSTGRES_DSN to run this package against PostgreSQL; each test gets its own
// schema. Without it these tests skip and the suite behaves as before.
//
//	docker run -d --name pg-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=vibe -p 55433:5432 postgres:17-alpine
//	TEST_POSTGRES_DSN="postgres://postgres:test@127.0.0.1:55433/vibe?sslmode=disable" go test ./internal/store/

// No column may be float4. PostgreSQL REAL holds about seven significant decimal digits,
// so a cost of 12,345,678.9 KRW is stored as 12,345,679 and the error compounds through
// every SUM built on it. SQLite's REAL is already double precision, which is why the
// schema read as correct for as long as it was only ever run there.
func TestPostgresHasNoSinglePrecisionColumns(t *testing.T) {
	dsn := os.Getenv("TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("set TEST_POSTGRES_DSN to check schema types against PostgreSQL")
	}
	db := openStoreForTest(t)
	defer db.Close()

	rows, err := db.db.QueryContext(context.Background(), `
		SELECT table_name, column_name
		FROM information_schema.columns
		WHERE table_schema = current_schema() AND data_type = 'real'
		ORDER BY table_name, column_name`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var found []string
	for rows.Next() {
		var table, column string
		if err := rows.Scan(&table, &column); err != nil {
			t.Fatal(err)
		}
		found = append(found, table+"."+column)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(found) > 0 {
		t.Errorf("%d column(s) are float4 on PostgreSQL and will round the values written to them: %v\n"+
			"Declare them DOUBLE PRECISION, or widen them in widenPostgresRealColumns.", len(found), found)
	}
}

// The same property from the outside: a cost written through the normal path must come
// back as the number that was written. The value is chosen to exceed float4's precision —
// at single precision it returns 12345679, an error of 0.1 KRW on one request, and the
// difference does not stay that small once it is summed.
func TestCostSurvivesTheRoundTripExactly(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	ctx := context.Background()

	const cost = 12345678.9
	now := time.Now().UTC()
	if err := db.InsertLogRecord(ctx, LogRecord{
		Request: RequestLog{
			ID: "precision-1", TraceID: "precision-1", Endpoint: "/v1/chat/completions",
			Model: "m", Provider: "up", StatusCode: 200, LatencyMS: 10, CreatedAt: now,
		},
		Usage: &TokenUsage{
			ID: "precision-usage-1", RequestID: "precision-1",
			EstimatedCost: cost, Currency: "KRW", Source: "test",
		},
	}); err != nil {
		t.Fatal(err)
	}

	var got float64
	if err := db.db.QueryRowContext(ctx,
		db.bind(`SELECT estimated_cost FROM token_usage WHERE request_id = ?`), "precision-1").
		Scan(&got); err != nil {
		t.Fatal(err)
	}
	if math.Abs(got-cost) > 1e-9 {
		t.Errorf("wrote %.4f KRW and read back %.4f — the column cannot hold the value it was given (off by %.4f)",
			cost, got, got-cost)
	}
}
