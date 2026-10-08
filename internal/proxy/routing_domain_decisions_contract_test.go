package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/store"
)

// Exercise the actual Routes and SQLStore, with isolated SQLite by default and
// the existing per-test PostgreSQL schema only when explicitly opted in. All
// data and credentials are synthetic; assertions never print raw response data.
// This is a limited recent list, not cursor pagination or a transactional
// snapshot: the handler lists decisions, then separately reads each signal set.
type domainDecisionsContractReport struct {
	Decisions []store.DomainRoutingDecision          `json:"decisions"`
	Signals   map[string][]store.DomainRoutingSignal `json:"signals"`
}

func domainDecisionsSeed(t *testing.T, db *store.SQLStore, id, route, requestID string, at time.Time, signals []store.DomainRoutingSignal) store.DomainRoutingDecision {
	t.Helper()
	d := store.DomainRoutingDecision{
		ID: id, RequestID: requestID, UserID: "synthetic-user", TeamID: "synthetic-record-team",
		QueryHash: "synthetic-hash", Route: route, Confidence: 0.625, ToolNames: []string{},
		EvidenceScore: 0.75, EvidenceCount: 2, Reason: "synthetic raw reason 공개 원문 <tag>",
		CreatedAt: at.UTC().Format(time.RFC3339Nano),
	}
	if err := db.InsertDomainRoutingDecision(t.Context(), d, signals); err != nil {
		t.Fatal("synthetic decision insertion failed")
	}
	return d
}

func domainDecisionsReport(t *testing.T, w *httptest.ResponseRecorder) domainDecisionsContractReport {
	t.Helper()
	var envelope map[string]json.RawMessage
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &envelope) != nil || len(envelope) != 2 {
		t.Fatalf("decision report contract differs, status=%d", w.Code)
	}
	var decisions []map[string]json.RawMessage
	var signals map[string]json.RawMessage
	if json.Unmarshal(envelope["decisions"], &decisions) != nil || decisions == nil ||
		json.Unmarshal(envelope["signals"], &signals) != nil || signals == nil || len(signals) != len(decisions) {
		t.Fatal("decision report requires a non-null array and one signal key per returned decision")
	}
	assertFields := func(fields map[string]json.RawMessage, stringFields, numberFields, boolFields []string, tools bool) {
		t.Helper()
		want := len(stringFields) + len(numberFields) + len(boolFields)
		if tools {
			want++
		}
		if len(fields) != want {
			t.Fatalf("diagnostic field count=%d want=%d", len(fields), want)
		}
		for _, field := range stringFields {
			var value string
			if raw, ok := fields[field]; !ok || string(raw) == "null" || json.Unmarshal(raw, &value) != nil {
				t.Fatal("diagnostic field must be a present non-null string")
			}
		}
		for _, field := range numberFields {
			var value float64
			if raw, ok := fields[field]; !ok || string(raw) == "null" || json.Unmarshal(raw, &value) != nil {
				t.Fatal("diagnostic field must be a present non-null number")
			}
		}
		for _, field := range boolFields {
			var value bool
			if raw, ok := fields[field]; !ok || string(raw) == "null" || json.Unmarshal(raw, &value) != nil {
				t.Fatal("diagnostic field must be a present non-null boolean")
			}
		}
		if tools {
			var values []json.RawMessage
			if json.Unmarshal(fields["tool_names"], &values) != nil || values == nil {
				t.Fatal("tool names must be a present non-null array")
			}
			for _, raw := range values {
				var value string
				if string(raw) == "null" || json.Unmarshal(raw, &value) != nil {
					t.Fatal("tool names must contain non-null strings")
				}
			}
		}
	}
	for _, decision := range decisions {
		assertFields(decision,
			[]string{"id", "request_id", "user_id", "team_id", "query_hash", "route", "reason", "created_at"},
			[]string{"confidence", "evidence_score", "evidence_count"},
			[]string{"fallback_used", "blocked_by_governance"}, true)
		var id string
		if json.Unmarshal(decision["id"], &id) != nil {
			t.Fatal("decision identity decoding failed")
		}
		raw, ok := signals[id]
		if !ok {
			t.Fatal("signal map did not retain exact decision identity")
		}
		if string(raw) == "null" {
			continue // A failed signal query/scan is currently ignored by the handler.
		}
		var rows []map[string]json.RawMessage
		if json.Unmarshal(raw, &rows) != nil || rows == nil {
			t.Fatal("successful signal lookup must return an array")
		}
		for _, row := range rows {
			assertFields(row, []string{"id", "decision_id", "source", "route", "reason", "created_at"}, []string{"score"}, nil, false)
			var decisionID string
			if json.Unmarshal(row["decision_id"], &decisionID) != nil || decisionID != id {
				t.Fatal("signal lookup joined by a different identity")
			}
		}
	}
	var result domainDecisionsContractReport
	if json.Unmarshal(w.Body.Bytes(), &result) != nil {
		t.Fatal("typed decision report decoding failed")
	}
	return result
}

