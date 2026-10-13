package store

import (
	"math"
	"reflect"
	"sort"
	"testing"
	"time"
)

func TestAPIKeyQuotaTotalsOverflow(t *testing.T) {
	for _, pair := range [][2]ReservedTotals{
		{{Tokens: math.MaxInt64}, {Tokens: 1}},
		{{Tokens: math.MinInt64}, {Tokens: -1}},
		{{CostKRW: math.MaxFloat64}, {CostKRW: math.MaxFloat64}},
		{{CostKRW: math.NaN()}, {}},
	} {
		if _, err := addReservedTotals(pair[0], pair[1]); err == nil {
			t.Fatal("invalid reservation total was accepted")
		}
	}
	if total, err := addReservedTotals(ReservedTotals{Tokens: math.MaxInt64 - 1, CostKRW: 0.25}, ReservedTotals{Tokens: 1, CostKRW: 0.5}); err != nil || total.Tokens != math.MaxInt64 || total.CostKRW != 0.75 {
		t.Fatal("valid reservation total was rejected")
	}
}

func quotaRotationChain(t *testing.T, db *SQLStore) []APIKeyRecord {
	t.Helper()
	old := rotationSeed(t, db)
	keys := []APIKeyRecord{old}
	for _, suffix := range []string{"family-one", "family-two"} {
		created, rotated := rotationAudits(old, suffix)
		next, err := db.RotateAPIKey(t.Context(), old, created.APIKeyID, "family-hash-"+suffix, time.Hour, created, rotated)
		if err != nil {
			t.Fatal("family rotation fixture failed")
		}
		old = next.APIKeyRecord
		keys = append(keys, old)
	}
	return keys
}

func TestAPIKeyQuotaFamilyAccounting(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	keys := quotaRotationChain(t, db)
	now := time.Now().In(seoulZone)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, seoulZone)
	if !db.rollupCovers(t.Context(), today) {
		t.Fatal("fast path fixture not covered")
	}
	for i, key := range keys {
		logUsage(t, db, "family-request-"+key.ID, key.ID, "192.0.2.1", (i+1)*10, float64(i+1), today.Add(time.Minute))
		if err := db.ReserveQuota(t.Context(), QuotaReservation{RequestID: "live-" + key.ID, APIKeyID: key.ID, ClientIP: "192.0.2.1", Tokens: int64(i + 1), CostKRW: float64(i+1) / 2, ExpiresAt: now.Add(time.Minute)}); err != nil {
			t.Fatal("live fixture failed")
		}
	}
	logUsage(t, db, "unrelated-request", "unrelated-key", "192.0.2.1", 900, 90, today.Add(time.Minute))
	if err := db.ReserveQuota(t.Context(), QuotaReservation{RequestID: "expired-family", APIKeyID: keys[0].ID, Tokens: 900, CostKRW: 90, ExpiresAt: now}); err != nil {
		t.Fatal("expired fixture failed")
	}
	if err := db.ReserveQuota(t.Context(), QuotaReservation{RequestID: "unrelated-live", APIKeyID: "unrelated-key", ClientIP: "192.0.2.1", Tokens: 90, CostKRW: 9, ExpiresAt: now.Add(time.Minute)}); err != nil {
		t.Fatal("unrelated fixture failed")
	}
	for _, phase := range []string{"all-rows", "audit-purged-and-original-deleted"} {
		if phase != "all-rows" {
			if _, err := db.db.ExecContext(t.Context(), `DELETE FROM audit_events`); err != nil {
				t.Fatal("audit purge fixture failed")
			}
			if err := db.DeleteAPIKey(t.Context(), keys[0].ID); err != nil {
				t.Fatal("key deletion failed")
			}
		}
		for _, since := range []time.Time{today, today.Add(time.Nanosecond)} {
			for _, key := range keys {
				requests, cost, tokens, err := db.UsageForPeriod(t.Context(), UsageFilter{Scope: "api_key", ScopeValue: key.ID, Since: since})
				if err != nil || requests != 3 || tokens != 60 || cost != 6 {
					t.Fatal("family accounting lost, duplicated or mixed unrelated usage")
				}
			}
		}
		live, err := db.LiveReservations(t.Context(), now)
		if err != nil {
			t.Fatal("family live totals unavailable")
		}
		for _, key := range keys {
			tokens, cost, err := db.ReservedUsage(t.Context(), "api_key", key.ID, now)
			if err != nil || tokens != 6 || cost != 3 || live["api_key"][key.ID].Tokens != tokens || live["api_key"][key.ID].CostKRW != cost {
				t.Fatal("scalar and batched reservations disagree on family")
			}
		}
		if live["global"]["*"].Tokens != 96 || live["ip"]["192.0.2.1"].Tokens != 96 {
			t.Fatal("family expansion duplicated global or IP reservations")
		}
	}
	for i, key := range keys {
		requests, cost, tokens, err := db.UsageSince(t.Context(), UsageFilter{Scope: "api_key", ScopeValue: key.ID, Since: today})
		if err != nil || requests != 1 || tokens != int64((i+1)*10) || cost != float64(i+1) {
			t.Fatal("rotation rewrote individual request attribution")
		}
	}
}

