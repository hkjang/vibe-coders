package proxy

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

// Exercise the actual transition handler with the snapshot it read before a
// competing request committed. No timing or goroutine ordering is assumed.
func TestChangeSetTransitionRejectsStaleServerSnapshot(t *testing.T) {
	for _, tc := range []struct{ from, to, committed, action string }{
		{"draft", "pending", "approved", "submit"},
		{"pending", "approved", "applied", "approve"},
	} {
		t.Run(tc.from, func(t *testing.T) {
			_, server, db := atomicSettingsServer(t)
			ctx := t.Context()
			seed := store.ChangeSet{ID: "stale-transition", Title: "concurrent review", Status: tc.from}
			if err := db.CreateChangeSet(ctx, seed); err != nil {
				t.Fatal(err)
			}
			stale, found, err := db.GetChangeSet(ctx, seed.ID)
			if err != nil || !found {
				t.Fatal("initial snapshot unavailable")
			}
			newer := stale
			newer.Status, newer.Note, newer.Reviewer = tc.committed, "newer review", "newer reviewer"
			newer.Prior = []store.ChangeSetItem{{Kind: "setting", Key: "retention.request_days", Value: "30"}}
			if err := db.UpdateChangeSet(ctx, newer); err != nil {
				t.Fatal(err)
			}
			before, _, err := db.GetChangeSet(ctx, seed.ID)
			if err != nil {
				t.Fatal(err)
			}
			r := httptest.NewRequest(http.MethodPost, "/admin/change-sets/stale-transition/"+tc.action, strings.NewReader(`{"note":"stale reason"}`))
			w := httptest.NewRecorder()
			server.changeSetTransition(w, r, stale, tc.from, tc.to)
			if w.Code != http.StatusConflict {
				t.Errorf("stale transition status=%d; want 409", w.Code)
			}
			after, found, err := db.GetChangeSet(ctx, seed.ID)
			if err != nil || !found || !reflect.DeepEqual(before, after) {
				t.Error("stale transition overwrote the committed state, reviewer, note or prior values")
			}
			audits, err := db.ListAdminAudit(ctx, 10)
			if err != nil || len(audits) != 0 {
				t.Error("rejected stale transition must not record a successful review")
			}
		})
	}
}
