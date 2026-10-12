package proxy

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"vibe-coders/internal/store"
)

func killStateRequest(s *Server, method, body string, ctx context.Context) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	s.handleKillSwitch(w, httptest.NewRequest(method, "/admin/kill-switch", strings.NewReader(body)).WithContext(ctx))
	return w
}

func TestKillStateReadDoesNotHideDatabaseFailureBehindCache(t *testing.T) {
	db, raw := impactFailureStore(t)
	s := &Server{db: db}
	if err := db.SetFlag(t.Context(), store.RuntimeFlag{Key: "gateway_disabled", Value: "true"}); err != nil {
		t.Fatal(err)
	}
	cached := s.killSnapshot(t.Context())
	if _, err := raw.ExecContext(t.Context(), "ALTER TABLE runtime_flags RENAME TO unavailable_kill_flags"); err != nil {
		t.Fatal(err)
	}
	w := killStateRequest(s, http.MethodGet, "", t.Context())
	if w.Code != 503 || !strings.Contains(w.Body.String(), "kill_switch_state_unavailable") {
		t.Errorf("database failure returned status%d rather than unknown state", w.Code)
	}
	if strings.Contains(w.Body.String(), "runtime_flags") || strings.Contains(w.Body.String(), "SQL") {
		t.Error("storage internals exposed")
	}
	if s.killState.value.Load() != cached {
		t.Error("admin failed read replaced inference cache")
	}
	if _, err := raw.ExecContext(t.Context(), "ALTER TABLE unavailable_kill_flags RENAME TO runtime_flags"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if result := killStateRequest(s, http.MethodGet, "", ctx); result.Code != 503 {
		t.Error("cancelled admin read was hidden by cache")
	}
}

func TestKillStateAuditFailureRollsBackFlagAndPreservesCache(t *testing.T) {
	db, raw := impactFailureStore(t)
	s := &Server{db: db}
	if err := db.SetFlag(t.Context(), store.RuntimeFlag{Key: "gateway_disabled", Value: "false", Note: "public baseline"}); err != nil {
		t.Fatal(err)
	}
	before, _, err := db.GetFlag(t.Context(), "gateway_disabled")
	if err != nil {
		t.Fatal(err)
	}
	cached := s.killSnapshot(t.Context())
	if _, err := raw.ExecContext(t.Context(), "ALTER TABLE admin_audit_logs RENAME TO unavailable_kill_audit"); err != nil {
		t.Fatal(err)
	}
	w := killStateRequest(s, http.MethodPost, `{"disabled":true,"reason":"public stop"}`, t.Context())
	if w.Code != 500 || !strings.Contains(w.Body.String(), "kill_switch_save_failed") {
		t.Errorf("audit failure returned status%d", w.Code)
	}
	if strings.Contains(w.Body.String(), "admin_audit_logs") || strings.Contains(w.Body.String(), "SQL") {
		t.Error("storage error exposed")
	}
	after, _, err := db.GetFlag(t.Context(), "gateway_disabled")
	if err != nil || before != after || s.killState.value.Load() != cached {
		t.Error("audit failure changed flag, metadata or inference cache")
	}
	if _, err := raw.ExecContext(t.Context(), "ALTER TABLE unavailable_kill_audit RENAME TO admin_audit_logs"); err != nil {
		t.Fatal(err)
	}
	logs, err := db.ListAdminAudit(t.Context(), 10)
	if err != nil || len(logs) != 0 {
		t.Error("failed write committed audit")
	}
}

func TestKillStateAdminReadRejectsMalformedAndObservesUncachedState(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	s := &Server{db: db}
	if err := db.SetFlag(t.Context(), store.RuntimeFlag{Key: "gateway_disabled", Value: "true"}); err != nil {
		t.Fatal(err)
	}
	cached := s.killSnapshot(t.Context())
	for _, tc := range []struct {
		value    string
		status   int
		disabled bool
	}{
		{"false", 200, false}, {" FALSE ", 200, false}, {" true ", 200, true}, {"TRUE", 200, true},
		{"1", 200, true}, {"0", 200, false}, {"", 503, false}, {"broken", 503, false}, {" 1 ", 503, false},
	} {
		if err := db.SetFlag(t.Context(), store.RuntimeFlag{Key: "gateway_disabled", Value: tc.value}); err != nil {
			t.Fatal(err)
		}
		w := killStateRequest(s, http.MethodGet, "", t.Context())
		if w.Code != tc.status {
			t.Errorf("value%q: status%d, want%d", tc.value, w.Code, tc.status)
			continue
		}
		if tc.status == 200 {
			var state struct {
				Disabled bool `json:"disabled"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &state); err != nil || state.Disabled != tc.disabled {
				t.Errorf("value%q: wrong uncached state", tc.value)
			}
		}
		if s.killState.value.Load() != cached {
			t.Fatal("admin read changed runtime cache contract")
		}
	}
}

func TestKillStateAcknowledgesCommittedMetadataAndPreservesLegacyBody(t *testing.T) {
	db := openTestStore(t)
	defer db.Close()
	s := &Server{db: db}
	initial := killStateRequest(s, http.MethodGet, "", t.Context())
	var initialState map[string]any
	if initial.Code != 200 || json.Unmarshal(initial.Body.Bytes(), &initialState) != nil || initialState["disabled"] != false || initialState["reason"] != "" || initialState["updated_by"] != "" || initialState["updated_at"] != "0001-01-01T00:00:00Z" {
		t.Fatal("missing flag no longer has the legacy false default")
	}
	for i, tc := range []struct {
		body     string
		disabled bool
		reason   string
	}{
		{`{"disabled":true,"reason":"  public stop  "}`, true, "public stop"},
		{`null`, false, ""},
		{`{"disabled":true}`, true, ""},
		{`{"disabled":null,"reason":null}`, false, ""},
		{`{}`, false, ""},
	} {
		s.killSnapshot(t.Context())
		w := killStateRequest(s, http.MethodPost, tc.body, t.Context())
		var ack struct {
			Disabled  bool   `json:"disabled"`
			Reason    string `json:"reason"`
			UpdatedAt string `json:"updated_at"`
			UpdatedBy string `json:"updated_by"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &ack) != nil || ack.Disabled != tc.disabled || ack.Reason != tc.reason || ack.UpdatedAt == "" {
			t.Fatalf("legacy request %d did not acknowledge its committed state", i)
		}
		flag, found, err := db.GetFlag(t.Context(), "gateway_disabled")
		logs, auditErr := db.ListAdminAudit(t.Context(), 20)
		if err != nil || !found || flag.Note != ack.Reason || flag.UpdatedBy != ack.UpdatedBy || auditErr != nil || len(logs) != i+1 {
			t.Fatal("successful acknowledgment and persisted flag/audit differ")
		}
		if s.killState.value.Load() != nil {
			t.Fatal("POST populated runtime cache from a follow-up read")
		}
	}
}