func domainDecisionsGET(t *testing.T, s *Server, query string) domainDecisionsContractReport {
	t.Helper()
	return domainDecisionsReport(t, routingCreateRequest(t, s, http.MethodGet, "/admin/routing/domain-decisions"+query, "", ""))
}

func TestRoutingDomainDecisionsHTTPPayload(t *testing.T) {
	db, s := domainReviewFixture(t)
	empty := domainDecisionsGET(t, s, "")
	if len(empty.Decisions) != 0 || len(empty.Signals) != 0 {
		t.Fatal("empty report must be an empty decision array and signal object")
	}
	at := time.Now().Add(-time.Hour)
	d := store.DomainRoutingDecision{
		ID: " synthetic / 공개?x#y%2f\\\ufeff\n ", RequestID: " request / 공개 ", UserID: "<script>synthetic</script>",
		TeamID: "other-team", QueryHash: "opaque-not-validated-as-hash", Route: "future-route <tag>",
		Confidence: 1.25, EvidenceScore: -0.5, EvidenceCount: -3,
		ToolNames:    []string{"", "synthetic/tool", "synthetic/tool", "<tag>\n공개"},
		FallbackUsed: true, BlockedByGovernance: true, Reason: "unmasked synthetic diagnostic\n<tag> 공개",
		CreatedAt: at.UTC().Format(time.RFC3339Nano),
	}
	sig := store.DomainRoutingSignal{ID: "synthetic-signal", DecisionID: d.ID, Source: "future-source <tag>",
		Route: "different-signal-route", Score: -1.75, Reason: "synthetic raw error\n<tag> 공개", CreatedAt: d.CreatedAt}
	if err := db.InsertDomainRoutingDecision(t.Context(), d, []store.DomainRoutingSignal{sig}); err != nil {
		t.Fatal("synthetic raw diagnostic insertion failed")
	}
	got := domainDecisionsGET(t, s, "")
	if !reflect.DeepEqual(got.Decisions, []store.DomainRoutingDecision{d}) ||
		!reflect.DeepEqual(got.Signals, map[string][]store.DomainRoutingSignal{d.ID: {sig}}) {
		t.Fatal("raw metadata, extensible strings, finite numbers, flags or tool ordering changed")
	}
}

func TestRoutingDomainDecisionsHTTPSignalIdentityAndOrdering(t *testing.T) {
	db, s := domainReviewFixture(t)
	at := time.Now().Add(-time.Hour).UTC()
	for i, id := range []string{"__proto__", "constructor", "toString", "", " padded ", "공개/%2f?x#y\\\ufeff"} {
		d := domainDecisionsSeed(t, db, id, "legal", "shared-request", at.Add(time.Duration(i)*time.Second), nil)
		got := domainDecisionsGET(t, s, "")
		if rows, ok := got.Signals[d.ID]; !ok || rows == nil || len(rows) != 0 {
			t.Fatal("empty signals lost exact arbitrary decision identity")
		}
	}
	sigs := []store.DomainRoutingSignal{
		{ID: "last", DecisionID: "ordered", Source: "z-source", Route: "raw-route", Score: 2.25, Reason: "raw reason", CreatedAt: at.Add(time.Minute).Format(time.RFC3339Nano)},
		{ID: "same-time-z", DecisionID: "ordered", Source: "z-source", Route: "raw-route", Score: 0.2, CreatedAt: at.Format(time.RFC3339Nano)},
		{ID: "same-time-a", DecisionID: "ordered", Source: "a-source", Route: "raw-route", Score: 0.3, CreatedAt: at.Format(time.RFC3339Nano)},
	}
	domainDecisionsSeed(t, db, "ordered", "legal", "shared-request", at.Add(time.Hour), sigs)
	// Identical request IDs do not merge signal sets. Only returned decisions get
	// map entries; neither request ID nor route is the signal join key.
	got := domainDecisionsGET(t, s, "?limit=1&request_id=shared-request")
	if len(got.Decisions) != 1 || got.Decisions[0].ID != "ordered" ||
		!reflect.DeepEqual(got.Signals["ordered"], []store.DomainRoutingSignal{sigs[2], sigs[1], sigs[0]}) {
		t.Fatal("signal identity, ascending timestamp/source ordering or recent limit differs")
	}
}

