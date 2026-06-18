package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

type MCPDiscoveryPolicy struct {
	Model               string
	Mode                string
	MaxMCPs             int
	Parallelism         int
	TimeoutMillis       int
	MinSelectorScore    float64
	MinEvidenceScore    float64
	AllowHighRiskTools  bool
	RequireApproval     bool
	AllowNoGroundAnswer bool
}

type MCPCandidate struct {
	UpstreamID       string   `json:"upstream_id"`
	UpstreamName     string   `json:"upstream_name"`
	ToolName         string   `json:"tool_name"`
	NamespacedTool   string   `json:"namespaced_tool"`
	Description      string   `json:"description"`
	Domains          []string `json:"domains"`
	RiskLevel        string   `json:"risk_level"`
	SelectorScore    float64  `json:"selector_score"`
	HealthScore      float64  `json:"health_score"`
	FinalScore       float64  `json:"final_score"`
	RequiresApproval bool     `json:"requires_approval"`
	TimeoutMS        int      `json:"timeout_ms"`
	MaxResults       int      `json:"max_results"`
}

type MCPEvidence struct {
	UpstreamID    string          `json:"upstream_id"`
	UpstreamName  string          `json:"upstream_name"`
	ToolName      string          `json:"tool_name"`
	Items         []MCPResultItem `json:"items"`
	SelectorScore float64         `json:"selector_score"`
	EvidenceScore float64         `json:"evidence_score"`
	SourceCount   int             `json:"source_count"`
	Error         string          `json:"error,omitempty"`
	LatencyMS     int64           `json:"latency_ms"`
}

type MCPResultItem struct {
	Title string  `json:"title,omitempty"`
	URI   string  `json:"uri,omitempty"`
	Text  string  `json:"text,omitempty"`
	Score float64 `json:"score,omitempty"`
}

func (rc *requestPipeline) stepMCPDiscovery() bool {
	s, r, w := rc.s, rc.r, rc.w
	if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" {
		return true
	}
	if rc.body == nil {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "failed to read request body", "invalid_request_error", "invalid_body")
			return false
		}
		rc.body = body
	}

	model, _, prompts, _ := extractAudit(rc.body, r.URL.Path, false)
	if !isMCPDiscoveryModel(model) {
		return true
	}
	if rc.authCtx != nil && !hasScope(rc.authCtx.Scopes, "mcp:use") {
		_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "scope_denied", APIKeyID: rc.authCtx.APIKeyID, TeamID: rc.authCtx.TeamID, IP: clientIP(r), UserAgent: r.UserAgent(), Detail: "mcp:use", CreatedAt: time.Now().UTC()})
		writeOpenAIError(w, http.StatusForbidden, "mcp:use scope is required for MCP discovery models", "permission_error", "scope_denied")
		return false
	}
	if rc.authCtx != nil && !listAllows(model, rc.authCtx.AllowedModels, rc.authCtx.DeniedModels) {
		_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "model_denied", APIKeyID: rc.authCtx.APIKeyID, TeamID: rc.authCtx.TeamID, IP: clientIP(r), UserAgent: r.UserAgent(), Detail: model, CreatedAt: time.Now().UTC()})
		writeOpenAIError(w, http.StatusForbidden, "model is not allowed by auth policy", "permission_error", "model_denied")
		return false
	}

	policy := mcpDiscoveryPolicyForModel(model)
	if strings.EqualFold(policy.Mode, "all_allowed") && rc.authCtx != nil && rc.authCtx.Role != "admin" && rc.authCtx.Role != "super_admin" {
		writeOpenAIError(w, http.StatusForbidden, "vibe/all-mcp is restricted to admin roles", "permission_error", "mcp_all_admin_required")
		return false
	}
	query := promptsPlainText(prompts)
	if strings.TrimSpace(query) == "" {
		writeOpenAIError(w, http.StatusBadRequest, "MCP discovery requires at least one user prompt", "invalid_request_error", "empty_query")
		return false
	}
	s.handleMCPDiscoveryChat(w, r, rc.body, query, policy, rc.apiKeyID, rc.authCtx)
	return false
}

