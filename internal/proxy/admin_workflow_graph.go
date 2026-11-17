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

const workflowGraphBodyLimit = 256 << 10

// Graph writes have an explicit canonical contract. Legacy decoding stays in
// the existing handler. Nested objects are checked below with their own fields.
func decodeWorkflowObject(raw []byte, target any, allowed []string, required ...string) error {
	if !utf8.Valid(raw) || len(raw) > workflowGraphBodyLimit {
		return store.ErrInvalidWorkflowGraph
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	if token, err := d.Token(); err != nil || token != json.Delim('{') {
		return store.ErrInvalidWorkflowGraph
	}
	seen := map[string]bool{}
	for d.More() {
		token, err := d.Token()
		name, ok := token.(string)
		if err != nil || !ok || seen[name] {
			return store.ErrInvalidWorkflowGraph
		}
		accepted := false
		for _, key := range allowed {
			if key == name {
				accepted = true
				break
			}
		}
		if !accepted {
			return store.ErrInvalidWorkflowGraph
		}
		seen[name] = true
		var value json.RawMessage
		if d.Decode(&value) != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return store.ErrInvalidWorkflowGraph
		}
	}
	if token, err := d.Token(); err != nil || token != json.Delim('}') {
		return store.ErrInvalidWorkflowGraph
	}
	for _, key := range required {
		if !seen[key] {
			return store.ErrInvalidWorkflowGraph
		}
	}
	if d.Decode(new(any)) != io.EOF || json.Unmarshal(raw, target) != nil {
		return store.ErrInvalidWorkflowGraph
	}
	return nil
}

func decodeWorkflowGraph(raw []byte) (store.Workflow, error) {
	var value struct {
		ID           string            `json:"id"`
		Name         string            `json:"name"`
		Description  string            `json:"description"`
		AllowedTeams string            `json:"allowed_teams"`
		Enabled      bool              `json:"enabled"`
		Steps        []json.RawMessage `json:"steps"`
		Flow         json.RawMessage   `json:"flow"`
	}
	keys := []string{"id", "name", "description", "allowed_teams", "enabled", "steps", "flow"}
	if err := decodeWorkflowObject(raw, &value, keys, keys...); err != nil {
		return store.Workflow{}, err
	}
	wf := store.Workflow{ID: value.ID, Name: strings.TrimSpace(value.Name), Description: value.Description, AllowedTeams: strings.TrimSpace(value.AllowedTeams), Enabled: value.Enabled}
	if !store.ValidWorkflowDetailID(wf.ID) || wf.Name == "" || len(wf.Name) > 800 || len(wf.Description) > 8000 || len(wf.AllowedTeams) > 8000 || len(value.Steps) > store.WorkflowGraphMaxSteps {
		return wf, store.ErrInvalidWorkflowGraph
	}
	var flow struct {
		Version int               `json:"version"`
		Entry   string            `json:"entry"`
		Edges   []json.RawMessage `json:"edges"`
	}
	if err := decodeWorkflowObject(value.Flow, &flow, []string{"version", "entry", "edges"}, "version", "entry", "edges"); err != nil {
		return wf, err
	}
	wf.Flow = &store.WorkflowFlow{Version: flow.Version, Entry: flow.Entry, Edges: []store.WorkflowEdge{}}
	if len(flow.Edges) > 2*store.WorkflowGraphMaxSteps {
		return wf, store.ErrInvalidWorkflowGraph
	}
	for _, rawEdge := range flow.Edges {
		var edge store.WorkflowEdge
		if err := decodeWorkflowObject(rawEdge, &edge, []string{"from", "to", "when"}, "from", "to", "when"); err != nil {
			return wf, err
		}
		wf.Flow.Edges = append(wf.Flow.Edges, edge)
	}
	stepKeys := []string{"id", "name", "type", "ref", "timeout_ms", "max_cost_krw", "max_tokens", "allowed_tools", "allowed_tables", "note", "condition"}
	for _, rawStep := range value.Steps {
		var step store.WorkflowStep
		if err := decodeWorkflowObject(rawStep, &step, stepKeys, "id", "name", "type"); err != nil {
			return wf, err
		}
		if step.Condition != nil {
			var fields map[string]json.RawMessage
			_ = json.Unmarshal(rawStep, &fields)
			if err := decodeWorkflowObject(fields["condition"], step.Condition, []string{"operator", "value"}, "operator"); err != nil {
				return wf, err
			}
		}
		wf.Steps = append(wf.Steps, step)
	}
	return wf, store.ValidateWorkflowGraph(wf)
}

func writeWorkflowGraphError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrWorkflowGraphConflict), errors.Is(err, store.ErrWorkflowGraphEditRequired):
		writeOpenAIError(w, 409, "검토한 워크플로가 바뀌었거나 분기 정의가 누락되었습니다. 최신 정의를 다시 조회해 검토하세요.", "invalid_request_error", "workflow_graph_conflict")
	case errors.Is(err, store.ErrInvalidWorkflowGraph):
		writeOpenAIError(w, 400, "워크플로 단계·연결·검토 기준과 변경 사유를 확인하세요.", "invalid_request_error", "invalid_workflow_graph")
	default:
		writeOpenAIError(w, 500, "저장 결과를 확인하지 못했습니다. 다시 저장하기 전에 현재 정의를 조회하세요.", "server_error", "workflow_graph_failed")
	}
}

