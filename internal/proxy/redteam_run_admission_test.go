package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"vibe-coders/internal/store"
)

// Exercise the production runner and gateway with a real local HTTP provider.
// Selection is supplied directly so the test can reach the runtime threshold
// independently of the separate advisory preflight estimate.
func redTeamAdmissionFixture(t *testing.T, handler http.HandlerFunc) (*Server, *store.SQLStore, store.RedTeamCampaign, []store.RedTeamTarget, []store.RedTeamProbePack, []store.RedTeamProbeCase) {
	t.Helper()
	resetRedTeamEmergencyTest(t)
	upstream := httptest.NewServer(handler)
	t.Cleanup(upstream.Close)
	db := openTestStore(t)
	logger := store.NewAsyncLogger(db, 32, filepath.Join(t.TempDir(), "fallback.ndjson"))
	logger.Start()
	t.Cleanup(func() { logger.Stop(context.Background()); db.Close() })
	s, err := NewServer(testConfig(upstream.URL, "unused-fixture-key"), db, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	c := store.RedTeamCampaign{ID: "admission", Name: "호출 제한 검사", Scope: "provider", Status: "approved", ExecutionMode: "active-controlled", TargetFilter: map[string]any{"models": []string{"test-model", "second-model", "third-model"}}}
	if err := db.UpsertRedTeamCampaign(context.Background(), c); err != nil {
		t.Fatal(err)
	}
	targets := []store.RedTeamTarget{{ID: "target", TargetType: "model", TargetRef: "model:test:test-model", Provider: "test", Model: "test-model", Enabled: true}}
	if err := db.SyncRedTeamTargets(context.Background(), targets); err != nil {
		t.Fatal(err)
	}
	packs := []store.RedTeamProbePack{{ID: "pack", Name: "검사", Enabled: true}}
	cases := []store.RedTeamProbeCase{{ID: "case", PackID: "pack", CaseKey: "admission", InputTemplate: "Synthetic safety test", ExpectedPolicy: "refuse", Severity: "low", TargetTypes: []string{"model"}}}
	if err := db.UpsertRedTeamProbePackWithCases(context.Background(), packs[0], cases); err != nil {
		t.Fatal(err)
	}
	return s, db, c, targets, packs, cases
}

func redTeamAdmissionReply(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"I cannot help with that request."}}]}`))
}

func assertRedTeamStopped(t *testing.T, db *store.SQLStore, result map[string]any, reason string, calls int) {
	t.Helper()
	if result["status"] != "stopped" || result["stopped"] != reason {
		t.Fatalf("expected stopped/%s, got %v/%v", reason, result["status"], result["stopped"])
	}
	runs := result["runs"].([]store.RedTeamRun)
	if len(runs) != 1 || runs[0].Status != "stopped" || runs[0].TotalCases != calls {
		t.Fatalf("partial execution reported as complete: %+v", runs)
	}
	stored, found, err := db.GetRedTeamRun(context.Background(), runs[0].ID)
	if err != nil || !found || stored.Status != "stopped" || stored.TotalCases != calls {
		t.Fatalf("partial execution not persisted: %+v %v", stored, err)
	}
	campaign, _, err := db.GetRedTeamCampaign(context.Background(), "admission")
	if err != nil || campaign.Status != "stopped" {
		t.Fatal("campaign stop not persisted")
	}
	baselines, err := db.ListRedTeamBaselines(context.Background())
	if err != nil || len(baselines) != 0 {
		t.Fatal("incomplete run must not advance a passing baseline")
	}
}

func TestRedTeamRunAdmissionBetweenModels(t *testing.T) {
	for _, reason := range []string{"budget_exceeded", "kill_switch", "context_cancelled"} {
		t.Run(reason, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var calls atomic.Int32
			s, db, c, targets, packs, cases := redTeamAdmissionFixture(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if reason == "kill_switch" {
					redteamKillSwitch.Store(true)
				}
				if reason == "context_cancelled" {
					cancel()
				}
				redTeamAdmissionReply(w)
			})
			if reason == "budget_exceeded" {
				c.BudgetLimitKRW = 0.5
			}
			r := httptest.NewRequest(http.MethodPost, "/admin/redteam/campaigns/admission/run", nil).WithContext(ctx)
			result, err := s.runRedTeamSelection(r, c, "synthetic-key", targets, packs, cases)
			if err != nil {
				t.Fatal(err)
			}
			if calls.Load() != 1 {
				t.Fatalf("dispatched %d calls after stop", calls.Load())
			}
			assertRedTeamStopped(t, db, result, reason, 1)
		})
	}
}

func TestRedTeamRunAdmissionAfterModelDiscovery(t *testing.T) {
	var probes atomic.Int32
	s, db, c, targets, packs, cases := redTeamAdmissionFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			redteamKillSwitch.Store(true)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":[{"id":"test-model"}]}`))
			return
		}
		probes.Add(1)
		redTeamAdmissionReply(w)
	})
	c.TargetFilter = map[string]any{"models": []string{"*"}}
	result, err := s.runRedTeamSelection(httptest.NewRequest(http.MethodPost, "/", nil), c, "synthetic-key", targets, packs, cases)
	if err != nil {
		t.Fatal(err)
	}
	if probes.Load() != 0 {
		t.Fatal("model probe dispatched after discovery activated kill switch")
	}
	assertRedTeamStopped(t, db, result, "kill_switch", 0)
}

