package proxy

import (
	"context"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func mcpPolicyServer(t *testing.T) (*Server, *store.SQLStore) {
	t.Helper()
	db := openTestStore(t)
	t.Cleanup(func() { db.Close() })
	logger := store.NewAsyncLogger(db, 8, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()) })
	upstream := httptest.NewServer(nil)
	t.Cleanup(upstream.Close)

	server, err := NewServer(testConfig(upstream.URL, "s"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	return server, db
}

func setAllowlistFlag(t *testing.T, db *store.SQLStore, value string) {
	t.Helper()
	if err := db.SetFlag(context.Background(), store.RuntimeFlag{
		Key: "mcp_allowlist_enabled", Value: value, UpdatedAt: time.Now().UTC(), UpdatedBy: "test",
	}); err != nil {
		t.Fatal(err)
	}
}

// Allowlist mode is the setting that decides whether an MCP server nobody listed is
// blocked or waved through, and it is turned on by a runtime flag.
//
// evaluateMCPPolicy is tested against a snapshot built by hand, so the step that reads that
// flag — the one an operator actually touches — was not exercised at all. A parse that
// never returns true leaves the switch looking set while every unlisted server keeps
// working.
func TestTheAllowlistFlagIsReadInEveryFormItIsWritten(t *testing.T) {
	cases := []struct {
		value string
		want  bool
	}{
		{"true", true},
		{"TRUE", true},
		{"True", true},
		{"  true  ", true},
		{"1", true},
		{"false", false},
		{"0", false},
		{"", false},
		{"yes", false},
	}
	for _, tc := range cases {
		s, db := mcpPolicyServer(t)
		setAllowlistFlag(t, db, tc.value)
		s.invalidateMCPPolicyCache()

		snap := s.mcpPolicySnapshot(context.Background())
		if snap.allowlist != tc.want {
			t.Errorf("flag %q gave allowlist=%v, want %v", tc.value, snap.allowlist, tc.want)
		}
	}

	// With no flag row at all the allowlist stays off: a gateway nobody has configured
	// must not start refusing MCP servers.
	s, _ := mcpPolicyServer(t)
	if s.mcpPolicySnapshot(context.Background()).allowlist {
		t.Error("allowlist mode is on with no flag set")
	}
}

// The snapshot is cached for a few seconds, and the invalidation is what makes an operator's
// change take effect before that. A cache that never reloads leaves policy frozen at
// whatever it was when the process started.
func TestThePolicySnapshotReloadsAfterInvalidation(t *testing.T) {
	s, db := mcpPolicyServer(t)
	ctx := context.Background()

	first := s.mcpPolicySnapshot(ctx)
	if first.allowlist {
		t.Fatal("allowlist is on before anything set it")
	}

	setAllowlistFlag(t, db, "true")
	if s.mcpPolicySnapshot(ctx).allowlist {
		t.Error("the change was picked up without an invalidation; the snapshot is not cached at all")
	}

	s.invalidateMCPPolicyCache()
	if !s.mcpPolicySnapshot(ctx).allowlist {
		t.Error("the change was not picked up after invalidation; policy is frozen")
	}
}

// The server modes an operator sets have to reach the decision, not just the flag.
func TestThePolicySnapshotCarriesTheServerModes(t *testing.T) {
	s, db := mcpPolicyServer(t)
	ctx := context.Background()

	for label, mode := range map[string]string{"github": "allow", "filesystem": "block", "shell": "warn"} {
		if err := db.UpsertMCPPolicy(ctx, store.MCPPolicy{ServerLabel: label, Mode: mode}); err != nil {
			t.Fatal(err)
		}
	}
	s.invalidateMCPPolicyCache()

	snap := s.mcpPolicySnapshot(ctx)
	for label, want := range map[string]string{"github": "allow", "filesystem": "block", "shell": "warn"} {
		if snap.modes[label] != want {
			t.Errorf("%s is %q in the snapshot, want %q", label, snap.modes[label], want)
		}
	}

	// And the decision follows from them.
	blocked := evaluateMCPPolicy(snap, []store.ToolInvocation{{IsMCP: true, ServerLabel: "filesystem"}})
	if !blocked.Blocked || blocked.BlockedServer != "filesystem" {
		t.Errorf("a blocked server was not blocked: %#v", blocked)
	}
}

// MCP policy applies to MCP servers. A tool that is not one carries no server to check, and
// an MCP tool with no label names none — treating either as a server puts a request in
// front of a policy that was never meant to see it, which under allowlist mode means
// refusing it.
func TestOnlyLabelledMCPToolsAreSubjectToMCPPolicy(t *testing.T) {
	snap := &mcpPolicySnapshot{allowlist: true, modes: map[string]string{"github": "allow"}}

	cases := []struct {
		name        string
		tools       []store.ToolInvocation
		wantBlocked bool
	}{
		{"a local function call is not an MCP server",
			[]store.ToolInvocation{{IsMCP: false, ServerLabel: "some-label", ToolName: "calc"}}, false},
		{"an MCP tool with no label names no server",
			[]store.ToolInvocation{{IsMCP: true, ServerLabel: "", ToolName: "read"}}, false},
		{"an allowed MCP server passes",
			[]store.ToolInvocation{{IsMCP: true, ServerLabel: "github"}}, false},
		{"an unlisted MCP server is blocked under allowlist",
			[]store.ToolInvocation{{IsMCP: true, ServerLabel: "filesystem"}}, true},
		{"a local tool alongside an allowed server is still fine",
			[]store.ToolInvocation{
				{IsMCP: false, ServerLabel: "filesystem", ToolName: "calc"},
				{IsMCP: true, ServerLabel: "github"},
			}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := evaluateMCPPolicy(snap, tc.tools); got.Blocked != tc.wantBlocked {
				t.Fatalf("blocked=%v want %v (%#v)", got.Blocked, tc.wantBlocked, got)
			}
		})
	}
}

// The warn header says which servers were flagged, so it must not appear when none were.
// An empty X-MCP-Warn-Servers reads as "there were warnings" to anything checking for the
// header rather than parsing it.
func TestTheWarnHeaderAppearsOnlyWhenThereAreWarnings(t *testing.T) {
	s, _ := mcpPolicyServer(t)
	s.mcpPolicy.Store(&mcpPolicySnapshot{
		modes:     map[string]string{"github": "allow", "shell": "warn"},
		fetchedAt: time.Now(),
	})

	call := func(tools []store.ToolInvocation) *httptest.ResponseRecorder {
		t.Helper()
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/v1/chat/completions", nil)
		blocked := s.enforceMCPPolicy(rec, req, store.LogRecord{
			Request: store.RequestLog{ID: "r1", TraceID: "t1"}, Tools: tools}, "t1")
		if blocked {
			t.Fatal("nothing here should be blocked")
		}
		return rec
	}

	quiet := call([]store.ToolInvocation{{IsMCP: true, ServerLabel: "github"}})
	if _, present := quiet.Header()["X-Mcp-Warn-Servers"]; present {
		t.Errorf("the warn header is present with no warnings: %q", quiet.Header().Get("X-MCP-Warn-Servers"))
	}

	warned := call([]store.ToolInvocation{{IsMCP: true, ServerLabel: "shell"}})
	if got := warned.Header().Get("X-MCP-Warn-Servers"); got != "shell" {
		t.Errorf("the warn header is %q, want %q", got, "shell")
	}
}
