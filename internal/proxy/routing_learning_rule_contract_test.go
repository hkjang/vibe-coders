package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// Existing Routes/SQLStore, synthetic records only. The create fixture rejects
// upstream calls. Recommendations are not saved rules or safety approvals.
func learningRuleSeed(t *testing.T, db *store.SQLStore, prefix, task, model string, score, requests, successes int, at time.Time) {
	t.Helper()
	for i := 0; i < requests; i++ {
		id := fmt.Sprintf("learning-contract-%s-%d", prefix, i)
		status := 200
		if i >= successes {
			status = 500
		}
		if err := db.InsertLogRecord(t.Context(), store.LogRecord{
			Request: store.RequestLog{ID: id, TraceID: id, Endpoint: "/v1/chat/completions",
				Model: model, TaskType: task, Complexity: score, StatusCode: status,
				LatencyMS: 10, CreatedAt: at},
			Usage: &store.TokenUsage{ID: id + "-usage", RequestID: id, TotalTokens: 10,
				EstimatedCost: 1, Currency: "KRW", Source: "usage", CreatedAt: at},
		}); err != nil {
			t.Fatal("synthetic learning record insertion failed")
		}
	}
}

func learningRuleReport(t *testing.T, s *Server, query string) store.RoutingLearning {
	t.Helper()
	w := routingCreateRequest(t, s, http.MethodGet, "/admin/routing/learning"+query, "", "")
	var report store.RoutingLearning
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &report) != nil ||
		report.Cells == nil || report.Recommendations == nil {
		t.Fatalf("learning response contract mismatch, status=%d", w.Code)
	}
	return report
}

func TestRoutingLearningRuleBucketBoundaries(t *testing.T) {
	db, s, _ := routingCreateFixture(t)
	cases := []struct {
		score  int
		bucket string
	}{{0, "low"}, {33, "low"}, {34, "medium"}, {66, "medium"}, {67, "high"}, {100, "high"}}
	for _, tc := range cases {
		label := fmt.Sprintf("score-%d", tc.score)
		learningRuleSeed(t, db, label, "refactor", label, tc.score, 1, 1, time.Now().UTC().Add(-time.Hour))
	}
	report := learningRuleReport(t, s, "?window=24h&min_samples=1")
	if len(report.Cells) != len(cases) || len(report.Recommendations) != 3 {
		t.Fatal("expected six model cells in three learning buckets")
	}
	for _, tc := range cases {
		t.Run(fmt.Sprintf("score_%d", tc.score), func(t *testing.T) {
			model := fmt.Sprintf("score-%d", tc.score)
			found := false
			for _, cell := range report.Cells {
				if cell.Model == model {
					found = true
					if cell.Bucket != tc.bucket || cell.Requests != 1 || cell.Successes != 1 || cell.TaskType != "refactor" {
						t.Fatal("actual SQL aggregate bucket/sample identity differs")
					}
				}
			}
			if !found || complexityBucket(tc.score) != tc.bucket {
				t.Fatal("HTTP learning result and hot-path learning bucket must agree")
			}
		})
	}
}