func TestRoutingDomainDecisionsHTTPFilters(t *testing.T) {
	db, s := domainReviewFixture(t)
	now := time.Now().UTC()
	ages := []time.Duration{time.Hour, 12 * time.Hour, 2 * 24 * time.Hour, 10 * 24 * time.Hour, 45 * 24 * time.Hour, 100 * 24 * time.Hour}
	for i, age := range ages {
		domainDecisionsSeed(t, db, fmt.Sprintf("window-%d", i), "legal", "shared-request", now.Add(-age), nil)
	}
	for index, tc := range []struct {
		query string
		want  int
	}{
		{"", 6}, {"?window=%20%20", 6}, {"?window=24h", 2}, {"?window=7d", 3},
		{"?window=30d", 4}, {"?window=90d", 5}, {"?window=2h", 1}, {"?window=%202h%20", 1},
		{"?window=invalid", 3}, {"?window=0h", 3}, {"?window=-1h", 3},
		{"?route=%20legal%20&request_id=%20shared-request%20", 6},
		{"?route=Legal", 0}, {"?route=leg", 0}, {"?route=legal%25", 0},
		{"?request_id=shared", 0}, {"?request_id=SHARED-REQUEST", 0},
		{"?route=%20&request_id=%20", 6},
		{"?team=unrelated&team_id=unrelated&status=unknown&cursor=unknown&offset=500", 6},
	} {
		got := domainDecisionsGET(t, s, tc.query)
		if len(got.Decisions) != tc.want {
			t.Fatalf("filter case=%d rows=%d want=%d", index, len(got.Decisions), tc.want)
		}
		for i := 1; i < len(got.Decisions); i++ {
			if got.Decisions[i-1].CreatedAt < got.Decisions[i].CreatedAt {
				t.Fatal("decisions are not ordered by descending creation time")
			}
		}
	}
	// Exact stored values are not themselves normalized. Query whitespace is
	// trimmed, so a space-padded stored route is not matched by the trimmed one.
	domainDecisionsSeed(t, db, "padded-route", " legal ", "shared-request", now, nil)
	domainDecisionsSeed(t, db, "different-route", "research", "shared-request", now.Add(-time.Minute), nil)
	rawRequest := "공개 /%2f?x#y\\"
	domainDecisionsSeed(t, db, "exact-request", "legal", rawRequest, now.Add(-2*time.Minute), nil)
	for index, tc := range []struct {
		query string
		want  int
	}{
		{"?route=%20legal%20", 7}, {"?route=legal&request_id=shared-request", 6},
		{"?route=research&request_id=shared-request", 1},
		{"?request_id=" + url.QueryEscape(" "+rawRequest+" "), 1},
		{"?route=research&request_id=" + url.QueryEscape(rawRequest), 0},
	} {
		if got := domainDecisionsGET(t, s, tc.query); len(got.Decisions) != tc.want {
			t.Fatalf("exact filter case=%d rows=%d want=%d", index, len(got.Decisions), tc.want)
		}
	}
	// Pin the inclusive store boundary deterministically, without assuming a
	// stable clock between separate HTTP requests.
	rows, err := db.ListDomainRoutingDecisions(t.Context(), store.DomainRoutingFilter{Limit: 50, Route: "legal", RequestID: "shared-request", Since: now.Add(-ages[2])})
	if err != nil || len(rows) != 3 || rows[2].ID != "window-2" {
		t.Fatalf("inclusive creation boundary differs, rows=%d", len(rows))
	}
}