func isMCPDiscoveryModel(model string) bool {
	switch strings.ToLower(strings.TrimSpace(model)) {
	case "vibe/grounded", "vibe/all-mcp", "vibe/research", "vibe/compliance", "vibe/policy", "vibe/legal":
		return true
	default:
		return false
	}
}

func mcpDiscoveryPolicyForModel(model string) MCPDiscoveryPolicy {
	normalized := strings.ToLower(strings.TrimSpace(model))
	switch normalized {
	case "vibe/all-mcp":
		return MCPDiscoveryPolicy{Model: normalized, Mode: "all_allowed", MaxMCPs: 20, Parallelism: 5, TimeoutMillis: 8000, MinSelectorScore: 0, MinEvidenceScore: 0.70}
	case "vibe/research":
		return MCPDiscoveryPolicy{Model: normalized, Mode: "selective", MaxMCPs: 5, Parallelism: 4, TimeoutMillis: 7000, MinSelectorScore: 0.50, MinEvidenceScore: 0.70}
	case "vibe/policy", "vibe/legal", "vibe/compliance":
		return MCPDiscoveryPolicy{Model: normalized, Mode: "domain_filtered", MaxMCPs: 5, Parallelism: 3, TimeoutMillis: 6000, MinSelectorScore: 0.60, MinEvidenceScore: 0.75, RequireApproval: normalized == "vibe/compliance"}
	default:
		return MCPDiscoveryPolicy{Model: normalized, Mode: "selective", MaxMCPs: 3, Parallelism: 3, TimeoutMillis: 5000, MinSelectorScore: 0.65, MinEvidenceScore: 0.75}
	}
}

func (s *Server) handleMCPDiscoveryChat(w http.ResponseWriter, r *http.Request, body []byte, query string, policy MCPDiscoveryPolicy, apiKeyID string, authCtx *store.AuthContext) {
	start := time.Now()
	traceID := traceIDFromRequest(r)
	meta := s.auditRequest(r.URL.Path, body, apiKeyID, traceID, r)
	meta.Request.Provider = "mcp_discovery"
	meta.Request.RouteReason = "mcp_discovery"
	meta.Request.RouteDetail = policy.Mode

	candidates, err := s.selectMCPCandidates(r.Context(), query, policy, authCtx)
	if err != nil {
		writeOpenAIError(w, http.StatusBadGateway, "mcp discovery failed: "+err.Error(), "mcp_error", "mcp_discovery_failed")
		return
	}
	w.Header().Set("X-MCP-Discovery-Model", policy.Model)
	w.Header().Set("X-MCP-Discovery-Mode", policy.Mode)
	w.Header().Set("X-MCP-Candidates", strconv.Itoa(len(candidates)))

	evidences := s.callSelectedMCPs(r, apiKeyID, authCtx, candidates, query, policy)
	filtered := make([]MCPEvidence, 0, len(evidences))
	for _, evidence := range evidences {
		if evidence.Error == "" && evidence.EvidenceScore >= policy.MinEvidenceScore {
			filtered = append(filtered, evidence)
		}
	}
	w.Header().Set("X-MCP-Evidence", strconv.Itoa(len(filtered)))
	content := renderMCPDiscoveryAnswer(policy, candidates, filtered)
	if len(filtered) == 0 && !policy.AllowNoGroundAnswer {
		w.Header().Set("X-MCP-Grounded", "false")
	} else {
		w.Header().Set("X-MCP-Grounded", "true")
	}

	meta.Request.StatusCode = http.StatusOK
	meta.Request.LatencyMS = time.Since(start).Milliseconds()
	meta.Request.ToolCount = len(evidences)
	meta.Request.RouteDetail = strings.Join(candidateIDs(candidates), ",")
	meta.Response = &store.ResponseLog{
		ID:                   newID("resp"),
		RequestID:            meta.Request.ID,
		StatusCode:           http.StatusOK,
		FinishReason:         "stop",
		ResponseHash:         audit.HashText(content),
		ResponseTextOptional: content,
		CreatedAt:            time.Now().UTC(),
	}
	meta.Usage = &store.TokenUsage{
		ID:               newID("usage"),
		RequestID:        meta.Request.ID,
		PromptTokens:     promptTokenEstimate(meta.Prompts),
		CompletionTokens: len(content) / 4,
		TotalTokens:      promptTokenEstimate(meta.Prompts) + len(content)/4,
		Currency:         "KRW",
		Source:           "mcp_discovery_estimated",
		CreatedAt:        time.Now().UTC(),
	}
	for _, evidence := range evidences {
		meta.Tools = append(meta.Tools, store.ToolInvocation{
			ID:          newID("tool"),
			RequestID:   meta.Request.ID,
			TraceID:     meta.Request.TraceID,
			APIKeyID:    apiKeyID,
			ServerLabel: evidence.UpstreamName,
			ToolName:    evidence.ToolName,
			Source:      "call",
			IsMCP:       true,
			IsError:     evidence.Error != "",
			ArgHash:     audit.HashText(query),
			CreatedAt:   time.Now().UTC(),
		})
	}
	s.recordDomainRoutingLearning(r, meta, query, policy, candidates, evidences, filtered, authCtx)
	s.metrics.IncRequest(false)
	s.metrics.ObserveLatency(meta.Request.LatencyMS)
	s.metrics.ObserveToolInvocations(meta.Tools)
	s.enqueue(meta)
	writeMCPDiscoveryCompletion(w, policy.Model, content, filtered)
}

