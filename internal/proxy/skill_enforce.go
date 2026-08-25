package proxy

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// evaluateSkillPolicy checks a request's model and declared tools against a skill's
// allowed_models / allowed_tools policy hints. Both lists are comma-separated globs;
// an empty list means "no restriction" for that dimension. It returns a human-readable
// violation message per failing item (empty slice = request complies).
func evaluateSkillPolicy(sk store.Skill, model string, tools []string, team string) []string {
	var violations []string
	if allowed := splitSkillList(sk.AllowedModels); len(allowed) > 0 && strings.TrimSpace(model) != "" {
		if !listAllows(model, allowed, nil) {
			violations = append(violations, "model '"+model+"' is not in the skill's allowed_models ("+sk.AllowedModels+")")
		}
	}
	if allowed := splitSkillList(sk.AllowedTools); len(allowed) > 0 {
		for _, t := range tools {
			if strings.TrimSpace(t) == "" {
				continue
			}
			if !listAllows(t, allowed, nil) {
				violations = append(violations, "tool '"+t+"' is not in the skill's allowed_tools ("+sk.AllowedTools+")")
			}
		}
	}
	if allowed := splitSkillList(sk.AllowedTeams); len(allowed) > 0 {
		if !listAllows(team, allowed, nil) {
			violations = append(violations, "team '"+team+"' is not in the skill's allowed_teams ("+sk.AllowedTeams+")")
		}
	}
	return violations
}

