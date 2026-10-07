package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// Real Routes and SQLStore. Existing helpers use isolated SQLite by default and
// the existing per-test schema only when TEST_POSTGRES_DSN is explicitly set.
// All records, credentials and upstreams are synthetic; never dump raw bodies.
func domainReviewFixture(t *testing.T) (*store.SQLStore, *Server) {
	t.Helper()
	db, s, rule := routingCreateFixture(t)
	example := store.DomainExample{ID: "review-example", Route: "text2sql", Text: "synthetic example", TextHash: "review-example-hash", Source: "manual", Confidence: 0.7, CreatedAt: "2026-10-01T00:00:00Z"}
	if err := db.UpsertDomainExample(t.Context(), example); err != nil {
		t.Fatal("synthetic example insertion failed")
	}
	providers, err := db.ListProviders(t.Context())
	if err != nil {
		t.Fatal("synthetic provider read failed")
	}
	cached := &routingRulesSnapshot{rules: []store.RoutingRule{rule}, fetchedAt: time.Now()}
	learned := &routingLearnSnapshot{enabled: false, minSamples: 20, fetchedAt: time.Now()}
	s.routingRules.Store(cached)
	s.learnCache.Store(learned)
	t.Cleanup(func() {
		ctx := context.Background() // Testing cancels t.Context before cleanup.
		rules, ruleErr := db.ListRoutingRules(ctx)
		examples, exampleErr := db.ListDomainExamples(ctx, "", 50)
		afterProviders, providerErr := db.ListProviders(ctx)
		if ruleErr != nil || exampleErr != nil || providerErr != nil || !reflect.DeepEqual(rules, []store.RoutingRule{rule}) ||
			!reflect.DeepEqual(examples, []store.DomainExample{example}) || !reflect.DeepEqual(providers, afterProviders) ||
			s.routingRules.Load() != cached || s.learnCache.Load() != learned {
			t.Error("review operations changed unrelated example, rule, provider or runtime cache state")
		}
		for _, key := range []string{"routing_learning_auto", "routing_learning_min_samples"} {
			if _, found, err := db.GetFlag(ctx, key); err != nil || found {
				t.Error("review operations changed automatic learning settings")
			}
		}
	})
	return db, s
}

func domainReviewSeed(t *testing.T, db *store.SQLStore, id, status string, at time.Time) store.DomainReviewQueueItem {
	t.Helper()
	item := store.DomainReviewQueueItem{ID: id, DecisionID: "synthetic-decision-" + id, QueryText: "synthetic raw query <tag> 공개 원문", SuggestedRoute: "text2sql", CurrentRoute: "chat", Reason: "synthetic review reason", Status: status, CreatedAt: at.UTC().Format(time.RFC3339Nano)}
	if err := db.EnqueueDomainReview(t.Context(), item); err != nil {
		t.Fatal("synthetic review insertion failed")
	}
	return item
}

func domainReviewReport(t *testing.T, w *httptest.ResponseRecorder) []store.DomainReviewQueueItem {
	t.Helper()
	var envelope map[string]json.RawMessage
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &envelope) != nil || len(envelope) != 1 {
		t.Fatalf("review report contract differs, status=%d", w.Code)
	}
	var rows []map[string]json.RawMessage
	if json.Unmarshal(envelope["items"], &rows) != nil || rows == nil {
		t.Fatal("review report must contain a non-null item array")
	}
	for _, row := range rows {
		if len(row) != 9 {
			t.Fatalf("review item field count=%d", len(row))
		}
		for _, field := range []string{"id", "decision_id", "query_text", "suggested_route", "current_route", "reason", "status", "created_at", "reviewed_at"} {
			var value string
			raw, ok := row[field]
			if !ok || string(raw) == "null" || json.Unmarshal(raw, &value) != nil {
				t.Fatal("review item has a missing or non-string field")
			}
		}
	}
	var result []store.DomainReviewQueueItem
	if json.Unmarshal(envelope["items"], &result) != nil {
		t.Fatal("review item decoding failed")
	}
	return result
}

func domainReviewACK(t *testing.T, w *httptest.ResponseRecorder, id, status string) {
	t.Helper()
	var fields map[string]string
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &fields) != nil || len(fields) != 2 || fields["id"] != id || fields["status"] != status {
		t.Fatalf("review acknowledgment differs, status=%d", w.Code)
	}
}

func domainReviewPath(id, action string) string {
	// Match the UI's encodeURIComponent(id + "/" + action) transport: action is
	// part of the existing single parameter, including its encoded separator.
	return "/admin/routing/domain-review/" + url.PathEscape(id+"/"+action)
}