func (s *Server) recordDomainRoutingLearning(r *http.Request, meta store.LogRecord, query string, policy MCPDiscoveryPolicy, candidates []MCPCandidate, evidences, filtered []MCPEvidence, authCtx *store.AuthContext) {
	if s.db == nil || meta.Request.ID == "" {
		return
	}
	route := domainRouteForMCPPolicy(policy)
	confidence := 0.0
	if len(candidates) > 0 {
		confidence = candidates[0].FinalScore
	}
	evidenceScore := 0.0
	for _, ev := range filtered {
		if ev.EvidenceScore > evidenceScore {
			evidenceScore = ev.EvidenceScore
		}
	}
	toolNames := []string{}
	for _, c := range candidates {
		toolNames = append(toolNames, c.UpstreamID+"/"+c.ToolName)
	}
	decision := store.DomainRoutingDecision{
		ID:            newID("drd"),
		RequestID:     meta.Request.ID,
		QueryHash:     audit.HashText(query),
		Route:         route,
		Confidence:    confidence,
		ToolNames:     toolNames,
		EvidenceScore: evidenceScore,
		EvidenceCount: len(filtered),
		Reason:        domainRoutingReason(policy, candidates, filtered),
		CreatedAt:     time.Now().UTC().Format(time.RFC3339Nano),
	}
	if authCtx != nil {
		decision.UserID = authCtx.UserID
		decision.TeamID = authCtx.TeamID
	}
	signals := domainRoutingSignals(decision.ID, route, policy, candidates, evidences, filtered)
	if err := s.db.InsertDomainRoutingDecision(r.Context(), decision, signals); err != nil {
		return
	}
	if shouldAutoPromoteDomainExample(decision, query) {
		_ = s.db.UpsertDomainExample(r.Context(), store.DomainExample{
			ID:           newID("dex"),
			Route:        route,
			Text:         truncateText(query, 2000),
			TextHash:     decision.QueryHash,
			Source:       "mcp_evidence",
			Confidence:   decision.Confidence,
			Approved:     true,
			AutoPromoted: true,
			CreatedAt:    decision.CreatedAt,
		})
	}
	if shouldReviewDomainDecision(decision, candidates, filtered) {
		_ = s.db.EnqueueDomainReview(r.Context(), store.DomainReviewQueueItem{
			ID:             newID("drv"),
			DecisionID:     decision.ID,
			QueryText:      truncateText(query, 2000),
			SuggestedRoute: route,
			CurrentRoute:   policy.Model,
			Reason:         decision.Reason,
			Status:         "pending",
			CreatedAt:      decision.CreatedAt,
		})
	}
}

func domainRouteForMCPPolicy(policy MCPDiscoveryPolicy) string {
	switch policy.Model {
	case "vibe/policy":
		return "company_policy"
	case "vibe/legal":
		return "legal"
	case "vibe/compliance":
		return "compliance"
	case "vibe/all-mcp", "vibe/research":
		return "research"
	default:
		return "grounded"
	}
}