// Existing admin authorization runs before dispatching to either mode.
func (s *Server) handleWorkflowGraphReview(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	q, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || len(q) != 2 || len(q["view"]) != 1 || q.Get("view") != "review" || len(q["id"]) != 1 || !store.ValidWorkflowDetailID(q.Get("id")) {
		writeWorkflowGraphError(w, store.ErrInvalidWorkflowGraph)
		return
	}
	wf, found, err := s.db.GetWorkflow(r.Context(), q.Get("id"))
	if err != nil {
		writeWorkflowGraphError(w, err)
		return
	}
	if !found {
		writeOpenAIError(w, 404, "워크플로를 찾을 수 없습니다.", "invalid_request_error", "workflow_not_found")
		return
	}
	revision, err := store.WorkflowRevision(wf)
	if err != nil {
		writeWorkflowGraphError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"workflow": wf, "revision": revision})
}

func (s *Server) handleWorkflowGraphWrite(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	read := r.Clone(r.Context())
	read.Method = http.MethodGet
	if !s.authorizeAdmin(read) {
		writeOpenAIError(w, 401, "워크플로 조회와 변경 권한이 필요합니다.", "invalid_request_error", "invalid_api_key")
		return
	}
	q, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || len(q) != 1 || len(q["review"]) != 1 || q.Get("review") != "graph" {
		writeWorkflowGraphError(w, store.ErrInvalidWorkflowGraph)
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, workflowGraphBodyLimit))
	var body struct {
		Workflow json.RawMessage `json:"workflow"`
		Revision string          `json:"expected_revision"`
		Reason   string          `json:"reason"`
	}
	if err != nil || decodeWorkflowObject(raw, &body, []string{"workflow", "expected_revision", "reason"}, "workflow", "expected_revision", "reason") != nil {
		writeWorkflowGraphError(w, store.ErrInvalidWorkflowGraph)
		return
	}
	body.Reason = strings.TrimSpace(body.Reason)
	if body.Reason == "" || utf8.RuneCountInString(body.Reason) > 500 {
		writeWorkflowGraphError(w, store.ErrInvalidWorkflowGraph)
		return
	}
	wf, err := decodeWorkflowGraph(body.Workflow)
	if err != nil {
		writeWorkflowGraphError(w, err)
		return
	}
	wf.CreatedBy = adminID(r)
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	audit := store.AdminAuditLog{ID: newID("aal"), AdminID: adminID(r), Action: "workflow.graph_save",
		BeforeValue: auditJSON(map[string]any{"id": wf.ID, "revision": body.Revision}),
		AfterValue:  auditJSON(map[string]any{"id": wf.ID, "reason": body.Reason, "steps": len(wf.Steps), "enabled": wf.Enabled})}
	saved, err := s.db.CommitWorkflowGraph(ctx, wf, body.Revision, audit)
	if err != nil {
		writeWorkflowGraphError(w, err)
		return
	}
	revision, err := store.WorkflowRevision(saved)
	if err != nil {
		writeWorkflowGraphError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"workflow": saved, "revision": revision})
}

// Graph activation requires the revision the operator saw, a reason, and both
// read/write authorization. The existing publish route remains the only route.
func (s *Server) handlePublishWorkflowGraph(w http.ResponseWriter, r *http.Request, wf store.Workflow) {
	w.Header().Set("Cache-Control", "no-store")
	read := r.Clone(r.Context())
	read.Method = http.MethodGet
	if !s.authorizeAdmin(read) {
		writeOpenAIError(w, 401, "워크플로 조회와 변경 권한이 필요합니다.", "invalid_request_error", "invalid_api_key")
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8192))
	var body struct {
		Revision string `json:"expected_revision"`
		Note     string `json:"note"`
	}
	if r.URL.RawQuery != "" || err != nil || decodeWorkflowObject(raw, &body, []string{"expected_revision", "note"}, "expected_revision", "note") != nil {
		writeWorkflowGraphError(w, store.ErrInvalidWorkflowGraph)
		return
	}
	body.Note = strings.TrimSpace(body.Note)
	if body.Note == "" || utf8.RuneCountInString(body.Note) > 500 {
		writeWorkflowGraphError(w, store.ErrInvalidWorkflowGraph)
		return
	}
	if _, issues := s.planWorkflow(r, wf); len(issues) > 0 {
		writeWorkflowGraphError(w, store.ErrInvalidWorkflowGraph)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	version, err := s.db.PublishWorkflowVersionReviewed(ctx, wf, body.Revision, adminID(r), body.Note, store.AdminAuditLog{ID: newID("aal"), AdminID: adminID(r), Action: "workflow.publish"})
	if err != nil {
		writeWorkflowGraphError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"workflow_id": wf.ID, "version": version, "enabled": true, "published": true})
}