func TestRoutingDomainDecisionsHTTPLimits(t *testing.T) {
	db, s := domainReviewFixture(t)
	now := time.Now().UTC().Add(-time.Hour)
	for i := 0; i < 205; i++ {
		domainDecisionsSeed(t, db, fmt.Sprintf("limit-%03d", i), "legal", "limit-request", now.Add(time.Duration(i)*time.Second), nil)
	}
	for index, tc := range []struct {
		query string
		want  int
	}{
		{"", 50}, {"?limit=%20", 50}, {"?limit=invalid", 50}, {"?limit=0", 50}, {"?limit=-1", 50},
		{"?limit=1.5", 50}, {"?limit=999999999999999999999999", 50},
		{"?limit=1", 1}, {"?limit=%202%20", 2}, {"?limit=200", 200}, {"?limit=201", 200}, {"?limit=1000", 200},
	} {
		got := domainDecisionsGET(t, s, tc.query)
		if len(got.Decisions) != tc.want || got.Decisions[0].ID != "limit-204" || got.Decisions[tc.want-1].ID != fmt.Sprintf("limit-%03d", 205-tc.want) {
			t.Fatalf("recent limit case=%d rows=%d want=%d", index, len(got.Decisions), tc.want)
		}
	}
}

func TestRoutingDomainDecisionsHTTPNullableStorage(t *testing.T) {
	db, raw := impactFailureStore(t)
	s, err := NewServer(testConfig("http://127.0.0.1:1", "synthetic-unused-upstream"), db, nil, nil)
	if err != nil {
		t.Fatal("synthetic server initialization failed")
	}
	at := time.Now().Add(-time.Hour)
	domainDecisionsSeed(t, db, "null-fields", "legal", "null-request", at, []store.DomainRoutingSignal{{ID: "null-signal", Source: "synthetic", Route: "legal", Score: 0.5}})
	if _, err := raw.ExecContext(t.Context(), "UPDATE domain_routing_decisions SET user_id=NULL, team_id=NULL, reason=NULL, tool_names_json=NULL, fallback_used=2, blocked_by_governance=-1 WHERE id='null-fields'"); err != nil {
		t.Fatal("nullable decision setup failed")
	}
	if _, err := raw.ExecContext(t.Context(), "UPDATE domain_routing_signals SET reason=NULL WHERE id='null-signal'"); err != nil {
		t.Fatal("nullable signal setup failed")
	}
	got := domainDecisionsGET(t, s, "")
	if len(got.Decisions) != 1 || got.Decisions[0].UserID != "" || got.Decisions[0].TeamID != "" || got.Decisions[0].Reason != "" ||
		len(got.Decisions[0].ToolNames) != 0 || got.Decisions[0].FallbackUsed || got.Decisions[0].BlockedByGovernance ||
		len(got.Signals["null-fields"]) != 1 || got.Signals["null-fields"][0].Reason != "" {
		t.Fatal("nullable strings/tools or integer flag interpretation differs")
	}
	for index, tc := range []struct {
		stored string
		want   []string
	}{
		{"null", []string{}}, {"[]", []string{}}, {"not-json", []string{}}, {`{"tool":"synthetic"}`, []string{}},
		{`["first",null,"last"]`, []string{"first", "", "last"}},
		{`["first",42,"last"]`, []string{"first", "", "last"}},
		{`["", "duplicate", "duplicate"]`, []string{"", "duplicate", "duplicate"}},
	} {
		// Both opt-in drivers accept numbered parameters; malformed JSON is
		// deliberate stored data, not a new parser-validation contract.
		if _, err := raw.ExecContext(t.Context(), "UPDATE domain_routing_decisions SET tool_names_json=$1 WHERE id='null-fields'", tc.stored); err != nil {
			t.Fatalf("tool storage setup failed, case=%d", index)
		}
		got := domainDecisionsGET(t, s, "")
		if !reflect.DeepEqual(got.Decisions[0].ToolNames, tc.want) {
			t.Fatalf("tool JSON normalization differs, case=%d", index)
		}
	}
}