func TestRoutingDomainReviewHTTPActions(t *testing.T) {
	db, s := domainReviewFixture(t)
	initial := domainReviewSeed(t, db, "review-selected", "pending", time.Now().Add(-time.Hour))
	other := domainReviewSeed(t, db, "review-other", "pending", time.Now().Add(-2*time.Hour))
	before := domainReviewReport(t, routingCreateRequest(t, s, http.MethodGet, "/admin/routing/domain-review", "", ""))
	if !reflect.DeepEqual(before, []store.DomainReviewQueueItem{initial, other}) || before[0].ReviewedAt != "" {
		t.Fatal("initial raw queue or empty review timestamp differs")
	}
	for index, action := range []string{"approve", "approve", "reject", "approve"} {
		status := "approved"
		if action == "reject" {
			status = "rejected"
		}
		// Malformed body is deliberately unused; it is not a JSON mutation API.
		start := time.Now().UTC()
		w := routingCreateRequest(t, s, http.MethodPost, domainReviewPath(initial.ID, action), "{ignored malformed body", "")
		domainReviewACK(t, w, initial.ID, status)
		end := time.Now().UTC()
		rows := domainReviewReport(t, routingCreateRequest(t, s, http.MethodGet, "/admin/routing/domain-review?status="+status, "", ""))
		if len(rows) != 1 {
			t.Fatalf("reviewed queue count=%d", len(rows))
		}
		reviewed, err := time.Parse(time.RFC3339Nano, rows[0].ReviewedAt)
		if end.Before(start) {
			start, end = end, start
		}
		if err != nil || reviewed.Before(start) || reviewed.After(end) {
			t.Fatalf("review timestamp was not refreshed, action=%d", index)
		}
		rows[0].Status, rows[0].ReviewedAt = initial.Status, initial.ReviewedAt
		if rows[0] != initial {
			t.Fatal("review action changed fields other than status/reviewed_at")
		}
		pending := domainReviewReport(t, routingCreateRequest(t, s, http.MethodGet, "/admin/routing/domain-review", "", ""))
		if !reflect.DeepEqual(pending, []store.DomainReviewQueueItem{other}) {
			t.Fatal("review action changed an unrelated queue item")
		}
	}
	for i := 0; i < 2; i++ {
		domainReviewACK(t, routingCreateRequest(t, s, http.MethodPost, domainReviewPath("review-absent", "reject"), "", ""), "review-absent", "rejected")
	}
	all, err := db.ListDomainReviewQueue(t.Context(), store.DomainRoutingFilter{Limit: 50})
	audits, auditErr := db.ListAdminAudit(t.Context(), 20)
	if err != nil || auditErr != nil || len(all) != 2 || len(audits) != 6 {
		t.Fatalf("repeated/absent action effects differ, rows=%d audits=%d", len(all), len(audits))
	}
	counts := map[string]int{}
	for _, entry := range audits {
		var payload map[string]string
		if entry.BeforeValue != "" || json.Unmarshal([]byte(entry.AfterValue), &payload) != nil || len(payload) != 1 {
			t.Fatal("review audit must contain only the selected ID")
		}
		counts[payload["id"]+"/"+entry.Action]++
	}
	if counts[initial.ID+"/domain_review.approved"] != 3 || counts[initial.ID+"/domain_review.rejected"] != 1 || counts["review-absent/domain_review.rejected"] != 2 {
		t.Fatal("each successful review attempt must produce its own audit")
	}
}

func TestRoutingDomainReviewHTTPEncodedIdentity(t *testing.T) {
	db, s := domainReviewFixture(t)
	for index, id := range []string{" padded id ", "공개 검토", "%2f", "a?b#c", `a\b`, "\ufeff", ".", ".."} {
		t.Run(fmt.Sprintf("identity_%d", index), func(t *testing.T) {
			seed := domainReviewSeed(t, db, id, "pending", time.Now().Add(-time.Hour))
			domainReviewACK(t, routingCreateRequest(t, s, http.MethodPost, domainReviewPath(id, "approve"), "", ""), id, "approved")
			rows, err := db.ListDomainReviewQueue(t.Context(), store.DomainRoutingFilter{Status: "approved", Limit: 50})
			if err != nil {
				t.Fatal("encoded identity lookup failed")
			}
			found := false
			for _, row := range rows {
				if row.ID == id {
					found = true
					if row.ReviewedAt == "" {
						t.Fatal("encoded action acknowledged without updating exact ID")
					}
					row.Status, row.ReviewedAt = seed.Status, seed.ReviewedAt
					if row != seed {
						t.Fatal("encoded action rewrote stored identity or metadata")
					}
				}
			}
			if !found {
				t.Fatal("exact decoded review identity was not persisted")
			}
		})
	}
}

