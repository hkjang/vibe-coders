package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func profileReviewRequest(s *Server, method, query, body, token string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "/admin/text2sql/profiles"+query, strings.NewReader(body))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	s.handleText2SQLProfiles(w, r)
	return w
}
func profileReviewBody() map[string]any {
	return map[string]any{"virtual_model": "vibe/text2sql-review", "mode": "preview", "upstream_model": "", "summary_model": "", "schema_name": "", "exec_connection_id": "", "enabled": true, "expected_revision": "absent", "reason": "정산 모델 설정"}
}

func TestText2SQLProfileReviewedHTTP(t *testing.T) {
	s, db, gateway := newAdminModelsTestServer(t, "")
	request := func(method, query, body string) (int, map[string]any) {
		t.Helper()
		r, _ := http.NewRequest(method, gateway.URL+"/admin/text2sql/profiles"+query, strings.NewReader(body))
		response, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var result map[string]any
		if json.NewDecoder(response.Body).Decode(&result) != nil {
			t.Fatal("invalid HTTP body")
		}
		if !validRequestID(response.Header.Get("X-Request-ID")) {
			t.Fatal("missing request ID")
		}
		return response.StatusCode, result
	}
	code, snapshot := request("GET", "?view=review&virtual_model=vibe%2Ftext2sql-review", "")
	if code != 200 || snapshot["review_supported"] != true || snapshot["profile"] != nil || snapshot["revision"] != "absent" {
		t.Fatal("missing create review capability")
	}
	input := profileReviewBody()
	input["mode"] = " EXECUTE "
	input["exec_connection_id"] = " selected "
	input["enabled"] = false
	raw, _ := json.Marshal(input)
	code, result := request("PUT", "", string(raw))
	if code != 200 {
		t.Fatalf("reviewed HTTP save status %d", code)
	}
	created := result["profile"].(map[string]any)
	if created["mode"] != "execute" || created["exec_connection_id"] != "selected" || created["enabled"] != false || created["updated_at"] == "" || len(created["revision"].(string)) != 64 {
		t.Fatal("incorrect committed snapshot")
	}
	code, snapshot = request("GET", "?view=review&virtual_model=vibe%2Ftext2sql-review", "")
	if code != 200 || !reflect.DeepEqual(snapshot["profile"], created) || snapshot["revision"] != created["revision"] {
		t.Fatal("review snapshot differs from committed record")
	}
	input["expected_revision"] = snapshot["revision"]
	input["mode"] = "preview"
	raw, _ = json.Marshal(input)
	code, result = request("PUT", "", string(raw))
	if code != 200 || result["profile"].(map[string]any)["revision"] == created["revision"] {
		t.Fatal("edit revision not advanced")
	}
	code, _ = request("PUT", "", string(raw))
	if code != 409 {
		t.Fatal("stale retry overwrote record")
	}
	audits, err := db.ListAdminAudit(t.Context(), 10)
	if err != nil || len(audits) != 2 || !strings.Contains(audits[0].AfterValue, "정산 모델 설정") || audits[0].Action != "text2sql.profile.reviewed_upsert" {
		t.Fatal("review audit missing")
	}
	w := profileReviewRequest(s, "GET", "?view=review&virtual_model=vibe%2Ftext2sql-review", "", "")
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("review snapshot is cacheable")
	}
}

func TestText2SQLProfileReviewedRejectsAmbiguousInput(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	valid := profileReviewBody()
	encoded, _ := json.Marshal(valid)
	base := string(encoded)
	cases := []string{"null", "[]", base + " {}", base + strings.Repeat(" ", text2SQLProfileReviewBodyLimit), strings.Replace(base, `"enabled":true`, `"enabled":true,"enabled":false`, 1), strings.Replace(base, `"reason":`, `"Reason":`, 1)}
	for key := range valid {
		missing := profileReviewBody()
		delete(missing, key)
		b, _ := json.Marshal(missing)
		cases = append(cases, string(b))
		missing = profileReviewBody()
		missing[key] = nil
		b, _ = json.Marshal(missing)
		cases = append(cases, string(b))
	}
	for key, value := range map[string]any{"unknown": "extra", "expected_revision": "bad", "mode": "automatic", "reason": strings.Repeat("한", 501), "virtual_model": "other/model", "upstream_model": strings.Repeat("a", 513), "enabled": "true"} {
		body := profileReviewBody()
		body[key] = value
		raw, _ := json.Marshal(body)
		cases = append(cases, string(raw))
	}
	for _, body := range cases {
		w := profileReviewRequest(s, "PUT", "", body, "")
		if w.Code != 400 {
			t.Fatalf("ambiguous input accepted with status %d", w.Code)
		}
	}
	for _, q := range []string{"?extra=1", "?view=review&virtual_model=vibe/text2sql-review", "?expected_revision=absent"} {
		if profileReviewRequest(s, "PUT", q, base, "").Code != 400 {
			t.Fatal("PUT query accepted")
		}
	}
	for _, q := range []string{"?view=review", "?view=review&virtual_model=other", "?view=review&view=review&virtual_model=vibe/text2sql-review", "?view=review&virtual_model=vibe/text2sql-review&extra=1"} {
		if profileReviewRequest(s, "GET", q, "", "").Code != 400 {
			t.Fatal("ambiguous review query accepted")
		}
	}
	profiles, err := db.ListText2SQLProfiles(t.Context())
	audits, auditErr := db.ListAdminAudit(t.Context(), 10)
	if err != nil || auditErr != nil || len(profiles) != 0 || len(audits) != 0 {
		t.Fatal("invalid review mutated store")
	}
}

