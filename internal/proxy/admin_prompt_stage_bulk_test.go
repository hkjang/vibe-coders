package proxy

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

const promptStageBulkPath = "/admin/prompts/promotions?view=promotion-review"

func seedStageBulkRequests(t *testing.T, db *store.SQLStore, name string, calls int) {
	t.Helper()
	for i := range calls {
		if err := db.InsertLogRecord(t.Context(), store.LogRecord{Request: store.RequestLog{ID: fmt.Sprintf("%s-%d", name, i), PromptName: name, PromptVersion: "v1", StatusCode: 200, CreatedAt: time.Now().UTC().Add(-time.Minute)}}); err != nil {
			t.Fatal(err)
		}
	}
}

func readStageBulkReview(t *testing.T, s *Server) promptStageBulkReview {
	t.Helper()
	w := stageWorkspaceRequest(s, "GET", promptStageBulkPath+"&window=1h", nil)
	var review promptStageBulkReview
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &review) != nil || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("review failed", w.Code)
	}
	for _, private := range []string{"old-note", "old-actor", "promoted_by", "prompt_name", "Note", "Promotion"} {
		if strings.Contains(w.Body.String(), private) {
			t.Fatal("review leaked internal data")
		}
	}
	return review
}

func TestPromptStageBulkReviewedAtomicWorkflow(t *testing.T) {
	for _, mode := range []string{"success", "stage-changed", "late-request", "late-evaluation", "expired", "forged", "different-actor"} {
		t.Run(mode, func(t *testing.T) {
			s, db, _ := newAdminModelsTestServer(t, "")
			seedStageBulkRequests(t, db, "alpha", 20)
			seedStageBulkRequests(t, db, "beta", 50)
			seedStageBulkRequests(t, db, "few", 1)
			if err := db.SetPromptStage(t.Context(), store.PromptPromotion{PromptName: "beta", PromptVersion: "v1", Stage: "validation", Note: "old-note", PromotedBy: "old-actor"}); err != nil {
				t.Fatal(err)
			}
			review := readStageBulkReview(t, s)
			if len(review.Items) != 2 || review.ObservedCount != 3 || review.IgnoredCount != 1 || review.BlockedCount != 0 || len(review.Revision) != 43 || review.Items[0].EligibleStage != "validation" || review.Items[1].EligibleStage != "production" {
				t.Fatal("criteria plan mismatch")
			}
			if mode == "stage-changed" {
				if err := db.SetPromptStage(t.Context(), store.PromptPromotion{PromptName: "beta", PromptVersion: "v1", Stage: "experiment"}); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "late-request" {
				if err := db.InsertLogRecord(t.Context(), store.LogRecord{Request: store.RequestLog{ID: "late", PromptName: "alpha", PromptVersion: "v1", StatusCode: 500, CreatedAt: review.Until.Add(-time.Second)}}); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "late-evaluation" {
				if err := db.InsertLLMEvaluations(t.Context(), []store.LLMEvaluation{{ID: "late-eval", RequestID: "alpha-0", Name: "quality", Category: "quality", Evaluator: "fixture", Passed: false, CreatedAt: time.Now().UTC()}}); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "expired" {
				review.Until = review.Until.Add(-6 * time.Minute)
				review.Since = review.Since.Add(-6 * time.Minute)
			}
			if mode == "forged" {
				review.Revision = strings.Repeat("z", 43)
			}
			if mode == "different-actor" {
				rows, err := db.PromptStageBulkSnapshot(t.Context(), review.Since, review.Until)
				if err != nil {
					t.Fatal(err)
				}
				foreign, _ := s.promptStageBulkReview(s.secrets.Load(), "different-reviewer", "1h", review.Since, review.Until, rows)
				review.Revision = foreign.Revision
			}
			payload := map[string]any{"window": review.Window, "since": review.Since, "until": review.Until, "revision": review.Revision, "reason": "전체 단계와 관측 기록 확인"}
			beforeA, _ := db.GetPromptStageSnapshot(t.Context(), "alpha", "v1")
			beforeB, _ := db.GetPromptStageSnapshot(t.Context(), "beta", "v1")
			w := stageWorkspaceRequest(s, "POST", promptStageBulkPath, payload)
			afterA, _ := db.GetPromptStageSnapshot(t.Context(), "alpha", "v1")
			afterB, _ := db.GetPromptStageSnapshot(t.Context(), "beta", "v1")
			audits, _ := db.ListAdminAudit(t.Context(), 20)
			if mode != "success" {
				if w.Code != 409 || afterA != beforeA || afterB != beforeB || len(audits) != 0 {
					t.Fatal("rejected review changed state", mode, w.Code)
				}
				return
			}
			var receipt struct {
				Count    int    `json:"count"`
				Revision string `json:"review_revision"`
			}
			if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &receipt) != nil || receipt.Count != 2 || receipt.Revision != review.Revision || afterA.Promotion.Stage != "validation" || afterB.Promotion.Stage != "production" || len(audits) != 1 || audits[0].Action != "prompt.promotion.auto" {
				t.Fatal("batch receipt/state mismatch", w.Code)
			}
			if !strings.Contains(audits[0].AfterValue, "전체 단계와 관측 기록 확인") || strings.Contains(audits[0].AfterValue, "alpha") || strings.Contains(audits[0].BeforeValue, "old-note") {
				t.Fatal("audit projection mismatch")
			}
			if duplicate := stageWorkspaceRequest(s, "POST", promptStageBulkPath, payload); duplicate.Code != 409 {
				t.Fatal("review applied twice", duplicate.Code)
			}
		})
	}
}

func TestPromptStageBulkUnsafeEmptyAndPermissions(t *testing.T) {
	s, db, _ := newAdminModelsTestServer(t, "")
	if empty := readStageBulkReview(t, s); len(empty.Items) != 0 || empty.Revision != "" {
		t.Fatal("empty review executable")
	}
	seedStageBulkRequests(t, db, "token=private-credential", 20)
	seedStageBulkRequests(t, db, "normal", 20)
	review := readStageBulkReview(t, s)
	if len(review.Items) != 2 || review.BlockedCount != 1 || review.Revision != "" {
		t.Fatal("unsafe target silently omitted")
	}
	for _, query := range []string{"&stage=experiment", "&window=forever", "&window=1h&window=7d", "&view=promotion-review"} {
		if w := stageWorkspaceRequest(s, "GET", promptStageBulkPath+query, nil); w.Code != 400 {
			t.Fatal("invalid review query accepted", w.Code)
		}
	}
	s.cfg.Auth.Enabled = true
	s.cfg.Auth.JWTSecret = "public-bulk-stage-fixture"
	for _, tc := range []struct {
		role   string
		scopes []string
		read   bool
	}{{"readonly_admin", []string{"admin:read"}, true}, {"user", []string{"models:read"}, false}} {
		token := issueLLMScopedTestToken(t, db, s, "stage-bulk-"+tc.role, tc.role, "", tc.scopes, time.Now().UTC())
		for _, method := range []string{"GET", "POST"} {
			r := httptest.NewRequest(method, promptStageBulkPath, strings.NewReader(`{}`))
			r.Header.Set("Authorization", "Bearer "+token)
			w := httptest.NewRecorder()
			s.Routes().ServeHTTP(w, r)
			if method == "GET" && (w.Code == 200) != tc.read {
				t.Fatal("read permission mismatch", w.Code)
			}
			if method == "POST" && w.Code != 401 && w.Code != 403 {
				t.Fatal("read-only actor reached batch apply", w.Code)
			}
		}
	}
}