func TestRoutingDomainReviewHTTPQueryNormalization(t *testing.T) {
	db, s := domainReviewFixture(t)
	now := time.Now().UTC()
	for index, age := range []time.Duration{time.Hour, 12 * time.Hour, 2 * 24 * time.Hour, 10 * 24 * time.Hour, 45 * 24 * time.Hour, 100 * 24 * time.Hour} {
		domainReviewSeed(t, db, fmt.Sprintf("window-%d", index), "pending", now.Add(-age))
	}
	domainReviewSeed(t, db, "future-status", "future", now.Add(-time.Minute))
	for _, tc := range []struct {
		query string
		want  int
	}{
		{"", 6}, {"?status=%20%20", 6}, {"?window=%20", 6},
		{"?window=24h", 2}, {"?window=7d", 3}, {"?window=30d", 4}, {"?window=90d", 5}, {"?window=2h", 1},
		{"?window=invalid", 3}, {"?window=0h", 3}, {"?window=-1h", 3}, {"?window=%202h%20", 1},
		{"?status=%20future%20", 1}, {"?status=all", 0}, {"?status=PENDING", 0}, {"?status=unknown", 0},
		{"?route=nonmatching&request_id=nonmatching&team=nonmatching&team_id=nonmatching", 6},
	} {
		rows := domainReviewReport(t, routingCreateRequest(t, s, http.MethodGet, "/admin/routing/domain-review"+tc.query, "", ""))
		if len(rows) != tc.want {
			t.Fatalf("normalized query row count=%d want=%d", len(rows), tc.want)
		}
		for i := 1; i < len(rows); i++ {
			if rows[i-1].CreatedAt < rows[i].CreatedAt {
				t.Fatal("queue is not ordered by descending creation time")
			}
		}
	}
	// Timestamp filtering uses created_at, even after an old row is reviewed now.
	domainReviewACK(t, routingCreateRequest(t, s, http.MethodPost, domainReviewPath("window-5", "approve"), "", ""), "window-5", "approved")
	if rows := domainReviewReport(t, routingCreateRequest(t, s, http.MethodGet, "/admin/routing/domain-review?status=approved&window=24h", "", "")); len(rows) != 0 {
		t.Fatal("window incorrectly uses review time")
	}
	// A deterministic store check pins the inclusive boundary without assuming
	// a stable wall clock between HTTP requests.
	boundary := now.Add(-2 * 24 * time.Hour)
	rows, err := db.ListDomainReviewQueue(t.Context(), store.DomainRoutingFilter{Status: "pending", Since: boundary, Limit: 50})
	if err != nil || len(rows) != 3 || rows[2].ID != "window-2" {
		t.Fatal("inclusive creation lower bound changed")
	}
}

func TestRoutingDomainReviewHTTPLimits(t *testing.T) {
	db, s := domainReviewFixture(t)
	now := time.Now().UTC()
	for index := 0; index < 205; index++ {
		domainReviewSeed(t, db, fmt.Sprintf("limit-%03d", index), "pending", now.Add(-time.Duration(index)*time.Minute))
	}
	for _, tc := range []struct {
		value string
		want  int
	}{
		{"", 50}, {"%20", 50}, {"invalid", 50}, {"0", 50}, {"-1", 50}, {"1.5", 50},
		{"999999999999999999999999999999", 50}, {"1", 1}, {"%202%20", 2}, {"%2B3", 3},
		{"200", 200}, {"201", 200}, {"1000", 200},
	} {
		rows := domainReviewReport(t, routingCreateRequest(t, s, http.MethodGet, "/admin/routing/domain-review?limit="+tc.value, "", ""))
		if len(rows) != tc.want || rows[0].ID != "limit-000" || rows[len(rows)-1].ID != fmt.Sprintf("limit-%03d", tc.want-1) {
			t.Fatalf("recent limit contract differs, count=%d want=%d", len(rows), tc.want)
		}
	}
	if audits, err := db.ListAdminAudit(t.Context(), 10); err != nil || len(audits) != 0 {
		t.Fatal("queue reads must not create mutation audits")
	}
}