func TestRoutingLearningRuleEvidenceMeaning(t *testing.T) {
	for _, different := range []bool{false, true} {
		name := "same_as_most_used_without_a_saved_rule"
		if different {
			name = "different_from_most_used_not_from_saved_configuration"
		}
		t.Run(name, func(t *testing.T) {
			db, s, _ := routingCreateFixture(t)
			at := time.Now().UTC().Add(-time.Hour)
			successes := 5
			if different {
				successes = 3
			}
			learningRuleSeed(t, db, "popular", "refactor", "public-popular", 34, 5, successes, at)
			if different {
				learningRuleSeed(t, db, "best", "refactor", "public-best", 66, 3, 3, at)
			}
			report := learningRuleReport(t, s, "?min_samples=2")
			if len(report.Recommendations) != 1 {
				t.Fatal("expected one observed task/bucket recommendation")
			}
			rec := report.Recommendations[0]
			wantModel, wantSamples := "public-popular", int64(5)
			if different {
				wantModel, wantSamples = "public-best", 3
			}
			if rec.RecommendedModel != wantModel || rec.TopModel != "public-popular" || rec.Differs != different ||
				!rec.Confident || rec.Samples != wantSamples || rec.SuccessRate != 1 || rec.Bucket != "medium" {
				t.Fatal("differs/confident/samples must describe observed model evidence")
			}
			if err := db.UpsertRoutingRule(t.Context(), store.RoutingRule{ID: "learning-active-other", Enabled: true,
				Priority: 1, MatchPattern: "*", MinComplexity: 0, MaxComplexity: 100, TargetModel: "public-unobserved"}); err != nil {
				t.Fatal("synthetic active rule insertion failed")
			}
			afterRule := learningRuleReport(t, s, "?min_samples=2")
			if !reflect.DeepEqual(report.Cells, afterRule.Cells) || !reflect.DeepEqual(report.Recommendations, afterRule.Recommendations) {
				t.Fatal("saved routing configuration must not redefine observed recommendation evidence")
			}
			learningRuleSeed(t, db, "sparse", "refactor", "public-sparse", 34, 1, 1, at)
			sparse := learningRuleReport(t, s, "?min_samples=2")
			if len(sparse.Cells) != len(report.Cells)+1 || len(sparse.Recommendations) != 1 {
				t.Fatal("under-floor evidence must remain visible in the aggregate")
			}
			got := sparse.Recommendations[0]
			if got.Confident || got.RecommendedModel != wantModel || got.Samples != wantSamples || got.Differs != different {
				t.Fatal("confidence is the sample-floor condition, not a traffic safety approval")
			}
		})
	}
}

func TestRoutingLearningRuleWindowAndSampleFloor(t *testing.T) {
	for _, tc := range []struct {
		name, query string
		window      time.Duration
		floor       int
		wantRec     bool
	}{
		{"default", "", 7 * 24 * time.Hour, 20, false},
		{"24_hours", "?window=24h&min_samples=3", 24 * time.Hour, 3, true},
		{"30_days", "?window=30d&min_samples=4", 30 * 24 * time.Hour, 4, false},
		{"90_days", "?window=90d&min_samples=1", 90 * 24 * time.Hour, 1, true},
		{"duration", "?window=2h&min_samples=2", 2 * time.Hour, 2, true},
		{"invalid_defaults", "?window=invalid&min_samples=invalid", 7 * 24 * time.Hour, 20, false},
		{"zero_defaults", "?window=0h&min_samples=0", 7 * 24 * time.Hour, 20, false},
		{"negative_defaults", "?window=-1h&min_samples=-1", 7 * 24 * time.Hour, 20, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, s, other := routingCreateFixture(t)
			learningRuleSeed(t, db, "floor", "refactor", "public-model", 33, 3, 3, time.Now().UTC().Add(-time.Hour))
			cached := &routingRulesSnapshot{rules: []store.RoutingRule{other}, fetchedAt: time.Now()}
			s.routingRules.Store(cached)
			before := time.Now().UTC().Add(-tc.window)
			report := learningRuleReport(t, s, tc.query)
			after := time.Now().UTC().Add(-tc.window)
			if after.Before(before) {
				before, after = after, before // Wall-clock monotonicity is not assumed.
			}
			since, err := time.Parse(time.RFC3339, report.Since)
			if err != nil || !strings.HasSuffix(report.Since, "Z") ||
				since.Before(before.Truncate(time.Second)) || since.After(after.Truncate(time.Second)) || report.MinSamples != tc.floor {
				t.Fatal("HTTP since/floor must report the effective normalized query criteria")
			}
			if len(report.Cells) != 1 || (len(report.Recommendations) == 1) != tc.wantRec {
				t.Fatal("the floor filters recommendations, not observed aggregate cells")
			}
			assertRoutingCreateUntouched(t, db, s, other, cached)
		})
	}
	// Deterministic store boundary; HTTP seconds-only since is not a snapshot token.
	t.Run("store_since_inclusive_and_chat_endpoint_only", func(t *testing.T) {
		db, _, _ := routingCreateFixture(t)
		since := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
		learningRuleSeed(t, db, "before", "refactor", "public-before", 33, 1, 1, since.Add(-time.Second))
		learningRuleSeed(t, db, "at", "refactor", "public-at", 34, 1, 1, since)
		learningRuleSeed(t, db, "after", "refactor", "public-after", 67, 1, 1, since.Add(time.Second))
		if err := db.InsertLogRecord(t.Context(), store.LogRecord{Request: store.RequestLog{
			ID: "learning-contract-embeddings", Endpoint: "/v1/embeddings", Model: "public-embedding",
			TaskType: "refactor", Complexity: 34, StatusCode: 200, CreatedAt: since.Add(time.Second),
		}}); err != nil {
			t.Fatal("synthetic non-chat insertion failed")
		}
		report, err := db.RoutingLearning(t.Context(), since, 1)
		if err != nil || len(report.Cells) != 2 || len(report.Recommendations) != 2 {
			t.Fatal("since or chat endpoint filtering differs")
		}
		seen := map[string]bool{}
		for _, cell := range report.Cells {
			seen[cell.Model] = true
		}
		if !seen["public-at"] || !seen["public-after"] {
			t.Fatal("only the at/after chat-completion fixture rows should be included")
		}
	})
}

