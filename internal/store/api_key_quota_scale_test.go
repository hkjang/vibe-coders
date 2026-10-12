package store

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// Opt-in synthetic scale measurement, not a production latency guarantee.
// Reproduce with VIBE_QUOTA_SCALE_TEST=1 on SQLite or TEST_POSTGRES_DSN.
func TestAPIKeyQuotaFamilyScale(t *testing.T) {
	if os.Getenv("VIBE_QUOTA_SCALE_TEST") != "1" {
		t.Skip("opt-in synthetic quota family scale and query-plan check")
	}
	db := openStoreForTest(t)
	defer db.Close()
	const familySize, unrelated = 512, 10000
	now := time.Now().UTC()
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	tx, err := db.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal("scale fixture transaction failed")
	}
	defer tx.Rollback()
	edge, err := tx.PrepareContext(ctx, db.bind(`INSERT INTO api_key_rotations (old_key_id, old_key_hash, new_key_id, grace_ends_at, created_at) VALUES (?, ?, ?, ?, ?)`))
	if err != nil {
		t.Fatal("scale edge preparation failed")
	}
	defer edge.Close()
	for i := 0; i < familySize-1+unrelated; i++ {
		old, next := fmt.Sprintf("scale-%d", i), fmt.Sprintf("scale-%d", i+1)
		if i >= familySize-1 {
			old, next = fmt.Sprintf("unrelated-old-%d", i), fmt.Sprintf("unrelated-new-%d", i)
		}
		if _, err := edge.ExecContext(ctx, old, old+"-hash", next, formatTime(now.Add(time.Hour)), formatTime(now)); err != nil {
			t.Fatal("scale lineage fixture failed")
		}
	}
	reserve, err := tx.PrepareContext(ctx, db.bind(`INSERT INTO quota_reservations (request_id, api_key_id, client_ip, tokens, cost_krw, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`))
	if err != nil {
		t.Fatal("scale reservation preparation failed")
	}
	defer reserve.Close()
	for i := 0; i < familySize; i++ {
		id := fmt.Sprintf("scale-%d", i)
		if _, err := reserve.ExecContext(ctx, "reservation-"+id, id, "192.0.2.1", 1, 0.5, formatTime(now), formatTime(now.Add(time.Hour))); err != nil {
			t.Fatal("scale reservation fixture failed")
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal("scale fixture commit failed")
	}
	if _, err := db.db.ExecContext(ctx, `ANALYZE api_key_rotations`); err != nil {
		t.Fatal("scale statistics failed")
	}
	start := time.Now()
	family, err := db.apiKeyQuotaFamily(ctx, "scale-511")
	if err != nil || len(family) != familySize {
		t.Fatal("scale family lookup mismatch")
	}
	familyDuration := time.Since(start)
	start = time.Now()
	live, err := db.LiveReservations(ctx, now)
	if err != nil || len(live["api_key"]) != familySize {
		t.Fatal("scale live family lookup mismatch")
	}
	liveDuration := time.Since(start)
	for _, total := range live["api_key"] {
		if total.Tokens != familySize || total.CostKRW != familySize/2 {
			t.Fatal("scale family aggregation mismatch")
		}
	}
	if live["global"]["*"].Tokens != familySize || live["ip"]["192.0.2.1"].Tokens != familySize {
		t.Fatal("scale global or IP overcount")
	}
	t.Logf("quota_scale dialect=%s edges=%d live=%d family_query_us=%d live_query_us=%d", db.dialect, familySize-1+unrelated, familySize, familyDuration.Microseconds(), liveDuration.Microseconds())
	query := apiKeyQuotaFamilyCTE + `SELECT id FROM key_family`
	if db.dialect == "postgres" {
		var raw []byte
		if err := db.db.QueryRowContext(ctx, db.bind("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "+query), "scale-511").Scan(&raw); err != nil {
			t.Fatal("family explain failed")
		}
		var plans []map[string]any
		if json.Unmarshal(raw, &plans) != nil {
			t.Fatal("family explain format invalid")
		}
		indexed, sequential := 0, 0
		var visit func(any)
		visit = func(value any) {
			switch node := value.(type) {
			case map[string]any:
				if name, _ := node["Index Name"].(string); strings.Contains(name, "api_key_rotations") {
					indexed++
				}
				if relation, _ := node["Relation Name"].(string); relation == "api_key_rotations" && node["Node Type"] == "Seq Scan" {
					sequential++
				}
				for _, child := range node {
					visit(child)
				}
			case []any:
				for _, child := range node {
					visit(child)
				}
			}
		}
		for _, plan := range plans {
			visit(plan)
		}
		t.Logf("quota_family_plan indexed=%d sequential=%d", indexed, sequential)
		if indexed < 2 || sequential != 0 {
			t.Fatal("large lineage traversal did not use both edge indexes")
		}
	} else {
		rows, err := db.db.QueryContext(ctx, "EXPLAIN QUERY PLAN "+query, "scale-511")
		if err != nil {
			t.Fatal("family explain failed")
		}
		defer rows.Close()
		indexed := 0
		for rows.Next() {
			var id, parent, unused int
			var detail string
			if rows.Scan(&id, &parent, &unused, &detail) != nil {
				t.Fatal("family explain row invalid")
			}
			if strings.Contains(detail, "SEARCH r USING INDEX") {
				indexed++
			}
		}
		if rows.Err() != nil || indexed < 2 {
			t.Fatal("large lineage traversal did not use both edge indexes")
		}
		t.Logf("quota_family_plan indexed=%d", indexed)
	}
}
