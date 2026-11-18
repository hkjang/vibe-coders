package store

import (
	"errors"
	"fmt"
	"reflect"
	"sync"
	"testing"
)

func routingDraftAudit(id string) AdminAuditLog {
	return AdminAuditLog{ID: id, AdminID: "public-reviewer", Action: "routing_rule.reviewed_update", BeforeValue: "reviewed original", AfterValue: "reviewed candidate"}
}

func TestRoutingDraftStorePreviewAndCommit(t *testing.T) {
	db, peer := routingPatchStores(t)
	before := seedRoutingOrder(t, db)
	target, note, priority := "public-draft", "새 공개 메모", 90
	patch := RoutingRulePatch{TargetModel: &target, Note: &note, Priority: &priority}
	draft, err := db.PreviewRoutingRuleEdit(t.Context(), before.Revision, "a-second", patch)
	if err != nil {
		t.Fatal(err)
	}
	if draft.Rules[0].ID != "a-second" || draft.Rule.TargetModel != target || !reflect.DeepEqual(before, readRoutingOrder(t, peer)) {
		t.Fatal("preview changed persistence or used wrong candidate order")
	}
	after, err := db.CommitRoutingRuleEdit(t.Context(), before.Revision, "a-second", patch, routingDraftAudit("draft-success"))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(after.Rules, draft.Rules) || after.Revision != draft.ResultRevision || !reflect.DeepEqual(after, readRoutingOrder(t, peer)) {
		t.Fatal("committed rules differ from candidate")
	}
	audits, err := peer.ListAdminAudit(t.Context(), 10)
	if err != nil || len(audits) != 1 || audits[0].Action != "routing_rule.reviewed_update" {
		t.Fatal("missing atomic audit")
	}
	if _, err := db.CommitRoutingRuleEdit(t.Context(), before.Revision, "a-second", patch, routingDraftAudit("replay")); !errors.Is(err, ErrRoutingOrderConflict) {
		t.Fatal("stale retry accepted")
	}
}

func TestRoutingDraftStoreAuditFailureRollsBack(t *testing.T) {
	db, peer := routingPatchStores(t)
	before := seedRoutingOrder(t, db)
	audit := routingDraftAudit("duplicate-audit")
	if err := db.InsertAdminAudit(t.Context(), audit); err != nil {
		t.Fatal(err)
	}
	model := "public-candidate"
	if _, err := db.CommitRoutingRuleEdit(t.Context(), before.Revision, "a-second", RoutingRulePatch{TargetModel: &model}, audit); err == nil {
		t.Fatal("duplicate audit accepted")
	}
	if !reflect.DeepEqual(before, readRoutingOrder(t, peer)) {
		t.Fatal("audit failure left changed rule")
	}
}

func TestRoutingDraftStoreUnrelatedWriterInvalidatesReview(t *testing.T) {
	db, peer := routingPatchStores(t)
	before := seedRoutingOrder(t, db)
	note, target := "another operator", "public-candidate"
	if _, err := peer.PatchRoutingRule(t.Context(), "disabled-third", RoutingRulePatch{Note: &note}); err != nil {
		t.Fatal(err)
	}
	current := readRoutingOrder(t, peer)
	if _, err := db.CommitRoutingRuleEdit(t.Context(), before.Revision, "a-second", RoutingRulePatch{TargetModel: &target}, routingDraftAudit("conflict")); !errors.Is(err, ErrRoutingOrderConflict) {
		t.Fatal("concurrent unrelated configuration ignored")
	}
	if !reflect.DeepEqual(current, readRoutingOrder(t, peer)) {
		t.Fatal("conflict changed current rules")
	}
}

func TestRoutingDraftStoreConcurrentEditorsCommitOnce(t *testing.T) {
	db, peer := routingPatchStores(t)
	before := seedRoutingOrder(t, db)
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for i, current := range []*SQLStore{db, peer} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			model := fmt.Sprintf("public-target-%d", i)
			_, err := current.CommitRoutingRuleEdit(t.Context(), before.Revision, "a-second", RoutingRulePatch{TargetModel: &model}, routingDraftAudit(fmt.Sprintf("operator-%d", i)))
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	success, conflict := 0, 0
	for err := range errs {
		if err == nil {
			success++
		} else if errors.Is(err, ErrRoutingOrderConflict) {
			conflict++
		} else {
			t.Fatal(err)
		}
	}
	audits, err := db.ListAdminAudit(t.Context(), 10)
	if success != 1 || conflict != 1 || err != nil || len(audits) != 1 {
		t.Fatal("concurrent edits did not produce exactly one audited commit")
	}
}