func TestRoutingDomainDecisionsHTTPStorageFailures(t *testing.T) {
	for _, failure := range []string{"signal_query", "signal_scan", "decision_list"} {
		t.Run(failure, func(t *testing.T) {
			db, raw := impactFailureStore(t)
			s, err := NewServer(testConfig("http://127.0.0.1:1", "synthetic-unused-upstream"), db, nil, nil)
			if err != nil {
				t.Fatal("synthetic server initialization failed")
			}
			at := time.Now().Add(-time.Hour)
			for _, id := range []string{"lookup-failed", "lookup-ok"} {
				domainDecisionsSeed(t, db, id, "legal", "shared-request", at,
					[]store.DomainRoutingSignal{{ID: "sig-" + id, Source: "synthetic", Route: "legal", Score: 0.5}})
			}
			statements := []string{"DROP TABLE domain_routing_signals"}
			if failure == "decision_list" {
				statements = []string{"DROP TABLE domain_routing_decisions"}
			} else if failure == "signal_scan" {
				// A portable isolated view produces a scan error for exactly one
				// ID. No production store interface or query is changed.
				statements = []string{
					"ALTER TABLE domain_routing_signals RENAME TO domain_routing_signals_seed",
					"CREATE VIEW domain_routing_signals AS SELECT id, decision_id, source, route, CASE WHEN decision_id='lookup-failed' THEN 'synthetic-invalid-number' ELSE CAST(score AS TEXT) END AS score, reason, created_at FROM domain_routing_signals_seed",
				}
			}
			for _, statement := range statements {
				if _, err := raw.ExecContext(t.Context(), statement); err != nil {
					t.Fatal("isolated synthetic storage failure setup failed")
				}
			}
			w := routingCreateRequest(t, s, http.MethodGet, "/admin/routing/domain-decisions", "", "")
			if failure == "decision_list" {
				var payload struct {
					Error struct {
						Code string `json:"code"`
					} `json:"error"`
				}
				if w.Code != 500 || json.Unmarshal(w.Body.Bytes(), &payload) != nil || payload.Error.Code != "domain_decisions_failed" {
					t.Fatalf("decision list failure differs, status=%d", w.Code)
				}
				return
			}
			got := domainDecisionsReport(t, w)
			if len(got.Decisions) != 2 || got.Signals["lookup-failed"] != nil {
				t.Fatal("signal lookup failure must preserve decisions with a null signal entry")
			}
			if failure == "signal_query" && got.Signals["lookup-ok"] != nil {
				t.Fatal("failed signal table lookup unexpectedly returned an array")
			}
			if failure == "signal_scan" && len(got.Signals["lookup-ok"]) != 1 {
				t.Fatal("one signal scan failure affected a different decision")
			}
			if empty := domainDecisionsGET(t, s, "?route=unmatched"); len(empty.Decisions) != 0 || len(empty.Signals) != 0 {
				t.Fatal("no decisions should cause no signal lookups")
			}
		})
	}
}

func TestRoutingDomainDecisionsHTTPPermissions(t *testing.T) {
	for _, tc := range []struct {
		name, mode, role string
		scopes           []string
		want             int
	}{
		{"super_read", "jwt", "super_admin", []string{"routing:read"}, 200},
		{"admin_read", "jwt", "admin", []string{"routing:read"}, 200},
		{"security_read", "jwt", "security_admin", []string{"routing:read"}, 200},
		{"raw_write_only", "jwt", "super_admin", []string{"routing:write"}, 401},
		{"operator_both", "jwt", "operator", []string{"routing:read", "routing:write"}, 403},
		{"team_both", "jwt", "team_admin", []string{"routing:read", "routing:write"}, 403},
		{"viewer_read", "jwt", "viewer", []string{"routing:read"}, 403},
		{"readonly_role", "jwt", "readonly_admin", []string{"routing:read"}, 403},
		{"ops_role", "jwt", "ops_admin", []string{"routing:read"}, 403},
		{"ai_role", "jwt", "ai_admin", []string{"routing:read"}, 403},
		{"role_without_scopes", "jwt", "super_admin", nil, 401},
		{"admin_scopes", "jwt", "admin", []string{"admin:read", "admin:write"}, 401},
		{"missing_jwt", "missing", "", nil, 401},
		{"invalid_jwt", "invalid", "", nil, 401},
		{"legacy_readonly", "readonly", "", nil, 403},
		{"legacy_full", "legacy", "", nil, 200},
		{"legacy_missing", "legacy_missing", "", nil, 401},
		{"open", "open", "", nil, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, s := domainReviewFixture(t)
			seed := domainDecisionsSeed(t, db, "permission-decision", "legal", "permission-request", time.Now().Add(-time.Hour), nil)
			token := ""
			switch tc.mode {
			case "jwt", "missing", "invalid":
				s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "synthetic-decisions-jwt-secret"
				if tc.mode == "jwt" {
					token = issueLLMScopedTestToken(t, db, s, tc.name, tc.role, "synthetic-different-caller-team", tc.scopes, time.Now().UTC())
				} else if tc.mode == "invalid" {
					token = "synthetic-invalid-token"
				}
			case "readonly", "legacy", "legacy_missing":
				s.cfg.Auth.AdminToken, s.cfg.Auth.AdminReadonlyToken = "synthetic-decisions-full", "synthetic-decisions-read"
				if tc.mode == "readonly" {
					token = s.cfg.Auth.AdminReadonlyToken
				} else if tc.mode == "legacy" {
					token = s.cfg.Auth.AdminToken
				}
			}
			w := routingCreateRequest(t, s, http.MethodGet, "/admin/routing/domain-decisions?team_id=unrelated", "", token)
			if w.Code != tc.want {
				t.Fatalf("decision permission status=%d want=%d", w.Code, tc.want)
			}
			if tc.want == 200 {
				if got := domainDecisionsReport(t, w); !reflect.DeepEqual(got.Decisions, []store.DomainRoutingDecision{seed}) {
					t.Fatal("authorized raw read masked or team-filtered stored data")
				}
			} else {
				var payload struct {
					Error struct {
						Code string `json:"code"`
					} `json:"error"`
				}
				code := "invalid_api_key"
				if tc.want == 403 {
					code = "raw_prompt_access_required"
				}
				if json.Unmarshal(w.Body.Bytes(), &payload) != nil || payload.Error.Code != code ||
					strings.Contains(w.Body.String(), seed.ID) || strings.Contains(w.Body.String(), seed.Reason) {
					t.Fatal("denied read code changed or exposed synthetic raw diagnostics")
				}
			}
			if audits, err := db.ListAdminAudit(t.Context(), 20); err != nil || len(audits) != 0 {
				t.Fatal("decision read unexpectedly created mutation audits")
			}
		})
	}
}

