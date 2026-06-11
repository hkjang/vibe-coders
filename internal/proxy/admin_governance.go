package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

var governanceConditionKeys = map[string]bool{
	"user": true, "user_id": true, "team": true, "team_id": true, "role": true,
	"team_name": true, "model": true, "provider": true, "endpoint": true, "risk_score": true,
	"complexity_score": true, "cost": true, "cost_krw": true, "contains_secret": true,
	"secret_type": true, "mcp_server": true, "mcp_tool": true,
}

var governanceActionKeys = map[string]bool{
	"block": true, "require_approval": true, "secret_action": true, "allow_models": true,
	"deny_models": true, "allow_providers": true, "deny_providers": true,
}

func (s *Server) handlePolicies(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		policies, err := s.db.ListPolicies(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "policies_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"policies": policies})
	case http.MethodPost:
		policy, rules, err := decodePolicyPayload(r.Body)
		if err != nil {
			writeOpenAIError(w, http.StatusBadRequest, err.Error(), "invalid_request_error", "invalid_policy")
			return
		}
		if err := s.db.UpsertPolicyWithRules(r.Context(), policy, rules); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "policy_save_failed")
			return
		}
		policy.Rules = rules
		s.auditAdmin(r, "governance.policy.upsert", "", auditJSON(policy))
		writeJSON(w, http.StatusCreated, map[string]any{"policy": policy})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) handlePolicyDecisions(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	filter := policyDecisionFilterFromRequest(r)
	events, err := s.db.ListPolicyDecisionEventsFiltered(r.Context(), filter)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "policy_decisions_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"policy_decisions": events,
		"count":            len(events),
		"filters": map[string]any{
			"request_id": filter.RequestID,
			"api_key_id": filter.APIKeyID,
			"user_id":    filter.UserID,
			"team_id":    filter.TeamID,
			"endpoint":   filter.Endpoint,
			"phase":      filter.Phase,
			"policy_id":  filter.PolicyID,
			"rule_id":    filter.RuleID,
			"decision":   filter.Decision,
			"model":      filter.Model,
			"provider":   filter.Provider,
			"since":      formatFilterSince(filter.Since),
			"limit":      filter.Limit,
		},
	})
}

func policyDecisionFilterFromRequest(r *http.Request) store.PolicyDecisionFilter {
	q := r.URL.Query()
	filter := store.PolicyDecisionFilter{
		Limit:     recentLimit(r),
		RequestID: strings.TrimSpace(q.Get("request_id")),
		APIKeyID:  strings.TrimSpace(q.Get("api_key_id")),
		UserID:    strings.TrimSpace(q.Get("user_id")),
		TeamID:    strings.TrimSpace(q.Get("team_id")),
		Endpoint:  strings.TrimSpace(q.Get("endpoint")),
		Phase:     strings.TrimSpace(q.Get("phase")),
		PolicyID:  strings.TrimSpace(q.Get("policy_id")),
		RuleID:    strings.TrimSpace(q.Get("rule_id")),
		Decision:  strings.TrimSpace(q.Get("decision")),
		Model:     strings.TrimSpace(q.Get("model")),
		Provider:  strings.TrimSpace(q.Get("provider")),
	}
	if raw := strings.TrimSpace(q.Get("since")); raw != "" {
		if parsed, err := time.Parse(time.RFC3339, raw); err == nil {
			filter.Since = parsed
		} else if parsed, err := time.Parse(time.RFC3339Nano, raw); err == nil {
			filter.Since = parsed
		}
	}
	if filter.Since.IsZero() && strings.TrimSpace(q.Get("window")) != "" {
		filter.Since = parseWindow(q.Get("window"), 24*time.Hour, "hour")
	}
	return filter
}

func formatFilterSince(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339)
}

