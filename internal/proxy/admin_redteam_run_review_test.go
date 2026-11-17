package proxy

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"vibe-coders/internal/store"
)

func reviewedFixture(t *testing.T, handler http.HandlerFunc) (*Server, *store.SQLStore, store.RedTeamCampaign) {
	t.Helper()
	s, db, c, _, _, _ := redTeamAdmissionFixture(t, handler)
	c.ProbePackIDs = []string{"pack"}
	if err := db.UpsertRedTeamCampaign(t.Context(), c); err != nil {
		t.Fatal(err)
	}
	c, _, _ = db.GetRedTeamCampaign(t.Context(), c.ID)
	return s, db, c
}
func reviewedRequest(s *Server, c store.RedTeamCampaign, body any, actor string, execute bool) *httptest.ResponseRecorder {
	encoded, _ := json.Marshal(body)
	r := httptest.NewRequest(http.MethodPost, "/admin/redteam/campaigns/"+c.ID+"/run-review", bytes.NewReader(encoded))
	r.Header.Set("Authorization", "Bearer "+actor)
	w := httptest.NewRecorder()
	if execute {
		s.handleRedTeamReviewedExecution(w, r, c)
	} else {
		s.handleRedTeamRunReview(w, r, c)
	}
	return w
}
func reviewedBody() redTeamRunReviewRequest {
	return redTeamRunReviewRequest{Kind: "live", Reason: "공개 실행 검토", Models: []string{"test-model"}, Limits: redTeamRunLimits{MaxCalls: 1, MaxOutputTokens: 77, BudgetLimitKRW: 10}}
}
func issueReviewed(t *testing.T, s *Server, c store.RedTeamCampaign, body redTeamRunReviewRequest) redTeamRunReviewResponse {
	t.Helper()
	w := reviewedRequest(s, c, body, "operator", false)
	if w.Code != 200 {
		t.Fatalf("review status %d: %s", w.Code, w.Body.String())
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("review may be cached")
	}
	var result redTeamRunReviewResponse
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}
func executionBody(review redTeamRunReviewResponse) map[string]string {
	return map[string]string{"review_token": review.ReviewToken, "proxy_key": "synthetic-key"}
}

func TestRedTeamReviewedCallsAreExplicitBoundedAndSingleUse(t *testing.T) {
	var calls atomic.Int32
	var actual struct {
		Model     string `json:"model"`
		MaxTokens int    `json:"max_tokens"`
	}
	s, db, c := reviewedFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodPost {
			t.Error("reviewed execution performed discovery")
		}
		if err := json.NewDecoder(r.Body).Decode(&actual); err != nil {
			t.Error(err)
		}
		redTeamAdmissionReply(w)
	})
	review := issueReviewed(t, s, c, reviewedBody())
	if calls.Load() != 0 || review.LiveCalls != 1 || review.RequestedOutputTokens != 77 || review.InputBytes == 0 {
		t.Fatal("invalid preview or executed before confirmation")
	}
	if strings.Contains(review.ReviewToken, "synthetic-key") || review.Scope != "responding_server" {
		t.Fatal("invalid review")
	}
	w := reviewedRequest(s, c, executionBody(review), "operator", true)
	if w.Code != 200 || calls.Load() != 1 || actual.Model != "test-model" || actual.MaxTokens != 77 {
		t.Fatalf("run status %d, calls %d, model/tokens %+v", w.Code, calls.Load(), actual)
	}
	var result map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	if result["complete"] != true || result["review_id"] != review.ReviewID {
		t.Fatal("missing reviewed outcome")
	}
	if w = reviewedRequest(s, c, executionBody(review), "operator", true); w.Code != 409 || calls.Load() != 1 {
		t.Fatal("replayed execution")
	}
	audits, err := db.ListAdminAudit(t.Context(), 100)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, a := range audits {
		if a.Action == "redteam.campaign.run.reviewed" {
			found = true
			if !strings.Contains(a.AfterValue, review.ReviewID) || strings.Contains(a.AfterValue, "synthetic-key") {
				t.Fatal("audit identity/secret error")
			}
		}
	}
	if !found {
		t.Fatal("missing admission audit")
	}
}

