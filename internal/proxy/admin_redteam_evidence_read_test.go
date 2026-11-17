package proxy

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func redTeamEvidenceReadFixture(t *testing.T) (*Server, *store.SQLStore, map[string]string) {
	t.Helper()
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "public-evidence-read-fixture"
	reader := issueLLMScopedTestToken(t, db, s, "evidence-reader", "readonly_admin", "", []string{"admin:read"}, time.Now().UTC())
	admin := issueLLMScopedTestToken(t, db, s, "evidence-admin", "admin", "", []string{"admin:read"}, time.Now().UTC())
	if err := db.InsertRedTeamRun(t.Context(), store.RedTeamRun{ID: "run-read", Status: "passed", Mode: "dry-run"}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertRedTeamCaseResult(t.Context(), store.RedTeamCaseResult{ID: "result-read", RunID: "run-read", CaseID: "case-read"}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertRedTeamEvidence(t.Context(), store.RedTeamEvidence{
		ID: "evidence-read", ResultID: "result-read", MaskedPrompt: "public masked prompt", MaskedResponse: "public masked response",
		RawPrompt: "private original prompt", RawResponse: "private original response",
		HeadersSummary: map[string]any{"seed_template": "private original seed", "model": "public-model", "unexpected": "private original header"},
		ToolCalls:      []map[string]any{{"name": "public-tool", "arguments": "private original arguments"}},
	}); err != nil {
		t.Fatal(err)
	}
	return s, db, map[string]string{"reader": reader, "admin": admin}
}

func evidenceReadRequest(s *Server, token, path string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("GET", path, nil)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	s.Routes().ServeHTTP(w, r)
	return w
}

func TestRedTeamEvidenceReadPermission(t *testing.T) {
	s, _, tokens := redTeamEvidenceReadFixture(t)
	reader, admin := tokens["reader"], tokens["admin"]
	for _, tc := range []struct {
		name, token, query string
		raw                bool
	}{
		{"reader legacy", reader, "", false},
		{"admin legacy", admin, "", true},
		{"reader app", reader, "?view=app", false},
		{"admin app", admin, "?view=app", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/admin/redteam/results/result-read/evidence"+tc.query, nil)
			r.Header.Set("Authorization", "Bearer "+tc.token)
			w := httptest.NewRecorder()
			s.Routes().ServeHTTP(w, r)
			if w.Code != 200 {
				t.Fatal("evidence unavailable", w.Code)
			}
			if strings.Contains(w.Body.String(), "private original") != tc.raw {
				t.Fatal("original evidence projection does not match viewer permission and explicit mode")
			}
			var response struct {
				Evidence store.RedTeamEvidence `json:"evidence"`
			}
			if json.Unmarshal(w.Body.Bytes(), &response) != nil || response.Evidence.MaskedPrompt != "public masked prompt" {
				t.Fatal("masked evidence missing")
			}
		})
	}
}

func TestRedTeamEvidenceReadExplicitRevealAndAudit(t *testing.T) {
	s, db, tokens := redTeamEvidenceReadFixture(t)
	path := "/admin/redteam/results/result-read/evidence?view=app"
	for _, role := range []string{"reader", "admin"} {
		w := evidenceReadRequest(s, tokens[role], path)
		var masked redTeamEvidenceReadResponse
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &masked) != nil || !masked.Masked || !masked.RawAvailable || masked.RawAllowed != (role == "admin") || masked.ToolCallCount != 1 || len(masked.Evidence.ToolCalls) != 0 || masked.Evidence.RawPrompt != "" || masked.Evidence.RawResponse != "" || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("default masked receipt mismatch", role, w.Code)
		}
	}
	if w := evidenceReadRequest(s, tokens["reader"], path+"&reveal=raw"); w.Code != 403 || strings.Contains(w.Body.String(), "private original") {
		t.Fatal("reader received original evidence")
	}
	before, err := db.ListAdminAudit(t.Context(), 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range before {
		if row.Action == "redteam.evidence.raw_view" {
			t.Fatal("default or denied read became a raw-view audit")
		}
	}
	w := evidenceReadRequest(s, tokens["admin"], path+"&reveal=raw")
	var raw redTeamEvidenceReadResponse
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &raw) != nil || raw.Masked || !raw.RawAllowed || raw.Evidence.RawPrompt != "private original prompt" || len(raw.Evidence.ToolCalls) != 1 || strings.Contains(w.Body.String(), "private original seed") || strings.Contains(w.Body.String(), "private original header") {
		t.Fatal("explicit original read mismatch", w.Code)
	}
	after, err := db.ListAdminAudit(t.Context(), 100)
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, row := range after {
		if row.Action == "redteam.evidence.raw_view" {
			count++
			var detail map[string]string
			if row.AdminID == "" || json.Unmarshal([]byte(row.AfterValue), &detail) != nil || len(detail) != 2 || detail["result_id"] != "result-read" || detail["evidence_id"] != "evidence-read" || strings.Contains(row.AfterValue, "private original") {
				t.Fatal("raw audit missing identity or contains original")
			}
		}
	}
	if count != 1 {
		t.Fatal("original read not audited exactly once")
	}
}

