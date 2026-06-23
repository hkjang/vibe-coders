package proxy

import (
	"encoding/json"
	"fmt"
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
	"deny_models": true, "allow_providers": true, "deny_providers": true, "allow": true,
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

// handlePolicyExport returns all policies (with rules) as a portable JSON document for
// GitOps — commit it to a repo, review changes as a diff, and re-import.
// GET /admin/policies/export
func (s *Server) handlePolicyExport(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	policies, err := s.db.ListPolicies(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "policies_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"version": 1, "count": len(policies), "policies": policies})
}

// handlePolicyImport applies an exported policy document. With ?dry_run=1 it reports the
// plan (which policies would be created vs updated, and rule counts) without writing —
// the GitOps "plan" step. Without it, the policies are upserted.
// POST /admin/policies/import[?dry_run=1] {policies:[...]}
func (s *Server) handlePolicyImport(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var payload struct {
		Policies []store.Policy `json:"policies"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	if len(payload.Policies) == 0 {
		writeOpenAIError(w, http.StatusBadRequest, "no policies in payload", "invalid_request_error", "empty_payload")
		return
	}
	existing, err := s.db.ListPolicies(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "policies_failed")
		return
	}
	existingIDs := map[string]bool{}
	for _, p := range existing {
		existingIDs[p.ID] = true
	}
	dryRun := r.URL.Query().Get("dry_run") == "1"
	plan := []map[string]any{}
	created, updated := 0, 0
	for _, p := range payload.Policies {
		if strings.TrimSpace(p.ID) == "" || strings.TrimSpace(p.Name) == "" {
			writeOpenAIError(w, http.StatusBadRequest, "each policy needs id and name", "invalid_request_error", "invalid_policy")
			return
		}
		action := "create"
		if existingIDs[p.ID] {
			action = "update"
			updated++
		} else {
			created++
		}
		plan = append(plan, map[string]any{"id": p.ID, "name": p.Name, "action": action, "rules": len(p.Rules)})
		if !dryRun {
			if err := s.db.UpsertPolicyWithRules(r.Context(), p, p.Rules); err != nil {
				writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "policy_import_failed")
				return
			}
		}
	}
	if !dryRun {
		s.auditAdmin(r, "governance.policy.import", "", auditJSON(map[string]any{"created": created, "updated": updated}))
	}
	writeJSON(w, http.StatusOK, map[string]any{"dry_run": dryRun, "created": created, "updated": updated, "plan": plan})
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

// handlePolicySimulate replays a candidate rule set against recent request
// contexts and reports how many would be blocked / require approval / allowed —
// a dry-run preview before the rules are saved.
// POST /admin/policies/simulate {rules:[{name,conditions,actions}], window?, limit?}
// Optionally {policy_id} to simulate an existing policy's saved rules.
func (s *Server) handlePolicySimulate(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var payload struct {
		Rules []struct {
			Name       string         `json:"name"`
			Conditions map[string]any `json:"conditions"`
			Actions    map[string]any `json:"actions"`
		} `json:"rules"`
		PolicyID string `json:"policy_id"`
		Window   string `json:"window"`
		Limit    int    `json:"limit"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}

	rules := make([]store.PolicyRule, 0, len(payload.Rules))
	for i, rr := range payload.Rules {
		rules = append(rules, store.PolicyRule{
			ID: "sim-" + itoaProxy(i), Name: firstNonEmpty(rr.Name, "sim-rule-"+itoaProxy(i)),
			Conditions: rr.Conditions, Actions: rr.Actions,
		})
	}
	// Fall back to an existing policy's active rules when no inline rules are given.
	if len(rules) == 0 && strings.TrimSpace(payload.PolicyID) != "" {
		all, err := s.db.ActivePolicyRules(r.Context())
		if err == nil {
			for _, rule := range all {
				if rule.PolicyID == payload.PolicyID {
					rules = append(rules, rule)
				}
			}
		}
	}
	if len(rules) == 0 {
		writeOpenAIError(w, http.StatusBadRequest, "provide rules[] or a policy_id to simulate", "invalid_request_error", "no_rules")
		return
	}

	since := parseWindow(payload.Window, 7*24*time.Hour, "day")
	contexts, err := s.db.GovernanceSimContexts(r.Context(), since, payload.Limit)
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "policy_sim_failed")
		return
	}

	var blocked, approval, allowed int
	sampleBlocked := []map[string]any{}
	// Shadow-enforcement impact: who is affected, likely false positives, and cost impact.
	affectedKeys := map[string]bool{}
	affectedTeams := map[string]bool{}
	var falsePositives int  // blocked but the request historically succeeded (2xx)
	var blockedCost float64 // cost of requests that would now be blocked
	fpSample := []map[string]any{}
	for _, c := range contexts {
		gctx := governanceContext{
			APIKeyID: c.APIKeyID, TeamID: c.TeamID, Model: c.Model, Provider: c.Provider,
			ComplexityScore: c.ComplexityScore, RiskScore: c.RiskScore,
		}
		d := evaluatePolicyRules(rules, gctx)
		switch {
		case d.Blocked:
			blocked++
			blockedCost += c.CostKRW
			if c.APIKeyID != "" {
				affectedKeys[c.APIKeyID] = true
			}
			if c.TeamID != "" {
				affectedTeams[c.TeamID] = true
			}
			// A historically successful request the policy would now block = false-positive candidate.
			if c.StatusCode >= 200 && c.StatusCode < 300 {
				falsePositives++
				if len(fpSample) < 20 {
					fpSample = append(fpSample, map[string]any{
						"api_key_id": c.APIKeyID, "team_id": c.TeamID, "model": c.Model,
						"provider": c.Provider, "status_code": c.StatusCode, "reason": d.Reason,
					})
				}
			}
			if len(sampleBlocked) < 20 {
				sampleBlocked = append(sampleBlocked, map[string]any{
					"api_key_id": c.APIKeyID, "model": c.Model, "provider": c.Provider,
					"risk_score": c.RiskScore, "status_code": c.StatusCode, "reason": d.Reason,
				})
			}
		case d.RequireApproval:
			approval++
		default:
			allowed++
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"evaluated":        len(contexts),
		"blocked":          blocked,
		"require_approval": approval,
		"allowed":          allowed,
		"block_rate":       safeRate(blocked, len(contexts)),
		"sample_blocked":   sampleBlocked,
		"shadow": map[string]any{
			"affected_keys":             len(affectedKeys),
			"affected_teams":            len(affectedTeams),
			"false_positive_candidates": falsePositives,
			"false_positive_rate":       safeRate(falsePositives, blocked),
			"blocked_cost_krw":          blockedCost,
			"false_positive_sample":     fpSample,
		},
		"since": since.UTC().Format(time.RFC3339),
		"note":  "secret/PII conditions are not evaluated from historical logs; model/provider/complexity/risk/team conditions are. false_positive_candidates = 과거 정상(2xx)이었으나 이 규칙이 차단할 요청(오탐 후보), blocked_cost_krw = 차단될 요청들의 과거 비용 합(절감 추정).",
	})
}