func TestRoutingDomainDecisionsHTTPMethodsAndNoMutations(t *testing.T) {
	db, s := domainReviewFixture(t)
	at := time.Now().Add(-time.Hour)
	seed := domainDecisionsSeed(t, db, "read-only-decision", "legal", "read-only-request", at,
		[]store.DomainRoutingSignal{{ID: "read-only-signal", Source: "synthetic", Route: "legal", Score: 0.5}})
	review := domainReviewSeed(t, db, "read-only-review", "pending", at)
	before := domainDecisionsGET(t, s, "")
	for _, method := range []string{http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		w := routingCreateRequest(t, s, method, "/admin/routing/domain-decisions", "{unused malformed body", "")
		if w.Code != 405 {
			t.Fatalf("unsupported method status=%d", w.Code)
		}
	}
	s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "synthetic-decisions-method-secret"
	read := issueLLMScopedTestToken(t, db, s, "read-only", "super_admin", "", []string{"routing:read"}, time.Now().UTC())
	write := issueLLMScopedTestToken(t, db, s, "write-only", "super_admin", "", []string{"routing:write"}, time.Now().UTC())
	for _, tc := range []struct {
		method, token string
		want          int
	}{
		{http.MethodHead, read, 405}, {http.MethodPost, read, 401},
		{http.MethodPost, write, 405}, {http.MethodGet, write, 401}, {http.MethodGet, read, 200},
	} {
		if w := routingCreateRequest(t, s, tc.method, "/admin/routing/domain-decisions", "", tc.token); w.Code != tc.want {
			t.Fatalf("method/scope precedence status=%d want=%d", w.Code, tc.want)
		}
	}
	s.cfg.Auth.Enabled = false
	after := domainDecisionsGET(t, s, "")
	reviews, reviewErr := db.ListDomainReviewQueue(t.Context(), store.DomainRoutingFilter{Limit: 50})
	audits, auditErr := db.ListAdminAudit(t.Context(), 20)
	if !reflect.DeepEqual(before, after) || len(after.Decisions) != 1 || !reflect.DeepEqual(after.Decisions[0], seed) ||
		reviewErr != nil || !reflect.DeepEqual(reviews, []store.DomainReviewQueueItem{review}) || auditErr != nil || len(audits) != 0 {
		t.Fatal("diagnostic requests changed decisions, signals, review state or mutation audit")
	}
}