func TestRoutingLearningRuleCreateNormalization(t *testing.T) {
	for _, tc := range []struct{ name, raw, normalized string }{
		{"NEL_trimmed", "\u0085public-model\u0085", "public-model"},
		{"FEFF_preserved", "\ufeffpublic-model\ufeff", "\ufeffpublic-model\ufeff"},
		{"NEL_outside_FEFF", "\u0085\ufeffpublic-model\ufeff\u0085", "\ufeffpublic-model\ufeff"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, s, _ := routingCreateFixture(t)
			learningRuleSeed(t, db, "normalization", "refactor", tc.raw, 34, 1, 1, time.Now().UTC().Add(-time.Hour))
			report := learningRuleReport(t, s, "?min_samples=1")
			if len(report.Recommendations) != 1 || report.Recommendations[0].RecommendedModel != tc.raw {
				t.Fatal("learning must retain observed model spelling before POST normalization")
			}
			body, err := json.Marshal(map[string]any{
				"target_model": report.Recommendations[0].RecommendedModel, "match_pattern": "*",
				"min_complexity": 34, "max_complexity": 66, "priority": 100, "enabled": true,
				"target_provider": "", "note": "\u0085학습 추천 적용 (refactor/medium)\u0085",
			})
			if err != nil {
				t.Fatal("synthetic recommendation body encoding failed")
			}
			ack := routingCreateACK(t, routingCreateRequest(t, s, http.MethodPost, "/admin/routing-rules", string(body), ""))
			if ack.TargetModel != tc.normalized || ack.Note != "학습 추천 적용 (refactor/medium)" ||
				ack.MinComplexity != 34 || ack.MaxComplexity != 66 || !ack.Enabled || !ack.CreatedAt.IsZero() {
				t.Fatal("recommendation creation must use Go trim and normalized zero-time acknowledgment")
			}
			get := routingCreateRequest(t, s, http.MethodGet, "/admin/routing-rules", "", "")
			var listed struct {
				Rules []store.RoutingRule `json:"rules"`
			}
			if get.Code != http.StatusOK || json.Unmarshal(get.Body.Bytes(), &listed) != nil {
				t.Fatal("stored collection GET failed")
			}
			found := false
			for _, row := range listed.Rules {
				if row.ID == ack.ID {
					found = true
					if row.CreatedAt.IsZero() {
						t.Fatal("stored timestamp must not equal the handler zero copy")
					}
					row.CreatedAt = time.Time{}
					if row != ack {
						t.Fatal("stored fields differ from acknowledged normalized configuration")
					}
				}
			}
			if !found {
				t.Fatal("acknowledged identity is missing from stored collection")
			}
		})
	}
}

