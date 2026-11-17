package proxy

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func replayFixture(t *testing.T, handler http.HandlerFunc) (*Server, *store.SQLStore, *sql.DB, store.RedTeamCampaign) {
	t.Helper()
	s, db, raw, campaign := reviewedRecordingFixture(t, handler)
	run := store.RedTeamRun{ID: "source-run", CampaignID: campaign.ID, TargetID: "target", Status: "passed", Mode: "dry-run", TotalCases: 1}
	if err := db.InsertRedTeamRun(t.Context(), run); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertRedTeamCaseResult(t.Context(), store.RedTeamCaseResult{ID: "source-result", RunID: run.ID, CaseID: "case", Decision: "pass", Severity: "low", EvidenceHash: "source-evidence-hash"}); err != nil {
		t.Fatal(err)
	}
	if err := db.InsertRedTeamEvidence(t.Context(), store.RedTeamEvidence{ID: "source-evidence", ResultID: "source-result", MaskedPrompt: "[source masked]", RawPrompt: "synthetic original prompt", RawResponse: "synthetic original response", ExportHash: "source-evidence-hash"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertRedTeamBaseline(t.Context(), store.RedTeamBaseline{ID: "source-baseline", TargetID: "target", PackID: "pack", BaselineScore: 17}); err != nil {
		t.Fatal(err)
	}
	return s, db, raw, campaign
}

func replayBody() redTeamReplayReviewRequest {
	return redTeamReplayReviewRequest{Reason: "한 건만 다시 검증", Model: "test-model", Limits: reviewedBody().Limits}
}

func replayRequest(s *Server, id string, body any, actor string, execute bool) *httptest.ResponseRecorder {
	encoded, _ := json.Marshal(body)
	r := httptest.NewRequest(http.MethodPost, "/admin/redteam/results/"+id+"/rerun-review", bytes.NewReader(encoded))
	r.Header.Set("Authorization", "Bearer "+actor)
	w := httptest.NewRecorder()
	if execute {
		s.handleRedTeamReviewedReplay(w, r, id)
	} else {
		s.handleRedTeamReplayReview(w, r, id)
	}
	return w
}

func issueReplay(t *testing.T, s *Server, body redTeamReplayReviewRequest) redTeamReplayReviewResponse {
	t.Helper()
	w := replayRequest(s, "source-result", body, "operator", false)
	if w.Code != 200 {
		t.Fatalf("review: %d %s", w.Code, w.Body.String())
	}
	var result redTeamReplayReviewResponse
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("review may be cached")
	}
	return result
}

func TestRedTeamReplayPreservesSourceAndCampaign(t *testing.T) {
	for _, rawRetention := range []bool{false, true} {
		t.Run(fmt.Sprint(rawRetention), func(t *testing.T) {
			var calls atomic.Int32
			s, db, _, campaign := replayFixture(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				var body struct {
					Model     string `json:"model"`
					MaxTokens int    `json:"max_tokens"`
					N         int    `json:"n"`
					Stream    bool   `json:"stream"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if body.Model != "test-model" || body.MaxTokens != 77 || body.N != 1 || body.Stream {
					t.Errorf("unbounded replay: %+v", body)
				}
				redTeamAdmissionReply(w)
			})
			// A replay must not run the other cases or approve the whole pack.
			if err := db.UpsertRedTeamProbeCase(t.Context(), store.RedTeamProbeCase{ID: "other-case", PackID: "pack", CaseKey: "other", InputTemplate: "Other synthetic case", TargetTypes: []string{"model"}}); err != nil {
				t.Fatal(err)
			}
			original, _, _ := db.GetRedTeamCaseResult(t.Context(), "source-result")
			originalRun, _, _ := db.GetRedTeamRun(t.Context(), "source-run")
			originalEvidence, _, _ := db.RedTeamEvidenceByResult(t.Context(), "source-result")
			originalBaselines, _ := db.ListRedTeamBaselines(t.Context())
			body := replayBody()
			body.RetainRawEvidence = rawRetention
			review := issueReplay(t, s, body)
			if calls.Load() != 0 || review.LiveCalls != 1 || review.CaseExecutions != 1 || review.SourceResult.ID != "source-result" || review.RetainRawEvidence != rawRetention {
				t.Fatal("review did not bind one explicit case")
			}
			w := replayRequest(s, "source-result", executionBody(review.redTeamRunReviewResponse), "operator", true)
			var out struct {
				Complete  bool               `json:"complete"`
				Runs      []store.RedTeamRun `json:"runs"`
				Recording redTeamRecording   `json:"recording"`
				Source    string             `json:"source_result_id"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
				t.Fatal(err)
			}
			if w.Code != 200 || !out.Complete || !out.Recording.Confirmed || out.Source != "source-result" || calls.Load() != 1 || len(out.Runs) != 1 {
				t.Fatalf("replay: %d %s, calls %d", w.Code, w.Body.String(), calls.Load())
			}
			newRun := out.Runs[0]
			if newRun.ID == originalRun.ID || newRun.SourceResultID != original.ID || newRun.ReviewID != review.ReviewID {
				t.Fatal("missing new-run provenance")
			}
			stored, found, err := db.GetRedTeamRun(t.Context(), newRun.ID)
			if err != nil || !found || stored.SourceResultID != original.ID || stored.ReviewID != review.ReviewID || stored.Status != "passed" {
				t.Fatal("provenance not persisted")
			}
			results, err := db.ListRedTeamCaseResults(t.Context(), newRun.ID)
			if err != nil || len(results) != 1 || results[0].ID == original.ID {
				t.Fatal("missing separate result")
			}
			evidence, found, err := db.RedTeamEvidenceByResult(t.Context(), results[0].ID)
			if err != nil || !found || (rawRetention && evidence.RawPrompt == "") || (!rawRetention && (evidence.RawPrompt != "" || evidence.RawResponse != "")) {
				t.Fatal("raw retention choice was not honored")
			}
			after, _, _ := db.GetRedTeamCaseResult(t.Context(), original.ID)
			afterRun, _, _ := db.GetRedTeamRun(t.Context(), originalRun.ID)
			afterEvidence, _, _ := db.RedTeamEvidenceByResult(t.Context(), original.ID)
			afterCampaign, _, _ := db.GetRedTeamCampaign(t.Context(), campaign.ID)
			afterBaselines, _ := db.ListRedTeamBaselines(t.Context())
			if !reflect.DeepEqual(original, after) || !reflect.DeepEqual(originalRun, afterRun) || !reflect.DeepEqual(originalEvidence, afterEvidence) || !reflect.DeepEqual(campaign, afterCampaign) || !reflect.DeepEqual(originalBaselines, afterBaselines) {
				t.Fatal("replay modified source, campaign or pack baseline")
			}
			if retry := replayRequest(s, "source-result", executionBody(review.redTeamRunReviewResponse), "operator", true); retry.Code != 409 || calls.Load() != 1 {
				t.Fatal("token reused")
			}
			audits, err := db.ListAdminAudit(t.Context(), 100)
			if err != nil {
				t.Fatal(err)
			}
			admitted := false
			for _, a := range audits {
				if a.Action == "redteam.result.replay.reviewed" {
					admitted = true
					if !strings.Contains(a.AfterValue, newRun.ID) || !strings.Contains(a.AfterValue, original.ID) || strings.Contains(a.AfterValue, "synthetic-key") {
						t.Fatal("admission provenance/credential leak")
					}
				}
			}
			if !admitted {
				t.Fatal("admission audit missing")
			}
		})
	}
}

func TestRedTeamReplayRejectsCrossOperationSourceAndStaleDefinitions(t *testing.T) {
	for _, change := range []string{"actor", "source", "campaign_token", "replay_token_on_campaign", "source_result", "source_evidence", "campaign", "case", "target", "pack", "provider", "kill"} {
		t.Run(change, func(t *testing.T) {
			var calls atomic.Int32
			s, db, _, campaign := replayFixture(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1); redTeamAdmissionReply(w) })
			review := issueReplay(t, s, replayBody())
			id, actor := "source-result", "operator"
			switch change {
			case "actor":
				actor = "other-operator"
			case "source":
				if err := db.InsertRedTeamCaseResult(t.Context(), store.RedTeamCaseResult{ID: "other-result", RunID: "source-run", CaseID: "case", Decision: "pass", Severity: "low"}); err != nil {
					t.Fatal(err)
				}
				id = "other-result"
			case "campaign_token":
				review.redTeamRunReviewResponse = issueReviewed(t, s, campaign, reviewedBody())
			case "replay_token_on_campaign":
				w := reviewedRequest(s, campaign, executionBody(review.redTeamRunReviewResponse), actor, true)
				if w.Code != 409 || calls.Load() != 0 {
					t.Fatal("replay token authorized full campaign")
				}
				return
			case "source_result":
				v, _, _ := db.GetRedTeamCaseResult(t.Context(), id)
				v.Decision = "fail"
				if err := db.UpdateRedTeamCaseResult(t.Context(), v); err != nil {
					t.Fatal(err)
				}
			case "source_evidence":
				if err := db.InsertRedTeamEvidence(t.Context(), store.RedTeamEvidence{ID: "new-source-evidence", ResultID: id, ExportHash: "new-hash", CreatedAt: "2099-01-01T00:00:00Z"}); err != nil {
					t.Fatal(err)
				}
			case "campaign":
				campaign.Name = "Changed"
				if err := db.UpsertRedTeamCampaign(t.Context(), campaign); err != nil {
					t.Fatal(err)
				}
			case "case":
				v, _, _ := db.GetRedTeamProbeCase(t.Context(), "case")
				v.InputTemplate = "Changed"
				if err := db.UpsertRedTeamProbeCase(t.Context(), v); err != nil {
					t.Fatal(err)
				}
			case "target":
				v, _, _ := db.GetRedTeamTarget(t.Context(), "target")
				v.Enabled = false
				if err := db.SyncRedTeamTargets(t.Context(), []store.RedTeamTarget{v}); err != nil {
					t.Fatal(err)
				}
			case "pack":
				if err := db.UpsertRedTeamProbePackWithCases(t.Context(), store.RedTeamProbePack{ID: "pack", Enabled: false}, nil); err != nil {
					t.Fatal(err)
				}
			case "provider":
				provider, _, _ := db.GetProvider(t.Context(), "test")
				provider.TimeoutMS++
				if err := db.UpsertProvider(t.Context(), provider); err != nil {
					t.Fatal(err)
				}
			case "kill":
				redteamKillSwitch.Store(true)
			}
			w := replayRequest(s, id, executionBody(review.redTeamRunReviewResponse), actor, true)
			if w.Code != 409 || calls.Load() != 0 {
				t.Fatalf("%s admitted: %d %s calls=%d", change, w.Code, w.Body.String(), calls.Load())
			}
		})
	}
}