func TestRoutingDomainDecisionsHTTPProducerMeaning(t *testing.T) {
	db, s, _ := routingCreateFixture(t)
	policy := MCPDiscoveryPolicy{Model: "vibe/legal", Mode: "synthetic-mode"}
	candidates := []MCPCandidate{
		{UpstreamID: "synthetic-first", ToolName: "candidate-not-called", FinalScore: 0.8},
		{UpstreamID: "synthetic-second", ToolName: "other-candidate", FinalScore: 0.99},
	}
	evidences := []MCPEvidence{
		{UpstreamID: "synthetic-first", ToolName: "evidence-first", EvidenceScore: 0.2},
		{UpstreamID: "synthetic-second", ToolName: "evidence-max", EvidenceScore: 0.95},
		{UpstreamID: "synthetic-error", ToolName: "evidence-excluded", EvidenceScore: -0.1, Error: "synthetic raw error <tag> 공개\nline"},
	}
	query := "synthetic private query 공개 <tag>"
	auth := &store.AuthContext{UserID: "synthetic-producer-user", TeamID: "synthetic-producer-team"}
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	s.recordDomainRoutingLearning(request, store.LogRecord{Request: store.RequestLog{ID: "producer-filtered"}}, query, policy, candidates, evidences, evidences[:2], auth)
	got := domainDecisionsGET(t, s, "?request_id=producer-filtered")
	if len(got.Decisions) != 1 {
		t.Fatalf("producer decision count=%d", len(got.Decisions))
	}
	d := got.Decisions[0]
	if d.UserID != auth.UserID || d.TeamID != auth.TeamID || d.Route != "legal" || d.QueryHash != audit.HashText(query) ||
		d.Confidence != 0.8 || d.EvidenceScore != 0.95 || d.EvidenceCount != 2 || d.FallbackUsed || d.BlockedByGovernance ||
		!reflect.DeepEqual(d.ToolNames, []string{"synthetic-first/candidate-not-called", "synthetic-second/other-candidate"}) ||
		d.Reason != "model=vibe/legal; mode=synthetic-mode; top_candidate=synthetic-first; confidence=0.80; evidence=0.20" {
		t.Fatal("producer confidence, filtered evidence, candidate tools, identity or raw reason meaning differs")
	}
	sigs := got.Signals[d.ID]
	if len(sigs) != 6 {
		t.Fatalf("producer signal count=%d", len(sigs))
	}
	byID := map[string]store.DomainRoutingSignal{}
	for _, sig := range sigs {
		byID[sig.ID] = sig
	}
	explicit, selector, excluded := byID[d.ID+"_explicit"], byID[d.ID+"_selector_0"], byID[d.ID+"_evidence_2"]
	if explicit.Source != "explicit_model" || explicit.Score != 0.99 || explicit.Reason != policy.Model ||
		selector.Source != "selector" || selector.Score != candidates[0].FinalScore || selector.Reason != "synthetic-first/candidate-not-called" ||
		excluded.Source != "mcp_evidence" || excluded.Score != -0.1 || excluded.Reason != "synthetic-error/evidence-excluded error="+evidences[2].Error {
		t.Fatal("signal scores/sources or excluded raw error evidence meaning differs")
	}
	// The evidence gate records a signal; this producer does not set either
	// fallback/governance flag, so false is not proof that no gate was triggered.
	s.recordDomainRoutingLearning(request, store.LogRecord{Request: store.RequestLog{ID: "producer-gate"}}, query, policy, nil, evidences[2:], nil, nil)
	gate := domainDecisionsGET(t, s, "?request_id=producer-gate")
	if len(gate.Decisions) != 1 {
		t.Fatalf("gate decision count=%d", len(gate.Decisions))
	}
	gd := gate.Decisions[0]
	if gd.Confidence != 0 || gd.EvidenceScore != 0 || gd.EvidenceCount != 0 || gd.FallbackUsed || gd.BlockedByGovernance ||
		len(gd.ToolNames) != 0 || gd.UserID != "" || gd.TeamID != "" || len(gate.Signals[gd.ID]) != 3 {
		t.Fatal("empty candidate/evidence state or recorded flags differ")
	}
	foundGate := false
	for _, sig := range gate.Signals[gd.ID] {
		if sig.Source == "evidence_gate" {
			foundGate = sig.Score == 0 && sig.Reason == "evidence below threshold"
		}
	}
	if !foundGate {
		t.Fatal("ungrounded evidence must retain its zero-score gate signal")
	}
	if examples, err := db.ListDomainExamples(t.Context(), "", 50); err != nil || len(examples) != 0 {
		t.Fatal("synthetic legal diagnostics unexpectedly promoted a routing example")
	}
}
