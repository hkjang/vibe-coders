package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"vibe-coders/internal/store"
)

type routingDraftPatch struct {
	Priority       *int    `json:"priority"`
	MatchPattern   *string `json:"match_pattern"`
	MinComplexity  *int    `json:"min_complexity"`
	MaxComplexity  *int    `json:"max_complexity"`
	TargetModel    *string `json:"target_model"`
	TargetProvider *string `json:"target_provider"`
	Note           *string `json:"note"`
}

func decodeRoutingDraftPatch(raw []byte) (store.RoutingRulePatch, error) {
	var p routingDraftPatch
	if decodeRoutingDraftObject(raw, &p, []string{"priority", "match_pattern", "min_complexity", "max_complexity", "target_model", "target_provider", "note"}) != nil {
		return store.RoutingRulePatch{}, store.ErrRoutingOrderInvalid
	}
	return store.RoutingRulePatch{Priority: p.Priority, MatchPattern: p.MatchPattern, MinComplexity: p.MinComplexity, MaxComplexity: p.MaxComplexity, TargetModel: p.TargetModel, TargetProvider: p.TargetProvider, Note: p.Note}, nil
}

// Optional fields remain strict: unique canonical keys, no nulls/unknowns or
// trailing document. Keep compatibility parsing outside this explicit mode.
func decodeRoutingDraftObject(raw []byte, target any, allowed []string, required ...string) error {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || len(fields) == 0 {
		return store.ErrRoutingOrderInvalid
	}
	for _, key := range required {
		if _, ok := fields[key]; !ok {
			return store.ErrRoutingOrderInvalid
		}
	}
	keys := make([]string, 0, len(fields))
	for key := range fields {
		found := false
		for _, candidate := range allowed {
			if key == candidate {
				found = true
				break
			}
		}
		if !found {
			return store.ErrRoutingOrderInvalid
		}
		keys = append(keys, key)
	}
	return decodeRoutingOrderJSON(raw, target, keys...)
}

func writeRoutingDraftError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrRoutingOrderConflict):
		writeOpenAIError(w, 409, "검토한 라우팅 설정이 바뀌었습니다. 최신 목록으로 다시 검토하세요.", "invalid_request_error", "routing_draft_conflict")
	case errors.Is(err, store.ErrRoutingRuleNotFound):
		writeOpenAIError(w, 404, "검토할 규칙을 찾을 수 없습니다.", "invalid_request_error", "routing_rule_not_found")
	case errors.Is(err, store.ErrRoutingDraftAmbiguous):
		writeOpenAIError(w, 422, "우선순위와 생성 시각이 같은 규칙이 있습니다. 규칙 순서를 먼저 정리하세요.", "invalid_request_error", "routing_draft_ambiguous")
	case errors.Is(err, store.ErrRoutingOrderLimit):
		writeOpenAIError(w, 422, "규칙 수 또는 식별자가 초안 검토 범위를 넘습니다.", "invalid_request_error", "routing_draft_limit")
	case errors.Is(err, store.ErrRoutingOrderInvalid):
		writeOpenAIError(w, 400, "검토 기준, 변경 내용과 시험 요청을 확인하세요.", "invalid_request_error", "invalid_routing_draft")
	default:
		writeOpenAIError(w, 500, "라우팅 검토 결과를 확인하지 못했습니다. 현재 설정을 다시 조회하세요.", "server_error", "routing_draft_failed")
	}
}

