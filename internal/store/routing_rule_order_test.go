package store

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

func seedRoutingOrder(t *testing.T, db *SQLStore) RoutingOrderSnapshot {
	t.Helper()
	for i, id := range []string{"z-first", "a-second", "disabled-third"} {
		rule := RoutingRule{ID: id, Enabled: i != 2, Priority: 100, MatchPattern: "고객-*", MinComplexity: 10,
			MaxComplexity: 90, TargetModel: id, TargetProvider: "공급자", Note: "유지할 메모 " + id,
			CreatedAt: time.Date(2026, 11, 1, 0, 0, 0, i+1, time.UTC)}
		if err := db.UpsertRoutingRule(t.Context(), rule); err != nil {
			t.Fatal(err)
		}
	}
	return readRoutingOrder(t, db)
}

func readRoutingOrder(t *testing.T, db *SQLStore) RoutingOrderSnapshot {
	t.Helper()
	got, err := db.GetRoutingOrderSnapshot(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func routingOrderAudit(id string) AdminAuditLog {
	return AdminAuditLog{ID: id, AdminID: "synthetic-operator", Action: "routing_rule.reorder", BeforeValue: "reviewed before", AfterValue: "reviewed after and reason"}
}

func TestRoutingOrderStorePreservesRouterOrderAndFields(t *testing.T) {
	db, peer := routingPatchStores(t)
	before := seedRoutingOrder(t, db)
	legacy, err := db.ListRoutingRules(t.Context())
	if err != nil || !reflect.DeepEqual(legacy, before.Rules) || before.AmbiguousTies || len(before.Revision) != 64 {
		t.Fatal("snapshot changed legacy router order")
	}
	if before.Rules[0].ID != "z-first" || before.Rules[1].ID != "a-second" {
		t.Fatal("model name replaced creation precedence")
	}
	ids := []string{"disabled-third", "a-second", "z-first"}
	got, err := db.ReorderRoutingRules(t.Context(), before.Revision, ids, routingOrderAudit("order-commit"))
	if err != nil || got.Revision == before.Revision || got.AmbiguousTies {
		t.Fatalf("reorder result: %v", err)
	}
	want, err := ProposedRoutingOrder(before, ids)
	if err != nil || !reflect.DeepEqual(want, got.Rules) || !reflect.DeepEqual(got, readRoutingOrder(t, peer)) {
		t.Fatal("only priorities may change, and response must match persisted state")
	}
	active, err := peer.ActiveRoutingRules(t.Context())
	if err != nil || len(active) != 2 || active[0].ID != "a-second" || active[1].ID != "z-first" {
		t.Fatal("existing router does not observe new order or disabled status")
	}
	audits, err := peer.ListAdminAudit(t.Context(), 10)
	if err != nil || len(audits) != 1 || audits[0].AdminID != "synthetic-operator" || audits[0].Action != "routing_rule.reorder" {
		t.Fatal("committed order must have its operator audit")
	}
}

func TestRoutingOrderStoreSnapshotDetectsEveryConfigurationField(t *testing.T) {
	for _, field := range []string{"enabled", "priority", "match_pattern", "min_complexity", "max_complexity", "target_model", "target_provider", "note", "created_at", "insert", "delete"} {
		t.Run(field, func(t *testing.T) {
			db, peer := routingPatchStores(t)
			before := seedRoutingOrder(t, db)
			var err error
			switch field {
			case "insert":
				err = peer.UpsertRoutingRule(t.Context(), RoutingRule{ID: "new-rule", TargetModel: "new", Priority: 99})
			case "delete":
				err = peer.DeleteRoutingRule(t.Context(), "z-first")
			default:
				value := any("changed")
				switch field {
				case "enabled":
					value = 0
				case "priority":
					value = 7
				case "min_complexity":
					value = 11
				case "max_complexity":
					value = 89
				}
				_, err = peer.db.ExecContext(t.Context(), peer.bind("UPDATE routing_rules SET "+field+" = ? WHERE id = ?"), value, "z-first")
			}
			if err != nil {
				t.Fatal(err)
			}
			current := readRoutingOrder(t, peer)
			got, err := db.ReorderRoutingRules(t.Context(), before.Revision, []string{"disabled-third", "a-second", "z-first"}, routingOrderAudit("stale"))
			if !errors.Is(err, ErrRoutingOrderConflict) || got.Revision != "" || !reflect.DeepEqual(current, readRoutingOrder(t, peer)) {
				t.Fatal("stale review changed current configuration")
			}
			audits, err := peer.ListAdminAudit(t.Context(), 10)
			if err != nil || len(audits) != 0 {
				t.Fatal("rejected order generated a committed mutation audit")
			}
		})
	}
}

func TestRoutingOrderStoreRejectsPartialDuplicateAndUnknownOrders(t *testing.T) {
	db, _ := routingPatchStores(t)
	before := seedRoutingOrder(t, db)
	for _, ids := range [][]string{nil, {"z-first"}, {"z-first", "a-second"}, {"z-first", "z-first", "disabled-third"}, {"unknown", "a-second", "z-first"}, {"z-first\n", "a-second", "disabled-third"}} {
		got, err := db.ReorderRoutingRules(t.Context(), before.Revision, ids, routingOrderAudit("invalid"))
		if !errors.Is(err, ErrRoutingOrderInvalid) || got.Revision != "" || !reflect.DeepEqual(before, readRoutingOrder(t, db)) {
			t.Fatal("invalid permutation changed stored order")
		}
	}
	for _, revision := range []string{"", "not-a-hash", strings.Repeat("a", 63)} {
		if _, err := db.ReorderRoutingRules(t.Context(), revision, []string{"disabled-third", "a-second", "z-first"}, routingOrderAudit("invalid-revision")); !errors.Is(err, ErrRoutingOrderInvalid) {
			t.Fatal("invalid revision accepted")
		}
	}
}

func TestRoutingOrderStoreAuditAndCommitFailuresRollback(t *testing.T) {
	for _, mode := range []string{"missing-audit", "audit-failure", "commit-failure", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			db, peer := routingPatchStores(t)
			before := seedRoutingOrder(t, db)
			audit := routingOrderAudit("order-failure")
			ctx := t.Context()
			drop := ""
			switch mode {
			case "missing-audit":
				audit.ID = ""
			case "audit-failure":
				if err := db.InsertAdminAudit(ctx, audit); err != nil {
					t.Fatal(err)
				}
			case "commit-failure":
				drop = installChangeSetAuditCommitFailure(t, db)
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			prior, err := db.ListAdminAudit(t.Context(), 10)
			if err != nil {
				t.Fatal(err)
			}
			got, err := db.ReorderRoutingRules(ctx, before.Revision, []string{"disabled-third", "a-second", "z-first"}, audit)
			if err == nil || got.Revision != "" || !reflect.DeepEqual(before, readRoutingOrder(t, peer)) {
				t.Fatal("failed transaction changed priorities or returned a success snapshot")
			}
			after, err := peer.ListAdminAudit(t.Context(), 10)
			if err != nil || !reflect.DeepEqual(prior, after) {
				t.Fatal("failed transaction changed audit history")
			}
			if drop != "" {
				if _, err := db.db.ExecContext(t.Context(), drop); err != nil {
					t.Fatal(err)
				}
				if _, err := db.ReorderRoutingRules(t.Context(), before.Revision, []string{"disabled-third", "a-second", "z-first"}, audit); err != nil {
					t.Fatal("failed COMMIT left an unusable connection")
				}
			}
		})
	}
}

func TestRoutingOrderStoreConcurrentOperatorsOneCommit(t *testing.T) {
	db, peer := routingPatchStores(t)
	before := seedRoutingOrder(t, db)
	start := make(chan struct{})
	done := make(chan error, 2)
	for index, current := range []*SQLStore{db, peer} {
		go func() {
			<-start
			ids := [][]string{{"disabled-third", "a-second", "z-first"}, {"a-second", "z-first", "disabled-third"}}[index]
			_, err := current.ReorderRoutingRules(t.Context(), before.Revision, ids, routingOrderAudit(fmt.Sprintf("operator-%d", index)))
			done <- err
		}()
	}
	close(start)
	committed, conflicts := 0, 0
	for range 2 {
		err := <-done
		if err == nil {
			committed++
		} else if errors.Is(err, ErrRoutingOrderConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	audits, err := db.ListAdminAudit(t.Context(), 10)
	if err != nil || committed != 1 || conflicts != 1 || len(audits) != 1 {
		t.Fatal("concurrent reviewed orders did not commit exactly once")
	}
}

func TestRoutingOrderStoreLegacyTiesAndRawTimestamps(t *testing.T) {
	db, _ := routingPatchStores(t)
	seedRoutingOrder(t, db)
	if _, err := db.db.ExecContext(t.Context(), `UPDATE routing_rules SET created_at = 'invalid-time-a'`); err != nil {
		t.Fatal(err)
	}
	before := readRoutingOrder(t, db)
	if !before.AmbiguousTies || !before.Rules[0].CreatedAt.IsZero() {
		t.Fatal("legacy tie ambiguity not reported")
	}
	if _, err := db.db.ExecContext(t.Context(), `UPDATE routing_rules SET created_at = 'invalid-time-b'`); err != nil {
		t.Fatal(err)
	}
	after := readRoutingOrder(t, db)
	if before.Revision == after.Revision {
		t.Fatal("raw timestamp change disappeared behind zero-time decoding")
	}
}

func TestRoutingOrderStoreWaitsForOrdinaryWriterAndRejectsStaleReview(t *testing.T) {
	db, peer := routingPatchStores(t)
	before := seedRoutingOrder(t, db)
	tx, err := peer.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(t.Context(), peer.bind(`UPDATE routing_rules SET note = ? WHERE id = ?`), "ordinary edit committed during review", "z-first"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := db.ReorderRoutingRules(ctx, before.Revision, []string{"disabled-third", "a-second", "z-first"}, routingOrderAudit("ordinary-writer-race"))
		done <- err
	}()
	select {
	case err := <-done:
		t.Fatalf("order passed an uncommitted ordinary write: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; !errors.Is(err, ErrRoutingOrderConflict) {
		t.Fatalf("ordinary edit conflict: %v", err)
	}
	after := readRoutingOrder(t, db)
	if after.Rules[0].Note != "ordinary edit committed during review" || after.Rules[0].Priority != 100 {
		t.Fatal("order overwrote ordinary edit")
	}
	audits, err := db.ListAdminAudit(t.Context(), 10)
	if err != nil || len(audits) != 0 {
		t.Fatal("conflicted order committed an audit")
	}
}

func TestRoutingOrderStoreBoundedAndSQLIdentifiers(t *testing.T) {
	db, _ := routingPatchStores(t)
	for i := range MaxRoutingOrderRules {
		id := fmt.Sprintf("row-%04d", i)
		if i == 0 {
			id = "quote'--? 한국어 / :"
		}
		if err := db.UpsertRoutingRule(t.Context(), RoutingRule{ID: id, Priority: i + 1, TargetModel: "synthetic", MaxComplexity: 100}); err != nil {
			t.Fatal(err)
		}
	}
	before := readRoutingOrder(t, db)
	ids := make([]string, len(before.Rules))
	for i := range ids {
		ids[len(ids)-1-i] = before.Rules[i].ID
	}
	after, err := db.ReorderRoutingRules(t.Context(), before.Revision, ids, routingOrderAudit("upper-bound"))
	if err != nil || len(after.Rules) != MaxRoutingOrderRules || after.Rules[len(ids)-1].ID != "quote'--? 한국어 / :" {
		t.Fatalf("bound/exact SQL identifier failed: %v", err)
	}
	if err := db.UpsertRoutingRule(t.Context(), RoutingRule{ID: "one-too-many", Priority: 9999, TargetModel: "synthetic"}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.GetRoutingOrderSnapshot(t.Context()); !errors.Is(err, ErrRoutingOrderLimit) {
		t.Fatal("oversized order returned an incomplete review")
	}
	if _, err := db.ReorderRoutingRules(t.Context(), after.Revision, ids, routingOrderAudit("over-bound")); !errors.Is(err, ErrRoutingOrderLimit) {
		t.Fatal("oversized current set was partially reordered")
	}
}