func TestRedTeamReplayRecordingFailureNeverChangesOriginal(t *testing.T) {
	for _, stage := range []string{"audit", "run_start", "evidence", "run_finish", "campaign_finish", "baseline"} {
		t.Run(stage, func(t *testing.T) {
			var calls atomic.Int32
			s, db, raw, campaign := replayFixture(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1); redTeamAdmissionReply(w) })
			original, _, _ := db.GetRedTeamCaseResult(t.Context(), "source-result")
			originalEvidence, _, _ := db.RedTeamEvidenceByResult(t.Context(), "source-result")
			review := issueReplay(t, s, replayBody())
			table, event := "redteam_runs", "INSERT"
			switch stage {
			case "audit":
				table = "admin_audit_logs"
			case "evidence":
				table = "redteam_evidence"
			case "run_finish":
				event = "UPDATE"
			case "campaign_finish":
				table, event = "redteam_campaigns", "UPDATE"
			case "baseline":
				table = "redteam_baselines"
			}
			stmts := []string{fmt.Sprintf(`CREATE TRIGGER reject_replay BEFORE %s ON %s BEGIN SELECT RAISE(ABORT, 'synthetic replay failure'); END`, event, table)}
			if os.Getenv("TEST_POSTGRES_DSN") != "" {
				stmts = []string{`CREATE FUNCTION reject_replay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic replay failure'; END $$`, fmt.Sprintf(`CREATE TRIGGER reject_replay BEFORE %s ON %s FOR EACH ROW EXECUTE FUNCTION reject_replay()`, event, table)}
			}
			for _, stmt := range stmts {
				if _, err := raw.ExecContext(t.Context(), stmt); err != nil {
					t.Fatal(err)
				}
			}
			w := replayRequest(s, "source-result", executionBody(review.redTeamRunReviewResponse), "operator", true)
			if stage == "audit" {
				if w.Code != 500 || calls.Load() != 0 {
					t.Fatal("unacknowledged audit dispatched")
				}
				return
			}
			var out struct {
				Complete  bool             `json:"complete"`
				Recording redTeamRecording `json:"recording"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
				t.Fatal(err)
			}
			unrelated := stage == "campaign_finish" || stage == "baseline"
			if w.Code != 200 || out.Complete != unrelated || out.Recording.Confirmed != unrelated {
				t.Fatalf("outcome %d %s", w.Code, w.Body.String())
			}
			wantCalls := int32(1)
			if stage == "run_start" {
				wantCalls = 0
			}
			if calls.Load() != wantCalls {
				t.Fatal("unexpected call count")
			}
			after, _, _ := db.GetRedTeamCaseResult(t.Context(), original.ID)
			afterEvidence, _, _ := db.RedTeamEvidenceByResult(t.Context(), original.ID)
			afterCampaign, _, _ := db.GetRedTeamCampaign(t.Context(), campaign.ID)
			if !reflect.DeepEqual(original, after) || !reflect.DeepEqual(originalEvidence, afterEvidence) || !reflect.DeepEqual(campaign, afterCampaign) {
				t.Fatal("original changed after recording failure")
			}
		})
	}
}

func TestRedTeamReplayRoutesRequireWritePermission(t *testing.T) {
	s, db, _, _ := replayFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("denied replay reached provider") })
	s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "public-replay-permission-fixture"
	token := issueLLMScopedTestToken(t, db, s, "replay-reader", "readonly_admin", "", []string{"admin:read"}, time.Now().UTC())
	for _, action := range []string{"rerun-review", "rerun-reviewed"} {
		for _, scenario := range []struct {
			token, marker string
			want          int
		}{{token, "app", 403}, {token, "", 401}, {"invalid", "app", 401}} {
			r := httptest.NewRequest(http.MethodPost, "/admin/redteam/results/source-result/"+action, strings.NewReader(`{}`))
			r.Header.Set("Authorization", "Bearer "+scenario.token)
			r.Header.Set("X-Vibe-UI", scenario.marker)
			w := httptest.NewRecorder()
			s.Routes().ServeHTTP(w, r)
			if w.Code != scenario.want {
				t.Fatalf("%s: got %d want %d", action, w.Code, scenario.want)
			}
		}
	}
}

func TestRedTeamReplayRejectsIneligibleSelectionWithoutCalls(t *testing.T) {
	for _, scenario := range []string{"max_calls", "empty_model", "glob_model", "virtual_model", "approval", "running_source", "missing_source", "text2sql", "mcp_tool", "app", "workflow"} {
		t.Run(scenario, func(t *testing.T) {
			s, db, _, campaign := replayFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("ineligible replay reached provider") })
			body, id, want := replayBody(), "source-result", 400
			switch scenario {
			case "max_calls":
				body.Limits.MaxCalls = 2
			case "empty_model":
				body.Model = ""
			case "glob_model":
				body.Model = "test-*"
			case "virtual_model":
				body.Model = "vibe/text2sql-test"
			case "approval":
				campaign.Status = "draft"
				if err := db.UpsertRedTeamCampaign(t.Context(), campaign); err != nil {
					t.Fatal(err)
				}
				cs, _, _ := db.GetRedTeamProbeCase(t.Context(), "case")
				if err := db.UpsertRedTeamProbePackWithCases(t.Context(), store.RedTeamProbePack{ID: "pack", Enabled: true, RequiresApproval: true}, []store.RedTeamProbeCase{cs}); err != nil {
					t.Fatal(err)
				}
			case "running_source":
				v, _, _ := db.GetRedTeamRun(t.Context(), "source-run")
				v.Status = "running"
				if err := db.UpdateRedTeamRun(t.Context(), v); err != nil {
					t.Fatal(err)
				}
			case "missing_source":
				id, want = "absent", 404
			default:
				campaign.Scope = "all"
				if err := db.UpsertRedTeamCampaign(t.Context(), campaign); err != nil {
					t.Fatal(err)
				}
				target, _, _ := db.GetRedTeamTarget(t.Context(), "target")
				target.TargetType = scenario
				if err := db.SyncRedTeamTargets(t.Context(), []store.RedTeamTarget{target}); err != nil {
					t.Fatal(err)
				}
				cs, _, _ := db.GetRedTeamProbeCase(t.Context(), "case")
				cs.TargetTypes = nil
				if err := db.UpsertRedTeamProbeCase(t.Context(), cs); err != nil {
					t.Fatal(err)
				}
			}
			w := replayRequest(s, id, body, "operator", false)
			if w.Code != want {
				t.Fatalf("review got %d want %d: %s", w.Code, want, w.Body.String())
			}
		})
	}
}
