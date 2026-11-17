package store

import (
	"errors"
	"reflect"
	"testing"
)

func workflowGraphAudit(id string) AdminAuditLog {
	return AdminAuditLog{ID: id, AdminID: "workflow-reviewer", Action: "workflow.graph_save", AfterValue: "분기 검토"}
}

func TestWorkflowGraphReviewedSaveConflictAndAudit(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	wf := testBranchWorkflow()
	wf.CreatedBy = "original-owner"
	saved, err := db.CommitWorkflowGraph(t.Context(), wf, "", workflowGraphAudit("graph-create"))
	if err != nil {
		t.Fatal(err)
	}
	revision, err := WorkflowRevision(saved)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CommitWorkflowGraph(t.Context(), wf, "", workflowGraphAudit("graph-create-replay")); !errors.Is(err, ErrWorkflowGraphConflict) {
		t.Fatalf("repeated create: %v", err)
	}
	wf.Name = "검토한 새 이름"
	wf.CreatedBy = "cannot-rewrite-owner"
	updated, err := db.CommitWorkflowGraph(t.Context(), wf, revision, workflowGraphAudit("graph-update"))
	if err != nil || updated.Name != wf.Name || updated.CreatedBy != "original-owner" {
		t.Fatalf("update: %+v %v", updated, err)
	}
	if _, err := db.CommitWorkflowGraph(t.Context(), wf, revision, workflowGraphAudit("graph-stale")); !errors.Is(err, ErrWorkflowGraphConflict) {
		t.Fatalf("stale update: %v", err)
	}
	audits, err := db.ListAdminAudit(t.Context(), 20)
	if err != nil || len(audits) != 2 {
		t.Fatalf("unexpected audit count %d %v", len(audits), err)
	}
	// Even the legacy publish operation changes the revision, rather than
	// allowing an old editor to undo the newly enabled state.
	nextRevision, _ := WorkflowRevision(updated)
	if _, err := db.PublishWorkflowVersion(t.Context(), updated, "publisher", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := db.CommitWorkflowGraph(t.Context(), wf, nextRevision, workflowGraphAudit("after-publish")); !errors.Is(err, ErrWorkflowGraphConflict) {
		t.Fatalf("concurrent publish ignored: %v", err)
	}
}

func TestWorkflowGraphReviewedSaveAuditRollback(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	wf := testBranchWorkflow()
	saved, err := db.CommitWorkflowGraph(t.Context(), wf, "", workflowGraphAudit("duplicate"))
	if err != nil {
		t.Fatal(err)
	}
	revision, _ := WorkflowRevision(saved)
	wf.Name = "must roll back"
	if _, err := db.CommitWorkflowGraph(t.Context(), wf, revision, workflowGraphAudit("duplicate")); err == nil {
		t.Fatal("audit failure ignored")
	}
	after, found, err := db.GetWorkflow(t.Context(), wf.ID)
	if err != nil || !found || !reflect.DeepEqual(after, saved) {
		t.Fatal("audit failure left a changed definition")
	}
	// Deletion must not turn a stale update into an unintended recreation.
	if err := db.DeleteWorkflow(t.Context(), wf.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.CommitWorkflowGraph(t.Context(), wf, revision, workflowGraphAudit("deleted")); !errors.Is(err, ErrWorkflowGraphConflict) {
		t.Fatalf("deleted workflow recreated: %v", err)
	}
	if _, found, _ := db.GetWorkflow(t.Context(), wf.ID); found {
		t.Fatal("deleted row reappeared")
	}
}

func TestWorkflowGraphPublishRevisionAndAtomicAudit(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	wf := testBranchWorkflow()
	if err := db.UpsertWorkflow(t.Context(), wf); err != nil {
		t.Fatal(err)
	}
	wf, _, _ = db.GetWorkflow(t.Context(), wf.ID)
	revision, _ := WorkflowRevision(wf)
	audit := AdminAuditLog{ID: "publish-duplicate", Action: "workflow.publish", AdminID: "operator"}
	if err := db.InsertAdminAudit(t.Context(), audit); err != nil {
		t.Fatal(err)
	}
	if _, err := db.PublishWorkflowVersionReviewed(t.Context(), wf, revision, "operator", "분기 확인", audit); err == nil {
		t.Fatal("duplicate audit accepted")
	}
	current, _, _ := db.GetWorkflow(t.Context(), wf.ID)
	versions, _ := db.ListWorkflowVersions(t.Context(), wf.ID)
	if !reflect.DeepEqual(current, wf) || len(versions) != 0 {
		t.Fatal("failed audit left activation or version")
	}
	audit.ID = "publish-success"
	version, err := db.PublishWorkflowVersionReviewed(t.Context(), wf, revision, "operator", "분기 확인", audit)
	if err != nil || version != 1 {
		t.Fatalf("publish %d %v", version, err)
	}
	current, _, _ = db.GetWorkflow(t.Context(), wf.ID)
	versions, _ = db.ListWorkflowVersions(t.Context(), wf.ID)
	if !current.Enabled || len(versions) != 1 || !reflect.DeepEqual(versions[0].Flow, wf.Flow) || !reflect.DeepEqual(versions[0].Steps, wf.Steps) {
		t.Fatal("snapshot or activation incorrect")
	}
	audit.ID = "publish-stale"
	if _, err := db.PublishWorkflowVersionReviewed(t.Context(), wf, revision, "operator", "stale", audit); !errors.Is(err, ErrWorkflowGraphConflict) {
		t.Fatalf("stale published %v", err)
	}
	if err := db.DeleteWorkflow(t.Context(), wf.ID); err != nil {
		t.Fatal(err)
	}
	next, _ := WorkflowRevision(current)
	if _, err := db.PublishWorkflowVersionReviewed(t.Context(), current, next, "operator", "deleted", audit); !errors.Is(err, ErrWorkflowGraphConflict) {
		t.Fatalf("deleted published %v", err)
	}
}

func TestWorkflowGraphConcurrentSaveAndPublish(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	wf := testBranchWorkflow()
	if err := db.UpsertWorkflow(t.Context(), wf); err != nil {
		t.Fatal(err)
	}
	wf, _, _ = db.GetWorkflow(t.Context(), wf.ID)
	revision, _ := WorkflowRevision(wf)
	start := make(chan struct{})
	out := make(chan error, 2)
	go func() {
		<-start
		changed := wf
		changed.Name = "동시 변경"
		_, err := db.CommitWorkflowGraph(t.Context(), changed, revision, workflowGraphAudit("concurrent-edit"))
		out <- err
	}()
	go func() {
		<-start
		_, err := db.PublishWorkflowVersionReviewed(t.Context(), wf, revision, "operator", "동시 게시", AdminAuditLog{ID: "concurrent-publish", Action: "workflow.publish"})
		out <- err
	}()
	close(start)
	success, conflict := 0, 0
	for range 2 {
		err := <-out
		if err == nil {
			success++
		} else if errors.Is(err, ErrWorkflowGraphConflict) {
			conflict++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("success %d conflict %d", success, conflict)
	}
	current, _, _ := db.GetWorkflow(t.Context(), wf.ID)
	versions, _ := db.ListWorkflowVersions(t.Context(), wf.ID)
	audits, _ := db.ListAdminAudit(t.Context(), 20)
	if len(audits) != 1 {
		t.Fatalf("audit count %d", len(audits))
	}
	if current.Enabled {
		if current.Name != wf.Name || len(versions) != 1 {
			t.Fatal("mixed publication")
		}
	} else if current.Name != "동시 변경" || len(versions) != 0 {
		t.Fatal("mixed edit")
	}
}

func TestWorkflowLegacyPublishCannotActivateConcurrentGraph(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	old := Workflow{ID: "converted", Name: "old", Steps: []WorkflowStep{{Type: "transform"}}}
	if err := db.UpsertWorkflow(t.Context(), old); err != nil {
		t.Fatal(err)
	}
	old, _, _ = db.GetWorkflow(t.Context(), old.ID)
	graph := testBranchWorkflow()
	graph.ID = old.ID
	if err := db.UpsertWorkflow(t.Context(), graph); err != nil {
		t.Fatal(err)
	}
	if _, err := db.PublishWorkflowVersion(t.Context(), old, "legacy", "stale"); !errors.Is(err, ErrWorkflowGraphConflict) {
		t.Fatalf("stale legacy publish %v", err)
	}
	current, _, _ := db.GetWorkflow(t.Context(), old.ID)
	versions, _ := db.ListWorkflowVersions(t.Context(), old.ID)
	if current.Enabled || len(versions) > 0 {
		t.Fatal("legacy publication activated unreviewed graph")
	}
}