func domainRoutingReason(policy MCPDiscoveryPolicy, candidates []MCPCandidate, filtered []MCPEvidence) string {
	parts := []string{"model=" + policy.Model, "mode=" + policy.Mode}
	if len(candidates) > 0 {
		parts = append(parts, "top_candidate="+candidates[0].UpstreamID, "confidence="+strconv.FormatFloat(candidates[0].FinalScore, 'f', 2, 64))
	}
	if len(filtered) > 0 {
		parts = append(parts, "evidence="+strconv.FormatFloat(filtered[0].EvidenceScore, 'f', 2, 64))
	} else {
		parts = append(parts, "no_grounded_evidence")
	}
	return strings.Join(parts, "; ")
}

func domainRoutingSignals(decisionID, route string, policy MCPDiscoveryPolicy, candidates []MCPCandidate, evidences, filtered []MCPEvidence) []store.DomainRoutingSignal {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	out := []store.DomainRoutingSignal{{
		ID: decisionID + "_explicit", DecisionID: decisionID, Source: "explicit_model", Route: route, Score: 0.99, Reason: policy.Model, CreatedAt: now,
	}}
	for i, c := range candidates {
		out = append(out, store.DomainRoutingSignal{
			ID: decisionID + "_selector_" + strconv.Itoa(i), DecisionID: decisionID, Source: "selector", Route: route,
			Score: c.FinalScore, Reason: c.UpstreamID + "/" + c.ToolName, CreatedAt: now,
		})
	}
	for i, ev := range evidences {
		score := ev.EvidenceScore
		reason := ev.UpstreamID + "/" + ev.ToolName
		if ev.Error != "" {
			reason += " error=" + ev.Error
		}
		out = append(out, store.DomainRoutingSignal{
			ID: decisionID + "_evidence_" + strconv.Itoa(i), DecisionID: decisionID, Source: "mcp_evidence", Route: route,
			Score: score, Reason: reason, CreatedAt: now,
		})
	}
	if len(filtered) == 0 {
		out = append(out, store.DomainRoutingSignal{
			ID: decisionID + "_gate", DecisionID: decisionID, Source: "evidence_gate", Route: route,
			Score: 0, Reason: "evidence below threshold", CreatedAt: now,
		})
	}
	return out
}

func shouldAutoPromoteDomainExample(decision store.DomainRoutingDecision, query string) bool {
	return strings.TrimSpace(query) != "" &&
		decision.Confidence >= 0.85 &&
		decision.EvidenceScore >= 0.80 &&
		decision.EvidenceCount > 0 &&
		decision.Route != "legal" &&
		decision.Route != "compliance"
}

func shouldReviewDomainDecision(decision store.DomainRoutingDecision, candidates []MCPCandidate, filtered []MCPEvidence) bool {
	if len(candidates) == 0 || len(filtered) == 0 {
		return true
	}
	if decision.Confidence < 0.75 {
		return true
	}
	if len(candidates) >= 2 && math.Abs(candidates[0].FinalScore-candidates[1].FinalScore) < 0.05 {
		return true
	}
	return false
}