func (s *Server) handleApprovals(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	if _, err := s.db.ExpireApprovals(r.Context(), time.Now().UTC()); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "approvals_expire_failed")
		return
	}
	filter := approvalFilterFromRequest(r)
	approvals, err := s.db.ListApprovalsFiltered(r.Context(), filter)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "approvals_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"approvals": approvals,
		"count":     len(approvals),
		"filters": map[string]any{
			"id":           filter.ID,
			"request_id":   filter.RequestID,
			"api_key_id":   filter.APIKeyID,
			"user_id":      filter.UserID,
			"team_id":      filter.TeamID,
			"subject_type": filter.SubjectType,
			"subject_id":   filter.SubjectID,
			"status":       filter.Status,
			"decided_by":   filter.DecidedBy,
			"reason":       filter.Reason,
			"since":        formatFilterSince(filter.Since),
			"limit":        filter.Limit,
		},
	})
}

func approvalFilterFromRequest(r *http.Request) store.ApprovalFilter {
	q := r.URL.Query()
	filter := store.ApprovalFilter{
		Limit:       recentLimit(r),
		ID:          strings.TrimSpace(q.Get("id")),
		RequestID:   strings.TrimSpace(q.Get("request_id")),
		APIKeyID:    strings.TrimSpace(q.Get("api_key_id")),
		UserID:      strings.TrimSpace(q.Get("user_id")),
		TeamID:      strings.TrimSpace(q.Get("team_id")),
		SubjectType: strings.TrimSpace(q.Get("subject_type")),
		SubjectID:   strings.TrimSpace(q.Get("subject_id")),
		Status:      strings.TrimSpace(q.Get("status")),
		DecidedBy:   strings.TrimSpace(q.Get("decided_by")),
		Reason:      strings.TrimSpace(q.Get("reason")),
	}
	if raw := strings.TrimSpace(q.Get("since")); raw != "" {
		if parsed, err := time.Parse(time.RFC3339, raw); err == nil {
			filter.Since = parsed
		} else if parsed, err := time.Parse(time.RFC3339Nano, raw); err == nil {
			filter.Since = parsed
		}
	}
	if filter.Since.IsZero() && strings.TrimSpace(q.Get("window")) != "" {
		filter.Since = parseWindow(q.Get("window"), 24*time.Hour, "hour")
	}
	return filter
}

func (s *Server) handleApprovalDecision(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/admin/approvals/"), "/")
	parts := strings.Split(rest, "/")
	if len(parts) != 2 || parts[0] == "" {
		writeOpenAIError(w, http.StatusBadRequest, "invalid approval path", "invalid_request_error", "invalid_approval")
		return
	}
	status := ""
	switch parts[1] {
	case "approve":
		status = "approved"
	case "reject":
		status = "rejected"
	default:
		writeOpenAIError(w, http.StatusNotFound, "not found", "invalid_request_error", "not_found")
		return
	}
	if _, err := s.db.ExpireApprovals(r.Context(), time.Now().UTC()); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "approval_expire_failed")
		return
	}
	approval, found, err := s.db.GetApproval(r.Context(), parts[0])
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "approval_lookup_failed")
		return
	}
	if !found {
		writeOpenAIError(w, http.StatusNotFound, "approval not found", "invalid_request_error", "approval_not_found")
		return
	}
	if approval.Status != "pending" {
		writeOpenAIError(w, http.StatusConflict, "approval is not pending: "+approval.Status, "invalid_request_error", "approval_not_pending")
		return
	}
	updated, err := s.db.SetPendingApprovalStatus(r.Context(), parts[0], status, adminID(r))
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "approval_update_failed")
		return
	}
	if !updated {
		writeOpenAIError(w, http.StatusConflict, "approval is not pending", "invalid_request_error", "approval_not_pending")
		return
	}
	approval, _, _ = s.db.GetApproval(r.Context(), parts[0])
	s.auditAdmin(r, "governance.approval."+status, "", auditJSON(approval))
	writeJSON(w, http.StatusOK, map[string]any{"approval": approval})
}