func TestRoutingDraftStoreRejectsAmbiguousAndInvalidEdits(t *testing.T) {
	db, _ := routingPatchStores(t)
	before := seedRoutingOrder(t, db)
	blank, tooHigh, enabled := " ", 101, true
	for _, patch := range []RoutingRulePatch{{}, {TargetModel: &blank}, {MaxComplexity: &tooHigh}, {Enabled: &enabled}} {
		if _, err := db.PreviewRoutingRuleEdit(t.Context(), before.Revision, "a-second", patch); !errors.Is(err, ErrRoutingOrderInvalid) {
			t.Fatal("invalid draft accepted")
		}
	}
	if _, err := db.db.ExecContext(t.Context(), db.bind(`UPDATE routing_rules SET created_at = ? WHERE id = ?`), formatTime(before.Rules[0].CreatedAt), before.Rules[1].ID); err != nil {
		t.Fatal(err)
	}
	current := readRoutingOrder(t, db)
	model := "candidate"
	if _, err := db.PreviewRoutingRuleEdit(t.Context(), current.Revision, "a-second", RoutingRulePatch{TargetModel: &model}); !errors.Is(err, ErrRoutingDraftAmbiguous) {
		t.Fatal("undefined precedence presented as a reliable comparison")
	}
}

func TestRoutingDraftStoreCommitFailureRollsBack(t *testing.T) {
	db, peer := routingPatchStores(t)
	before := seedRoutingOrder(t, db)
	drop := installChangeSetAuditCommitFailure(t, db)
	model := "public-candidate"
	patch := RoutingRulePatch{TargetModel: &model}
	audit := routingDraftAudit("commit-failure")
	result, err := db.CommitRoutingRuleEdit(t.Context(), before.Revision, "a-second", patch, audit)
	if err == nil || result.Revision != "" || !reflect.DeepEqual(before, readRoutingOrder(t, peer)) {
		t.Fatal("failed commit returned a success result or changed the rule")
	}
	audits, err := peer.ListAdminAudit(t.Context(), 10)
	if err != nil || len(audits) != 0 {
		t.Fatal("failed commit left an audit record")
	}
	if _, err := db.db.ExecContext(t.Context(), drop); err != nil {
		t.Fatal(err)
	}
	if _, err := db.CommitRoutingRuleEdit(t.Context(), before.Revision, "a-second", patch, audit); err != nil {
		t.Fatal("failed commit left the connection unusable")
	}
}

func TestRoutingDraftStoreUnexpectedDatabaseRewriteRollsBack(t *testing.T) {
	db, peer := routingPatchStores(t)
	before := seedRoutingOrder(t, db)
	statements := []string{`CREATE TRIGGER draft_rewrite AFTER UPDATE OF target_model ON routing_rules BEGIN UPDATE routing_rules SET note = 'unexpected database rewrite' WHERE id = NEW.id; END`}
	if db.dialect == "postgres" {
		statements = []string{
			`CREATE FUNCTION draft_rewrite_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.note := 'unexpected database rewrite'; RETURN NEW; END $$`,
			`CREATE TRIGGER draft_rewrite BEFORE UPDATE OF target_model ON routing_rules FOR EACH ROW EXECUTE FUNCTION draft_rewrite_fn()`,
		}
	}
	for _, statement := range statements {
		if _, err := db.db.ExecContext(t.Context(), statement); err != nil {
			t.Fatal(err)
		}
	}
	model := "public-candidate"
	result, err := db.CommitRoutingRuleEdit(t.Context(), before.Revision, "a-second", RoutingRulePatch{TargetModel: &model}, routingDraftAudit("rewrite"))
	if !errors.Is(err, ErrRoutingOrderConflict) || result.Revision != "" || !reflect.DeepEqual(before, readRoutingOrder(t, peer)) {
		t.Fatal("database rewrite escaped the reviewed result guard")
	}
	audits, err := peer.ListAdminAudit(t.Context(), 10)
	if err != nil || len(audits) != 0 {
		t.Fatal("rejected database rewrite left an audit record")
	}
}

func TestRoutingDraftStorePreservesRawCreationPrecedence(t *testing.T) {
	db, peer := routingPatchStores(t)
	seedRoutingOrder(t, db)
	for _, row := range []struct{ id, stamp string }{{"z-first", "2026-11-01T00:00:00Z"}, {"a-second", "2026-11-01T00:00:00.1Z"}} {
		if _, err := db.db.ExecContext(t.Context(), db.bind(`UPDATE routing_rules SET created_at = ? WHERE id = ?`), row.stamp, row.id); err != nil {
			t.Fatal(err)
		}
	}
	before := readRoutingOrder(t, db)
	model := "public-candidate"
	patch := RoutingRulePatch{TargetModel: &model}
	draft, err := db.PreviewRoutingRuleEdit(t.Context(), before.Revision, "a-second", patch)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CommitRoutingRuleEdit(t.Context(), before.Revision, "a-second", patch, routingDraftAudit("raw-creation")); err != nil {
		t.Fatal(err)
	}
	actual, err := peer.ListRoutingRules(t.Context())
	if err != nil || !reflect.DeepEqual(actual, draft.Rules) {
		t.Fatal("preview precedence differs from existing SQL ordering")
	}
}
