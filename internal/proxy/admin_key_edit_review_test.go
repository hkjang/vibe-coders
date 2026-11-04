package proxy

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

type countedKeyPatchBody struct {
	io.Reader
	read int
}

func (body *countedKeyPatchBody) Read(value []byte) (int, error) {
	n, err := body.Reader.Read(value)
	body.read += n
	return n, err
}

func (*countedKeyPatchBody) Close() error { return nil }

func TestAdminKeyEditParserBoundsInputBeforeDecode(t *testing.T) {
	review := `"review":{"reason":"검토","expected_revision":"` + strings.Repeat("a", 64) + `"}`
	for _, parts := range [][2]string{
		{`{` + review + `,"name":"`, `"}`},
		{`{"name":"`, `",` + review + `}`},
		{`{"extension":"`, `",` + review + `}`},
		{`{"name":"`, `"}`},
	} {
		body := &countedKeyPatchBody{Reader: io.MultiReader(strings.NewReader(parts[0]), strings.NewReader(strings.Repeat("x", 1<<20)), strings.NewReader(parts[1]))}
		r := httptest.NewRequest(http.MethodPatch, "/", nil)
		r.Body = body
		_, err := readAdminKeyPatchRequest(httptest.NewRecorder(), r)
		if err == nil || body.read > 8193 {
			t.Fatal("PATCH decoder must stop reading before buffering an oversized JSON value")
		}
	}
}

func TestAdminKeyEditParserExactByteBoundary(t *testing.T) {
	review := `"review":{"reason":"검토","expected_revision":"` + strings.Repeat("a", 64) + `"}`
	for _, suffix := range []string{`"}`, `",` + review + `}`} {
		for _, size := range []int{8192, 8193} {
			prefix := `{"name":"`
			body := prefix + strings.Repeat("x", size-len(prefix)-len(suffix)) + suffix
			r := httptest.NewRequest(http.MethodPatch, "/", strings.NewReader(body))
			_, err := readAdminKeyPatchRequest(httptest.NewRecorder(), r)
			if (err == nil) != (size == 8192) {
				t.Fatal("PATCH byte boundary mismatch")
			}
		}
	}
}

func TestAdminKeyEditReviewRejectsStaleBrowserSnapshot(t *testing.T) {
	f := newAPIKeyScopeContractFixture(t)
	key := store.APIKeyRecord{ID: "edit-review-stale", Name: "원래 이름", KeyHash: "public-edit-fixture", Role: "developer", Status: "active"}
	if f.db.UpsertAPIKey(t.Context(), key) != nil {
		t.Fatal("fixture unavailable")
	}
	key = f.key(t, key.ID)
	revision, err := f.db.APIKeyRevision(t.Context(), key)
	if err != nil {
		t.Fatal("review unavailable")
	}
	key.Name = "다른 관리자의 변경"
	if f.db.UpsertAPIKey(t.Context(), key) != nil {
		t.Fatal("concurrent edit unavailable")
	}
	body, _ := json.Marshal(map[string]any{"name": "오래된 초안", "review": map[string]string{"reason": "변경 검토", "expected_revision": revision}})
	f.request(t, http.MethodPatch, "/admin/api-keys/"+key.ID, f.adminToken, string(body), http.StatusConflict)
	if f.key(t, key.ID).Name != key.Name {
		t.Fatal("stale browser review overwrote a newer edit")
	}
}