func safeRate(n, total int) float64 {
	if total == 0 {
		return 0
	}
	return float64(n) / float64(total)
}

// handleGoldenRun runs every golden prompt (optionally filtered by tag) against
// the given models and reports an aggregate pass/fail — the CI regression gate.
// POST /admin/golden-prompts/run {models[], tag?, min_pass_rate?}
//
//	?fail_on_regression=1 → returns HTTP 422 when not all checks pass, so a CI
//	step using `curl --fail` (or a non-zero exit) flags the regression.
func (s *Server) handleGoldenRun(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var payload struct {
		Models      []string `json:"models"`
		Tag         string   `json:"tag"`
		MinPassRate *float64 `json:"min_pass_rate"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	models := normalizeModelList(payload.Models)
	if len(models) == 0 {
		writeOpenAIError(w, http.StatusBadRequest, "models is required", "invalid_request_error", "missing_models")
		return
	}
	prompts, err := s.db.ListGoldenPrompts(r.Context())
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "golden_prompts_failed")
		return
	}
	tag := strings.TrimSpace(payload.Tag)

	results := []store.GoldenPromptResult{}
	failures := []map[string]any{}
	total, passed := 0, 0
	for _, p := range prompts {
		if tag != "" && !containsString(p.Tags, tag) {
			continue
		}
		for _, model := range models {
			run := s.runGovernanceChat(r.Context(), r, model, p.Prompt)
			score, ok := scoreGoldenResponse(p.Expected, run.Response)
			if run.Error != "" {
				ok = false
			}
			result := store.GoldenPromptResult{
				ID: newID("gpr"), PromptID: p.ID, Model: model, Score: score, Passed: ok,
				CostKRW: run.CostKRW, LatencyMS: run.LatencyMS, Response: run.Response, CreatedAt: time.Now().UTC(),
			}
			if run.Error != "" {
				result.Response = "ERROR: " + run.Error
			}
			_ = s.db.InsertGoldenPromptResult(r.Context(), result)
			results = append(results, result)
			total++
			if ok {
				passed++
			} else {
				failures = append(failures, map[string]any{"prompt_id": p.ID, "name": p.Name, "model": model, "score": score})
			}
		}
	}

	passRate := 1.0
	if total > 0 {
		passRate = float64(passed) / float64(total)
	}
	minPassRate := 1.0
	if payload.MinPassRate != nil {
		minPassRate = *payload.MinPassRate
	}
	regressed := total > 0 && passRate < minPassRate

	s.auditAdmin(r, "governance.golden.run", "", auditJSON(map[string]any{"total": total, "passed": passed, "tag": tag, "models": models}))

	body := map[string]any{
		"total": total, "passed": passed, "failed": total - passed,
		"pass_rate": passRate, "min_pass_rate": minPassRate,
		"regressed": regressed, "failures": failures, "results": results,
	}
	status := http.StatusOK
	if regressed && strings.TrimSpace(r.URL.Query().Get("fail_on_regression")) == "1" {
		status = http.StatusUnprocessableEntity
	}
	writeJSON(w, status, body)
}

// handleGoldenWorkflows is CRUD for Golden Workflows (named, ordered golden suites).
// GET → list; POST {id?,name,description?,steps[],tags?} → upsert; DELETE ?id= → remove.
func (s *Server) handleGoldenWorkflows(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	switch r.Method {
	case http.MethodGet:
		wfs, err := s.db.ListGoldenWorkflows(r.Context())
		if err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "golden_workflows_failed")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"workflows": wfs})
	case http.MethodPost:
		var wf store.GoldenWorkflow
		if err := json.NewDecoder(r.Body).Decode(&wf); err != nil {
			writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
			return
		}
		wf.Name = strings.TrimSpace(wf.Name)
		if wf.Name == "" {
			writeOpenAIError(w, http.StatusBadRequest, "name is required", "invalid_request_error", "missing_name")
			return
		}
		cleaned := wf.Steps[:0]
		for _, step := range wf.Steps {
			step.Name = strings.TrimSpace(step.Name)
			step.Prompt = strings.TrimSpace(step.Prompt)
			if step.Prompt == "" {
				continue
			}
			cleaned = append(cleaned, step)
		}
		wf.Steps = cleaned
		if len(wf.Steps) == 0 {
			writeOpenAIError(w, http.StatusBadRequest, "at least one step with a prompt is required", "invalid_request_error", "missing_steps")
			return
		}
		if wf.ID == "" {
			wf.ID = newID("gwf")
		}
		if err := s.db.UpsertGoldenWorkflow(r.Context(), wf); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "golden_workflow_save_failed")
			return
		}
		s.auditAdmin(r, "governance.golden.workflow.upsert", wf.ID, auditJSON(map[string]any{"name": wf.Name, "steps": len(wf.Steps)}))
		writeJSON(w, http.StatusOK, wf)
	case http.MethodDelete:
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		if id == "" {
			writeOpenAIError(w, http.StatusBadRequest, "id is required", "invalid_request_error", "missing_id")
			return
		}
		if err := s.db.DeleteGoldenWorkflow(r.Context(), id); err != nil {
			writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "golden_workflow_delete_failed")
			return
		}
		s.auditAdmin(r, "governance.golden.workflow.delete", id, "")
		writeJSON(w, http.StatusOK, map[string]any{"deleted": id})
	default:
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
	}
}

// handleGoldenWorkflowRun runs a Golden Workflow's steps in order across the given
// models and reports per-step results plus an aggregate pass rate.
// POST /admin/golden-workflows/run {id, models[], min_pass_rate?}
//
//	?fail_on_regression=1 → HTTP 422 when pass_rate < min_pass_rate (CI gate).
func (s *Server) handleGoldenWorkflowRun(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "method not allowed", "invalid_request_error", "method_not_allowed")
		return
	}
	var payload struct {
		ID          string   `json:"id"`
		Models      []string `json:"models"`
		MinPassRate *float64 `json:"min_pass_rate"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid JSON body", "invalid_request_error", "invalid_body")
		return
	}
	if strings.TrimSpace(payload.ID) == "" {
		writeOpenAIError(w, http.StatusBadRequest, "id is required", "invalid_request_error", "missing_id")
		return
	}
	models := normalizeModelList(payload.Models)
	if len(models) == 0 {
		writeOpenAIError(w, http.StatusBadRequest, "models is required", "invalid_request_error", "missing_models")
		return
	}
	wf, err := s.db.GetGoldenWorkflow(r.Context(), strings.TrimSpace(payload.ID))
	if err != nil || wf.ID == "" {
		writeOpenAIError(w, http.StatusNotFound, "workflow not found", "invalid_request_error", "workflow_not_found")
		return
	}

	steps := []map[string]any{}
	failures := []map[string]any{}
	total, passed := 0, 0
	for _, model := range models {
		for idx, step := range wf.Steps {
			run := s.runGovernanceChat(r.Context(), r, model, step.Prompt)
			score, ok := scoreGoldenResponse(step.Expected, run.Response)
			if run.Error != "" {
				ok = false
			}
			stepName := step.Name
			if stepName == "" {
				stepName = fmt.Sprintf("step %d", idx+1)
			}
			steps = append(steps, map[string]any{
				"step": idx + 1, "name": stepName, "model": model,
				"score": score, "passed": ok, "cost_krw": run.CostKRW, "latency_ms": run.LatencyMS,
			})
			total++
			if ok {
				passed++
			} else {
				failures = append(failures, map[string]any{"step": idx + 1, "name": stepName, "model": model, "score": score})
			}
		}
	}

	passRate := 1.0
	if total > 0 {
		passRate = float64(passed) / float64(total)
	}
	minPassRate := 1.0
	if payload.MinPassRate != nil {
		minPassRate = *payload.MinPassRate
	}
	regressed := total > 0 && passRate < minPassRate

	s.auditAdmin(r, "governance.golden.workflow.run", wf.ID, auditJSON(map[string]any{"name": wf.Name, "total": total, "passed": passed, "models": models}))

	body := map[string]any{
		"workflow_id": wf.ID, "workflow_name": wf.Name,
		"total": total, "passed": passed, "failed": total - passed,
		"pass_rate": passRate, "min_pass_rate": minPassRate,
		"regressed": regressed, "failures": failures, "steps": steps,
	}
	status := http.StatusOK
	if regressed && strings.TrimSpace(r.URL.Query().Get("fail_on_regression")) == "1" {
		status = http.StatusUnprocessableEntity
	}
	writeJSON(w, status, body)
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

func containsString(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
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
