package proxy

import (
	"bytes"
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

const routingOrderBodyLimit = 512 << 10

type routingOrderInput struct {
	Order            []string `json:"order"`
	ExpectedRevision string   `json:"expected_revision"`
	Reason           string   `json:"reason"`
}

// New order operations require canonical, unique, non-null top-level fields.
// Existing create, single-rule PATCH and ordinary preview parsing stay unchanged.
func decodeRoutingOrderJSON(raw []byte, target any, fields ...string) error {
	if len(raw) > routingOrderBodyLimit || !utf8.Valid(raw) {
		return store.ErrRoutingOrderInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return store.ErrRoutingOrderInvalid
	}
	allowed := map[string]bool{}
	for _, name := range fields {
		allowed[name] = true
	}
	seen := map[string]bool{}
	for decoder.More() {
		token, err := decoder.Token()
		name, ok := token.(string)
		if err != nil || !ok || !allowed[name] || seen[name] {
			return store.ErrRoutingOrderInvalid
		}
		seen[name] = true
		var value json.RawMessage
		if decoder.Decode(&value) != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return store.ErrRoutingOrderInvalid
		}
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') || len(seen) != len(allowed) {
		return store.ErrRoutingOrderInvalid
	}
	if decoder.Decode(new(any)) != io.EOF || json.Unmarshal(raw, target) != nil {
		return store.ErrRoutingOrderInvalid
	}
	return nil
}

func writeRoutingOrderError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrRoutingOrderConflict):
		writeOpenAIError(w, 409, "검토한 라우팅 설정이 변경되었습니다. 최신 목록으로 다시 검토하세요.", "invalid_request_error", "routing_order_conflict")
	case errors.Is(err, store.ErrRoutingOrderInvalid):
		writeOpenAIError(w, 400, "전체 규칙 순서, 검토 기준과 변경 사유를 확인하세요.", "invalid_request_error", "invalid_routing_order")
	case errors.Is(err, store.ErrRoutingOrderLimit):
		writeOpenAIError(w, 422, "규칙 수 또는 식별자가 순서 편집 범위를 넘습니다. 기존 규칙 편집을 사용하세요.", "invalid_request_error", "routing_order_limit")
	default:
		writeOpenAIError(w, 500, "라우팅 순서 작업 결과를 확인하지 못했습니다. 현재 설정을 다시 조회하세요.", "server_error", "routing_order_failed")
	}
}

func (s *Server) handleRoutingOrderSnapshot(w http.ResponseWriter, r *http.Request) {
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || len(query) != 1 || len(query["view"]) != 1 || query.Get("view") != "order" {
		err = store.ErrRoutingOrderInvalid
	}
	if err != nil {
		writeRoutingOrderError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	snapshot, err := s.db.GetRoutingOrderSnapshot(ctx)
	if err != nil {
		writeRoutingOrderError(w, err)
		return
	}
	writeJSON(w, 200, snapshot)
}

func routingPriorityAudit(rules []store.RoutingRule) []map[string]any {
	result := make([]map[string]any, 0, len(rules))
	for _, rule := range rules {
		result = append(result, map[string]any{"id": rule.ID, "priority": rule.Priority})
	}
	return result
}

func (s *Server) handleRoutingOrderWrite(w http.ResponseWriter, r *http.Request) {
	// Collection editing needs the same read authority as the reviewed list,
	// in addition to the routing:write check already performed by the handler.
	read := r.Clone(r.Context())
	read.Method = http.MethodGet
	if !s.authorizeAdmin(read) {
		writeOpenAIError(w, 401, "라우팅 조회 권한이 필요합니다.", "invalid_request_error", "invalid_api_key")
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, routingOrderBodyLimit))
	var input routingOrderInput
	if err != nil || r.URL.RawQuery != "" || decodeRoutingOrderJSON(raw, &input, "order", "expected_revision", "reason") != nil {
		writeRoutingOrderError(w, store.ErrRoutingOrderInvalid)
		return
	}
	input.Reason = strings.TrimSpace(input.Reason)
	if input.Reason == "" || utf8.RuneCountInString(input.Reason) > 500 {
		writeRoutingOrderError(w, store.ErrRoutingOrderInvalid)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	before, err := s.db.GetRoutingOrderSnapshot(ctx)
	if err != nil {
		writeRoutingOrderError(w, err)
		return
	}
	if before.Revision != input.ExpectedRevision {
		writeRoutingOrderError(w, store.ErrRoutingOrderConflict)
		return
	}
	proposed, err := store.ProposedRoutingOrder(before, input.Order)
	if err != nil {
		writeRoutingOrderError(w, err)
		return
	}
	beforeAudit := auditJSON(routingPriorityAudit(before.Rules))
	afterAudit := auditJSON(map[string]any{"rules": routingPriorityAudit(proposed), "reason": input.Reason})
	// The store rechecks this same complete snapshot while excluding ordinary
	// writers, so these audit values and the persisted order cannot diverge.
	result, err := s.db.ReorderRoutingRules(ctx, input.ExpectedRevision, input.Order, store.AdminAuditLog{
		ID: newID("audit"), AdminID: adminID(r), Action: "routing_rule.reorder", BeforeValue: beforeAudit, AfterValue: afterAudit,
	})
	if err != nil {
		writeRoutingOrderError(w, err)
		return
	}
	s.invalidateRoutingRulesCache()
	s.runAdminPostChange(r, "routing_rule.reorder", beforeAudit, afterAudit, "")
	writeJSON(w, 200, result)
}