func TestRoutingLearningRuleTaskIndependentEvaluator(t *testing.T) {
	_, s, _ := routingCreateFixture(t)
	body := `{"match_pattern":"*","target_model":"public-recommended","min_complexity":34,"max_complexity":66,"priority":100,"enabled":true,"note":"학습 추천 적용 (refactor/medium)"}`
	routingCreateACK(t, routingCreateRequest(t, s, http.MethodPost, "/admin/routing-rules", body, ""))
	for _, task := range []string{"refactor", "debug", "other"} {
		for _, tc := range []struct {
			score int
			want  bool
		}{{33, false}, {34, true}, {66, true}, {67, false}} {
			t.Run(fmt.Sprintf("%s_%d", task, tc.score), func(t *testing.T) {
				request := store.RequestLog{Model: "public-original", TaskType: task, Complexity: tc.score}
				// The real evaluator accepts model/complexity, not task_type or
				// recommendation note. This is not a full upstream request.
				decision := s.evaluateRoutingRules(t.Context(), request.Model, request.Complexity)
				if decision.Applied != tc.want || (tc.want && decision.TargetModel != "public-recommended") {
					t.Fatal("a saved model/complexity rule must not imply a task-specific filter")
				}
			})
		}
	}
}

func TestRoutingLearningRulePermissionContract(t *testing.T) {
	for _, tc := range []struct {
		name, mode string
		scopes     []string
		read, post int
	}{
		{"routing_read", "jwt", []string{"routing:read"}, 200, 401},
		{"routing_write", "jwt", []string{"routing:write"}, 401, 201},
		{"routing_both", "jwt", []string{"routing:read", "routing:write"}, 200, 201},
		{"admin_not_routing", "jwt", []string{"admin:read", "admin:write"}, 401, 401},
		{"missing_jwt", "missing", nil, 401, 401},
		{"legacy_readonly", "readonly", nil, 200, 401},
		{"legacy_full", "legacy", nil, 200, 201},
		{"open", "open", nil, 200, 201},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, s, other := routingCreateFixture(t)
			token := ""
			switch tc.mode {
			case "jwt", "missing":
				s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "public-learning-jwt-secret"
				if tc.mode == "jwt" {
					token = issueLLMScopedTestToken(t, db, s, tc.name, "operator", "", tc.scopes, time.Now().UTC())
				}
			case "readonly", "legacy":
				s.cfg.Auth.AdminToken, s.cfg.Auth.AdminReadonlyToken = "public-learning-full", "public-learning-read"
				token = s.cfg.Auth.AdminReadonlyToken
				if tc.mode == "legacy" {
					token = s.cfg.Auth.AdminToken
				}
			}
			cached := &routingRulesSnapshot{rules: []store.RoutingRule{other}, fetchedAt: time.Now()}
			s.routingRules.Store(cached)
			read := routingCreateRequest(t, s, http.MethodGet, "/admin/routing/learning", "", token)
			if read.Code != tc.read {
				t.Fatalf("learning GET status=%d want=%d", read.Code, tc.read)
			}
			assertRoutingCreateUntouched(t, db, s, other, cached)
			post := routingCreateRequest(t, s, http.MethodPost, "/admin/routing-rules", `{"target_model":"public-model","min_complexity":34,"max_complexity":66}`, token)
			if post.Code != tc.post {
				t.Fatalf("rule POST status=%d want=%d", post.Code, tc.post)
			}
			if tc.post != http.StatusCreated {
				assertRoutingCreateUntouched(t, db, s, other, cached)
			} else {
				routingCreateACK(t, post)
			}
		})
	}
}
