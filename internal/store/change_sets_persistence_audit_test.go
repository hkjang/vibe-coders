package store

import (
	"errors"
	"reflect"
	"strconv"
	"testing"
)

func TestChangeSetAuditedSettingsPersistence(t *testing.T) {
	for _, pair := range [][2]string{{"approved", "apply_pending"}, {"applied", "rollback_pending"}} {
		for _, mode := range []string{"commit", "audit-failure", "commit-failure", "stale-revision", "setting-conflict"} {
			t.Run(pair[1]+"/"+mode, func(t *testing.T) {
				db := openStoreForTest(t)
				defer db.Close()
				db.db.SetMaxOpenConns(1)
				ctx := t.Context()
				if err := db.CreateChangeSet(ctx, ChangeSet{ID: "persist", Title: "persist", Status: pair[0]}); err != nil {
					t.Fatal(err)
				}
				if err := db.UpsertAdminSettings(ctx, []AdminSetting{settingRecord("test.a", "old-a", 0), settingRecord("test.b", "old-b", 0)}, "seed", "seed"); err != nil {
					t.Fatal(err)
				}
				next, _, err := db.GetChangeSet(ctx, "persist")
				if err != nil {
					t.Fatal(err)
				}
				next.Status = pair[1]
				next.Prior = []ChangeSetItem{{Kind: "setting", Key: "test.a", Value: "old-a"}, {Kind: "setting", Key: "test.b", Value: "old-b"}}
				audit := AdminAuditLog{ID: "persistence-audit", Action: "change_set.persisted", BeforeValue: next.ID}
				drop := ""
				switch mode {
				case "audit-failure":
					err = db.InsertAdminAudit(ctx, audit)
				case "commit-failure":
					drop = installChangeSetAuditCommitFailure(t, db)
				case "stale-revision":
					_, err = db.db.ExecContext(ctx, `UPDATE change_sets SET updated_at = 'competing' WHERE id = 'persist'`)
				}
				if err != nil {
					t.Fatal(err)
				}
				before, _, err := db.GetChangeSet(ctx, next.ID)
				if err != nil {
					t.Fatal(err)
				}
				beforeSettings, err := db.ListAdminSettings(ctx)
				if err != nil {
					t.Fatal(err)
				}
				beforeAudits, err := db.ListAdminAudit(ctx, 10)
				if err != nil {
					t.Fatal(err)
				}
				bVersion := 1
				if mode == "setting-conflict" {
					bVersion = 0
				}
				settings := []AdminSetting{settingRecord("test.b", "next-b", bVersion), settingRecord("test.a", "next-a", 1)}
				result, stageErr := db.StageChangeSetSettingsAudited(ctx, next, pair[0], "operator", "reason", settings, audit)
				after, _, err := db.GetChangeSet(ctx, next.ID)
				afterSettings, settingsErr := db.ListAdminSettings(ctx)
				audits, auditErr := db.ListAdminAudit(ctx, 10)
				if err != nil || settingsErr != nil || auditErr != nil {
					t.Fatal("persistence outcome unavailable")
				}
				if mode == "commit" {
					if stageErr != nil || !reflect.DeepEqual(result, after) || after.Status != pair[1] || len(audits) != 1 {
						t.Fatal("persistence response does not match the committed marker and audit")
					}
					for _, setting := range afterSettings {
						if setting.Version != 2 || setting.UpdatedBy != "operator" {
							t.Fatal("setting did not commit with the marker")
						}
					}
				} else {
					if stageErr == nil || result.ID != "" || !reflect.DeepEqual(before, after) || !reflect.DeepEqual(beforeSettings, afterSettings) || !reflect.DeepEqual(beforeAudits, audits) {
						t.Fatal("failed persistence changed settings, marker or audit")
					}
					if mode == "stale-revision" && !errors.Is(stageErr, ErrChangeSetConflict) || mode == "setting-conflict" && !errors.Is(stageErr, ErrAdminSettingConflict) {
						t.Fatal("wrong persistence conflict")
					}
				}
				for _, key := range []string{"test.a", "test.b"} {
					history, err := db.ListAdminSettingHistory(ctx, key, 10)
					want := 1
					if mode == "commit" {
						want = 2
					}
					if err != nil || len(history) != want {
						t.Fatal("setting history did not share the persistence outcome")
					}
				}
				if drop != "" {
					if _, err := db.db.ExecContext(ctx, drop); err != nil {
						t.Fatal(err)
					}
					if _, err := db.StageChangeSetSettingsAudited(ctx, next, pair[0], "operator", "reason", settings, audit); err != nil {
						t.Fatal("persistence connection did not recover")
					}
				}
			})
		}
	}
}

