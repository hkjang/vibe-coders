package proxy

import (
	"context"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// Execute the actual inline authentication blocks with deterministic synthetic
// responses. This supplements, but does not replace, the real browser/auth suite.
func TestAdminUIAuthBehaviour(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not installed; skipping admin UI authentication behaviour checks")
	}
	_, testFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve admin UI authentication behaviour test path")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, node, filepath.Join(filepath.Dir(testFile), "testdata", "admin_ui_auth_behavior.js"))
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("admin UI authentication behaviour checks failed: %v\n%s", err, out)
	}
	t.Logf("\n%s", out)
}