func (s *Server) handleRoutingDraftPreview(w http.ResponseWriter, r *http.Request, raw []byte) {
	w.Header().Set("Cache-Control", "no-store")
	var input struct {
		Edit    json.RawMessage `json:"rule_edit"`
		Request json.RawMessage `json:"request"`
	}
	var edit struct {
		ID       string          `json:"id"`
		Revision string          `json:"expected_revision"`
		Patch    json.RawMessage `json:"patch"`
	}
	var request struct {
		Model    string `json:"model"`
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
		Key string `json:"api_key_id"`
	}
	if r.URL.RawQuery != "" || decodeRoutingOrderJSON(raw, &input, "rule_edit", "request") != nil || decodeRoutingOrderJSON(input.Edit, &edit, "id", "expected_revision", "patch") != nil || decodeRoutingDraftObject(input.Request, &request, []string{"model", "messages", "api_key_id"}, "model", "messages") != nil {
		writeRoutingDraftError(w, store.ErrRoutingOrderInvalid)
		return
	}
	if strings.TrimSpace(request.Model) == "" || utf8.RuneCountInString(request.Model) > 256 || len(request.Messages) == 0 || len(request.Messages) > 64 || len(request.Key) > 2048 {
		writeRoutingDraftError(w, store.ErrRoutingOrderInvalid)
		return
	}
	var requestFields map[string]json.RawMessage
	_ = json.Unmarshal(input.Request, &requestFields)
	var messages []json.RawMessage
	_ = json.Unmarshal(requestFields["messages"], &messages)
	for i, message := range messages {
		var fields map[string]json.RawMessage
		if decodeRoutingOrderJSON(message, &fields, "role", "content") != nil || len(request.Messages[i].Content) > 65536 {
			writeRoutingDraftError(w, store.ErrRoutingOrderInvalid)
			return
		}
		switch request.Messages[i].Role {
		case "user", "assistant", "system", "developer":
		default:
			writeRoutingDraftError(w, store.ErrRoutingOrderInvalid)
			return
		}
	}
	patch, err := decodeRoutingDraftPatch(edit.Patch)
	if err != nil {
		writeRoutingDraftError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	draft, err := s.db.PreviewRoutingRuleEdit(ctx, edit.Revision, edit.ID, patch)
	if err != nil {
		writeRoutingDraftError(w, err)
		return
	}
	auth, keyID, ok := s.routingPreviewAuthContext(w, r, map[string]any{"api_key_id": request.Key})
	if !ok {
		return
	}
	plan := func(rules []store.RoutingRule) map[string]any {
		result := s.planIntelligentRoutingUsing(ctx, input.Request, "/v1/chat/completions", false, false, auth, func(model string, score int) routingDecision {
			decision, _ := evaluateRoutingRuleOrder(rules, model, score)
			return decision
		})
		return s.routingPreviewResult(r, result, keyID)
	}
	before, after := plan(draft.Before.Rules), plan(draft.Rules)
	current, err := s.db.GetRoutingOrderSnapshot(ctx)
	if err == nil && current.Revision != edit.Revision {
		err = store.ErrRoutingOrderConflict
	}
	if err != nil {
		writeRoutingDraftError(w, err)
		return
	}
	// The rules and key scope are fixed for this comparison. Health, learning
	// and provider configuration are ordinary live reads, not one DB snapshot.
	writeJSON(w, 200, map[string]any{"stage": "routing_plan", "revision": edit.Revision, "runtime_consistency": "sequential_live_reads", "observed_at": time.Now().UTC(), "before": before, "after": after})
}

func (s *Server) handleRoutingDraftWrite(w http.ResponseWriter, r *http.Request, id string) {
	w.Header().Set("Cache-Control", "no-store")
	read := r.Clone(r.Context())
	read.Method = http.MethodGet
	if !s.authorizeAdmin(read) {
		writeOpenAIError(w, 401, "라우팅 조회 권한이 필요합니다.", "invalid_request_error", "invalid_api_key")
		return
	}
	query, queryErr := url.ParseQuery(r.URL.RawQuery)
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, routingOrderBodyLimit))
	var input struct {
		Revision string          `json:"expected_revision"`
		Patch    json.RawMessage `json:"patch"`
		Reason   string          `json:"reason"`
	}
	if err != nil || queryErr != nil || len(query) != 1 || len(query["review"]) != 1 || query.Get("review") != "edit" || decodeRoutingOrderJSON(raw, &input, "expected_revision", "patch", "reason") != nil {
		writeRoutingDraftError(w, store.ErrRoutingOrderInvalid)
		return
	}
	input.Reason = strings.TrimSpace(input.Reason)
	if input.Reason == "" || utf8.RuneCountInString(input.Reason) > 500 {
		writeRoutingDraftError(w, store.ErrRoutingOrderInvalid)
		return
	}
	patch, err := decodeRoutingDraftPatch(input.Patch)
	if err != nil {
		writeRoutingDraftError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	draft, err := s.db.PreviewRoutingRuleEdit(ctx, input.Revision, id, patch)
	if err != nil {
		writeRoutingDraftError(w, err)
		return
	}
	beforeAudit := auditJSON(draft.Original)
	afterAudit := auditJSON(map[string]any{"rule": draft.Rule, "reason": input.Reason})
	result, err := s.db.CommitRoutingRuleEdit(ctx, input.Revision, id, patch, store.AdminAuditLog{ID: newID("audit"), AdminID: adminID(r), Action: "routing_rule.reviewed_update", BeforeValue: beforeAudit, AfterValue: afterAudit})
	if err != nil {
		writeRoutingDraftError(w, err)
		return
	}
	s.invalidateRoutingRulesCache()
	s.runAdminPostChange(r, "routing_rule.reviewed_update", beforeAudit, afterAudit, "")
	writeJSON(w, 200, map[string]any{"rule": draft.Rule, "revision": result.Revision})
}
