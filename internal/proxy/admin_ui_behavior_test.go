package proxy

import (
	"os/exec"
	"testing"
)

// The admin UI's JavaScript lives inside a Go raw string, so `go test` never executes
// it — a broken palette or focus trap ships silently. testdata/admin_ui_behavior.js
// pulls individual functions out of admin_ui.go and runs them against a stub DOM.
//
// Node is not a build requirement, so the test skips when it is absent rather than
// failing a developer who has no reason to install it. The static invariants in
// admin_ui_static_test.go always run and need nothing extra.
func TestAdminUIBehaviour(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not installed; skipping admin UI behaviour checks")
	}
	out, err := exec.Command(node, "testdata/admin_ui_behavior.js").CombinedOutput()
	if err != nil {
		t.Fatalf("admin UI behaviour checks failed: %v\n%s", err, out)
	}
	t.Logf("\n%s", out)
}
