package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

// Applying, rolling back or deleting a change set edits live gateway settings.
// The audit trail has to carry the operator's stated reason, and deleting one
// used to leave no record at all.
func TestChangeSetLifecycleRecordsTheOperatorReason(t *testing.T) {
	ts, _, db := atomicSettingsServer(t)
	ctx := context.Background()

	seed := func(id, status string) {
		t.Helper()
		cs := store.ChangeSet{
			ID: id, Title: "retention change", Status: status,
			Items: []store.ChangeSetItem{{Kind: "setting", Key: "retention.request_days", Value: "45"}},
			Prior: []store.ChangeSetItem{{Kind: "setting", Key: "retention.request_days", Value: "30"}},
		}
		if err := db.CreateChangeSet(ctx, cs); err != nil {
			t.Fatal(err)
		}
	}
	auditDetail := func(action string) string {
		t.Helper()
		events, err := db.ListAdminAudit(ctx, 200)
		if err != nil {
			t.Fatal(err)
		}
		for _, event := range events {
			if event.Action == action {
				return event.AfterValue
			}
		}
		return ""
	}

	seed("cs-approve", "pending")
	resp, _ := req(t, http.MethodPost, ts.URL+"/admin/change-sets/cs-approve/approve", `{"note":"reviewed with the on-call"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("approve status = %d", resp.StatusCode)
	}
	if detail := auditDetail("change_set.approved"); !strings.Contains(detail, "reviewed with the on-call") {
		t.Fatalf("approval audit detail = %q, want the stated reason", detail)
	}

	seed("cs-apply", "approved")
	resp, _ = req(t, http.MethodPost, ts.URL+"/admin/change-sets/cs-apply/apply", `{"note":"shrinking retention for disk pressure"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("apply status = %d", resp.StatusCode)
	}
	if detail := auditDetail("change_set.apply"); !strings.Contains(detail, "shrinking retention for disk pressure") {
		t.Fatalf("apply audit detail = %q, want the stated reason", detail)
	}

	seed("cs-delete", "draft")
	resp, _ = req(t, http.MethodDelete, ts.URL+"/admin/change-sets/cs-delete", `{"note":"superseded by cs-apply"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("delete status = %d", resp.StatusCode)
	}
	detail := auditDetail("change_set.delete")
	if detail == "" {
		t.Fatal("deleting a change set left no audit record")
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(detail), &parsed); err != nil {
		t.Fatalf("delete audit detail is not JSON: %q", detail)
	}
	if parsed["reason"] != "superseded by cs-apply" || parsed["status"] != "draft" {
		t.Fatalf("delete audit detail = %#v, want the reason and the status it was deleted from", parsed)
	}
}
