package proxy

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"vibe-coders/internal/store"
)

func stageWorkspaceRequest(s *Server, method, path string, body any) *httptest.ResponseRecorder {
	encoded, _ := json.Marshal(body)
	w := httptest.NewRecorder()
	s.Routes().ServeHTTP(w, httptest.NewRequest(method, path, bytes.NewReader(encoded)))
	return w
}
func TestPromptStageWorkspaceProjectionAndAuditedWrite(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	ctx := t.Context()
	for _, name := range []string{"public", "token=private-credential"} {
		if err := db.SetPromptStage(ctx, store.PromptPromotion{PromptName: name, PromptVersion: "v1", Stage: "experiment", Note: "private-note", PromotedBy: "private-actor"}); err != nil {
			t.Fatal(err)
		}
	}
	w := stageWorkspaceRequest(s, "GET", "/admin/prompts/promotions?view=workspace", nil)
	var response struct {
		Items []promptStageWorkspaceItem `json:"items"`
		Total int                        `json:"total"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &response) != nil || response.Total != 2 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("workspace response", w.Code)
	}
	for _, forbidden := range []string{"private-", "promoted_by", "note", "prompt_name"} {
		if strings.Contains(w.Body.String(), forbidden) {
			t.Fatal("workspace leaked private data")
		}
	}
	row := response.Items[0]
	if !row.CanChange || len(row.Revision) != 43 || response.Items[1].CanChange || response.Items[1].Name != "[숨김]" {
		t.Fatal("unsafe identity not locked")
	}
	payload := map[string]any{"name": row.Name, "version": row.Version, "revision": row.Revision, "stage": "validation", "reason": "검토 결과 확인"}
	w = stageWorkspaceRequest(s, "POST", "/admin/prompts/promotions?view=workspace", payload)
	var receipt map[string]any
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &receipt) != nil || receipt["reference"] != row.Reference || receipt["stage"] != "validation" || receipt["revision"] == row.Revision {
		t.Fatal("write receipt mismatch", w.Code)
	}
	after, err := db.GetPromptStageSnapshot(ctx, "public", "v1")
	audits, aerr := db.ListAdminAudit(ctx, 20)
	if err != nil || aerr != nil || after.Promotion.Note != "검토 결과 확인" || len(audits) != 1 || audits[0].Action != "prompt.promotion.set" || !strings.Contains(audits[0].AfterValue, "검토 결과 확인") {
		t.Fatal("audit/state not committed")
	}
	w = stageWorkspaceRequest(s, "POST", "/admin/prompts/promotions?view=workspace", payload)
	if w.Code != 409 {
		t.Fatal("stale revision accepted", w.Code)
	}
	audits, _ = db.ListAdminAudit(ctx, 20)
	if len(audits) != 1 {
		t.Fatal("stale write added audit")
	}
	w = stageWorkspaceRequest(s, "GET", "/admin/prompts/promotions", nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "private-note") {
		t.Fatal("legacy read changed")
	}
	for _, query := range []string{"view=workspace&limit=101", "view=workspace&limit=025", "view=workspace&offset=-1", "view=workspace&window=forever", "view=workspace&stage=unknown", "view=workspace&view=workspace", "view=workspace&extra=1", "view=bad", "view=%zz"} {
		if w := stageWorkspaceRequest(s, "GET", "/admin/prompts/promotions?"+query, nil); w.Code != 400 {
			t.Fatal("invalid query accepted", query, w.Code)
		}
	}
	for _, value := range []map[string]any{{"action": "auto"}, {"name": "token=private-credential", "version": "v1", "stage": "production", "reason": "r", "revision": row.Revision}, {"name": "public", "version": "v1", "stage": "production", "reason": "token=secret", "revision": row.Revision}} {
		if w := stageWorkspaceRequest(s, "POST", "/admin/prompts/promotions?view=workspace", value); w.Code != 400 {
			t.Fatal("invalid mutation accepted", w.Code)
		}
	}
}
func TestPromptStageWorkspacePermissionsAndReadFailures(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.Enabled = true
	s.cfg.Auth.JWTSecret = "public-stage-fixture"
	for _, tc := range []struct {
		role   string
		scopes []string
		read   bool
	}{{"admin", []string{"admin:read"}, true}, {"readonly_admin", []string{"admin:read"}, true}, {"user", []string{"models:read"}, false}} {
		token := issueLLMScopedTestToken(t, db, s, "stage-"+tc.role, tc.role, "", tc.scopes, time.Now().UTC())
		for _, method := range []string{"GET", "POST"} {
			r := httptest.NewRequest(method, "/admin/prompts/promotions?view=workspace", strings.NewReader(`{}`))
			r.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			s.Routes().ServeHTTP(w, r)
			if method == "GET" && (w.Code == 200) != tc.read {
				t.Fatal("read scope mismatch", tc.role, w.Code)
			}
			if method == "POST" && (w.Code != 401 && w.Code != 403) {
				t.Fatal("read-only actor reached write", tc.role, w.Code)
			}
		}
	}
	s.cfg.Auth.Enabled = false
	db.Close()
	for _, path := range []string{"/admin/prompts/promotions", "/admin/prompts/promotions?view=workspace"} {
		w := stageWorkspaceRequest(s, "GET", path, nil)
		if w.Code != 500 || strings.Contains(w.Body.String(), "database") || strings.Contains(w.Body.String(), "items") {
			t.Fatal("storage failure concealed or leaked", w.Code)
		}
	}
}