func (s *Server) selectMCPCandidates(ctx context.Context, query string, policy MCPDiscoveryPolicy, authCtx *store.AuthContext) ([]MCPCandidate, error) {
	upstreams, err := s.db.ActiveMCPUpstreams(ctx)
	if err != nil {
		return nil, err
	}
	snap := s.mcpToolsSnapshotCached(ctx)
	toolsByUpstream := map[string][]mcpToolDef{}
	for _, tool := range snap.tools {
		if route, ok := snap.routes[tool.Name]; ok {
			toolsByUpstream[route.upstreamID] = append(toolsByUpstream[route.upstreamID], tool)
		}
	}
	policySnap := s.mcpPolicySnapshot(ctx)
	candidates := []MCPCandidate{}
	for _, up := range upstreams {
		meta := defaultedMCPMetadata(up)
		if !mcpModelAllowed(policy.Model, meta.AllowedModels) {
			continue
		}
		if !mcpRiskAllowed(meta.RiskLevel, policy) || meta.RequiresApproval {
			continue
		}
		if strings.EqualFold(policy.Mode, "domain_filtered") && !mcpDomainMatches(policy.Model, meta.Domains, query) {
			continue
		}
		tool, ok := pickMCPDiscoveryTool(toolsByUpstream[up.ID], meta.DefaultTool)
		if !ok {
			continue
		}
		route := snap.routes[tool.Name]
		decision := evaluateMCPPolicy(policySnap, []store.ToolInvocation{{IsMCP: true, ServerLabel: route.upstreamName, ToolName: route.bareTool}})
		if decision.Blocked {
			continue
		}
		selector := scoreMCPRelevance(query, up, meta, tool)
		if !strings.EqualFold(policy.Mode, "all_allowed") && selector < policy.MinSelectorScore {
			continue
		}
		health := mcpHealthScoreFromSnapshot(snap, up)
		final := selector*0.8 + health*0.2
		candidates = append(candidates, MCPCandidate{
			UpstreamID:       up.ID,
			UpstreamName:     up.Name,
			ToolName:         route.bareTool,
			NamespacedTool:   tool.Name,
			Description:      firstNonEmpty(meta.Description, tool.Description, up.Name),
			Domains:          meta.Domains,
			RiskLevel:        meta.RiskLevel,
			SelectorScore:    roundScore(selector),
			HealthScore:      roundScore(health),
			FinalScore:       roundScore(final),
			RequiresApproval: meta.RequiresApproval,
			TimeoutMS:        firstPositive(meta.TimeoutMS, policy.TimeoutMillis),
			MaxResults:       firstPositive(meta.MaxResults, 5),
		})
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].FinalScore == candidates[j].FinalScore {
			return candidates[i].UpstreamID < candidates[j].UpstreamID
		}
		return candidates[i].FinalScore > candidates[j].FinalScore
	})
	if policy.MaxMCPs > 0 && len(candidates) > policy.MaxMCPs {
		candidates = candidates[:policy.MaxMCPs]
	}
	return candidates, nil
}

func (s *Server) callSelectedMCPs(r *http.Request, apiKeyID string, authCtx *store.AuthContext, candidates []MCPCandidate, query string, policy MCPDiscoveryPolicy) []MCPEvidence {
	if len(candidates) == 0 {
		return nil
	}
	parallelism := policy.Parallelism
	if parallelism <= 0 {
		parallelism = 1
	}
	sem := make(chan struct{}, parallelism)
	out := make(chan MCPEvidence, len(candidates))
	var wg sync.WaitGroup
	for _, candidate := range candidates {
		candidate := candidate
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			out <- s.callOneMCPDiscoveryTool(r, apiKeyID, authCtx, candidate, query)
		}()
	}
	wg.Wait()
	close(out)
	evidences := []MCPEvidence{}
	for evidence := range out {
		evidences = append(evidences, evidence)
	}
	sort.Slice(evidences, func(i, j int) bool {
		if evidences[i].EvidenceScore == evidences[j].EvidenceScore {
			return evidences[i].UpstreamID < evidences[j].UpstreamID
		}
		return evidences[i].EvidenceScore > evidences[j].EvidenceScore
	})
	return evidences
}