func TestChangeSetAuditedFinalization(t *testing.T) {
	for _, pair := range [][2]string{{"apply_pending", "applied"}, {"rollback_pending", "rolled_back"}} {
		for _, mode := range []string{"commit", "audit-failure", "commit-failure", "stale-revision"} {
			t.Run(pair[0]+"/"+mode, func(t *testing.T) {
				db := openStoreForTest(t)
				defer db.Close()
				db.db.SetMaxOpenConns(1)
				ctx := t.Context()
				if err := db.CreateChangeSet(ctx, ChangeSet{ID: "finalize", Title: "finalize", Status: pair[0]}); err != nil {
					t.Fatal(err)
				}
				snapshot, _, err := db.GetChangeSet(ctx, "finalize")
				if err != nil {
					t.Fatal(err)
				}
				audit := AdminAuditLog{ID: "final-audit", Action: "change_set.finalized", BeforeValue: snapshot.ID}
				drop := ""
				switch mode {
				case "audit-failure":
					err = db.InsertAdminAudit(ctx, audit)
				case "commit-failure":
					drop = installChangeSetAuditCommitFailure(t, db)
				case "stale-revision":
					_, err = db.db.ExecContext(ctx, `UPDATE change_sets SET updated_at = 'competing' WHERE id = 'finalize'`)
				}
				if err != nil {
					t.Fatal(err)
				}
				before, _, err := db.GetChangeSet(ctx, snapshot.ID)
				if err != nil {
					t.Fatal(err)
				}
				beforeAudits, err := db.ListAdminAudit(ctx, 10)
				if err != nil {
					t.Fatal(err)
				}
				result, changed, finalizeErr := db.FinalizeChangeSetAudited(ctx, snapshot, pair[0], pair[1], audit)
				after, _, err := db.GetChangeSet(ctx, snapshot.ID)
				audits, auditErr := db.ListAdminAudit(ctx, 10)
				if err != nil || auditErr != nil {
					t.Fatal("completion outcome unavailable")
				}
				if mode != "commit" {
					if finalizeErr == nil || changed || result.ID != "" || !reflect.DeepEqual(before, after) || !reflect.DeepEqual(beforeAudits, audits) {
						t.Fatal("failed completion changed marker or audit")
					}
					if drop != "" {
						if _, err := db.db.ExecContext(ctx, drop); err != nil {
							t.Fatal(err)
						}
						if _, changed, err := db.FinalizeChangeSetAudited(ctx, snapshot, pair[0], pair[1], audit); err != nil || !changed {
							t.Fatal("completion connection did not recover")
						}
					}
					return
				}
				if finalizeErr != nil || !changed || result.Status != pair[1] || !reflect.DeepEqual(result, after) || len(audits) != 1 {
					t.Fatal("completion response does not match atomic marker and audit")
				}
				audit.ID = "duplicate-finalizer"
				duplicate, changed, err := db.FinalizeChangeSetAudited(ctx, snapshot, pair[0], pair[1], audit)
				if err != nil || changed || !reflect.DeepEqual(duplicate, after) {
					t.Fatal("already-finalized response does not match committed state")
				}
				audits, err = db.ListAdminAudit(ctx, 10)
				if err != nil || len(audits) != 1 {
					t.Fatal("duplicate finalizer appended a second audit")
				}
			})
		}
	}
}