func TestRedTeamEvidenceReadQueryAndLegacyToken(t *testing.T) {
	s, _, tokens := redTeamEvidenceReadFixture(t)
	path := "/admin/redteam/results/result-read/evidence"
	for _, query := range []string{"view=", "view=other", "view=app&view=app", "view=app&unknown=raw", "view=app&reveal=", "view=app&reveal=other", "view=app&reveal=raw&reveal=raw", "reveal=raw", "view=%zz", "view=app;reveal=raw"} {
		w := evidenceReadRequest(s, tokens["admin"], path+"?"+query)
		if w.Code != 400 || strings.Contains(w.Body.String(), "private original") {
			t.Fatal("bad query accepted", query, w.Code)
		}
	}
	if w := evidenceReadRequest(s, "", path+"?view=app"); w.Code != 401 {
		t.Fatal("anonymous read accepted")
	}
	s.cfg.Auth.Enabled, s.cfg.Auth.AdminToken, s.cfg.Auth.AdminReadonlyToken = false, "public-admin", "public-reader"
	if w := evidenceReadRequest(s, "public-reader", path+"?view=app&reveal=raw"); w.Code != 403 {
		t.Fatal("legacy readonly token received originals")
	}
	if w := evidenceReadRequest(s, "public-admin", path+"?view=app&reveal=raw"); w.Code != 200 || !strings.Contains(w.Body.String(), "private original prompt") {
		t.Fatal("legacy full token cannot explicitly reveal")
	}
}

func TestRedTeamEvidenceReadAuditFailure(t *testing.T) {
	db, raw := impactFailureStore(t)
	s := &Server{db: db}
	if err := db.InsertRedTeamEvidence(t.Context(), store.RedTeamEvidence{ID: "evidence-audit", ResultID: "result-audit", RawPrompt: "private original audit prompt"}); err != nil {
		t.Fatal(err)
	}
	statement := "CREATE TRIGGER evidence_raw_audit_fault BEFORE INSERT ON admin_audit_logs WHEN NEW.action = 'redteam.evidence.raw_view' BEGIN SELECT RAISE(FAIL, 'private-audit-fault'); END"
	if os.Getenv("TEST_POSTGRES_DSN") != "" {
		statement = "ALTER TABLE admin_audit_logs ADD CONSTRAINT evidence_raw_audit_fault CHECK (action <> 'redteam.evidence.raw_view')"
	}
	if _, err := raw.ExecContext(t.Context(), statement); err != nil {
		t.Fatal(err)
	}
	w := evidenceReadRequest(s, "", "/admin/redteam/results/result-audit/evidence?view=app&reveal=raw")
	if w.Code != 503 || strings.Contains(w.Body.String(), "private-") || strings.Contains(w.Body.String(), "private original") || strings.Contains(w.Body.String(), `"evidence"`) {
		t.Fatal("audit failure leaked originals or storage details", w.Code)
	}
}

func TestRedTeamResultsReadDoesNotFallbackToOriginal(t *testing.T) {
	s, db, tokens := redTeamEvidenceReadFixture(t)
	if err := db.InsertRedTeamEvidence(t.Context(), store.RedTeamEvidence{ID: "evidence-old", ResultID: "result-read", RawPrompt: "private original fallback", CreatedAt: "2099-01-01T00:00:00Z"}); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		role, query string
		raw         bool
	}{
		{"reader", "", false}, {"reader", "?view=app", false}, {"admin", "", true}, {"admin", "?view=app", false},
	} {
		w := evidenceReadRequest(s, tokens[tc.role], "/admin/redteam/runs/run-read/results"+tc.query)
		if w.Code != 200 || strings.Contains(w.Body.String(), "private original fallback") != tc.raw || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("prompt fallback crossed read boundary", tc.role, tc.query, w.Code)
		}
	}
	if w := evidenceReadRequest(s, tokens["admin"], "/admin/redteam/runs/run-read/results?view=app&reveal=raw"); w.Code != 400 {
		t.Fatal("bulk original reveal accepted")
	}
}

