package store

import (
	"context"
	"fmt"
	"sync"
	"testing"
)

func TestRuntimeFlagAuditedFailureAndCancellationAreAtomic(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	const key = "test.audited.flag"
	before, err := db.SaveRuntimeFlagAudited(t.Context(), RuntimeFlag{Key: key, Value: "old", Note: "baseline", UpdatedBy: "actor-a"}, AdminAuditLog{ID: "audit-existing", Action: "public.flag", AdminID: "actor-a", AfterValue: "old"})
	if err != nil {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	for _, tc := range []struct {
		name  string
		ctx   context.Context
		audit AdminAuditLog
	}{
		{"duplicate-audit", t.Context(), AdminAuditLog{ID: "audit-existing", Action: "public.flag"}},
		{"invalid-audit", t.Context(), AdminAuditLog{Action: "public.flag"}},
		{"cancelled", cancelled, AdminAuditLog{ID: "audit-cancelled", Action: "public.flag"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := db.SaveRuntimeFlagAudited(tc.ctx, RuntimeFlag{Key: key, Value: "new", Note: "replacement", UpdatedBy: "actor-b"}, tc.audit)
			if err == nil || got != (RuntimeFlag{}) {
				t.Fatal("failed transaction returned success")
			}
			after, found, err := db.GetFlag(t.Context(), key)
			if err != nil || !found || before != after {
				t.Fatal("failed audit changed flag metadata")
			}
			logs, err := db.ListAdminAudit(t.Context(), 20)
			if err != nil || len(logs) != 1 || logs[0].AfterValue != "old" {
				t.Fatal("failed write changed audit")
			}
		})
	}
}

func TestRuntimeFlagAuditedCommitFailureCleansConnection(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	db.db.SetMaxOpenConns(1)
	const key = "test.audited.commit"
	before, err := db.SaveRuntimeFlagAudited(t.Context(), RuntimeFlag{Key: key, Value: "old"}, AdminAuditLog{ID: "audit-before", Action: "public.flag"})
	if err != nil {
		t.Fatal(err)
	}
	statements := []string{
		`CREATE TABLE audit_fk_parent (id INTEGER PRIMARY KEY)`,
		`CREATE TABLE audit_fk_child (parent_id INTEGER REFERENCES audit_fk_parent(id) DEFERRABLE INITIALLY DEFERRED)`,
	}
	drop := `DROP TRIGGER audit_bad_commit`
	if db.dialect == "postgres" {
		statements = append(statements,
			`CREATE FUNCTION audit_bad_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO audit_fk_child VALUES (1); RETURN NEW; END $$`,
			`CREATE TRIGGER audit_bad_commit AFTER INSERT ON admin_audit_logs FOR EACH ROW EXECUTE FUNCTION audit_bad_commit()`)
		drop += ` ON admin_audit_logs`
	} else {
		statements = append([]string{`PRAGMA foreign_keys = ON`}, statements...)
		statements = append(statements, `CREATE TRIGGER audit_bad_commit AFTER INSERT ON admin_audit_logs BEGIN INSERT INTO audit_fk_child VALUES (1); END`)
	}
	for _, sql := range statements {
		if _, err := db.db.ExecContext(t.Context(), sql); err != nil {
			t.Fatal(err)
		}
	}
	got, err := db.SaveRuntimeFlagAudited(t.Context(), RuntimeFlag{Key: key, Value: "new"}, AdminAuditLog{ID: "audit-failed", Action: "public.flag"})
	if err == nil || got != (RuntimeFlag{}) {
		t.Fatal("deferred commit failure returned success")
	}
	after, found, err := db.GetFlag(t.Context(), key)
	logs, auditErr := db.ListAdminAudit(t.Context(), 20)
	if err != nil || !found || before != after || auditErr != nil || len(logs) != 1 || logs[0].ID != "audit-before" {
		t.Fatal("commit failure retained flag or audit")
	}
	var children int
	if err := db.db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM audit_fk_child`).Scan(&children); err != nil || children != 0 {
		t.Fatal("commit failure retained trigger side effect")
	}
	if _, err := db.db.ExecContext(t.Context(), drop); err != nil {
		t.Fatal(err)
	}
	got, err = db.SaveRuntimeFlagAudited(t.Context(), RuntimeFlag{Key: key, Value: "recovered"}, AdminAuditLog{ID: "audit-recovered", Action: "public.flag"})
	if err != nil || got.Value != "recovered" {
		t.Fatal("connection did not recover after failed commit")
	}
	logs, auditErr = db.ListAdminAudit(t.Context(), 20)
	if auditErr != nil || len(logs) != 2 {
		t.Fatal("recovered write lost audit")
	}
}

func TestRuntimeFlagAuditedConcurrentAcknowledgmentsOwnSnapshot(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	db.db.SetMaxOpenConns(4)
	var workers sync.WaitGroup
	for i := 0; i < 8; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			value := fmt.Sprintf("public-value-%d", i)
			got, err := db.SaveRuntimeFlagAudited(t.Context(), RuntimeFlag{Key: "test.concurrent.audited", Value: value, Note: value, UpdatedBy: value}, AdminAuditLog{ID: fmt.Sprintf("audit-%d", i), Action: "public.flag", AdminID: value, AfterValue: value})
			if err != nil || got.Value != value || got.Note != value || got.UpdatedBy != value {
				t.Error("acknowledgment did not own its transaction snapshot")
			}
		}()
	}
	workers.Wait()
	logs, err := db.ListAdminAudit(t.Context(), 20)
	if err != nil || len(logs) != 8 {
		t.Fatal("concurrent acknowledged writes lost audits")
	}
	for _, log := range logs {
		if log.AfterValue != log.AdminID || log.CreatedAt == "" {
			t.Fatal("incoherent audited actor or value")
		}
	}
}

func TestRuntimeFlagAuditedValidationRollsBackTriggerChanges(t *testing.T) {
	db := openStoreForTest(t)
	defer db.Close()
	const key = "test.audited.validation"
	before, err := db.SaveRuntimeFlagAudited(t.Context(), RuntimeFlag{Key: key, Value: "old"}, AdminAuditLog{ID: "audit-baseline", Action: "public.flag"})
	if err != nil {
		t.Fatal(err)
	}
	statements := []string{`CREATE TRIGGER audit_change_flag AFTER INSERT ON admin_audit_logs BEGIN UPDATE runtime_flags SET value = 'unexpected' WHERE key = 'test.audited.validation'; END`}
	if db.dialect == "postgres" {
		statements = []string{
			`CREATE FUNCTION audit_change_flag() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE runtime_flags SET value = 'unexpected' WHERE key = 'test.audited.validation'; RETURN NEW; END $$`,
			`CREATE TRIGGER audit_change_flag AFTER INSERT ON admin_audit_logs FOR EACH ROW EXECUTE FUNCTION audit_change_flag()`,
		}
	}
	for _, statement := range statements {
		if _, err := db.db.ExecContext(t.Context(), statement); err != nil {
			t.Fatal(err)
		}
	}
	got, err := db.SaveRuntimeFlagAudited(t.Context(), RuntimeFlag{Key: key, Value: "new"}, AdminAuditLog{ID: "audit-rejected", Action: "public.flag"})
	if err == nil || got != (RuntimeFlag{}) {
		t.Fatal("unexpected stored value returned a success snapshot")
	}
	after, found, err := db.GetFlag(t.Context(), key)
	logs, auditErr := db.ListAdminAudit(t.Context(), 20)
	if err != nil || !found || before != after || auditErr != nil || len(logs) != 1 || logs[0].ID != "audit-baseline" {
		t.Fatal("snapshot validation failed to roll back flag, trigger change and audit")
	}
}