func TestChangeSetAuditedConcurrentFinalizers(t *testing.T) {
	for _, pair := range [][2]string{{"apply_pending", "applied"}, {"rollback_pending", "rolled_back"}} {
		t.Run(pair[0], func(t *testing.T) {
			first, second := routingPatchStores(t)
			ctx := t.Context()
			if err := first.CreateChangeSet(ctx, ChangeSet{ID: "parallel-final", Title: "parallel", Status: pair[0]}); err != nil {
				t.Fatal(err)
			}
			snapshot, _, err := first.GetChangeSet(ctx, "parallel-final")
			if err != nil {
				t.Fatal(err)
			}
			type outcome struct {
				row     ChangeSet
				changed bool
				err     error
			}
			start := make(chan struct{})
			results := make(chan outcome, 2)
			for index, db := range []*SQLStore{first, second} {
				go func() {
					<-start
					row, changed, err := db.FinalizeChangeSetAudited(ctx, snapshot, pair[0], pair[1], AdminAuditLog{
						ID: "parallel-final-" + strconv.Itoa(index), Action: "change_set.finalized", BeforeValue: snapshot.ID,
					})
					results <- outcome{row, changed, err}
				}()
			}
			close(start)
			changedCount := 0
			rows := []ChangeSet{}
			for range 2 {
				result := <-results
				if result.err != nil || result.row.Status != pair[1] {
					t.Fatal("concurrent completion did not return final state")
				}
				if result.changed {
					changedCount++
				}
				rows = append(rows, result.row)
			}
			stored, _, err := first.GetChangeSet(ctx, snapshot.ID)
			audits, auditErr := first.ListAdminAudit(ctx, 10)
			if err != nil || auditErr != nil || changedCount != 1 || len(audits) != 1 || !reflect.DeepEqual(rows[0], stored) || !reflect.DeepEqual(rows[1], stored) {
				t.Fatal("concurrent finalizers disagreed or duplicated completion audit")
			}
		})
	}
}

// A deletion that read the old approved/applied snapshot must not remove the
// recovery marker after settings have committed, even across independent pools.
func TestChangeSetAuditedPersistenceConcurrentDeletion(t *testing.T) {
	for _, pair := range [][2]string{{"approved", "apply_pending"}, {"applied", "rollback_pending"}} {
		t.Run(pair[1], func(t *testing.T) {
			first, second := routingPatchStores(t)
			ctx := t.Context()
			if err := first.CreateChangeSet(ctx, ChangeSet{ID: "stage-delete", Title: "parallel", Status: pair[0]}); err != nil {
				t.Fatal("create fixture failed")
			}
			if err := first.UpsertAdminSettings(ctx, []AdminSetting{settingRecord("test.stage", "old", 0)}, "seed", "seed"); err != nil {
				t.Fatal("seed setting failed")
			}
			snapshot, found, err := first.GetChangeSet(ctx, "stage-delete")
			if err != nil || !found {
				t.Fatal("snapshot unavailable")
			}
			start := make(chan struct{})
			type outcome struct {
				action string
				err    error
			}
			results := make(chan outcome, 2)
			go func() {
				<-start
				err := first.DeleteChangeSetAudited(ctx, snapshot, AdminAuditLog{ID: "delete", Action: "delete", BeforeValue: snapshot.ID})
				results <- outcome{"delete", err}
			}()
			go func() {
				<-start
				next := snapshot
				next.Status = pair[1]
				next.Prior = []ChangeSetItem{{Kind: "setting", Key: "test.stage", Value: "old"}}
				_, err := second.StageChangeSetSettingsAudited(ctx, next, pair[0], "operator", "reason",
					[]AdminSetting{settingRecord("test.stage", "new", 1)}, AdminAuditLog{ID: "stage", Action: "stage", BeforeValue: snapshot.ID})
				results <- outcome{"stage", err}
			}()
			close(start)
			wins, conflicts, winner := 0, 0, ""
			for range 2 {
				r := <-results
				if r.err == nil {
					wins++
					winner = r.action
				} else if errors.Is(r.err, ErrChangeSetConflict) {
					conflicts++
				} else {
					t.Fatal("unexpected concurrent persistence error")
				}
			}
			if wins != 1 || conflicts != 1 {
				t.Fatal("persistence/deletion must have one winner")
			}
			current, found, err := first.GetChangeSet(ctx, snapshot.ID)
			if err != nil || found != (winner == "stage") || found && (current.Status != pair[1] || len(current.Prior) != 1 || current.Prior[0].Value != "old") {
				t.Fatal("recovery marker lost or partially persisted")
			}
			history, err := first.ListAdminSettingHistory(ctx, "test.stage", 10)
			want := 1
			if winner == "stage" {
				want = 2
			}
			if err != nil || len(history) != want {
				t.Fatal("setting history disagrees with winner")
			}
			settings, err := first.ListAdminSettings(ctx)
			value, version := "old", 1
			if winner == "stage" {
				value, version = "new", 2
			}
			if err != nil || len(settings) != 1 || settings[0].ValueJSON != strconv.Quote(value) || settings[0].Version != version {
				t.Fatal("setting value disagrees with winner")
			}
			audits, err := first.ListAdminAudit(ctx, 10)
			if err != nil || len(audits) != 1 || audits[0].Action != winner {
				t.Fatal("audit disagrees with winner")
			}
		})
	}
}
