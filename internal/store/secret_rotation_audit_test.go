package store

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestSecretRotationAuditCommitsOnlySafeCounts(t *testing.T) {
	db, oldCipher, newCipher := rotationFixture(t)
	seedRotationInventory(t, db, oldCipher)
	counts, err := db.RotateEncryptedColumnsWithAudit(t.Context(), oldCipher.Decrypt, newCipher.Encrypt, AdminAuditLog{
		ID: "rotation-audit", AdminID: "test-actor", Action: "secrets.rotate",
		BeforeValue: "synthetic-private-before", AfterValue: "synthetic-private-after",
	})
	if err != nil {
		t.Fatal(err)
	}
	audits, err := db.ListAdminAudit(t.Context(), 10)
	if err != nil || len(audits) != 1 {
		t.Fatal("rotation must commit exactly one audit")
	}
	audit := audits[0]
	if audit.ID != "rotation-audit" || audit.AdminID != "test-actor" || audit.Action != "secrets.rotate" || audit.BeforeValue != "" || audit.CreatedAt == "" {
		t.Fatal("audit must retain the action and actor without caller-supplied values")
	}
	var payload map[string]map[string]int
	if err := json.Unmarshal([]byte(audit.AfterValue), &payload); err != nil || len(payload) != 1 || !reflect.DeepEqual(payload["rotated"], counts) {
		t.Fatal("rotation audit must contain only the committed per-table counts")
	}
	for table, value := range readRotationInventory(t, db) {
		plaintext, err := newCipher.Decrypt(value)
		if err != nil || plaintext != "synthetic-inventory-secret" {
			t.Fatalf("successful audit did not commit %s rotation", table)
		}
	}
}

func TestSecretRotationAuditFailureRollsBackAllStores(t *testing.T) {
	for _, failure := range []string{"audit", "commit"} {
		t.Run(failure, func(t *testing.T) {
			db, oldCipher, newCipher := rotationFixture(t)
			db.db.SetMaxOpenConns(1)
			seedRotationInventory(t, db, oldCipher)
			audit := AdminAuditLog{ID: "rotation-audit", AdminID: "test-actor", Action: "secrets.rotate"}
			var removeFault string
			if failure == "audit" {
				if err := db.InsertAdminAudit(t.Context(), audit); err != nil {
					t.Fatal(err)
				}
				removeFault = `DELETE FROM admin_audit_logs WHERE id='rotation-audit'`
			} else {
				removeFault = installChangeSetAuditCommitFailure(t, db)
			}
			before := readRotationInventory(t, db)
			beforeAudits, err := db.ListAdminAudit(t.Context(), 10)
			if err != nil {
				t.Fatal(err)
			}
			counts, err := db.RotateEncryptedColumnsWithAudit(t.Context(), oldCipher.Decrypt, newCipher.Encrypt, audit)
			if err == nil || counts != nil {
				t.Fatal("faulted audited rotation must fail")
			}
			audits, err := db.ListAdminAudit(t.Context(), 10)
			if err != nil || !reflect.DeepEqual(audits, beforeAudits) || !reflect.DeepEqual(readRotationInventory(t, db), before) {
				t.Fatal("failed transaction changed ciphertext or committed an audit")
			}
			if _, err := db.db.ExecContext(t.Context(), removeFault); err != nil {
				t.Fatal(err)
			}
			if counts, err := db.RotateEncryptedColumnsWithAudit(t.Context(), oldCipher.Decrypt, newCipher.Encrypt, audit); err != nil || len(counts) != len(before) {
				t.Fatal("connection must be reusable after fault recovery")
			}
		})
	}
}

func TestSecretRotationRejectsMissingAuditIdentity(t *testing.T) {
	for _, audit := range []AdminAuditLog{
		{AdminID: "test-actor", Action: "secrets.rotate"},
		{ID: "rotation-audit", Action: "secrets.rotate"},
		{ID: "rotation-audit", AdminID: "test-actor", Action: "wrong-action"},
	} {
		db, oldCipher, newCipher := rotationFixture(t)
		seedRotationInventory(t, db, oldCipher)
		before := readRotationInventory(t, db)
		if _, err := db.RotateEncryptedColumnsWithAudit(t.Context(), oldCipher.Decrypt, newCipher.Encrypt, audit); err == nil {
			t.Fatal("rotation accepted an invalid audit identity")
		}
		if !reflect.DeepEqual(before, readRotationInventory(t, db)) {
			t.Fatal("rejected audit changed stored ciphertext")
		}
	}
}