func TestAdminKeyEditReviewRejectsCappedRotation(t *testing.T) {
	f := newAPIKeyScopeContractFixture(t)
	key := store.APIKeyRecord{ID: "edit-capped-rotation", Name: "교체 전", KeyHash: "synthetic-capped-old", UserID: "review-owner", Role: "developer", Status: "active", Scopes: []string{"chat:completion"}, ExpiresAt: time.Now().UTC().Add(time.Hour)}
	if f.db.UpsertAPIKey(t.Context(), key) != nil {
		t.Fatal("fixture unavailable")
	}
	key = f.key(t, key.ID)
	revision, err := f.db.APIKeyRevision(t.Context(), key)
	if err != nil {
		t.Fatal("revision unavailable")
	}
	created := store.AuthEvent{ID: "edit-capped-created", APIKeyID: "edit-capped-replacement", EventType: "api_key_created", ActorUserID: key.UserID}
	rotated := store.AuthEvent{ID: "edit-capped-rotated", APIKeyID: key.ID, EventType: "api_key_rotated", ActorUserID: key.UserID}
	if _, err := f.db.RotateAPIKey(t.Context(), key, created.APIKeyID, "synthetic-capped-new", store.MaxAPIKeyRotationGrace, created, rotated); err != nil {
		t.Fatal("rotation failed")
	}
	body, _ := json.Marshal(map[string]any{"scopes": []string{}, "review": map[string]string{"reason": "교체 전 권한 검토", "expected_revision": revision}})
	f.request(t, http.MethodPatch, "/admin/api-keys/"+key.ID, f.adminToken, string(body), http.StatusConflict)
	if len(f.key(t, key.ID).Scopes) != 1 || len(f.key(t, created.APIKeyID).Scopes) != 1 {
		t.Fatal("stale edit changed original or replacement grants")
	}
	audits, err := f.db.ListAdminAudit(t.Context(), 20)
	if err != nil || len(audits) != 0 {
		t.Fatal("rejected stale edit produced success audit")
	}
}

func TestAdminKeyEditReviewRecordsReasonAndAdvertisesCapability(t *testing.T) {
	f := newAPIKeyScopeContractFixture(t)
	key := store.APIKeyRecord{ID: "edit-review-valid", Name: "검토 전", KeyHash: "public-valid-edit-fixture", Role: "developer", Status: "active"}
	if f.db.UpsertAPIKey(t.Context(), key) != nil {
		t.Fatal("fixture unavailable")
	}
	key = f.key(t, key.ID)
	revision, err := f.db.APIKeyRevision(t.Context(), key)
	if err != nil {
		t.Fatal("review unavailable")
	}
	body, _ := json.Marshal(map[string]any{"name": "검토 후", "review": map[string]string{"reason": "업무 이름 정리", "expected_revision": revision}})
	f.request(t, http.MethodPatch, "/admin/api-keys/"+key.ID, f.adminToken, string(body), http.StatusOK)
	audits, err := f.db.ListAdminAudit(t.Context(), 20)
	if err != nil || len(audits) != 1 || !strings.Contains(audits[0].AfterValue, "업무 이름 정리") || strings.Contains(audits[0].AfterValue, revision) {
		t.Fatal("review reason must be audited without its opaque revision")
	}
	var catalog struct {
		EditReviewSupported bool `json:"edit_review_supported"`
	}
	raw := f.request(t, http.MethodGet, "/admin/api-keys", f.adminToken, "", http.StatusOK)
	if json.Unmarshal(raw, &catalog) != nil || !catalog.EditReviewSupported {
		t.Fatal("edit review capability missing")
	}
}

func TestAdminKeyEditReviewRejectsMalformedReview(t *testing.T) {
	for _, body := range []string{
		`{"name":"x","review":{"reason":"확인"}}`,
		`{"name":"x","review":{"reason":null,"expected_revision":"` + strings.Repeat("a", 64) + `"}}`,
		`{"name":"x","review":{"reason":"확인","expected_revision":null}}`,
		`{"name":"x","review":{"reason":" ","expected_revision":"` + strings.Repeat("a", 64) + `"}}`,
		`{"name":"x","review":{"reason":"확인","reason":"중복","expected_revision":"` + strings.Repeat("a", 64) + `"}}`,
	} {
		f := newAPIKeyScopeContractFixture(t)
		key := store.APIKeyRecord{ID: "edit-review-invalid", Name: "보존할 이름", KeyHash: "public-invalid-edit-fixture", Role: "developer", Status: "active"}
		if f.db.UpsertAPIKey(t.Context(), key) != nil {
			t.Fatal("fixture unavailable")
		}
		f.request(t, http.MethodPatch, "/admin/api-keys/"+key.ID, f.adminToken, body, http.StatusBadRequest)
		if f.key(t, key.ID).Name != key.Name {
			t.Fatal("invalid review changed metadata")
		}
	}
}

