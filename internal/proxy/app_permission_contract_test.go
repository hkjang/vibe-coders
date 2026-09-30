package proxy

import (
	"encoding/json"
	"net/http"
	"net/url"
	"reflect"
	"slices"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// Explicit app grants are additive, not an allowlist replacing the app's team
// and role conditions. Exercise the actual routes, JWT sessions and database.
func TestAppPermissionContractAdditiveVisibilityAndIdempotence(t *testing.T) {
	f := newAppPermissionContractFixture(t)
	before := f.app(t, "permission-active")
	user := f.token(t, "permission-user", "developer", "other-team", nil)
	peer := f.token(t, "permission-peer", "developer", "other-team", nil)
	member := f.token(t, "permission-member", "developer", "allowed-team", nil)
	wrongRole := f.token(t, "permission-role", "reviewer", "allowed-team", nil)
	f.visible(t, user, false, false)
	f.visible(t, peer, false, false)
	f.visible(t, member, true, false)
	f.visible(t, wrongRole, false, false)

	f.request(t, http.MethodPost, f.path, f.adminToken,
		`{"subject_type":" USER ","subject_id":" permission-user "}`, http.StatusOK)
	first := f.permissions(t)
	if len(first) != 1 || first[0].SubjectType != "user" || first[0].SubjectID != "permission-user" ||
		first[0].GrantedBy != "admin_"+hashProxyKey(f.adminToken)[:12] || first[0].CreatedAt == "" {
		t.Fatal("grant must preserve normalized target and the existing pseudonymous administrator audit identity")
	}
	f.visible(t, user, true, false)
	f.visible(t, peer, false, false)
	secondAdmin := f.token(t, "permission-second-admin", "super_admin", "", []string{"admin:read", "admin:write"})
	f.request(t, http.MethodPost, f.path, secondAdmin,
		`{"subject_type":"user","subject_id":"permission-user"}`, http.StatusOK)
	if !reflect.DeepEqual(first, f.permissions(t)) {
		t.Fatal("repeated grant must not replace grant identity, administrator or creation time")
	}

	f.request(t, http.MethodPost, f.path, f.adminToken,
		`{"subject_type":"team","subject_id":"other-team"}`, http.StatusOK)
	f.visible(t, peer, true, false)
	f.revoke(t, "user", "permission-user")
	f.visible(t, user, true, false) // A remaining team grant still permits access.
	f.revoke(t, "team", "other-team")
	f.visible(t, user, false, false)
	f.visible(t, peer, false, false)
	f.revoke(t, "team", "other-team") // Missing tuple is an idempotent success.
	if len(f.permissions(t)) != 0 {
		t.Fatal("revocation must remove only the selected explicit tuples")
	}

	for _, subject := range []string{"permission-member", "permission-role"} {
		body, _ := json.Marshal(map[string]string{"subject_type": "user", "subject_id": subject})
		f.request(t, http.MethodPost, f.path, f.adminToken, string(body), http.StatusOK)
	}
	f.visible(t, wrongRole, true, false)
	f.revoke(t, "user", "permission-member")
	f.visible(t, member, true, false) // Coarse team+role conditions still allow access.
	f.revoke(t, "user", "permission-role")
	f.visible(t, wrongRole, false, false)
	f.request(t, http.MethodPost, "/admin/apps/permission-archived/permissions", f.adminToken,
		`{"subject_type":"user","subject_id":"permission-user"}`, http.StatusOK)
	f.visible(t, user, false, false) // An explicit grant cannot reveal an archived app.
	f.request(t, http.MethodGet, "/v1/apps/permission-other", user, "", http.StatusNotFound)
	if !reflect.DeepEqual(before, f.app(t, "permission-active")) {
		t.Fatal("permission changes must not modify the app's base team, role, status or content")
	}

	events, err := f.db.ListAdminAudit(t.Context(), 100)
	if err != nil {
		t.Fatal("app permission audit lookup failed")
	}
	for _, action := range []string{"work_app.permission_grant", "work_app.permission_revoke"} {
		if !slices.ContainsFunc(events, func(event store.AdminAuditPublic) bool {
			var target struct {
				SubjectType string `json:"subject_type"`
				SubjectID   string `json:"subject_id"`
			}
			return event.Action == action && event.AdminID == "admin_"+hashProxyKey(f.adminToken)[:12] &&
				event.BeforeValue == "permission-active" && json.Unmarshal([]byte(event.AfterValue), &target) == nil &&
				target.SubjectType == "user" && target.SubjectID == "permission-user"
		}) {
			t.Fatal("permission change must retain the existing administrator and target audit contract")
		}
	}
}

func TestAppPermissionContractOpaqueTargetsRemainDistinct(t *testing.T) {
	f := newAppPermissionContractFixture(t)
	app := f.app(t, "permission-active")
	const canonical = "permission-user"
	const prefixed = "\uFEFFpermission-user"
	const unicodeTarget = "사용자-한글"
	grant := func(subject string) {
		t.Helper()
		body, err := json.Marshal(map[string]string{"subject_type": "user", "subject_id": subject})
		if err != nil {
			t.Fatal("opaque target fixture encoding failed")
		}
		f.request(t, http.MethodPost, f.path, f.adminToken, string(body), http.StatusOK)
	}
	assertTargets := func(want ...string) {
		t.Helper()
		permissions := f.permissions(t)
		if len(permissions) != len(want) {
			t.Fatal("opaque permission targets must remain separate stored tuples")
		}
		for _, subject := range want {
			if !slices.ContainsFunc(permissions, func(permission store.AppPermission) bool {
				return permission.SubjectType == "user" && permission.SubjectID == subject
			}) {
				t.Fatal("permission API normalized or removed a different opaque target")
			}
		}
	}
	// ECMAScript trim removes U+FEFF, but the existing Go API preserves it.
	// A UI must never normalize a stored revocation target into another tuple.
	for _, subject := range []string{canonical, prefixed, unicodeTarget} {
		grant(subject)
	}
	assertTargets(canonical, prefixed, unicodeTarget)
	f.revoke(t, "user", canonical)
	assertTargets(prefixed, unicodeTarget)
	grant(canonical)
	f.revoke(t, "user", prefixed)
	assertTargets(canonical, unicodeTarget)
	f.revoke(t, "user", unicodeTarget)
	assertTargets(canonical)
	if !reflect.DeepEqual(app, f.app(t, "permission-active")) {
		t.Fatal("opaque permission target changes must not alter the base app")
	}
}

func TestAppPermissionContractImportedWhitespaceTargets(t *testing.T) {
	f := newAppPermissionContractFixture(t)
	const canonical = "permission-user"
	const imported = "\u0085permission-user"
	f.request(t, http.MethodPost, f.path, f.adminToken,
		`{"subject_type":"user","subject_id":"permission-user"}`, http.StatusOK)
	// NEL edges cannot be created through the current HTTP grant API, but old
	// or imported records can exist in the store and are returned without edits.
	if err := f.db.GrantAppPermission(t.Context(), store.AppPermission{
		ID: "permission-imported-nel", AppID: "permission-active",
		SubjectType: "user", SubjectID: imported, GrantedBy: "synthetic-import",
	}); err != nil {
		t.Fatal("imported permission fixture seed failed")
	}
	before := f.permissions(t)
	if len(before) != 2 || !slices.ContainsFunc(before, func(permission store.AppPermission) bool {
		return permission.SubjectID == imported
	}) {
		t.Fatal("public list must retain imported opaque identifiers exactly")
	}
	// Preserve the old API's Go TrimSpace contract; do not pretend it accepts
	// an exact imported target. The UI must reject this row before DELETE,
	// since forwarding it would remove the canonical grant instead.
	f.revoke(t, "user", imported)
	after := f.permissions(t)
	if len(after) != 1 || after[0].SubjectID != imported {
		t.Fatal("existing Go whitespace normalization contract changed")
	}
	f.revoke(t, "user", canonical)
	if !reflect.DeepEqual(after, f.permissions(t)) {
		t.Fatal("canonical repeat revocation must not remove the imported tuple")
	}
}

func TestAppPermissionContractWriteDenialsPreserveState(t *testing.T) {
	f := newAppPermissionContractFixture(t)
	f.request(t, http.MethodPost, f.path, f.adminToken,
		`{"subject_type":"user","subject_id":"permission-user"}`, http.StatusOK)
	before, app := f.permissions(t), f.app(t, "permission-active")
	readonly := f.token(t, "permission-readonly", "readonly_admin", "", []string{"admin:read"})
	unprivileged := f.token(t, "permission-ordinary", "developer", "", nil)
	f.request(t, http.MethodGet, f.path, readonly, "", http.StatusOK)
	for _, token := range []string{readonly, unprivileged, ""} {
		for _, method := range []string{http.MethodPost, http.MethodDelete} {
			path := f.path
			if method == http.MethodDelete {
				path += "?subject_type=user&subject_id=permission-user"
			}
			data := f.request(t, method, path, token,
				`{"subject_type":"team","subject_id":"not-granted"}`, http.StatusUnauthorized)
			f.errorCode(t, data, "invalid_api_key")
			if !reflect.DeepEqual(before, f.permissions(t)) || !reflect.DeepEqual(app, f.app(t, "permission-active")) {
				t.Fatal("a rejected permission write changed stored grants or app fields")
			}
		}
	}
	for _, token := range []string{unprivileged, ""} {
		f.request(t, http.MethodGet, f.path, token, "", http.StatusUnauthorized)
	}
}

func TestAppPermissionContractValidationAndMissingApp(t *testing.T) {
	f := newAppPermissionContractFixture(t)
	f.request(t, http.MethodPost, f.path, f.adminToken,
		`{"subject_type":"user","subject_id":"permission-user"}`, http.StatusOK)
	before, app := f.permissions(t), f.app(t, "permission-active")
	for _, tc := range []struct {
		method, path, body, code string
		status                   int
	}{
		{http.MethodPost, f.path, `{`, "bad_request", http.StatusBadRequest},
		{http.MethodPost, f.path, `{"subject_type":"role","subject_id":"developer"}`, "bad_subject", http.StatusBadRequest},
		{http.MethodPost, f.path, `{"subject_type":"user","subject_id":"  "}`, "bad_subject", http.StatusBadRequest},
		{http.MethodDelete, f.path + "?subject_type=user", "", "bad_subject", http.StatusBadRequest},
		{http.MethodDelete, f.path + "?subject_id=permission-user", "", "bad_subject", http.StatusBadRequest},
		{http.MethodGet, "/admin/apps/permission-missing/permissions", "", "not_found", http.StatusNotFound},
		{http.MethodPost, "/admin/apps/permission-missing/permissions", `{"subject_type":"user","subject_id":"permission-user"}`, "not_found", http.StatusNotFound},
		{http.MethodDelete, "/admin/apps/permission-missing/permissions?subject_type=user&subject_id=permission-user", "", "not_found", http.StatusNotFound},
	} {
		f.errorCode(t, f.request(t, tc.method, tc.path, f.adminToken, tc.body, tc.status), tc.code)
		if !reflect.DeepEqual(before, f.permissions(t)) || !reflect.DeepEqual(app, f.app(t, "permission-active")) {
			t.Fatal("invalid permission requests must not mutate existing grants or app fields")
		}
	}
	// Preserve, do not strengthen, the old DELETE contract: an unknown nonempty
	// type is accepted but cannot match our user grant. The UI must not guess user.
	f.request(t, http.MethodDelete, f.path+"?subject_type=role&subject_id=permission-user", f.adminToken, "", http.StatusOK)
	if !reflect.DeepEqual(before, f.permissions(t)) {
		t.Fatal("unknown-type revocation must not be silently redirected to a user grant")
	}
	// Existing API accepts a stable identifier without a directory existence lookup.
	f.request(t, http.MethodPost, f.path, f.adminToken,
		`{"subject_type":"user","subject_id":"not-a-directory-user"}`, http.StatusOK)
	if len(f.permissions(t)) != 2 {
		t.Fatal("permission API's opaque identifier contract changed")
	}
}

type appPermissionContractFixture struct {
	*apiKeyScopeContractFixture // Shared real-HTTP transport only; no key API calls.
	server                      *Server
	path                        string
}

func newAppPermissionContractFixture(t *testing.T) *appPermissionContractFixture {
	t.Helper()
	f := &appPermissionContractFixture{apiKeyScopeContractFixture: &apiKeyScopeContractFixture{}, path: "/admin/apps/permission-active/permissions"}
	f.gateway, f.server, f.db = scopedSettingsSecurityServer(t, "http://127.0.0.1:9")
	if !f.server.cfg.Auth.Enabled {
		t.Fatal("app permission contracts require authenticated real routes")
	}
	f.adminToken = f.token(t, "permission-admin", "super_admin", "", []string{"admin:read", "admin:write"})
	for _, id := range []string{"permission-active", "permission-archived", "permission-other"} {
		status := "active"
		if id == "permission-archived" {
			status = "archived"
		}
		if f.db.CreateWorkApp(t.Context(), store.WorkApp{
			ID: id, Title: "Synthetic permission app", Description: "public contract fixture", Owner: "fixture-owner",
			Status: status, AllowedTeams: "allowed-team", AllowedRoles: "developer",
			Components: []store.AppComponent{{Kind: "model", Ref: "synthetic-model", Label: "Synthetic model"}},
		}) != nil {
			t.Fatal("app permission fixture seed failed")
		}
	}
	return f
}

func (f *appPermissionContractFixture) token(t *testing.T, subject, role, team string, scopes []string) string {
	t.Helper()
	return issueLLMScopedTestToken(t, f.db, f.server, subject, role, team, scopes, time.Now().UTC())
}

func (f *appPermissionContractFixture) permissions(t *testing.T) []store.AppPermission {
	t.Helper()
	stored, err := f.db.ListAppPermissions(t.Context(), "permission-active")
	var response struct {
		AppID       string                `json:"app_id"`
		Permissions []store.AppPermission `json:"permissions"`
	}
	data := f.request(t, http.MethodGet, f.path, f.adminToken, "", http.StatusOK)
	if err != nil || json.Unmarshal(data, &response) != nil || response.AppID != "permission-active" ||
		response.Permissions == nil || !reflect.DeepEqual(stored, response.Permissions) {
		t.Fatal("public permission list must match the persisted app grant tuples")
	}
	return stored
}

func (f *appPermissionContractFixture) app(t *testing.T, id string) store.WorkApp {
	t.Helper()
	app, found, err := f.db.GetWorkApp(t.Context(), id)
	if err != nil || !found {
		t.Fatal("app permission fixture app lookup failed")
	}
	return app
}

func (f *appPermissionContractFixture) revoke(t *testing.T, kind, subject string) {
	t.Helper()
	query := url.Values{"subject_type": {kind}, "subject_id": {subject}}
	f.request(t, http.MethodDelete, f.path+"?"+query.Encode(), f.adminToken, "", http.StatusOK)
}

func (f *appPermissionContractFixture) visible(t *testing.T, token string, active, archived bool) {
	t.Helper()
	var response struct {
		Apps []store.WorkApp `json:"apps"`
	}
	if json.Unmarshal(f.request(t, http.MethodGet, "/v1/apps", token, "", http.StatusOK), &response) != nil {
		t.Fatal("app visibility response did not match the public schema")
	}
	for id, visible := range map[string]bool{"permission-active": active, "permission-archived": archived} {
		if slices.ContainsFunc(response.Apps, func(app store.WorkApp) bool { return app.ID == id }) != visible {
			t.Fatal("app list did not preserve additive access and active status rules")
		}
		status := http.StatusNotFound
		if visible {
			status = http.StatusOK
		}
		f.request(t, http.MethodGet, "/v1/apps/"+id, token, "", status)
	}
}

func (f *appPermissionContractFixture) errorCode(t *testing.T, data []byte, want string) {
	t.Helper()
	var response struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(data, &response) != nil || response.Error.Code != want {
		t.Fatal("permission rejection changed its stable public error code")
	}
}