func TestRoutingDomainReviewHTTPPermissions(t *testing.T) {
	for _, tc := range []struct {
		name, mode, role string
		scopes           []string
		read, write      int
	}{
		{"super_both", "jwt", "super_admin", []string{"routing:read", "routing:write"}, 200, 200},
		{"admin_both", "jwt", "admin", []string{"routing:read", "routing:write"}, 200, 200},
		{"security_read", "jwt", "security_admin", []string{"routing:read"}, 200, 401},
		{"raw_write_only", "jwt", "super_admin", []string{"routing:write"}, 401, 200},
		{"operator_both", "jwt", "operator", []string{"routing:read", "routing:write"}, 403, 200},
		{"team_both", "jwt", "team_admin", []string{"routing:read", "routing:write"}, 403, 200},
		{"viewer_read", "jwt", "viewer", []string{"routing:read"}, 403, 401},
		{"readonly_role", "jwt", "readonly_admin", []string{"routing:read"}, 403, 401},
		{"ops_role", "jwt", "ops_admin", []string{"routing:read"}, 403, 401},
		{"ai_role", "jwt", "ai_admin", []string{"routing:read"}, 403, 401},
		{"role_no_scopes", "jwt", "super_admin", nil, 401, 401},
		{"admin_scopes", "jwt", "admin", []string{"admin:read", "admin:write"}, 401, 401},
		{"missing_jwt", "missing", "", nil, 401, 401},
		{"invalid_jwt", "invalid", "", nil, 401, 401},
		{"legacy_readonly", "readonly", "", nil, 403, 401},
		{"legacy_full", "legacy", "", nil, 200, 200},
		{"open", "open", "", nil, 200, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, s := domainReviewFixture(t)
			seed := domainReviewSeed(t, db, "permission-review", "pending", time.Now().Add(-time.Hour))
			token := ""
			switch tc.mode {
			case "jwt", "missing", "invalid":
				s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "synthetic-review-jwt-secret"
				if tc.mode == "jwt" {
					token = issueLLMScopedTestToken(t, db, s, tc.name, tc.role, "synthetic-team", tc.scopes, time.Now().UTC())
				} else if tc.mode == "invalid" {
					token = "synthetic-invalid-token"
				}
			case "readonly", "legacy":
				s.cfg.Auth.AdminToken, s.cfg.Auth.AdminReadonlyToken = "synthetic-review-full", "synthetic-review-read"
				token = s.cfg.Auth.AdminReadonlyToken
				if tc.mode == "legacy" {
					token = s.cfg.Auth.AdminToken
				}
			}
			get := routingCreateRequest(t, s, http.MethodGet, "/admin/routing/domain-review?team_id=unrelated", "", token)
			if get.Code != tc.read {
				t.Fatalf("queue permission status=%d want=%d", get.Code, tc.read)
			}
			if tc.read == 200 {
				if rows := domainReviewReport(t, get); !reflect.DeepEqual(rows, []store.DomainReviewQueueItem{seed}) {
					t.Fatal("raw reader must receive exact unmasked record")
				}
			} else if strings.Contains(get.Body.String(), seed.QueryText) || strings.Contains(get.Body.String(), seed.ID) {
				t.Fatal("denied queue read exposed synthetic record data")
			}
			post := routingCreateRequest(t, s, http.MethodPost, domainReviewPath(seed.ID, "reject"), "", token)
			if post.Code != tc.write {
				t.Fatalf("action permission status=%d want=%d", post.Code, tc.write)
			}
			rows, err := db.ListDomainReviewQueue(t.Context(), store.DomainRoutingFilter{Limit: 50})
			audits, auditErr := db.ListAdminAudit(t.Context(), 10)
			if err != nil || auditErr != nil || len(rows) != 1 {
				t.Fatal("permission state verification failed")
			}
			if tc.write == 200 {
				domainReviewACK(t, post, seed.ID, "rejected")
				if rows[0].Status != "rejected" || rows[0].ReviewedAt == "" || len(audits) != 1 {
					t.Fatal("authorized review action was not persisted and audited")
				}
				rows[0].Status, rows[0].ReviewedAt = seed.Status, seed.ReviewedAt
			} else if len(audits) != 0 {
				t.Fatal("denied action created a mutation audit")
			}
			if rows[0] != seed {
				t.Fatal("permission check changed unauthorized or unrelated review fields")
			}
		})
	}
}