func (s *Server) handleSecretEvents(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodGet {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	filter := secretEventFilterFromRequest(r)
	events, err := s.db.ListSecretEventsFiltered(r.Context(), filter)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "secret_events_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"secret_events": events,
		"count":         len(events),
		"filters": map[string]any{
			"request_id":   filter.RequestID,
			"api_key_id":   filter.APIKeyID,
			"user_id":      filter.UserID,
			"team_id":      filter.TeamID,
			"secret_type":  filter.SecretType,
			"action":       filter.Action,
			"location":     filter.Location,
			"matched_hash": filter.MatchedHash,
			"since":        formatFilterSince(filter.Since),
			"limit":        filter.Limit,
		},
	})
}

func secretEventFilterFromRequest(r *http.Request) store.SecretEventFilter {
	q := r.URL.Query()
	filter := store.SecretEventFilter{
		Limit:       recentLimit(r),
		RequestID:   strings.TrimSpace(q.Get("request_id")),
		APIKeyID:    strings.TrimSpace(q.Get("api_key_id")),
		UserID:      strings.TrimSpace(q.Get("user_id")),
		TeamID:      strings.TrimSpace(q.Get("team_id")),
		SecretType:  strings.TrimSpace(q.Get("secret_type")),
		Action:      strings.TrimSpace(q.Get("action")),
		Location:    strings.TrimSpace(q.Get("location")),
		MatchedHash: strings.TrimSpace(q.Get("matched_hash")),
	}
	if raw := strings.TrimSpace(q.Get("since")); raw != "" {
		if parsed, err := time.Parse(time.RFC3339, raw); err == nil {
			filter.Since = parsed
		} else if parsed, err := time.Parse(time.RFC3339Nano, raw); err == nil {
			filter.Since = parsed
		}
	}
	if filter.Since.IsZero() && strings.TrimSpace(q.Get("window")) != "" {
		filter.Since = parseWindow(q.Get("window"), 24*time.Hour, "hour")
	}
	return filter
}