func TestRedTeamReviewedRejectsStaleAndWrongOwner(t *testing.T) {
	for _, change := range []string{"actor", "campaign", "provider", "case", "target", "expired", "server", "kill"} {
		t.Run(change, func(t *testing.T) {
			var calls atomic.Int32
			s, db, c := reviewedFixture(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1); redTeamAdmissionReply(w) })
			review := issueReviewed(t, s, c, reviewedBody())
			actor := "operator"
			switch change {
			case "actor":
				actor = "different"
			case "campaign":
				c.Name = "변경된 캠페인"
			case "provider":
				p, _, _ := db.GetProvider(t.Context(), "test")
				p.TimeoutMS++
				if err := db.UpsertProvider(t.Context(), p); err != nil {
					t.Fatal(err)
				}
			case "case":
				if err := db.UpsertRedTeamProbePackWithCases(t.Context(), store.RedTeamProbePack{ID: "pack", Enabled: true}, []store.RedTeamProbeCase{{ID: "case", PackID: "pack", CaseKey: "admission", InputTemplate: "Changed", TargetTypes: []string{"model"}}}); err != nil {
					t.Fatal(err)
				}
			case "target":
				if err := db.SyncRedTeamTargets(t.Context(), []store.RedTeamTarget{{ID: "target", TargetType: "model", TargetRef: "changed", Provider: "test", Model: "test-model", Enabled: true}}); err != nil {
					t.Fatal(err)
				}
			case "expired":
				entry := s.redTeamReviews.entries[review.ReviewToken]
				entry.ExpiresAt = time.Now().Add(-time.Second)
				s.redTeamReviews.entries[review.ReviewToken] = entry
			case "server":
				s.redTeamReviews = redTeamExecutionReviews{}
			case "kill":
				redteamKillSwitch.Store(true)
			}
			w := reviewedRequest(s, c, executionBody(review), actor, true)
			if w.Code != 409 || calls.Load() != 0 {
				t.Fatalf("unsafe admission: %d / %d", w.Code, calls.Load())
			}
			if change == "actor" {
				if w = reviewedRequest(s, c, executionBody(review), "operator", true); w.Code != 200 {
					t.Fatal("wrong actor consumed owner's review")
				}
			}
		})
	}
}

func TestRedTeamReviewedRejectsUnsafeInputs(t *testing.T) {
	s, _, c := reviewedFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("review invoked provider") })
	for _, invalid := range []string{"zero_calls", "too_many_calls", "zero_output", "too_many_output", "zero_budget", "estimate", "blank_reason", "long_reason", "wildcard", "duplicate", "spaced", "unknown_kind", "missing_models"} {
		t.Run(invalid, func(t *testing.T) {
			body := reviewedBody()
			switch invalid {
			case "zero_calls":
				body.Limits.MaxCalls = 0
			case "too_many_calls":
				body.Limits.MaxCalls = 201
			case "zero_output":
				body.Limits.MaxOutputTokens = 0
			case "too_many_output":
				body.Limits.MaxOutputTokens = 4097
			case "zero_budget":
				body.Limits.BudgetLimitKRW = 0
			case "estimate":
				body.Limits.BudgetLimitKRW = .1
			case "blank_reason":
				body.Reason = " "
			case "long_reason":
				body.Reason = strings.Repeat("검", 1001)
			case "wildcard":
				body.Models = []string{"test-*"}
			case "duplicate":
				body.Models = []string{"test-model", "test-model"}
				body.Limits.MaxCalls = 2
			case "spaced":
				body.Models = []string{" test-model"}
			case "unknown_kind":
				body.Kind = "automatic"
			case "missing_models":
				body.Models = nil
			}
			if w := reviewedRequest(s, c, body, "operator", false); w.Code != 400 {
				t.Fatalf("invalid accepted: %d", w.Code)
			}
		})
	}
	body := reviewedBody()
	body.Reason = strings.Repeat("🧪", 1000)
	issueReviewed(t, s, c, body)
}