func TestRoutingDomainReviewHTTPInvalidPathsAndMethods(t *testing.T) {
	db, s := domainReviewFixture(t)
	seed := domainReviewSeed(t, db, "path-review", "pending", time.Now().Add(-time.Hour))
	for _, tc := range []struct {
		method, suffix, code string
		status               int
	}{
		{http.MethodPost, "/path-review", "invalid_review_path", 400},
		{http.MethodPost, "/%20%2Fapprove", "invalid_review_path", 400},
		{http.MethodPost, "/path-review%2Faccept", "invalid_review_action", 400},
		{http.MethodPost, "/path-review%2Fapprove%2Fextra", "invalid_review_action", 400},
		{http.MethodPost, "/path-review%2F", "invalid_review_action", 400},
		{http.MethodPost, "", "method_not_allowed", 405},
		{http.MethodGet, "/path-review%2Fapprove", "method_not_allowed", 405},
		{http.MethodDelete, "/path-review%2Fapprove", "method_not_allowed", 405},
	} {
		w := routingCreateRequest(t, s, tc.method, "/admin/routing/domain-review"+tc.suffix, "", "")
		var payload struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if w.Code != tc.status || json.Unmarshal(w.Body.Bytes(), &payload) != nil || payload.Error.Code != tc.code {
			t.Fatalf("path/method contract differs, status=%d want=%d", w.Code, tc.status)
		}
	}
	rows, err := db.ListDomainReviewQueue(t.Context(), store.DomainRoutingFilter{Limit: 50})
	audits, auditErr := db.ListAdminAudit(t.Context(), 10)
	if err != nil || auditErr != nil || !reflect.DeepEqual(rows, []store.DomainReviewQueueItem{seed}) || len(audits) != 0 {
		t.Fatal("invalid action changed review state or audit")
	}
}

func TestRoutingDomainReviewHTTPNullableStorage(t *testing.T) {
	db, raw := impactFailureStore(t)
	s, err := NewServer(testConfig("http://127.0.0.1:1", "synthetic-unused-upstream"), db, nil, nil)
	if err != nil {
		t.Fatal("synthetic server initialization failed")
	}
	domainReviewSeed(t, db, "null-fields", "pending", time.Now().Add(-time.Hour))
	if _, err := raw.ExecContext(t.Context(), "UPDATE domain_review_queue SET current_route = NULL, reason = NULL, reviewed_at = NULL WHERE id = 'null-fields'"); err != nil {
		t.Fatal("nullable synthetic field setup failed")
	}
	rows := domainReviewReport(t, routingCreateRequest(t, s, http.MethodGet, "/admin/routing/domain-review", "", ""))
	if len(rows) != 1 || rows[0].CurrentRoute != "" || rows[0].Reason != "" || rows[0].ReviewedAt != "" {
		t.Fatal("nullable storage fields must serialize as empty strings")
	}
}

func TestRoutingDomainReviewHTTPStorageFailures(t *testing.T) {
	for _, auditOnly := range []bool{false, true} {
		name := "queue"
		if auditOnly {
			name = "audit"
		}
		t.Run(name, func(t *testing.T) {
			db, raw := impactFailureStore(t)
			s, err := NewServer(testConfig("http://127.0.0.1:1", "synthetic-unused-upstream"), db, nil, nil)
			if err != nil {
				t.Fatal("synthetic server initialization failed")
			}
			domainReviewSeed(t, db, "failure-review", "pending", time.Now().Add(-time.Hour))
			statement := "DROP TABLE domain_review_queue"
			if auditOnly {
				statement = "DROP TABLE admin_audit_logs"
			}
			if _, err := raw.ExecContext(t.Context(), statement); err != nil {
				t.Fatal("isolated synthetic table failure setup failed")
			}
			post := routingCreateRequest(t, s, http.MethodPost, domainReviewPath("failure-review", "approve"), "", "")
			get := routingCreateRequest(t, s, http.MethodGet, "/admin/routing/domain-review?status=approved", "", "")
			if auditOnly {
				domainReviewACK(t, post, "failure-review", "approved")
				rows := domainReviewReport(t, get)
				if len(rows) != 1 || rows[0].ReviewedAt == "" || rows[0].Status != "approved" {
					t.Fatal("audit failure must not roll back the review update")
				}
				return
			}
			for _, tc := range []struct {
				response *httptest.ResponseRecorder
				code     string
			}{{post, "domain_review_update_failed"}, {get, "domain_review_failed"}} {
				var body struct {
					Error struct {
						Code string `json:"code"`
					} `json:"error"`
				}
				if tc.response.Code != 500 || json.Unmarshal(tc.response.Body.Bytes(), &body) != nil || body.Error.Code != tc.code {
					t.Fatalf("storage failure contract differs, status=%d", tc.response.Code)
				}
			}
		})
	}
}