func (s *Server) handleReplay(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method == http.MethodGet {
		jobs, err := s.db.ListReplayJobs(r.Context(), recentLimit(r))
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "replay_jobs_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"jobs": jobs})
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var payload struct {
		SourceRequestID string   `json:"source_request_id"`
		Prompt          string   `json:"prompt"`
		Models          []string `json:"models"`
		Execute         *bool    `json:"execute"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	payload.Prompt = strings.TrimSpace(payload.Prompt)
	if payload.Prompt == "" && strings.TrimSpace(payload.SourceRequestID) != "" {
		_, raw, found, _ := s.db.RequestRawBody(r.Context(), strings.TrimSpace(payload.SourceRequestID))
		if found {
			payload.Prompt = raw
		}
	}
	if payload.Prompt == "" {
		writeOpenAIError(w, http.StatusBadRequest, "prompt or source_request_id with raw body is required", "invalid_request_error", "missing_prompt")
		return
	}
	if len(payload.Models) == 0 {
		writeOpenAIError(w, http.StatusBadRequest, "models is required", "invalid_request_error", "missing_models")
		return
	}
	job := store.ReplayJob{
		ID:              newID("replay"),
		SourceRequestID: strings.TrimSpace(payload.SourceRequestID),
		Prompt:          payload.Prompt,
		Models:          payload.Models,
		Status:          "pending",
		CreatedBy:       adminID(r),
		CreatedAt:       time.Now().UTC(),
	}
	execute := true
	if payload.Execute != nil {
		execute = *payload.Execute
	}
	if execute {
		job.Status = "running"
	}
	if err := s.db.InsertReplayJob(r.Context(), job); err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "replay_create_failed")
		return
	}
	results := []governanceRunResult{}
	if execute {
		allFailed := true
		for _, model := range normalizeModelList(payload.Models) {
			run := s.runGovernanceChat(r.Context(), r, model, payload.Prompt)
			if run.Error == "" && run.StatusCode >= 200 && run.StatusCode < 300 {
				allFailed = false
			}
			results = append(results, run)
		}
		job.Status = "completed"
		if allFailed {
			job.Status = "failed"
		}
		job.Results = auditJSON(results)
		if err := s.db.UpdateReplayJob(r.Context(), job.ID, job.Status, job.Results); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "replay_update_failed")
			return
		}
	}
	s.auditAdmin(r, "governance.replay.create", "", auditJSON(map[string]any{"id": job.ID, "models": job.Models}))
	writeJSON(w, http.StatusCreated, map[string]any{"job": job, "results": results})
}

func (s *Server) handleGoldenPrompts(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		prompts, err := s.db.ListGoldenPrompts(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "golden_prompts_failed")
			return
		}
		results, err := s.db.ListGoldenPromptResults(r.Context(), strings.TrimSpace(r.URL.Query().Get("prompt_id")), recentLimit(r))
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "golden_results_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"golden_prompts": prompts, "results": results})
	case http.MethodPost:
		var payload struct {
			ID       string   `json:"id"`
			Name     string   `json:"name"`
			Prompt   string   `json:"prompt"`
			Expected string   `json:"expected"`
			Tags     []string `json:"tags"`
			Models   []string `json:"models"`
			Run      bool     `json:"run"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		p := store.GoldenPrompt{ID: payload.ID, Name: payload.Name, Prompt: payload.Prompt, Expected: payload.Expected, Tags: payload.Tags}
		if p.ID == "" {
			p.ID = newID("golden")
		}
		p.Name = strings.TrimSpace(p.Name)
		p.Prompt = strings.TrimSpace(p.Prompt)
		if p.Name == "" || p.Prompt == "" {
			writeOpenAIError(w, http.StatusBadRequest, "name and prompt are required", "invalid_request_error", "missing_golden_prompt")
			return
		}
		models := normalizeModelList(payload.Models)
		if payload.Run && len(models) == 0 {
			writeOpenAIError(w, http.StatusBadRequest, "models is required when run=true", "invalid_request_error", "missing_models")
			return
		}
		if err := s.db.UpsertGoldenPrompt(r.Context(), p); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "golden_prompt_save_failed")
			return
		}
		runResults := []store.GoldenPromptResult{}
		if payload.Run || len(payload.Models) > 0 {
			if len(models) == 0 {
				writeOpenAIError(w, http.StatusBadRequest, "models is required when run=true", "invalid_request_error", "missing_models")
				return
			}
			for _, model := range models {
				run := s.runGovernanceChat(r.Context(), r, model, p.Prompt)
				score, passed := scoreGoldenResponse(p.Expected, run.Response)
				if run.Error != "" {
					passed = false
				}
				result := store.GoldenPromptResult{
					ID:        newID("gpr"),
					PromptID:  p.ID,
					Model:     model,
					Score:     score,
					Passed:    passed,
					CostKRW:   run.CostKRW,
					LatencyMS: run.LatencyMS,
					Response:  run.Response,
					CreatedAt: time.Now().UTC(),
				}
				if run.Error != "" {
					result.Response = "ERROR: " + run.Error
				}
				if err := s.db.InsertGoldenPromptResult(r.Context(), result); err != nil {
					writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "golden_result_save_failed")
					return
				}
				runResults = append(runResults, result)
			}
		}
		s.auditAdmin(r, "governance.golden.upsert", "", auditJSON(map[string]any{"id": p.ID, "name": p.Name}))
		writeJSON(w, http.StatusCreated, map[string]any{"golden_prompt": p, "results": runResults})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func (s *Server) handleContexts(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		contexts, err := s.db.ListContextRegistry(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "contexts_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"contexts": contexts})
	case http.MethodPost:
		var c store.ContextRegistryEntry
		if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		if c.ID == "" {
			c.ID = newID("ctx")
		}
		c.Key = strings.TrimSpace(c.Key)
		c.Name = strings.TrimSpace(c.Name)
		c.Content = strings.TrimSpace(c.Content)
		if c.Key == "" || c.Name == "" || c.Content == "" {
			writeOpenAIError(w, http.StatusBadRequest, "key, name and content are required", "invalid_request_error", "missing_context")
			return
		}
		if !c.Enabled {
			c.Enabled = true
		}
		if c.TokenEstimate == 0 {
			c.TokenEstimate = audit.EstimateTokens(c.Content)
		}
		if err := s.db.UpsertContextRegistry(r.Context(), c); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "context_save_failed")
			return
		}
		s.auditAdmin(r, "governance.context.upsert", "", auditJSON(map[string]any{"id": c.ID, "key": c.Key}))
		writeJSON(w, http.StatusCreated, map[string]any{"context": c})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