func TestRedTeamReviewedSimulationNeverNeedsOrUsesKey(t *testing.T) {
	s, _, c := reviewedFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("simulation called provider") })
	body := reviewedBody()
	body.Kind = "simulation"
	review := issueReviewed(t, s, c, body)
	if review.LiveCalls != 0 || review.CaseExecutions != 1 || len(review.Targets[0].Models) != 0 {
		t.Fatal("simulation misrepresented")
	}
	if w := reviewedRequest(s, c, executionBody(review), "operator", true); w.Code != 400 {
		t.Fatal("key silently ignored")
	}
	review = issueReviewed(t, s, c, body)
	w := reviewedRequest(s, c, map[string]string{"review_token": review.ReviewToken}, "operator", true)
	if w.Code != 200 {
		t.Fatalf("simulation failed: %d", w.Code)
	}
}

func TestRedTeamReviewedConfigurationChangeStopsNextCall(t *testing.T) {
	var calls atomic.Int32
	var db *store.SQLStore
	s, database, c := reviewedFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		p, _, _ := db.GetProvider(r.Context(), "test")
		p.TimeoutMS++
		if err := db.UpsertProvider(r.Context(), p); err != nil {
			t.Error(err)
		}
		redTeamAdmissionReply(w)
	})
	db = database
	body := reviewedBody()
	body.Models = []string{"test-model", "second-model"}
	body.Limits.MaxCalls = 2
	review := issueReviewed(t, s, c, body)
	w := reviewedRequest(s, c, executionBody(review), "operator", true)
	var result map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	if w.Code != 200 || calls.Load() != 1 || result["stopped"] != "configuration_changed" || result["complete"] != false {
		t.Fatalf("configuration change escaped: %d %v", w.Code, result["stopped"])
	}
}

func TestRedTeamReviewRegistryConcurrentAdmissionAndExpiry(t *testing.T) {
	var registry redTeamExecutionReviews
	record := redTeamExecutionReview{Actor: "a", CampaignID: "c", ExpiresAt: time.Now().Add(time.Minute)}
	token, ok := registry.issue(record)
	if !ok {
		t.Fatal("issue")
	}
	var admitted atomic.Int32
	var wg sync.WaitGroup
	for range 30 {
		wg.Go(func() {
			if _, ok := registry.consume(token, "a", "c"); ok {
				admitted.Add(1)
			}
		})
	}
	wg.Wait()
	if admitted.Load() != 1 {
		t.Fatal("multiple admission")
	}
	second, _ := registry.issue(record)
	if _, ok := registry.consume(second, "a", "c"); ok {
		t.Fatal("overlapping campaign")
	}
	registry.finish("c")
	if _, ok := registry.consume(second, "a", "c"); !ok {
		t.Fatal("independent review blocked after finish")
	}
	record.ExpiresAt = time.Now().Add(-time.Minute)
	expired, _ := registry.issue(record)
	if _, ok := registry.consume(expired, "a", "c"); ok {
		t.Fatal("expired review admitted")
	}
}