func TestAPIKeyQuotaFamilyDefinitionsAndCrossPoolVisibility(t *testing.T) {
	writer, reader := routingPatchStores(t)
	old := rotationSeed(t, writer)
	seedQuota(t, writer, "family-limit", "api_key", old.ID, 100, true)
	if _, err := reader.ActiveQuotasFor(t.Context(), "api_key", old.ID); err != nil {
		t.Fatal("cache prime failed")
	}
	created, rotated := rotationAudits(old, "cross-pool")
	next, err := writer.RotateAPIKey(t.Context(), old, created.APIKeyID, "new-cross-pool-hash", time.Hour, created, rotated)
	if err != nil {
		t.Fatal("rotation failed")
	}
	quotas, err := reader.ActiveQuotasFor(t.Context(), "api_key", next.ID)
	if err != nil || len(quotas) != 1 || quotas[0].ID != "family-limit" {
		t.Fatal("warm definitions cache missed cross-pool rotation")
	}
	seedQuota(t, writer, "replacement-limit", "api_key", next.ID, 50, true)
	seedQuota(t, writer, "disabled-limit", "api_key", old.ID, 1, false)
	seedQuota(t, writer, "unrelated-limit", "api_key", "unrelated-key", 1, true)
	for _, id := range []string{old.ID, next.ID} {
		quotas, err := writer.ActiveQuotasFor(t.Context(), "api_key", id)
		if err != nil {
			t.Fatal("family definitions unavailable")
		}
		ids := []string{}
		for _, q := range quotas {
			ids = append(ids, q.ID)
		}
		sort.Strings(ids)
		if !reflect.DeepEqual(ids, []string{"family-limit", "replacement-limit"}) {
			t.Fatal("family rules omitted, duplicated or included unrelated/disabled limits")
		}
	}
}

func TestAPIKeyQuotaFamilyCycleTerminates(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	// Defensive against manually imported/corrupt lineage, not a supported
	// rotation operation: UNION must still return each member only once.
	for _, edge := range [][2]string{{"cycle-a", "cycle-b"}, {"cycle-b", "cycle-a"}} {
		if _, err := db.db.ExecContext(t.Context(), db.bind(`INSERT INTO api_key_rotations (old_key_id, old_key_hash, new_key_id, grace_ends_at, created_at) VALUES (?, ?, ?, ?, ?)`), edge[0], edge[0]+"-hash", edge[1], formatTime(time.Now()), formatTime(time.Now())); err != nil {
			t.Fatal("cycle fixture failed")
		}
	}
	family, err := db.apiKeyQuotaFamily(t.Context(), "cycle-a")
	if err != nil || !reflect.DeepEqual(family, []string{"cycle-a", "cycle-b"}) {
		t.Fatal("cycle traversal repeated or lost a member")
	}
}

func TestAPIKeyQuotaLiveComponents(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	now := time.Now().UTC()
	for _, edge := range [][2]string{{"a", "bridge"}, {"bridge", "b"}, {"c", "d"}, {"d", "c"}, {"idle-a", "idle-b"}} {
		if _, err := db.db.ExecContext(t.Context(), db.bind(`INSERT INTO api_key_rotations (old_key_id, old_key_hash, new_key_id, grace_ends_at, created_at) VALUES (?, ?, ?, ?, ?)`), edge[0], edge[0]+"-hash", edge[1], formatTime(now), formatTime(now)); err != nil {
			t.Fatal("component fixture failed")
		}
	}
	empty, err := db.LiveReservations(t.Context(), now)
	if err != nil || len(empty["api_key"]) != 0 || len(empty["global"]) != 0 {
		t.Fatal("empty reservations included idle lineage")
	}
	// No api_keys rows are needed; a deleted intermediate key still bridges
	// a family. A disjoint cycle must neither repeat nor mix its totals.
	for id, tokens := range map[string]int64{"a": 2, "b": 3, "c": 7, "d": 11, "solo": 13, "": 17} {
		if err := db.ReserveQuota(t.Context(), QuotaReservation{RequestID: "component-" + id, APIKeyID: id, Tokens: tokens, CostKRW: float64(tokens) / 2, ExpiresAt: now.Add(time.Hour)}); err != nil {
			t.Fatal("component reservation failed")
		}
	}
	live, err := db.LiveReservations(t.Context(), now)
	if err != nil || len(live["api_key"]) != 7 {
		t.Fatal("live component membership mismatch")
	}
	for id, expected := range map[string]int64{"a": 5, "bridge": 5, "b": 5, "c": 18, "d": 18, "solo": 13, "": 17} {
		tokens, cost, err := db.ReservedUsage(t.Context(), "api_key", id, now)
		if err != nil || tokens != expected || cost != float64(expected)/2 || live["api_key"][id] != (ReservedTotals{Tokens: tokens, CostKRW: cost}) {
			t.Fatal("component scalar and batch totals disagree")
		}
	}
	for scope, value := range map[string]string{"global": "*", "ip": "unknown", "team": "unassigned"} {
		if live[scope][value] != (ReservedTotals{Tokens: 53, CostKRW: 26.5}) {
			t.Fatal("component expansion changed non-key totals")
		}
	}
}
