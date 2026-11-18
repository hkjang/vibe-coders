package proxy

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func graphHTTP(t *testing.T, base, method, path, token string, body []byte, want int) []byte {
	t.Helper()
	req, err := http.NewRequest(method, base+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != want {
		t.Fatalf("%s %s = %d, want %d: %s", method, path, response.StatusCode, want, raw)
	}
	return raw
}

func graphWriteJSON(wf store.Workflow, revision string) []byte {
	raw, _ := json.Marshal(map[string]any{"workflow": map[string]any{"id": wf.ID, "name": wf.Name, "description": wf.Description, "steps": wf.Steps, "flow": wf.Flow, "enabled": wf.Enabled, "allowed_teams": wf.AllowedTeams}, "expected_revision": revision, "reason": "분기 경로 검토"})
	return raw
}

func TestWorkflowGraphHTTPReviewedSaveAndLegacyProtection(t *testing.T) {
	s, db, gateway := newAdminModelsTestServer(t, "graph-admin")
	s.cfg.Auth.AdminReadonlyToken = "graph-reader"
	wf := runtimeBranchFixture()
	wf.Name = "입력 분기"
	wf.Enabled = true
	write := graphWriteJSON(wf, "")
	graphHTTP(t, gateway.URL, "POST", "/admin/workflows?review=graph", "graph-reader", write, 401)
	graphHTTP(t, gateway.URL, "POST", "/admin/workflows?review=graph", "", write, 401)
	var saved struct {
		Workflow store.Workflow `json:"workflow"`
		Revision string         `json:"revision"`
	}
	if err := json.Unmarshal(graphHTTP(t, gateway.URL, "POST", "/admin/workflows?review=graph", "graph-admin", write, 200), &saved); err != nil {
		t.Fatal(err)
	}
	if len(saved.Revision) != 64 || saved.Workflow.Flow.Entry != "start" {
		t.Fatal("missing reviewed definition")
	}
	graphHTTP(t, gateway.URL, "POST", "/admin/workflows?review=graph", "graph-admin", write, 409)
	var review struct {
		Revision string `json:"revision"`
	}
	if err := json.Unmarshal(graphHTTP(t, gateway.URL, "GET", "/admin/workflows?view=review&id=branch", "graph-reader", nil, 200), &review); err != nil || review.Revision != saved.Revision {
		t.Fatal("review revision mismatch")
	}
	wf.Name = "수정한 분기"
	graphHTTP(t, gateway.URL, "POST", "/admin/workflows?review=graph", "graph-admin", graphWriteJSON(wf, review.Revision), 200)
	graphHTTP(t, gateway.URL, "POST", "/admin/workflows?review=graph", "graph-admin", graphWriteJSON(wf, review.Revision), 409)
	graphHTTP(t, gateway.URL, "POST", "/admin/workflows", "graph-admin", []byte(`{"id":"branch","name":"legacy overwrite","steps":[{"type":"chat"}]}`), 409)
	stored, _, err := db.GetWorkflow(t.Context(), "branch")
	if err != nil || stored.Name != "수정한 분기" || stored.Flow == nil {
		t.Fatal("legacy edit erased graph")
	}
	audits, err := db.ListAdminAudit(t.Context(), 20)
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, item := range audits {
		if item.Action == "workflow.graph_save" {
			count++
			if !strings.Contains(item.AfterValue, "분기 경로 검토") {
				t.Fatal("reason absent")
			}
		}
	}
	if count != 2 {
		t.Fatalf("successful write audit count=%d", count)
	}
}

func TestWorkflowGraphHTTPStrictWriteValidation(t *testing.T) {
	_, db, gateway := newAdminModelsTestServer(t, "graph-admin")
	wf := runtimeBranchFixture()
	wf.Name = "strict"
	valid := string(graphWriteJSON(wf, ""))
	for _, tt := range []struct{ name, body, path string }{
		{"duplicate", strings.Replace(valid, `"reason":`, `"reason":"first","reason":`, 1), "?review=graph"},
		{"alias", strings.Replace(valid, `"reason":`, `"Reason":`, 1), "?review=graph"},
		{"null", strings.Replace(valid, `"expected_revision":""`, `"expected_revision":null`, 1), "?review=graph"},
		{"nested duplicate", strings.Replace(valid, `"entry":"start"`, `"entry":"wrong","entry":"start"`, 1), "?review=graph"},
		{"bad predicate", strings.Replace(valid, `"non_empty"`, `"eval"`, 1), "?review=graph"},
		{"extra", valid + ` {}`, "?review=graph"},
		{"query", valid, "?review=graph&review=graph"},
		{"scope query", valid, "?review=graph&id=other"},
		{"mode", valid, "?review=unknown"},
		{"large", strings.Repeat(" ", workflowGraphBodyLimit) + valid, "?review=graph"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			graphHTTP(t, gateway.URL, "POST", "/admin/workflows"+tt.path, "graph-admin", []byte(tt.body), 400)
		})
	}
	if rows, err := db.ListWorkflows(t.Context()); err != nil || len(rows) != 0 {
		t.Fatal("invalid request changed workflows")
	}
	for _, query := range []string{"?view=review", "?view=review&id=branch&id=other", "?view=review&id=branch&limit=1"} {
		graphHTTP(t, gateway.URL, "GET", "/admin/workflows"+query, "graph-admin", nil, 400)
	}
	graphHTTP(t, gateway.URL, "GET", "/admin/workflows?view=review&id=missing", "graph-admin", nil, 404)
}

func TestWorkflowGraphHTTPReviewedPublish(t *testing.T) {
	s, db, gateway := newAdminModelsTestServer(t, "graph-admin")
	s.cfg.Auth.AdminReadonlyToken = "graph-reader"
	wf := runtimeBranchFixture()
	wf.Name = "게시 분기"
	wf.Enabled = false
	if err := db.UpsertWorkflow(t.Context(), wf); err != nil {
		t.Fatal(err)
	}
	wf, _, _ = db.GetWorkflow(t.Context(), wf.ID)
	revision, _ := store.WorkflowRevision(wf)
	body, _ := json.Marshal(map[string]string{"expected_revision": revision, "note": "실행 허용 검토"})
	path := "/admin/workflows/" + wf.ID + "/publish"
	for _, bad := range []string{`{}`, `{"note":"legacy"}`, `{"expected_revision":null,"note":"reason"}`, `{"expected_revision":"` + revision + `","note":""}`, `{"expected_revision":"` + revision + `","note":"one","note":"two"}`} {
		graphHTTP(t, gateway.URL, "POST", path, "graph-admin", []byte(bad), 400)
	}
	graphHTTP(t, gateway.URL, "POST", path, "graph-reader", body, 401)
	graphHTTP(t, gateway.URL, "POST", path+"?unexpected=1", "graph-admin", body, 400)
	graphHTTP(t, gateway.URL, "POST", path, "graph-admin", body, 200)
	graphHTTP(t, gateway.URL, "POST", path, "graph-admin", body, 409)
	current, _, _ := db.GetWorkflow(t.Context(), wf.ID)
	versions, _ := db.ListWorkflowVersions(t.Context(), wf.ID)
	if !current.Enabled || len(versions) != 1 || versions[0].Flow == nil {
		t.Fatal("published graph missing")
	}
	audits, _ := db.ListAdminAudit(t.Context(), 20)
	count := 0
	for _, audit := range audits {
		if audit.Action == "workflow.publish" {
			count++
			if !strings.Contains(audit.AfterValue, "실행 허용 검토") {
				t.Fatal("reason missing")
			}
		}
	}
	if count != 1 {
		t.Fatalf("publish audits=%d", count)
	}
}