func (s *Server) callOneMCPDiscoveryTool(r *http.Request, apiKeyID string, authCtx *store.AuthContext, candidate MCPCandidate, query string) MCPEvidence {
	args := map[string]any{"query": query, "top_k": candidate.MaxResults}
	rawArgs, _ := json.Marshal(args)
	route := mcpRoute{upstreamID: candidate.UpstreamID, upstreamName: candidate.UpstreamName, bareTool: candidate.ToolName}
	if resp := s.enforceMCPToolGovernance(r, apiKeyID, authCtx, route, candidate.ToolName, rawArgs, json.RawMessage("null")); resp != nil {
		msg := "blocked by governance"
		if resp.Error != nil {
			msg = resp.Error.Message
		}
		return MCPEvidence{UpstreamID: candidate.UpstreamID, UpstreamName: candidate.UpstreamName, ToolName: candidate.ToolName, SelectorScore: candidate.SelectorScore, Error: msg}
	}
	up, found, err := s.db.GetMCPUpstream(r.Context(), candidate.UpstreamID)
	if err != nil || !found || !up.Enabled {
		return MCPEvidence{UpstreamID: candidate.UpstreamID, UpstreamName: candidate.UpstreamName, ToolName: candidate.ToolName, SelectorScore: candidate.SelectorScore, Error: "upstream unavailable"}
	}
	timeout := time.Duration(firstPositive(candidate.TimeoutMS, 5000)) * time.Millisecond
	callCtx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	start := time.Now()
	result, err := s.callUpstream(callCtx, up, "tools/call", map[string]any{"name": candidate.ToolName, "arguments": args})
	latency := time.Since(start).Milliseconds()
	if err != nil {
		s.logMCPCall(r, apiKeyID, candidate.UpstreamName, candidate.ToolName, rawArgs, true, http.StatusBadGateway, latency)
		return MCPEvidence{UpstreamID: candidate.UpstreamID, UpstreamName: candidate.UpstreamName, ToolName: candidate.ToolName, SelectorScore: candidate.SelectorScore, Error: err.Error(), LatencyMS: latency}
	}
	items, toolErr := extractMCPResultItems(result)
	isErr := toolErr != ""
	s.logMCPCall(r, apiKeyID, candidate.UpstreamName, candidate.ToolName, rawArgs, isErr, http.StatusOK, latency)
	evidence := MCPEvidence{
		UpstreamID:    candidate.UpstreamID,
		UpstreamName:  candidate.UpstreamName,
		ToolName:      candidate.ToolName,
		Items:         items,
		SelectorScore: candidate.SelectorScore,
		SourceCount:   len(items),
		Error:         toolErr,
		LatencyMS:     latency,
	}
	evidence.EvidenceScore = roundScore(scoreMCPEvidence(candidate, evidence))
	return evidence
}