// splitSkillList splits a comma-separated policy list, trimming blanks.
func splitSkillList(csv string) []string {
	out := []string{}
	for _, p := range strings.Split(csv, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// parseRequestToolNames extracts declared tool/function names from an OpenAI chat
// completion body (both the modern `tools[].function.name` and legacy `functions[].name`).
func parseRequestToolNames(body []byte) []string {
	if len(body) == 0 {
		return nil
	}
	var req struct {
		Tools []struct {
			Function struct {
				Name string `json:"name"`
			} `json:"function"`
			Name string `json:"name"`
		} `json:"tools"`
		Functions []struct {
			Name string `json:"name"`
		} `json:"functions"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		return nil
	}
	seen := map[string]bool{}
	out := []string{}
	add := func(n string) {
		n = strings.TrimSpace(n)
		if n != "" && !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	for _, t := range req.Tools {
		add(t.Function.Name)
		add(t.Name)
	}
	for _, f := range req.Functions {
		add(f.Name)
	}
	return out
}

// injectSkillInstructions prepends the skill's instructions as a system message so a request
// that opts into a skill actually runs under its manual (not just its policy). Mirrors the
// X-Vibe-Knowledge prepend. Only chat-style bodies (with a messages array) are rewritten;
// returns (body, false) on any parse issue or empty instructions (safe no-op).
func injectSkillInstructions(body []byte, instructions string) ([]byte, bool) {
	instructions = strings.TrimSpace(instructions)
	if instructions == "" || len(body) == 0 {
		return body, false
	}
	var root map[string]any
	if err := json.Unmarshal(body, &root); err != nil {
		return body, false
	}
	msgs, ok := root["messages"].([]any)
	if !ok {
		return body, false
	}
	sysMsg := map[string]any{"role": "system", "content": "[Skill instructions]\n" + instructions}
	root["messages"] = append([]any{sysMsg}, msgs...)
	out, err := json.Marshal(root)
	if err != nil {
		return body, false
	}
	return out, true
}

// stepSkill enforces Skill policy when a request opts into a skill via the X-Vibe-Skill
// header. It runs after routing (so the effective model is known) and before governance.
// Modes (skills.enforcement runtime setting): off (skip), warn (header + audit only),
// enforce (block on violation / unusable skill). The decision is also recorded as a
// skill_run so operators can see who invoked which skill and whether it was allowed.
func (rc *requestPipeline) stepSkill() bool {
	s, r, w := rc.s, rc.r, rc.w
	if r.Method != http.MethodPost {
		return true
	}
	name := strings.TrimSpace(firstNonEmptyHeader(r, "X-Vibe-Skill", "X-Skill"))
	if name == "" {
		return true
	}
	mode := strings.ToLower(strings.TrimSpace(s.skillsConf().Enforcement))
	if mode == "" {
		mode = "warn"
	}
	if mode == "off" {
		return true
	}

	sk, found, err := s.db.GetSkill(r.Context(), name)
	if err != nil {
		// Never fail a proxy request because the skill lookup errored — log and pass through.
		slog.Warn("skill lookup failed", "skill", name, "error", err)
		return true
	}
	w.Header().Set("X-Vibe-Skill", name)

	if !found || sk.Status != "production" {
		w.Header().Set("X-Vibe-Skill-Status", "unavailable")
		if mode == "enforce" {
			rc.skillName = name
			s.metrics.IncSkillBlocked()
			rc.recordSkillRun(name, "", "blocked", rc.meta.Request.Model, 0, 0)
			_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "skill_denied", APIKeyID: rc.apiKeyID, IP: clientIP(r), UserAgent: r.UserAgent(), Detail: "skill not in production: " + name, CreatedAt: time.Now().UTC()})
			writeOpenAIError(w, http.StatusForbidden, "skill is not available (not found or not in production): "+name, "permission_error", "skill_unavailable")
			return false
		}
		return true
	}

	rc.skillName = sk.Name
	rc.skillVersion = sk.Version
	tools := parseRequestToolNames(rc.body)
	rc.skillTools = strings.Join(tools, ",")
	w.Header().Set("X-Vibe-Skill-Version", sk.Version)

	team := ""
	if rc.authCtx != nil {
		team = rc.authCtx.TeamID
	}
	violations := evaluateSkillPolicy(sk, rc.meta.Request.Model, tools, team)
	detail := strings.Join(violations, "; ")

	// enforce mode blocks on any violation (no injection).
	if len(violations) > 0 && mode == "enforce" {
		w.Header().Set("X-Vibe-Skill-Policy", "blocked")
		s.metrics.IncSkillBlocked()
		rc.recordSkillRun(sk.Name, sk.Version, "blocked", rc.meta.Request.Model, 0, 0)
		_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "skill_policy_blocked", APIKeyID: rc.apiKeyID, IP: clientIP(r), UserAgent: r.UserAgent(), Detail: sk.Name + ": " + detail, CreatedAt: time.Now().UTC()})
		writeOpenAIError(w, http.StatusForbidden, "skill policy violation: "+detail, "permission_error", "skill_policy_violation")
		return false
	}
	if len(violations) == 0 {
		w.Header().Set("X-Vibe-Skill-Policy", "ok")
	} else {
		w.Header().Set("X-Vibe-Skill-Policy", "warn")
		w.Header().Set("X-Vibe-Skill-Policy-Detail", detail)
	}

	// Daily invocation cap (blast-radius control for expensive/high-risk skills). Counts
	// today's actual executions (ok/error) from skill_runs; blocked attempts don't consume it.
	if sk.DailyLimit > 0 {
		startOfDay := time.Now().UTC().Truncate(24 * time.Hour)
		used, err := s.db.CountSkillRunsSince(r.Context(), sk.Name, startOfDay, []string{"ok", "error"})
		if err == nil {
			w.Header().Set("X-Vibe-Skill-Daily-Used", strconv.FormatInt(used, 10))
			w.Header().Set("X-Vibe-Skill-Daily-Limit", strconv.Itoa(sk.DailyLimit))
			if used >= int64(sk.DailyLimit) {
				if mode == "enforce" {
					w.Header().Set("X-Vibe-Skill-Policy", "rate_limited")
					rc.recordSkillRun(sk.Name, sk.Version, "blocked", rc.meta.Request.Model, 0, 0)
					_ = s.db.InsertAuditEvent(r.Context(), store.AuthEvent{ID: newID("ae"), EventType: "skill_rate_limited", APIKeyID: rc.apiKeyID, IP: clientIP(r), UserAgent: r.UserAgent(), Detail: sk.Name + ": daily limit " + strconv.Itoa(sk.DailyLimit), CreatedAt: time.Now().UTC()})
					w.Header().Set("Retry-After", "3600")
					writeOpenAIError(w, http.StatusTooManyRequests, "skill daily limit reached for '"+sk.Name+"'", "rate_limit_error", "skill_rate_limited")
					return false
				}
				w.Header().Set("X-Vibe-Skill-Policy", "warn")
				w.Header().Set("X-Vibe-Skill-Policy-Detail", "daily limit reached")
			}
		}
	}

	// Apply the skill: prepend its instructions as a system message so the request actually
	// runs under the manual. The rewritten body flows to the remaining pipeline steps.
	if newBody, applied := injectSkillInstructions(rc.body, sk.Instructions); applied {
		rc.body = newBody
		w.Header().Set("X-Vibe-Skill-Applied", "1")
	}
	return true
}

// recordSkillRun appends a skill execution-log entry (best-effort; never blocks the request).
// status is one of "ok" | "error" | "blocked". cost/latency are 0 when not yet known
// (e.g. an enforce block before the upstream call).
func (rc *requestPipeline) recordSkillRun(name, version, status, model string, costKRW float64, latencyMS int64) {
	if strings.TrimSpace(name) == "" {
		return
	}
	run := store.SkillRun{
		SkillName:    name,
		SkillVersion: version,
		Actor:        rc.apiKeyID,
		ToolsUsed:    rc.skillTools,
		Model:        model,
		Status:       status,
		CostKRW:      costKRW,
		LatencyMS:    latencyMS,
		CreatedAt:    time.Now().UTC().Format(time.RFC3339Nano),
	}
	go func(run store.SkillRun) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := rc.s.db.RecordSkillRun(ctx, run); err != nil {
			slog.Warn("record skill run failed", "skill", run.SkillName, "error", err)
		}
	}(run)
	// Mirror to the ClickHouse behavioral DW (best-effort, no-op when unconfigured).
	rc.s.emitSkillFact(run)
}
