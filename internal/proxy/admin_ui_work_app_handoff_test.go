package proxy

import (
	"context"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// Execute the actual inline work app handoff blocks with deterministic synthetic
// responses. This supplements, but does not replace, the real browser/auth suite.
func TestAdminUIWorkAppHandoff(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not installed; skipping admin UI work app handoff behaviour checks")
	}
	_, testFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve admin UI work app handoff behaviour test path")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, node, filepath.Join(filepath.Dir(testFile), "testdata", "admin_ui_work_app_handoff.js"))
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("admin UI work app handoff behaviour checks failed: %v\n%s", err, out)
	}
	t.Logf("\n%s", out)
}