func TestRedTeamRunAdmissionCallLimitDoesNotSimulateRemainder(t *testing.T) {
	var calls atomic.Int32
	s, db, c, targets, packs, cases := redTeamAdmissionFixture(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1); redTeamAdmissionReply(w) })
	c.TargetFilter = map[string]any{"models": []string{"test-model"}}
	probe := cases[0]
	cases = make([]store.RedTeamProbeCase, redteamActiveMaxCalls+1)
	for i := range cases {
		cases[i] = probe
		cases[i].ID = fmt.Sprintf("case-%d", i)
	}
	result, err := s.runRedTeamSelection(httptest.NewRequest(http.MethodPost, "/", nil), c, "synthetic-key", targets, packs, cases)
	if err != nil {
		t.Fatal(err)
	}
	if int(calls.Load()) != redteamActiveMaxCalls {
		t.Fatalf("unexpected call count: %d", calls.Load())
	}
	assertRedTeamStopped(t, db, result, "call_limit", redteamActiveMaxCalls)
}

func TestRedTeamRunAdmissionCompleteStillUpdatesBaseline(t *testing.T) {
	var calls atomic.Int32
	s, db, c, targets, packs, cases := redTeamAdmissionFixture(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1); redTeamAdmissionReply(w) })
	result, err := s.runRedTeamSelection(httptest.NewRequest(http.MethodPost, "/", nil), c, "synthetic-key", targets, packs, cases)
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 3 || result["status"] != "completed" || result["stopped"] != "" {
		t.Fatal("complete run changed")
	}
	baselines, err := db.ListRedTeamBaselines(context.Background())
	if err != nil || len(baselines) != 1 {
		t.Fatal("complete passing run did not update baseline")
	}
	// Completion and stopped outputs must remain JSON encodable for the API.
	if _, err := json.Marshal(result); err != nil {
		t.Fatal(err)
	}
}

func TestRedTeamRunAdmissionDuringRateWait(t *testing.T) {
	var calls atomic.Int32
	timers := make(chan *time.Timer, 1)
	s, db, c, targets, packs, cases := redTeamAdmissionFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			timers <- time.AfterFunc(50*time.Millisecond, func() { redteamKillSwitch.Store(true) })
		}
		redTeamAdmissionReply(w)
	})
	c.QPSLimit = 2
	result, err := s.runRedTeamSelection(httptest.NewRequest(http.MethodPost, "/", nil), c, "synthetic-key", targets, packs, cases)
	select {
	case timer := <-timers:
		timer.Stop()
	default:
	}
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("dispatched %d calls after rate wait", calls.Load())
	}
	assertRedTeamStopped(t, db, result, "kill_switch", 1)
}

func TestRedTeamRunAdmissionUpstreamErrorDoesNotPassBaseline(t *testing.T) {
	s, db, c, targets, packs, cases := redTeamAdmissionFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"synthetic provider rejection"}}`))
	})
	result, err := s.runRedTeamSelection(httptest.NewRequest(http.MethodPost, "/", nil), c, "synthetic-key", targets, packs, cases)
	if err != nil {
		t.Fatal(err)
	}
	runs := result["runs"].([]store.RedTeamRun)
	if len(runs) != 1 || runs[0].Status != "failed" || runs[0].FailedCases != 3 {
		t.Fatal("upstream failures were treated as passing model tests")
	}
	baselines, err := db.ListRedTeamBaselines(context.Background())
	if err != nil || len(baselines) != 0 {
		t.Fatal("upstream errors advanced passing baseline")
	}
	stored, err := db.ListRedTeamCaseResults(context.Background(), runs[0].ID)
	if err != nil || len(stored) != 3 {
		t.Fatal("error results not retained")
	}
	for _, result := range stored {
		if result.Decision != "error" {
			t.Fatal("upstream failure classification lost")
		}
	}
}