func TestAdminKeyEditReviewParserCompatibility(t *testing.T) {
	review := `"review":{"reason":"검토 사유","expected_revision":"` + strings.Repeat("a", 64) + `"}`
	for _, tc := range []struct {
		name  string
		body  string
		valid bool
	}{
		{"legacy null", `null`, true},
		{"legacy empty", `{}`, true},
		{"legacy omitted fields", `{"name":"이름"}`, true},
		{"legacy null scopes", `{"scopes":null}`, true},
		{"legacy empty scopes", `{"scopes":[]}`, true},
		{"legacy unknown field", `{"name":"이름","extra":true}`, true},
		{"legacy trailing value", `{"name":"이름"} {}`, true},
		{"paired review", `{"name":"이름",` + review + `}`, true},
		{"review preserves null semantics", `{"name":null,"scopes":null,` + review + `}`, true},
		{"review explicit empty scopes", `{"scopes":[],` + review + `}`, true},
		{"review trailing value", `{"name":"이름",` + review + `} {}`, false},
		{"review unknown field", `{"name":"이름","extra":true,` + review + `}`, false},
		{"review duplicate editable field", `{"name":"a","name":"b",` + review + `}`, false},
		{"review mixed case field", `{"Name":"a",` + review + `}`, false},
		{"review mixed case marker", `{"Review":{"reason":"확인","expected_revision":"` + strings.Repeat("a", 64) + `"}}`, false},
		{"review null", `{"name":"이름","review":null}`, false},
		{"review empty", `{"name":"이름","review":{}}`, false},
		{"review oversized reason", `{"name":"이름","review":{"reason":"` + strings.Repeat("가", 1025) + `","expected_revision":"` + strings.Repeat("a", 64) + `"}}`, false},
		{"review oversized object", `{"name":"` + strings.Repeat("a", 8192) + `",` + review + `}`, false},
		{"review oversized whitespace", strings.Repeat(" ", 8192) + `{` + review + `}`, false},
		{"review oversized trailing whitespace", `{` + review + `}` + strings.Repeat(" ", 8192), false},
		{"review invalid UTF-8", `{"name":"` + string([]byte{255}) + `",` + review + `}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPatch, "/", strings.NewReader(tc.body))
			_, err := readAdminKeyPatchRequest(httptest.NewRecorder(), request)
			if (err == nil) != tc.valid {
				t.Fatal("PATCH compatibility or review validation mismatch")
			}
		})
	}
}

func TestAdminKeyEditReviewDoesNotAuditNoOp(t *testing.T) {
	f := newAPIKeyScopeContractFixture(t)
	key := store.APIKeyRecord{ID: "edit-review-noop", Name: "같은 이름", KeyHash: "public-noop-fixture", Role: "developer", Status: "active"}
	if f.db.UpsertAPIKey(t.Context(), key) != nil {
		t.Fatal("fixture unavailable")
	}
	key = f.key(t, key.ID)
	revision, err := f.db.APIKeyRevision(t.Context(), key)
	if err != nil {
		t.Fatal("review unavailable")
	}
	body, _ := json.Marshal(map[string]any{"name": key.Name, "review": map[string]string{"reason": "변경 없는 요청", "expected_revision": revision}})
	f.request(t, http.MethodPatch, "/admin/api-keys/"+key.ID, f.adminToken, string(body), http.StatusBadRequest)
	audits, err := f.db.ListAdminAudit(t.Context(), 20)
	if err != nil || len(audits) != 0 {
		t.Fatal("no-op reviewed request must not create a change audit")
	}
}