func TestRedTeamEvidenceReadRoleMatrixAndStoragePreserved(t *testing.T) {
	s, db, _ := redTeamEvidenceReadFixture(t)
	before, ok, err := db.RedTeamEvidenceByResult(t.Context(), "result-read")
	if err != nil || !ok {
		t.Fatal("fixture missing")
	}
	for _, role := range []string{"super_admin", "admin", "security_admin", "readonly_admin", "ops_admin", "ai_admin", "team_admin", "viewer"} {
		t.Run(role, func(t *testing.T) {
			token := issueLLMScopedTestToken(t, db, s, "reader-"+role, role, "", []string{"admin:read"}, time.Now().UTC())
			allowed := role == "super_admin" || role == "admin" || role == "security_admin"
			path := "/admin/redteam/results/result-read/evidence?view=app"
			w := evidenceReadRequest(s, token, path)
			var body redTeamEvidenceReadResponse
			if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &body) != nil || body.RawAllowed != allowed || !body.Masked || strings.Contains(w.Body.String(), "private original") {
				t.Fatal("role projection mismatch", w.Code)
			}
			w = evidenceReadRequest(s, token, path+"&reveal=raw")
			want := 403
			if allowed {
				want = 200
			}
			if w.Code != want || (strings.Contains(w.Body.String(), "private original prompt") != allowed) {
				t.Fatal("role reveal mismatch", w.Code)
			}
		})
	}
	after, ok, err := db.RedTeamEvidenceByResult(t.Context(), "result-read")
	a, _ := json.Marshal(before)
	b, _ := json.Marshal(after)
	if err != nil || !ok || string(a) != string(b) {
		t.Fatal("reading changed stored evidence")
	}
}

func TestRedTeamEvidenceReadReprojectsStoredMaskedCapture(t *testing.T) {
	s, db, tokens := redTeamEvidenceReadFixture(t)
	secret := "sk-abcdefghijklmnopqrstuvwxyz123456"
	capture := "앞 문장\n" + secret + "\n뒤 문장"
	if err := db.InsertRedTeamEvidence(t.Context(), store.RedTeamEvidence{ID: "evidence-reproject", ResultID: "result-read", MaskedPrompt: capture, MaskedResponse: capture, HeadersSummary: map[string]any{"model": capture, "leak_findings": []any{capture, map[string]any{"text": "private original"}}, "seed_template": capture}, CreatedAt: "2099-01-01T00:00:00Z"}); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/admin/redteam/results/result-read/evidence?view=app", "/admin/redteam/results/result-read/evidence", "/admin/redteam/runs/run-read/results?view=app"} {
		w := evidenceReadRequest(s, tokens["reader"], path)
		if w.Code != 200 || strings.Contains(w.Body.String(), secret) || strings.Contains(w.Body.String(), "private original") || !strings.Contains(w.Body.String(), "앞 문장") || !strings.Contains(w.Body.String(), "뒤 문장") {
			t.Fatal("current masking missing", w.Code)
		}
	}
}

func TestRedTeamEvidenceReadEmptyMissingAndPathBoundaries(t *testing.T) {
	s, db, tokens := redTeamEvidenceReadFixture(t)
	if err := db.InsertRedTeamEvidence(t.Context(), store.RedTeamEvidence{ID: "evidence-empty", ResultID: "empty"}); err != nil {
		t.Fatal(err)
	}
	w := evidenceReadRequest(s, tokens["admin"], "/admin/redteam/results/empty/evidence?view=app")
	var empty redTeamEvidenceReadResponse
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &empty) != nil || empty.RawAvailable || empty.ToolCallCount != 0 || empty.Evidence.ToolCalls == nil || empty.Evidence.HeadersSummary == nil {
		t.Fatal("empty receipt invalid")
	}
	for _, path := range []string{"/admin/redteam/results/missing/evidence?view=app", "/admin/redteam/results/result-read/evidence/extra?view=app", "/admin/redteam/runs/run-read/results/extra?view=app", "/admin/redteam/runs/run-read?view=app"} {
		w = evidenceReadRequest(s, tokens["admin"], path)
		if w.Code != 404 || strings.Contains(w.Body.String(), "private original") || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("invalid read path accepted", path, w.Code)
		}
	}
	writer := issueLLMScopedTestToken(t, db, s, "read-method-check", "admin", "", []string{"admin:read", "admin:write"}, time.Now().UTC())
	for _, path := range []string{"/admin/redteam/results/result-read/evidence?view=app", "/admin/redteam/runs/run-read/results?view=app"} {
		r := httptest.NewRequest("POST", path, nil)
		r.Header.Set("Authorization", "Bearer "+writer)
		w = httptest.NewRecorder()
		s.Routes().ServeHTTP(w, r)
		if w.Code != 405 || strings.Contains(w.Body.String(), "private original") {
			t.Fatal("write method accepted for read", w.Code)
		}
	}
}