func decodePolicyPayload(body io.Reader) (store.Policy, []store.PolicyRule, error) {
	var raw map[string]any
	dec := json.NewDecoder(body)
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil {
		return store.Policy{}, nil, err
	}
	id := strings.TrimSpace(toString(raw["id"]))
	if id == "" {
		id = newID("pol")
	}
	enabled := true
	if v, ok := raw["enabled"]; ok {
		enabled = boolAction(v)
	}
	policy := store.Policy{
		ID:          id,
		Name:        strings.TrimSpace(toString(raw["name"])),
		Description: strings.TrimSpace(toString(raw["description"])),
		Enabled:     enabled,
		Priority:    intFromAny(raw["priority"], 100),
		CreatedAt:   time.Now().UTC(),
	}
	if policy.Name == "" {
		policy.Name = policy.ID
	}
	rules := []store.PolicyRule{}
	if rawRules, ok := raw["rules"].([]any); ok {
		for _, item := range rawRules {
			ruleMap, ok := item.(map[string]any)
			if !ok {
				continue
			}
			rules = append(rules, decodePolicyRuleMap(policy.ID, ruleMap))
		}
	} else {
		rule := decodePolicyRuleMap(policy.ID, raw)
		if len(rule.Conditions) > 0 || len(rule.Actions) > 0 {
			rules = append(rules, rule)
		}
	}
	return policy, rules, nil
}

func decodePolicyRuleMap(policyID string, raw map[string]any) store.PolicyRule {
	id := strings.TrimSpace(toString(raw["id"]))
	if id == "" {
		id = newID("prule")
	}
	enabled := true
	if v, ok := raw["enabled"]; ok {
		enabled = boolAction(v)
	}
	conditions := mapFromAny(raw["conditions"])
	actions := mapFromAny(raw["actions"])
	for key, value := range raw {
		lower := strings.ToLower(strings.TrimSpace(key))
		if governanceConditionKeys[lower] {
			conditions[lower] = value
		}
		if governanceActionKeys[lower] {
			actions[lower] = value
		}
	}
	return store.PolicyRule{
		ID:         id,
		PolicyID:   policyID,
		Name:       strings.TrimSpace(toString(raw["name"])),
		Enabled:    enabled,
		Priority:   intFromAny(raw["priority"], 100),
		Conditions: conditions,
		Actions:    actions,
		CreatedAt:  time.Now().UTC(),
	}
}

func mapFromAny(value any) map[string]any {
	out := map[string]any{}
	if raw, ok := value.(map[string]any); ok {
		for key, item := range raw {
			out[strings.ToLower(strings.TrimSpace(key))] = item
		}
	}
	return out
}

func intFromAny(value any, fallback int) int {
	switch v := value.(type) {
	case int:
		return v
	case float64:
		if v != 0 {
			return int(v)
		}
	case json.Number:
		if n, err := v.Int64(); err == nil && n != 0 {
			return int(n)
		}
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n != 0 {
			return n
		}
	}
	return fallback
}

func normalizeModelList(models []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, model := range models {
		model = strings.TrimSpace(model)
		if model == "" || seen[model] {
			continue
		}
		seen[model] = true
		out = append(out, model)
	}
	return out
}
