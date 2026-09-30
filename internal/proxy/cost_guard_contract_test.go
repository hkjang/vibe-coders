package proxy

import (
	"encoding/json"
	"math"
	"net/http"
	"reflect"
	"slices"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestCostGuardContractOptionalNullAndExplicitValues(t *testing.T) {
	f := newCostGuardContractFixture(t)
	f.config(t, http.MethodGet, "", false, 0)
	for _, body := range []string{`{}`, `null`, `{"enabled":null,"threshold_krw":null}`} {
		f.config(t, http.MethodPost, body, false, 0)
		if len(f.flags(t)) != 0 {
			t.Fatal("no-op cost patch must not create missing flags")
		}
	}
	f.config(t, http.MethodPost, `{"enabled":true,"threshold_krw":47.25}`, true, 47.25)
	before := f.flags(t)
	f.config(t, http.MethodPost, `{"enabled":false}`, false, 47.25)
	if !reflect.DeepEqual(before["cost_guard_threshold_krw"], f.flags(t)["cost_guard_threshold_krw"]) {
		t.Fatal("omitted threshold must retain its value and metadata")
	}
	before = f.flags(t)
	f.config(t, http.MethodPost, `{"enabled":null,"threshold_krw":27.5}`, false, 27.5)
	if !reflect.DeepEqual(before["cost_guard_enabled"], f.flags(t)["cost_guard_enabled"]) {
		t.Fatal("null enabled must retain its value and metadata")
	}
	before = f.flags(t)
	f.config(t, http.MethodPost, `{"enabled":true,"threshold_krw":null}`, true, 27.5)
	if !reflect.DeepEqual(before["cost_guard_threshold_krw"], f.flags(t)["cost_guard_threshold_krw"]) {
		t.Fatal("null threshold must retain its value and metadata")
	}
	before = f.flags(t)
	for _, body := range []string{`{}`, `null`, `{"enabled":null,"threshold_krw":null}`} {
		f.config(t, http.MethodPost, body, true, 27.5)
		if !reflect.DeepEqual(before, f.flags(t)) {
			t.Fatal("no-op cost patch must not rewrite existing flags")
		}
	}
	f.config(t, http.MethodPost, `{"enabled":false,"threshold_krw":0}`, false, 0)
	f.config(t, http.MethodGet, "", false, 0)
}

func TestCostGuardContractInvalidPatchIsNotPartiallyApplied(t *testing.T) {
	f := newCostGuardContractFixture(t)
	f.config(t, http.MethodPost, `{"enabled":false,"threshold_krw":47.25}`, false, 47.25)
	before, events := f.flags(t), f.audit(t)
	cached := f.server.costSnapshotCached(t.Context())
	for _, body := range []string{
		`{"enabled":true,"threshold_krw":-1}`, `{"enabled":true,"threshold_krw":-0.01}`,
		`{"enabled":true,"threshold_krw":"0"}`, `{"enabled":"true","threshold_krw":0}`,
		`{"enabled":true,"threshold_krw":1e309}`, `{`,
	} {
		f.request(t, http.MethodPost, "/admin/cost", f.adminToken, body, http.StatusBadRequest)
		if !reflect.DeepEqual(before, f.flags(t)) || !reflect.DeepEqual(events, f.audit(t)) {
			t.Fatal("invalid cost patch changed flags, metadata or committed audit")
		}
		if f.server.costCache.Load() != cached {
			t.Fatal("rejected cost patch invalidated the previously confirmed cache")
		}
	}
}

func TestCostGuardContractWriteDenialsPreserveState(t *testing.T) {
	f := newCostGuardContractFixture(t)
	f.config(t, http.MethodPost, `{"enabled":true,"threshold_krw":11.5}`, true, 11.5)
	before, events := f.flags(t), f.audit(t)
	readonly := f.token(t, "cost-readonly", "readonly_admin", []string{"admin:read"})
	ordinary := f.token(t, "cost-ordinary", "developer", nil)
	f.request(t, http.MethodGet, "/admin/cost", readonly, "", http.StatusOK)
	for _, token := range []string{readonly, ordinary, ""} {
		f.request(t, http.MethodPost, "/admin/cost", token,
			`{"enabled":false,"threshold_krw":0}`, http.StatusUnauthorized)
		if !reflect.DeepEqual(before, f.flags(t)) || !reflect.DeepEqual(events, f.audit(t)) {
			t.Fatal("denied cost patch changed stored configuration or audit")
		}
	}
	for _, token := range []string{ordinary, ""} {
		f.request(t, http.MethodGet, "/admin/cost", token, "", http.StatusUnauthorized)
	}
}

func TestCostGuardContractCorruptRetainedFlagsCannotCommit(t *testing.T) {
	for _, tc := range []struct{ name, key, value, partial string }{
		{"invalid boolean", "cost_guard_enabled", "perhaps", `{"threshold_krw":2.5}`},
		{"negative threshold", "cost_guard_threshold_krw", "-1", `{"enabled":true}`},
		{"nan threshold", "cost_guard_threshold_krw", "NaN", `{"enabled":true}`},
		{"infinite threshold", "cost_guard_threshold_krw", "+Inf", `{"enabled":true}`},
		{"invalid threshold", "cost_guard_threshold_krw", "not-a-number", `{"enabled":true}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newCostGuardContractFixture(t)
			f.config(t, http.MethodPost, `{"enabled":false,"threshold_krw":47.25}`, false, 47.25)
			cached := f.server.costSnapshotCached(t.Context())
			if err := f.db.SetFlag(t.Context(), store.RuntimeFlag{Key: tc.key, Value: tc.value,
				UpdatedBy: "synthetic-import", Note: "retain on rejected patch"}); err != nil {
				t.Fatal("corrupt cost fixture seed failed")
			}
			before, events := f.flags(t), f.audit(t)
			// Management reads must not substitute the still-valid runtime cache.
			f.request(t, http.MethodGet, "/admin/cost", f.adminToken, "", http.StatusServiceUnavailable)
			for _, body := range []string{tc.partial, `{}`, `null`} {
				f.request(t, http.MethodPost, "/admin/cost", f.adminToken, body, http.StatusServiceUnavailable)
				if !reflect.DeepEqual(before, f.flags(t)) || !reflect.DeepEqual(events, f.audit(t)) {
					t.Fatal("retained invalid cost flag must reject before committing any other flag")
				}
				if f.server.costCache.Load() != cached {
					t.Fatal("rejected cost patch must not invalidate the runtime cache")
				}
			}
			f.config(t, http.MethodPost, `{"enabled":true,"threshold_krw":2.5}`, true, 2.5)
			f.config(t, http.MethodGet, "", true, 2.5)
		})
	}
}

func TestCostGuardContractAuditRetainsExistingIdentity(t *testing.T) {
	f := newCostGuardContractFixture(t)
	f.config(t, http.MethodPost, `{"enabled":true,"threshold_krw":12.5}`, true, 12.5)
	if !slices.ContainsFunc(f.audit(t), func(event store.AdminAuditPublic) bool {
		var patch struct {
			Enabled      *bool    `json:"enabled"`
			ThresholdKRW *float64 `json:"threshold_krw"`
		}
		return event.Action == "cost_guard.set" && event.AdminID == "admin_"+hashProxyKey(f.adminToken)[:12] &&
			event.BeforeValue == "" && json.Unmarshal([]byte(event.AfterValue), &patch) == nil &&
			patch.Enabled != nil && *patch.Enabled && patch.ThresholdKRW != nil && *patch.ThresholdKRW == 12.5
	}) {
		t.Fatal("committed cost patch must preserve the existing actor, action and submitted values audit")
	}
}

type costGuardContractFixture struct {
	*apiKeyScopeContractFixture // Reuse real HTTP transport, not API-key business operations.
	server                      *Server
}

func newCostGuardContractFixture(t *testing.T) *costGuardContractFixture {
	t.Helper()
	f := &costGuardContractFixture{apiKeyScopeContractFixture: &apiKeyScopeContractFixture{}}
	f.gateway, f.server, f.db = scopedSettingsSecurityServer(t, "http://127.0.0.1:9")
	if !f.server.cfg.Auth.Enabled {
		t.Fatal("cost guard contracts require authenticated real routes")
	}
	f.adminToken = f.token(t, "cost-admin", "super_admin", []string{"admin:read", "admin:write"})
	return f
}

func (f *costGuardContractFixture) token(t *testing.T, subject, role string, scopes []string) string {
	t.Helper()
	return issueLLMScopedTestToken(t, f.db, f.server, subject, role, "", scopes, time.Now().UTC())
}

func (f *costGuardContractFixture) flags(t *testing.T) map[string]store.RuntimeFlag {
	t.Helper()
	flags, err := f.db.GetRuntimeFlagSnapshot(t.Context(), []string{"cost_guard_enabled", "cost_guard_threshold_krw"})
	if err != nil {
		t.Fatal("cost flag snapshot lookup failed")
	}
	return flags
}

func (f *costGuardContractFixture) audit(t *testing.T) []store.AdminAuditPublic {
	t.Helper()
	events, err := f.db.ListAdminAudit(t.Context(), 100)
	if err != nil {
		t.Fatal("cost audit lookup failed")
	}
	return events
}

func (f *costGuardContractFixture) config(t *testing.T, method, body string, enabled bool, threshold float64) {
	t.Helper()
	data := f.request(t, method, "/admin/cost", f.adminToken, body, http.StatusOK)
	var value struct {
		Enabled      *bool    `json:"enabled"`
		ThresholdKRW *float64 `json:"threshold_krw"`
	}
	if json.Unmarshal(data, &value) != nil || value.Enabled == nil || value.ThresholdKRW == nil ||
		*value.Enabled != enabled || *value.ThresholdKRW != threshold ||
		math.IsNaN(*value.ThresholdKRW) || math.IsInf(*value.ThresholdKRW, 0) {
		t.Fatal("cost management response must contain the confirmed boolean and finite numeric configuration")
	}
}