func extractMCPResultItems(raw json.RawMessage) ([]MCPResultItem, string) {
	var parsed struct {
		Content []struct {
			Type  string  `json:"type"`
			Text  string  `json:"text"`
			Title string  `json:"title"`
			URI   string  `json:"uri"`
			Score float64 `json:"score"`
		} `json:"content"`
		Results []MCPResultItem `json:"results"`
		IsError bool            `json:"isError"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		text := strings.TrimSpace(string(raw))
		if text == "" {
			return nil, "empty MCP result"
		}
		return []MCPResultItem{{Text: truncateText(text, 1200)}}, ""
	}
	if parsed.IsError {
		return nil, "MCP tool returned isError"
	}
	items := []MCPResultItem{}
	for _, item := range parsed.Content {
		if strings.TrimSpace(item.Text) == "" && strings.TrimSpace(item.URI) == "" {
			continue
		}
		items = append(items, MCPResultItem{Title: item.Title, URI: item.URI, Text: truncateText(item.Text, 1200), Score: item.Score})
	}
	for _, item := range parsed.Results {
		item.Text = truncateText(item.Text, 1200)
		if strings.TrimSpace(item.Text) != "" || strings.TrimSpace(item.URI) != "" {
			items = append(items, item)
		}
	}
	if len(items) == 0 {
		return nil, "no textual evidence"
	}
	return items, ""
}

func renderMCPDiscoveryAnswer(policy MCPDiscoveryPolicy, candidates []MCPCandidate, evidences []MCPEvidence) string {
	if len(candidates) == 0 {
		return "확인 가능한 MCP 후보가 없습니다. 등록된 MCP의 enabled 상태, metadata domains/allowed_models/default_tool 설정, 그리고 MCP 정책 allowlist를 확인해 주세요."
	}
	if len(evidences) == 0 {
		names := candidateIDs(candidates)
		return "선택된 MCP 후보(" + strings.Join(names, ", ") + ")에서 evidence score 기준을 넘는 근거를 찾지 못했습니다. 일반 LLM 추정 답변은 비활성화되어 있습니다."
	}
	var b strings.Builder
	b.WriteString("MCP 근거 기반 응답입니다.\n\n")
	b.WriteString("선택 정책: ")
	b.WriteString(policy.Model)
	b.WriteString(" / ")
	b.WriteString(policy.Mode)
	b.WriteString("\n\n")
	for i, evidence := range evidences {
		b.WriteString(fmt.Sprintf("%d. %s / %s (evidence %.2f)\n", i+1, evidence.UpstreamName, evidence.ToolName, evidence.EvidenceScore))
		for j, item := range evidence.Items {
			if j >= 3 {
				break
			}
			line := strings.TrimSpace(item.Text)
			if line == "" {
				line = item.URI
			}
			if item.Title != "" {
				b.WriteString("   - ")
				b.WriteString(item.Title)
				b.WriteString(": ")
			} else {
				b.WriteString("   - ")
			}
			b.WriteString(truncateText(line, 500))
			if item.URI != "" {
				b.WriteString(" (")
				b.WriteString(item.URI)
				b.WriteString(")")
			}
			b.WriteString("\n")
		}
	}
	return b.String()
}

func writeMCPDiscoveryCompletion(w http.ResponseWriter, model, content string, evidences []MCPEvidence) {
	resp := map[string]any{
		"id":      "chatcmpl-" + newID("mcp"),
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   model,
		"choices": []map[string]any{{
			"index":         0,
			"message":       map[string]any{"role": "assistant", "content": content},
			"finish_reason": "stop",
		}},
		"usage":    map[string]any{"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
		"evidence": evidences,
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Task-Type", "mcp_discovery")
	_ = json.NewEncoder(w).Encode(resp)
}

func defaultedMCPMetadata(up store.MCPUpstream) store.MCPUpstreamMetadata {
	meta := up.Metadata
	if meta.Description == "" {
		meta.Description = up.Name
	}
	if len(meta.Domains) == 0 {
		meta.Domains = inferMCPDomains(up.ID + " " + up.Name + " " + meta.Description)
	}
	if meta.RiskLevel == "" {
		meta.RiskLevel = "low"
	}
	if meta.DefaultTool == "" {
		meta.DefaultTool = "search"
	}
	return meta
}

func inferMCPDomains(text string) []string {
	lower := strings.ToLower(text)
	domains := []string{}
	for domain, keys := range map[string][]string{
		"policy":     {"policy", "hr", "work", "rule", "사규", "복무", "휴가", "근태"},
		"legal":      {"legal", "law", "contract", "법률", "법무", "계약"},
		"security":   {"security", "vulnerability", "secret", "보안", "취약점"},
		"compliance": {"compliance", "audit", "governance", "감사", "준법"},
		"research":   {"research", "search", "paper", "web", "리서치", "검색"},
	} {
		for _, key := range keys {
			if strings.Contains(lower, key) {
				domains = append(domains, domain)
				break
			}
		}
	}
	if len(domains) == 0 {
		return []string{"general"}
	}
	sort.Strings(domains)
	return domains
}

func mcpModelAllowed(model string, allowed []string) bool {
	if len(allowed) == 0 {
		return true
	}
	model = strings.ToLower(strings.TrimSpace(model))
	for _, pattern := range allowed {
		if wildcardMatch(strings.ToLower(strings.TrimSpace(pattern)), model) {
			return true
		}
	}
	return false
}

func mcpRiskAllowed(risk string, policy MCPDiscoveryPolicy) bool {
	switch strings.ToLower(strings.TrimSpace(risk)) {
	case "high", "critical":
		return policy.AllowHighRiskTools
	default:
		return true
	}
}

func mcpDomainMatches(model string, domains []string, query string) bool {
	targets := targetDomainsForMCPModel(model)
	if len(targets) == 0 {
		return true
	}
	for _, domain := range domains {
		if targets[strings.ToLower(domain)] {
			return true
		}
	}
	return false
}

func targetDomainsForMCPModel(model string) map[string]bool {
	switch strings.ToLower(strings.TrimSpace(model)) {
	case "vibe/policy":
		return map[string]bool{"policy": true, "hr": true, "work_rule": true, "legal": true, "security": true}
	case "vibe/legal":
		return map[string]bool{"legal": true, "policy": true, "security": true}
	case "vibe/compliance":
		return map[string]bool{"legal": true, "policy": true, "security": true, "compliance": true, "audit": true}
	default:
		return nil
	}
}

func pickMCPDiscoveryTool(tools []mcpToolDef, defaultTool string) (mcpToolDef, bool) {
	if len(tools) == 0 {
		return mcpToolDef{}, false
	}
	defaultTool = strings.ToLower(strings.TrimSpace(defaultTool))
	if defaultTool != "" {
		for _, tool := range tools {
			name := strings.ToLower(tool.Name)
			if name == defaultTool || strings.HasSuffix(name, "__"+defaultTool) {
				return tool, true
			}
		}
	}
	for _, want := range []string{"search", "query", "retrieve", "find", "lookup"} {
		for _, tool := range tools {
			name := strings.ToLower(tool.Name)
			if name == want || strings.HasSuffix(name, "__"+want) || strings.Contains(name, want) {
				return tool, true
			}
		}
	}
	return tools[0], true
}

func scoreMCPRelevance(query string, up store.MCPUpstream, meta store.MCPUpstreamMetadata, tool mcpToolDef) float64 {
	queryTokens := tokenSet(query)
	if len(queryTokens) == 0 {
		return 0
	}
	haystack := strings.Join([]string{up.ID, up.Name, meta.Description, strings.Join(meta.Domains, " "), tool.Name, tool.Description}, " ")
	hayTokens := tokenSet(haystack)
	overlap := 0
	for token := range queryTokens {
		if hayTokens[token] {
			overlap++
		}
	}
	score := float64(overlap) / math.Max(1, float64(len(queryTokens)))
	for _, domain := range meta.Domains {
		if queryTokens[strings.ToLower(domain)] {
			score += 0.20
		}
	}
	if strings.Contains(strings.ToLower(tool.Name), "search") || strings.Contains(strings.ToLower(tool.Description), "search") {
		score += 0.05
	}
	if score > 1 {
		return 1
	}
	return score
}

func scoreMCPEvidence(candidate MCPCandidate, evidence MCPEvidence) float64 {
	if evidence.Error != "" || len(evidence.Items) == 0 {
		return 0
	}
	resultScore := 0.35
	if len(evidence.Items) > 1 {
		resultScore = 0.45
	}
	sourceScore := 0.10
	for _, item := range evidence.Items {
		if item.URI != "" || item.Title != "" {
			sourceScore = 0.20
			break
		}
	}
	score := candidate.SelectorScore*0.25 + resultScore + sourceScore + candidate.HealthScore*0.10 + 0.10
	if score > 1 {
		return 1
	}
	return score
}

func mcpHealthScoreFromSnapshot(snap *mcpToolsSnapshot, up store.MCPUpstream) float64 {
	if snap == nil {
		return 0.5
	}
	if snap.errors[up.Name] != "" || snap.errors[up.ID] != "" {
		return 0.4
	}
	return 1
}

func tokenSet(text string) map[string]bool {
	out := map[string]bool{}
	var b strings.Builder
	flush := func() {
		if b.Len() == 0 {
			return
		}
		token := strings.ToLower(b.String())
		b.Reset()
		if len([]rune(token)) < 2 || mcpStopwords[token] {
			return
		}
		out[token] = true
	}
	for _, r := range text {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(unicode.ToLower(r))
		} else {
			flush()
		}
	}
	flush()
	return out
}

var mcpStopwords = map[string]bool{
	"the": true, "and": true, "for": true, "with": true, "from": true, "this": true, "that": true,
	"what": true, "how": true, "can": true, "are": true, "is": true, "to": true, "of": true,
	"내": true, "우리": true, "어떻게": true, "무엇": true, "대한": true, "관련": true,
}

func wildcardMatch(pattern, value string) bool {
	if pattern == "" || pattern == "*" {
		return true
	}
	if !strings.Contains(pattern, "*") {
		return pattern == value
	}
	parts := strings.Split(pattern, "*")
	pos := 0
	for i, part := range parts {
		if part == "" {
			continue
		}
		idx := strings.Index(value[pos:], part)
		if idx < 0 {
			return false
		}
		if i == 0 && !strings.HasPrefix(value, part) {
			return false
		}
		pos += idx + len(part)
	}
	last := parts[len(parts)-1]
	return last == "" || strings.HasSuffix(value, last)
}

func firstPositive(values ...int) int {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}

func roundScore(v float64) float64 {
	return math.Round(v*100) / 100
}

func truncateText(text string, max int) string {
	text = strings.Join(strings.Fields(text), " ")
	if max <= 0 || len(text) <= max {
		return text
	}
	if max <= 3 {
		return text[:max]
	}
	return strings.TrimSpace(text[:max-3]) + "..."
}

func candidateIDs(candidates []MCPCandidate) []string {
	out := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		out = append(out, candidate.UpstreamID+"/"+candidate.ToolName)
	}
	return out
}