func TestRedTeamReviewedAuditFailureConsumesWithoutExecution(t *testing.T) {
	resetRedTeamEmergencyTest(t)
	db, raw := impactFailureStore(t)
	s := &Server{db: db}
	c := store.RedTeamCampaign{ID: "audit", Name: "감사 실패", Scope: "all", ExecutionMode: "dry-run", ProbePackIDs: []string{"pack"}}
	if err := db.UpsertRedTeamCampaign(t.Context(), c); err != nil {
		t.Fatal(err)
	}
	if err := db.SyncRedTeamTargets(t.Context(), []store.RedTeamTarget{{ID: "t", TargetType: "model", TargetRef: "model", Enabled: true}}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRedTeamProbePackWithCases(t.Context(), store.RedTeamProbePack{ID: "pack", Enabled: true}, []store.RedTeamProbeCase{{ID: "case", CaseKey: "audit", PackID: "pack", InputTemplate: "public", TargetTypes: []string{"model"}}}); err != nil {
		t.Fatal(err)
	}
	body := reviewedBody()
	body.Kind = "simulation"
	review := issueReviewed(t, s, c, body)
	statement := "CREATE TRIGGER reviewed_audit_fault BEFORE INSERT ON admin_audit_logs BEGIN SELECT RAISE(FAIL, 'private-fault'); END"
	if os.Getenv("TEST_POSTGRES_DSN") != "" {
		statement = "ALTER TABLE admin_audit_logs ADD CONSTRAINT reviewed_audit_fault CHECK (action <> 'redteam.campaign.run.reviewed')"
	}
	if _, err := raw.ExecContext(t.Context(), statement); err != nil {
		t.Fatal(err)
	}
	payload := map[string]string{"review_token": review.ReviewToken}
	w := reviewedRequest(s, c, payload, "operator", true)
	if w.Code != 500 || strings.Contains(w.Body.String(), "private-fault") {
		t.Fatal("audit failure incorrectly acknowledged or leaked")
	}
	runs, err := db.ListRedTeamRuns(t.Context(), 100)
	if err != nil || len(runs) != 0 {
		t.Fatal("executed before audit confirmation")
	}
	if w = reviewedRequest(s, c, payload, "operator", true); w.Code != 409 {
		t.Fatal("failed admission allowed reuse")
	}
}

func TestRedTeamReviewedRoutesRequireWritePermission(t *testing.T) {
	s, db, c := reviewedFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("unauthorized provider call") })
	s.cfg.Auth.Enabled = true
	s.cfg.Auth.JWTSecret = "public-reviewed-execution-fixture"
	for _, role := range []string{"admin", "readonly_admin", "user"} {
		scopes := []string{"admin:read"}
		if role == "admin" {
			scopes = append(scopes, "admin:write")
		}
		token := issueLLMScopedTestToken(t, db, s, "reviewed-"+role, role, "", scopes, time.Now().UTC())
		for _, action := range []string{"run-review", "run-reviewed"} {
			body := any(reviewedBody())
			if action == "run-reviewed" {
				body = map[string]string{"review_token": "unavailable"}
			}
			encoded, _ := json.Marshal(body)
			r := httptest.NewRequest(http.MethodPost, "/admin/redteam/campaigns/"+c.ID+"/"+action, bytes.NewReader(encoded))
			r.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			s.Routes().ServeHTTP(w, r)
			if role == "admin" {
				want := 200
				if action == "run-reviewed" {
					want = 409
				}
				if w.Code != want {
					t.Fatalf("admin %s: %d", action, w.Code)
				}
			} else if w.Code != 401 && w.Code != 403 {
				t.Fatalf("read-only admitted %s: %d", action, w.Code)
			}
		}
	}
}

func TestRedTeamReviewedExternalPermissionUsesActualProvider(t *testing.T) {
	s, db, c := reviewedFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("review called provider") })
	provider, _, _ := db.GetProvider(t.Context(), "test")
	provider.BaseURL = "https://external.example.invalid/v1"
	if err := db.UpsertProvider(t.Context(), provider); err != nil {
		t.Fatal(err)
	}
	if w := reviewedRequest(s, c, reviewedBody(), "operator", false); w.Code != 400 {
		t.Fatal("stale catalog metadata bypassed external permission")
	}
	c.ExternalProviderAllowed = true
	issueReviewed(t, s, c, reviewedBody())
	provider.Enabled = false
	if err := db.UpsertProvider(t.Context(), provider); err != nil {
		t.Fatal(err)
	}
	if w := reviewedRequest(s, c, reviewedBody(), "operator", false); w.Code != 400 {
		t.Fatal("disabled provider reviewed as live")
	}
}

func TestRedTeamReviewStrictJSONAndCapacity(t *testing.T) {
	s, _, c := reviewedFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("invalid request called provider") })
	for _, body := range []string{`{}`, `null`, `{"extra":true}`, `{"reason":"` + strings.Repeat("x", 20000) + `"}`, `{} {}`} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		s.handleRedTeamRunReview(w, r, c)
		if w.Code != 400 {
			t.Fatal("invalid JSON accepted", w.Code)
		}
	}
	var registry redTeamExecutionReviews
	entry := redTeamExecutionReview{ExpiresAt: time.Now().Add(time.Minute)}
	for range redTeamReviewCapacity {
		if _, ok := registry.issue(entry); !ok {
			t.Fatal("unexpected capacity")
		}
	}
	if _, ok := registry.issue(entry); ok {
		t.Fatal("unbounded review capacity")
	}
	for token, record := range registry.entries {
		record.ExpiresAt = time.Now().Add(-time.Second)
		registry.entries[token] = record
	}
	if _, ok := registry.issue(entry); !ok {
		t.Fatal("expired capacity not reclaimed")
	}
}
