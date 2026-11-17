package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func TestRedTeamReviewedText2SQLIsExplicitSimulation(t *testing.T) {
	var calls atomic.Int32
	s, db, c := reviewedFixture(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1); redTeamAdmissionReply(w) })
	c.Scope, c.TargetFilter = "all", map[string]any{}
	targets := []store.RedTeamTarget{
		{ID: "target", TargetType: "model", TargetRef: "model:test:test-model", Provider: "test", Model: "test-model", Enabled: true},
		{ID: "sql", TargetType: "text2sql", TargetRef: "text2sql:preview", Provider: "text2sql", Model: "vibe/text2sql-preview", Enabled: true},
	}
	if err := db.SyncRedTeamTargets(t.Context(), targets); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRedTeamProbePackWithCases(t.Context(), store.RedTeamProbePack{ID: "pack", Enabled: true}, []store.RedTeamProbeCase{{ID: "case", PackID: "pack", CaseKey: "bounded", InputTemplate: "Synthetic test", ExpectedPolicy: "refuse", TargetTypes: []string{"model", "text2sql"}}}); err != nil {
		t.Fatal(err)
	}
	review := issueReviewed(t, s, c, reviewedBody())
	if review.LiveCalls != 1 || review.CaseExecutions != 2 || len(review.Targets) != 2 || review.RequestedOutputTokens != 77 {
		t.Fatal("mixed selection misrepresented")
	}
	for _, target := range review.Targets {
		if target.ID == "sql" && (target.LiveCalls != 0 || target.CaseExecutions != 1 || len(target.Models) != 0) {
			t.Fatal("Text2SQL presented as bounded live call")
		}
	}
	w := reviewedRequest(s, c, executionBody(review), "operator", true)
	if w.Code != 200 || calls.Load() != 1 {
		t.Fatalf("mixed execution: %d / %d", w.Code, calls.Load())
	}
	c.Scope = "text2sql"
	if w := reviewedRequest(s, c, reviewedBody(), "operator", false); w.Code != 400 {
		t.Fatal("live review with no physical calls accepted")
	}
	body := reviewedBody()
	body.Kind = "simulation"
	review = issueReviewed(t, s, c, body)
	w = reviewedRequest(s, c, map[string]string{"review_token": review.ReviewToken}, "operator", true)
	if w.Code != 200 || calls.Load() != 1 || review.LiveCalls != 0 || review.CaseExecutions != 1 {
		t.Fatal("simulation invoked a nested executor")
	}
}

func TestRedTeamReviewedRejectsVirtualModelOverrides(t *testing.T) {
	s, db, c := reviewedFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("review called upstream") })
	if err := db.UpsertAgentRoute(t.Context(), store.AgentRoute{ID: "agent", VirtualModel: "custom-agent", BackingModel: "test-model", Provider: "test", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	for _, model := range []string{"vibe/text2sql-preview", "VIBE/Text2SQL-exec", "vibe/grounded", "vibe/all_mcp", "custom-agent", "auto", "vibe/auto", "vibe-coders/auto", "VIBE/AUTO"} {
		t.Run(model, func(t *testing.T) {
			body := reviewedBody()
			body.Models = []string{model}
			if w := reviewedRequest(s, c, body, "operator", false); w.Code != 400 {
				t.Fatalf("virtual model accepted: %d", w.Code)
			}
		})
	}
}

func TestRedTeamReviewedRuntimeGuardsNestedExecutors(t *testing.T) {
	var calls atomic.Int32
	s, db, c := reviewedFixture(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1); redTeamAdmissionReply(w) })
	s.t2sRuntime.Store(&config.Text2SQLConfig{Enabled: true})
	// A physical model becomes an agent route AFTER review. The guard at the
	// executor must still reject it, including the race after the plan lookup.
	review := issueReviewed(t, s, c, reviewedBody())
	if err := db.UpsertAgentRoute(t.Context(), store.AgentRoute{ID: "agent", VirtualModel: "test-model", BackingModel: "backing-model", Provider: "test", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if w := reviewedRequest(s, c, executionBody(review), "operator", true); w.Code != 409 {
		t.Fatal("changed agent route admitted")
	}
	for _, model := range []string{"vibe/text2sql-preview", "vibe/grounded", "vibe/all_mcp", "test-model"} {
		t.Run(model, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/", nil)
			r = r.WithContext(context.WithValue(r.Context(), redTeamReviewedOutputKey{}, 77))
			result := s.redTeamActiveInvoke(r, "synthetic-key", model, "test", "Synthetic test", "reviewed-boundary", 77)
			if result.Code != 400 || calls.Load() != 0 {
				t.Fatalf("nested executor escaped boundary: %d / %d", result.Code, calls.Load())
			}
		})
	}
}

