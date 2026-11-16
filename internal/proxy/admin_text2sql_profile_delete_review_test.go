package proxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func profileDeleteReviewBody(t *testing.T, db *store.SQLStore, model string) map[string]any {
	t.Helper()
	if err := db.UpsertText2SQLProfile(t.Context(), store.Text2SQLProfile{VirtualModel: model, Mode: "execute", Enabled: true, ExecConnectionID: "analytics"}); err != nil {
		t.Fatal(err)
	}
	p, found, err := db.GetText2SQLProfile(t.Context(), model)
	if err != nil || !found {
		t.Fatal("profile fixture unavailable")
	}
	return map[string]any{"virtual_model": model, "confirmation": model, "expected_revision": p.Revision, "reason": "  이전 프로필 정리  "}
}
func profileDeleteReviewRequest(s *Server, method, suffix, body, token string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, text2SQLProfileDeleteReviewPath+suffix, strings.NewReader(body))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	s.handleText2SQLProfileReviewedDelete(w, r)
	return w
}
func TestText2SQLProfileDeleteReviewedHTTP(t *testing.T) {
	_, db, gateway := newAdminModelsTestServer(t, "")
	model := "vibe/text2sql-reviewed-delete"
	input := profileDeleteReviewBody(t, db, model)
	before, _, _ := db.GetText2SQLProfile(t.Context(), model)
	raw, _ := json.Marshal(input)
	for attempt, expectedStatus := range []int{200, 409} {
		response, err := http.Post(gateway.URL+text2SQLProfileDeleteReviewPath, "application/json", strings.NewReader(string(raw)))
		if err != nil {
			t.Fatal(err)
		}
		var result map[string]any
		err = json.NewDecoder(response.Body).Decode(&result)
		response.Body.Close()
		if err != nil || response.StatusCode != expectedStatus || !validRequestID(response.Header.Get("X-Request-ID")) {
			t.Fatal("reviewed delete HTTP contract failed", response.StatusCode, err)
		}
		if attempt == 0 && (result["status"] != "deleted" || result["virtual_model"] != model || result["reviewed_revision"] != input["expected_revision"] || response.Header.Get("Cache-Control") != "no-store") {
			t.Fatal("missing exact deletion receipt")
		}
	}
	_, found, err := db.GetText2SQLProfile(t.Context(), model)
	audits, auditErr := db.ListAdminAudit(t.Context(), 10)
	if err != nil || auditErr != nil || found || len(audits) != 1 || audits[0].Action != "text2sql.profile.reviewed_delete" {
		t.Fatal("deletion audit missing or duplicated")
	}
	var recordedBefore store.Text2SQLProfile
	var recordedAfter map[string]any
	if json.Unmarshal([]byte(audits[0].BeforeValue), &recordedBefore) != nil || json.Unmarshal([]byte(audits[0].AfterValue), &recordedAfter) != nil {
		t.Fatal("invalid deletion audit")
	}
	if recordedBefore.Revision != before.Revision || recordedBefore.ExecConnectionID != before.ExecConnectionID || recordedAfter["reason"] != "이전 프로필 정리" || recordedAfter["expected_revision"] != before.Revision {
		t.Fatal("audit must preserve reviewed state and reason")
	}
}

