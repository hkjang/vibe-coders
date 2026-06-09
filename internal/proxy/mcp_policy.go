package proxy

import (
	"context"
	"net/http"
	"sort"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

const mcpPolicyTTL = 5 * time.Second

type mcpPolicySnapshot struct {
	allowlist bool
	modes     map[string]string // server_label -> allow|block|warn
	fetchedAt time.Time
}

func (s *Server) mcpPolicySnapshot(ctx context.Context) *mcpPolicySnapshot {
	if cached := s.mcpPolicy.Load(); cached != nil && time.Since(cached.fetchedAt) < mcpPolicyTTL {
		return cached
	}
	snap := &mcpPolicySnapshot{modes: map[string]string{}, fetchedAt: time.Now()}
	if modes, err := s.db.MCPPolicyMap(ctx); err == nil {
		snap.modes = modes
	}
	if flag, found, err := s.db.GetFlag(ctx, "mcp_allowlist_enabled"); err == nil && found {
		snap.allowlist = strings.EqualFold(strings.TrimSpace(flag.Value), "true") || flag.Value == "1"
	}
	s.mcpPolicy.Store(snap)
	return snap
}

func (s *Server) invalidateMCPPolicyCache() { s.mcpPolicy.Store(nil) }

// mcpDecision is the result of evaluating a request's MCP servers against policy.
type mcpDecision struct {
	Blocked       bool
	BlockedServer string
	Reason        string
	Warnings      []string
}

// evaluateMCPPolicy inspects the MCP servers declared/used in a request and decides
// whether to block it. In allowlist mode any MCP server without an explicit "allow"
// is blocked; otherwise only servers marked "block" are rejected. "warn" servers are
// allowed but recorded.
func evaluateMCPPolicy(snap *mcpPolicySnapshot, tools []store.ToolInvocation) mcpDecision {
	if snap == nil {
		return mcpDecision{}
	}
	servers := map[string]bool{}
	for _, t := range tools {
		if t.IsMCP && t.ServerLabel != "" {
			servers[t.ServerLabel] = true
		}
	}
	if len(servers) == 0 {
		return mcpDecision{}
	}
	ordered := make([]string, 0, len(servers))
	for srv := range servers {
		ordered = append(ordered, srv)
	}
	sort.Strings(ordered)

	decision := mcpDecision{}
	for _, srv := range ordered {
		mode := snap.modes[srv]
		switch mode {
		case "block":
			return mcpDecision{Blocked: true, BlockedServer: srv, Reason: "server_blocked"}
		case "warn":
			decision.Warnings = append(decision.Warnings, srv)
		case "allow":
			// explicitly allowed
		default:
			if snap.allowlist {
				return mcpDecision{Blocked: true, BlockedServer: srv, Reason: "not_in_allowlist"}
			}
		}
	}
	return decision
}

// enforceMCPPolicy returns true if the request was blocked (and a response written).
func (s *Server) enforceMCPPolicy(w http.ResponseWriter, r *http.Request, meta store.LogRecord, traceID string) bool {
	snap := s.mcpPolicySnapshot(r.Context())
	decision := evaluateMCPPolicy(snap, meta.Tools)
	if len(decision.Warnings) > 0 {
		w.Header().Set("X-MCP-Warn-Servers", strings.Join(decision.Warnings, ","))
	}
	if !decision.Blocked {
		return false
	}
	w.Header().Set("X-MCP-Blocked-Server", decision.BlockedServer)
	w.Header().Set("X-Request-ID", traceID)
	s.metrics.IncMCPBlocked()

	// record the blocked attempt so it shows up in history/audit
	meta.Request.StatusCode = http.StatusForbidden
	meta.Request.Provider = "blocked"
	meta.Request.Error = "mcp policy: " + decision.Reason + " (" + decision.BlockedServer + ")"
	s.metrics.ObserveToolInvocations(meta.Tools)
	s.enqueue(meta)

	writeOpenAIError(w, http.StatusForbidden,
		"MCP server '"+decision.BlockedServer+"' is not permitted by gateway policy ("+decision.Reason+")",
		"mcp_policy_error", decision.Reason)
	return true
}