func TestText2SQLProfileReviewedAuthAndFailure(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "public-profile-session-fixture"
	raw, _ := json.Marshal(profileReviewBody())
	for _, tc := range []struct {
		name, role string
		scopes     []string
		get, put   int
	}{
		{"admin", "super_admin", []string{"admin:read", "admin:write"}, 200, 200},
		{"reader", "super_admin", []string{"admin:read"}, 200, 401},
		{"writer", "super_admin", []string{"admin:write"}, 401, 403},
		{"masked", "readonly_admin", []string{"admin:read", "admin:write"}, 403, 403},
		{"none", "super_admin", nil, 401, 401},
	} {
		token := issueLLMScopedTestToken(t, db, s, "profile-"+tc.name, tc.role, "", tc.scopes, time.Now().UTC())
		get := profileReviewRequest(s, "GET", "?view=review&virtual_model=vibe/text2sql-review", "", token)
		// Each authorization case uses its own identifier.
		if get.Code != tc.get {
			t.Fatalf("%s GET status %d", tc.name, get.Code)
		}
		body := profileReviewBody()
		body["virtual_model"] = "vibe/text2sql-" + tc.name
		encoded, _ := json.Marshal(body)
		put := profileReviewRequest(s, "PUT", "", string(encoded), token)
		if put.Code != tc.put {
			t.Fatalf("%s PUT status %d", tc.name, put.Code)
		}
	}
	s.cfg.Auth.Enabled = false
	s.cfg.Auth.AdminToken = "fixture-admin"
	s.cfg.Auth.AdminReadonlyToken = "fixture-reader"
	if profileReviewRequest(s, "PUT", "", string(raw), "fixture-reader").Code != 401 {
		t.Fatal("legacy readonly wrote profile")
	}
	if profileReviewRequest(s, "GET", "?view=review&virtual_model=vibe/text2sql-review", "", "fixture-reader").Code != 403 {
		t.Fatal("legacy readonly saw raw profile")
	}
	if profileReviewRequest(s, "PUT", "", string(raw), "fixture-admin").Code != 200 {
		t.Fatal("legacy admin denied")
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"GET", "PUT"} {
		query := ""
		if method == "GET" {
			query = "?view=review&virtual_model=vibe/text2sql-review"
		}
		w := profileReviewRequest(s, method, query, string(raw), "fixture-admin")
		body, _ := io.ReadAll(w.Result().Body)
		if w.Code != 503 || strings.Contains(string(body), "database is closed") {
			t.Fatal("storage failure leaked or succeeded")
		}
	}
}

func TestText2SQLProfileReviewedLegacyConflict(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	input := profileReviewBody()
	raw, _ := json.Marshal(input)
	if profileReviewRequest(s, "PUT", "", string(raw), "").Code != 200 {
		t.Fatal("create failed")
	}
	before, _, err := db.GetText2SQLProfile(t.Context(), "vibe/text2sql-review")
	if err != nil {
		t.Fatal(err)
	}
	input["expected_revision"] = before.Revision
	input["mode"] = "execute"
	raw, _ = json.Marshal(input)
	if err := db.UpsertText2SQLProfile(t.Context(), store.Text2SQLProfile{VirtualModel: before.VirtualModel, Mode: "preview", ExecConnectionID: "new-source", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if profileReviewRequest(s, "PUT", "", string(raw), "").Code != 409 {
		t.Fatal("legacy change overwritten")
	}
	audits, err := db.ListAdminAudit(t.Context(), 10)
	if err != nil || len(audits) != 1 {
		t.Fatal("failed write added success audit")
	}
}