func TestText2SQLProfileDeleteReviewedInvalidInput(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	model := "vibe/text2sql-reviewed-delete"
	input := profileDeleteReviewBody(t, db, model)
	before, _, _ := db.GetText2SQLProfile(t.Context(), model)
	raw, _ := json.Marshal(input)
	base := string(raw)
	cases := []string{"null", "[]", base + " {}", base + strings.Repeat(" ", 4<<10), string([]byte{0xff}), strings.Replace(base, `"confirmation":`, `"Confirmation":`, 1), strings.Replace(base, `"reason":`, `"reason":"first","reason":`, 1)}
	clone := func() map[string]any {
		out := map[string]any{}
		for key, value := range input {
			out[key] = value
		}
		return out
	}
	for key := range input {
		for _, missing := range []bool{true, false} {
			body := clone()
			if missing {
				delete(body, key)
			} else {
				body[key] = nil
			}
			encoded, _ := json.Marshal(body)
			cases = append(cases, string(encoded))
		}
	}
	for key, value := range map[string]any{"unknown": true, "confirmation": model + " ", "virtual_model": strings.ToUpper(model), "expected_revision": "absent", "reason": strings.Repeat("한", 501)} {
		body := clone()
		body[key] = value
		encoded, _ := json.Marshal(body)
		cases = append(cases, string(encoded))
	}
	for _, body := range cases {
		if w := profileDeleteReviewRequest(s, "POST", "", body, ""); w.Code != 400 {
			t.Fatal("invalid reviewed delete accepted", w.Code)
		}
	}
	if profileDeleteReviewRequest(s, "POST", "?reason=override", base, "").Code != 400 {
		t.Fatal("query accepted")
	}
	for _, method := range []string{"GET", "HEAD", "PUT", "DELETE"} {
		w := profileDeleteReviewRequest(s, method, "", base, "")
		if w.Code != 405 || w.Header().Get("Allow") != "POST" {
			t.Fatal("unexpected deletion method accepted")
		}
	}
	if profileDeleteReviewRequest(s, "POST", "/extra", base, "").Code != 404 {
		t.Fatal("wrong path accepted")
	}
	after, _, _ := db.GetText2SQLProfile(t.Context(), model)
	audits, err := db.ListAdminAudit(t.Context(), 10)
	if !reflect.DeepEqual(before, after) || err != nil || len(audits) != 0 {
		t.Fatal("invalid action changed profile or audit")
	}
	if err := db.UpsertText2SQLProfile(t.Context(), before); err != nil {
		t.Fatal(err)
	}
	if profileDeleteReviewRequest(s, "POST", "", base, "").Code != 409 {
		t.Fatal("legacy same-value write not detected")
	}
}

func TestText2SQLProfileDeleteReviewedAuthAndFailure(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "public-profile-delete-session-fixture"
	for _, tc := range []struct {
		name, role string
		scopes     []string
		status     int
	}{
		{"admin", "super_admin", []string{"admin:read", "admin:write"}, 200},
		{"reader", "super_admin", []string{"admin:read"}, 401},
		{"writer", "super_admin", []string{"admin:write"}, 403},
		{"masked", "readonly_admin", []string{"admin:read", "admin:write"}, 403},
		{"none", "super_admin", nil, 401},
	} {
		token := issueLLMScopedTestToken(t, db, s, "profile-delete-"+tc.name, tc.role, "", tc.scopes, time.Now().UTC())
		input := profileDeleteReviewBody(t, db, "vibe/text2sql-delete-"+tc.name)
		raw, _ := json.Marshal(input)
		if w := profileDeleteReviewRequest(s, "POST", "", string(raw), token); w.Code != tc.status {
			t.Fatalf("%s deletion status %d", tc.name, w.Code)
		}
		_, found, err := db.GetText2SQLProfile(t.Context(), input["virtual_model"].(string))
		if err != nil || found != (tc.status != 200) {
			t.Fatal("unauthorized delete changed record")
		}
	}
	s.cfg.Auth.Enabled = false
	s.cfg.Auth.AdminToken, s.cfg.Auth.AdminReadonlyToken = "fixture-admin", "fixture-reader"
	raw, _ := json.Marshal(profileDeleteReviewBody(t, db, "vibe/text2sql-delete-legacy"))
	if profileDeleteReviewRequest(s, "POST", "", string(raw), "fixture-reader").Code != 401 {
		t.Fatal("legacy readonly deleted profile")
	}
	if profileDeleteReviewRequest(s, "POST", "", string(raw), "fixture-admin").Code != 200 {
		t.Fatal("legacy admin denied")
	}
	raw, _ = json.Marshal(profileDeleteReviewBody(t, db, "vibe/text2sql-delete-unavailable"))
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	w := profileDeleteReviewRequest(s, "POST", "", string(raw), "fixture-admin")
	if w.Code != 503 || strings.Contains(w.Body.String(), "database is closed") {
		t.Fatal("storage error leaked or succeeded")
	}
}
