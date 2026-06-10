package store

import (
	"context"
	"sort"
	"strings"
	"time"
)

// AgentStat is one coding-agent's aggregate performance (Claude Code, Cursor,
// Roo, Qwen, …), derived from the request User-Agent.
type AgentStat struct {
	Agent           string  `json:"agent"`
	Requests        int64   `json:"requests"`
	SuccessRate     float64 `json:"success_rate"` // 2xx & no error & no fallback
	FallbackRate    float64 `json:"fallback_rate"`
	Tokens          int64   `json:"tokens"`
	AvgCostKRW      float64 `json:"avg_cost_krw"`
	TotalCostKRW    float64 `json:"total_cost_krw"`
	AvgLatencyMS    float64 `json:"avg_latency_ms"`
	AvgFirstChunkMS float64 `json:"avg_first_chunk_ms"`
	ToolCalls       int64   `json:"tool_calls"`
	ToolErrors      int64   `json:"tool_errors"`
	ToolErrorRate   float64 `json:"tool_error_rate"`
	LastSeen        string  `json:"last_seen"`
	SampleUA        string  `json:"sample_ua"` // an example raw user-agent in this bucket
}

// AgentAnalytics is the agent leaderboard for a time window.
type AgentAnalytics struct {
	Since  string      `json:"since"`
	Agents []AgentStat `json:"agents"`
}

// classifyAgent folds a raw User-Agent into a friendly coding-agent label.
// Best-effort substring matching; unrecognized agents fall back to the first
// token of the UA so they still group meaningfully.
func classifyAgent(ua string) string {
	u := strings.ToLower(strings.TrimSpace(ua))
	if u == "" {
		return "(unknown)"
	}
	type rule struct {
		needle string
		label  string
	}
	// order matters: specific before generic
	for _, r := range []rule{
		{"claude-code", "Claude Code"}, {"claude code", "Claude Code"}, {"claudecode", "Claude Code"}, {"claude-cli", "Claude Code"},
		{"cursor", "Cursor"},
		{"roo", "Roo Code"},
		{"cline", "Cline"},
		{"kilo", "Kilo Code"},
		{"qwen", "Qwen Code"},
		{"aider", "Aider"},
		{"continue", "Continue"},
		{"open-webui", "OpenWebUI"}, {"openwebui", "OpenWebUI"},
		{"langflow", "Langflow"},
		{"openai-python", "OpenAI Python SDK"}, {"openai-node", "OpenAI Node SDK"},
		{"anthropic", "Anthropic SDK"},
		{"claude", "Claude Code"},
		{"axios", "axios"}, {"node-fetch", "node-fetch"}, {"python-requests", "Python requests"}, {"httpx", "httpx"},
		{"curl", "curl"},
		{"vscode", "VS Code"}, {"vs code", "VS Code"},
	} {
		if strings.Contains(u, r.needle) {
			return r.label
		}
	}
	// fallback: first token (before '/' or whitespace), capped
	tok := ua
	for _, sep := range []string{"/", " ", ";"} {
		if i := strings.Index(tok, sep); i > 0 {
			tok = tok[:i]
		}
	}
	tok = strings.TrimSpace(tok)
	if tok == "" {
		return "(unknown)"
	}
	if len(tok) > 24 {
		tok = tok[:24]
	}
	return tok
}

// AgentAnalytics aggregates chat-completion outcomes per coding agent since `since`.
func (s *SQLStore) AgentAnalytics(ctx context.Context, since time.Time) (AgentAnalytics, error) {
	out := AgentAnalytics{Since: since.UTC().Format(time.RFC3339), Agents: []AgentStat{}}
	query := s.bind(`
		SELECT COALESCE(NULLIF(r.user_agent, ''), '') AS ua,
			COUNT(*) AS requests,
			SUM(CASE WHEN r.status_code >= 200 AND r.status_code < 300 AND COALESCE(r.error, '') = '' AND COALESCE(r.failover, 0) = 0 THEN 1 ELSE 0 END) AS successes,
			SUM(COALESCE(r.failover, 0)) AS fallbacks,
			SUM(r.latency_ms) AS sum_latency,
			SUM(COALESCE(r.first_chunk_ms, 0)) AS sum_first_chunk,
			SUM(COALESCE(t.total_tokens, 0)) AS tokens,
			SUM(COALESCE(t.estimated_cost, 0)) AS cost,
			SUM(COALESCE(ti.calls, 0)) AS tool_calls,
			SUM(COALESCE(ti.errs, 0)) AS tool_errors,
			MAX(r.created_at) AS last_seen
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		LEFT JOIN (
			SELECT request_id,
				SUM(CASE WHEN source = 'call' THEN 1 ELSE 0 END) AS calls,
				SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) AS errs
			FROM tool_invocations GROUP BY request_id
		) ti ON ti.request_id = r.id
		WHERE r.created_at >= ? AND r.endpoint LIKE '%chat/completions%'
		GROUP BY ua`)
	rows, err := s.db.QueryContext(ctx, query, since.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return out, err
	}
	defer rows.Close()

	type acc struct {
		requests, successes, fallbacks, sumLat, sumFc, tokens, calls, errs int64
		cost                                                               float64
		lastSeen, ua                                                       string
	}
	buckets := map[string]*acc{}
	order := []string{}
	for rows.Next() {
		var ua string
		var requests, successes, fallbacks, sumLat, sumFc, tokens, calls, errs int64
		var cost float64
		var lastSeen string
		if err := rows.Scan(&ua, &requests, &successes, &fallbacks, &sumLat, &sumFc, &tokens, &cost, &calls, &errs, &lastSeen); err != nil {
			return out, err
		}
		agent := classifyAgent(ua)
		a := buckets[agent]
		if a == nil {
			a = &acc{}
			buckets[agent] = a
			order = append(order, agent)
		}
		a.requests += requests
		a.successes += successes
		a.fallbacks += fallbacks
		a.sumLat += sumLat
		a.sumFc += sumFc
		a.tokens += tokens
		a.cost += cost
		a.calls += calls
		a.errs += errs
		if lastSeen > a.lastSeen {
			a.lastSeen = lastSeen
		}
		if a.ua == "" && ua != "" {
			a.ua = ua
		}
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	for _, agent := range order {
		a := buckets[agent]
		st := AgentStat{
			Agent: agent, Requests: a.requests, Tokens: a.tokens, TotalCostKRW: a.cost,
			ToolCalls: a.calls, ToolErrors: a.errs, LastSeen: a.lastSeen, SampleUA: a.ua,
		}
		if a.requests > 0 {
			st.SuccessRate = float64(a.successes) / float64(a.requests)
			st.FallbackRate = float64(a.fallbacks) / float64(a.requests)
			st.AvgLatencyMS = float64(a.sumLat) / float64(a.requests)
			st.AvgFirstChunkMS = float64(a.sumFc) / float64(a.requests)
			st.AvgCostKRW = a.cost / float64(a.requests)
		}
		if a.calls > 0 {
			st.ToolErrorRate = float64(a.errs) / float64(a.calls)
		}
		out.Agents = append(out.Agents, st)
	}
	sort.SliceStable(out.Agents, func(i, j int) bool { return out.Agents[i].Requests > out.Agents[j].Requests })
	return out, nil
}