func TestRedTeamReviewedPhysicalUpstreamPayload(t *testing.T) {
	for _, field := range []string{"max_tokens", "max_completion_tokens"} {
		t.Run(field, func(t *testing.T) {
			var actual map[string]any
			s, _, _ := reviewedFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if err := json.NewDecoder(r.Body).Decode(&actual); err != nil {
					t.Error(err)
				}
				redTeamAdmissionReply(w)
			})
			payload := map[string]any{"model": "test-model", "messages": []map[string]string{{"role": "user", "content": "Synthetic test"}}, field: 9000, "n": 9, "stream": true}
			encoded, _ := json.Marshal(payload)
			r := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewReader(encoded))
			r.Header.Set("Authorization", "Bearer synthetic-key")
			r.Header.Set("X-Proxy-Provider", "test")
			r = r.WithContext(context.WithValue(r.Context(), redTeamReviewedOutputKey{}, 77))
			r = r.WithContext(context.WithValue(r.Context(), redTeamReviewedModelKey{}, "test-model"))
			w := httptest.NewRecorder()
			s.handleOpenAI(w, r)
			if w.Code != 200 || actual[field] != float64(77) || actual["n"] != float64(1) || actual["stream"] != false {
				t.Fatalf("unbounded physical payload: status %d / %v", w.Code, actual)
			}
			if field == "max_completion_tokens" && actual["max_tokens"] != nil {
				t.Fatal("conflicting token bounds")
			}
		})
	}
}

func TestRedTeamReviewedBoundaryIsNotAnExternalHeader(t *testing.T) {
	r := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	r.Header.Set("X-Redteam", "1")
	r.Header.Set("X-Redteam-Max-Output-Tokens", "77")
	w := httptest.NewRecorder()
	rc := &requestPipeline{r: r, w: w}
	input := []byte(`{"model":"ordinary","max_tokens":9000,"n":2,"stream":true}`)
	actual, ok := rc.reviewedPhysicalBody(input)
	if !ok || !bytes.Equal(actual, input) || rc.rejectReviewedVirtualModel() {
		t.Fatal("ordinary requests affected by public headers")
	}
	rc.r = r.WithContext(context.WithValue(r.Context(), redTeamReviewedOutputKey{}, 77))
	if _, ok := rc.reviewedPhysicalBody([]byte(`null`)); ok || w.Code != 400 || !strings.Contains(w.Body.String(), "redteam_review_body_invalid") {
		t.Fatal("invalid reviewed body accepted")
	}
}

func TestRedTeamReviewedPhysicalModelSurvivesNoSubstitutions(t *testing.T) {
	for _, scenario := range []string{"deprecation", "context_overflow"} {
		t.Run(scenario, func(t *testing.T) {
			models := make(chan string, 8)
			var calls atomic.Int32
			s, db, campaign := reviewedFixture(t, func(w http.ResponseWriter, r *http.Request) {
				var payload struct {
					Model string `json:"model"`
				}
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
					t.Error(err)
				}
				models <- payload.Model
				calls.Add(1)
				if scenario == "context_overflow" && payload.Model == "test-model" {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusBadRequest)
					_, _ = w.Write([]byte(`{"error":{"code":"context_length_exceeded","message":"maximum context length exceeded"}}`))
					return
				}
				redTeamAdmissionReply(w)
			})
			if scenario == "deprecation" {
				if _, err := db.UpsertModelDeprecation(t.Context(), store.ModelDeprecation{ModelGlob: "test-model", Replacement: "replacement-model", SunsetDate: "2000-01-01"}); err != nil {
					t.Fatal(err)
				}
			}
			review := issueReviewed(t, s, campaign, reviewedBody())
			w := reviewedRequest(s, campaign, executionBody(review), "operator", true)
			wantCalls := int32(0)
			if scenario == "context_overflow" {
				wantCalls = 1
			}
			if w.Code != 200 || calls.Load() != wantCalls {
				t.Fatalf("reviewed substitution escaped: %d / %d", w.Code, calls.Load())
			}
			if wantCalls == 1 && <-models != "test-model" {
				t.Fatal("reviewed physical model changed")
			}
			results, err := db.ListRedTeamCaseResults(t.Context(), "")
			if err != nil || len(results) != 1 || results[0].Decision != "error" {
				t.Fatal("undelivered probe reported as a model verdict")
			}
			// A normal legacy invocation still gets the existing replacement behavior.
			legacy := s.redTeamActiveInvoke(httptest.NewRequest(http.MethodPost, "/", nil), "synthetic-key", "test-model", "test", "Public synthetic", "legacy", 77)
			if legacy.Code != 200 {
				t.Fatalf("legacy replacement changed: %d", legacy.Code)
			}
			if scenario == "deprecation" {
				if calls.Load() != 1 || <-models != "replacement-model" {
					t.Fatal("legacy deprecation changed")
				}
			} else {
				if calls.Load() != 3 || <-models != "test-model" || <-models != defaultAutoModel("reasoning") {
					t.Fatal("legacy context replacement changed")
				}
			}
		})
	}
}
