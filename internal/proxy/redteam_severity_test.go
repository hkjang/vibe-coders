package proxy

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"vibe-coders/internal/store"
)

func severityJSONRequest(t *testing.T, s *Server, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(raw)))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.Routes().ServeHTTP(w, r)
	return w
}

func TestRedTeamSeverityPackWriters(t *testing.T) {
	s, db, _ := newRedTeamTestServer(t)
	for _, severity := range []string{"low", "medium", "high", "critical"} {
		for _, explicit := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/explicit-%v", severity, explicit), func(t *testing.T) {
				want := explicit || severity == "high" || severity == "critical"
				id := fmt.Sprintf("severity-%s-%v", severity, explicit)
				p := store.RedTeamProbePack{ID: id, Name: id, Severity: severity, RequiresApproval: explicit}
				response := severityJSONRequest(t, s, "/admin/redteam/probe-packs", p)
				if response.Code != http.StatusCreated {
					t.Fatalf("pack status=%d", response.Code)
				}
				if got := probeMetadataPack(t, db, id); got.RequiresApproval != want {
					t.Errorf("JSON approval=%v want=%v", got.RequiresApproval, want)
				}
				for _, marked := range []bool{false, true} {
					csvID := fmt.Sprintf("%s-csv-%v", id, marked)
					row := probeCSVPublicRow(csvID+"-case", "Synthetic severity check")
					row[0], row[1], row[3], row[4], row[9] = csvID, csvID, severity, fmt.Sprint(explicit), severity
					header := strings.Split(probeCSVPublicHeader, ",")
					if !marked {
						header, row = header[:13], row[:13]
					}
					response = probeCSVImportResponse(s, probeCSVRecordsBody(t, [][]string{header, row}))
					if response.Code != http.StatusOK {
						t.Fatalf("CSV status=%d", response.Code)
					}
					if got := probeMetadataPack(t, db, csvID); got.RequiresApproval != want {
						t.Errorf("marked=%v CSV approval=%v want=%v", marked, got.RequiresApproval, want)
					}
				}
			})
		}
		t.Run(severity+"/manual", func(t *testing.T) {
			name := "manual severity " + severity
			body := map[string]any{"pack_name": name, "case_key": "severity", "input_template": "Synthetic manual edit", "severity": severity}
			response := severityJSONRequest(t, s, "/admin/redteam/probe-cases", body)
			if response.Code != http.StatusCreated {
				t.Fatalf("manual status=%d", response.Code)
			}
			pack := probeMetadataPack(t, db, redTeamCustomPackID(name))
			want := severity == "high" || severity == "critical"
			if pack.RequiresApproval != want {
				t.Errorf("new manual approval=%v want=%v", pack.RequiresApproval, want)
			}
			pack.RequiresApproval = true
			if err := db.UpsertRedTeamProbePackWithCases(t.Context(), pack, nil); err != nil {
				t.Fatal(err)
			}
			body["severity"] = "low"
			response = severityJSONRequest(t, s, "/admin/redteam/probe-cases", body)
			if response.Code != http.StatusCreated {
				t.Fatalf("edit status=%d", response.Code)
			}
			if !probeMetadataPack(t, db, pack.ID).RequiresApproval {
				t.Error("manual prompt edit cleared existing approval control")
			}
		})
	}
}

func TestRedTeamSeverityCampaignPreviewAndReview(t *testing.T) {
	var calls atomic.Int32
	s, db, c := reviewedFixture(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1); redTeamAdmissionReply(w) })
	c.Status = "draft"
	c.TargetFilter = map[string]any{"target_type": "model", "provider": "test", "models": []string{"severity-model"}}
	providers, err := db.ListProviderConfigs(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, p := range providers {
		if p.Name == "test" {
			p.ModelPatterns = "severity-model"
			if err := db.UpsertProvider(t.Context(), p); err != nil {
				t.Fatal(err)
			}
			found = true
		}
	}
	if !found {
		t.Fatal("synthetic provider missing")
	}
	for _, severity := range []string{"low", "medium", "high", "critical"} {
		for _, explicit := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/explicit-%v", severity, explicit), func(t *testing.T) {
				pack := probeMetadataPack(t, db, "pack")
				pack.Severity, pack.RequiresApproval = severity, explicit
				if err := db.UpsertRedTeamProbePackWithCases(t.Context(), pack, nil); err != nil {
					t.Fatal(err)
				}
				want := explicit || severity == "high" || severity == "critical"
				r := httptest.NewRequest(http.MethodPost, "/synthetic-preview", nil)
				preview, err := s.redTeamDryRun(r, c)
				if err != nil {
					t.Fatal(err)
				}
				if preview["targets"] != 1 || preview["case_executions"] != 1 {
					t.Fatalf("synthetic model not selected: targets=%v cases=%v", preview["targets"], preview["case_executions"])
				}
				if preview["requires_approval"] != want || preview["can_run"] == want {
					t.Errorf("preview approval=%v can_run=%v want approval=%v", preview["requires_approval"], preview["can_run"], want)
				}
				body := reviewedBody()
				body.Models = []string{"severity-model"}
				response := reviewedRequest(s, c, body, "operator", false)
				if (response.Code == http.StatusOK) == want {
					t.Errorf("review status=%d want approval=%v", response.Code, want)
				}
				if want {
					if _, err := s.runRedTeamCampaign(r, c, "synthetic-key"); err == nil || !strings.Contains(err.Error(), "requires approval") {
						t.Errorf("legacy execution lost approval gate: %v", err)
					}
				}
				if calls.Load() != 0 {
					t.Fatal("preview or blocked execution invoked upstream")
				}
			})
		}
	}
}

func TestRedTeamSeverityMCPRiskKeepsSimulationBoundary(t *testing.T) {
	var calls atomic.Int32
	s, db, c, _, packs, cases := redTeamAdmissionFixture(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1); redTeamAdmissionReply(w) })
	c.Scope, c.DestructiveToolPolicy = "mcp", "allow"
	c.ProbePackIDs = []string{"pack"}
	c.TargetFilter = nil
	cases[0].TargetTypes = []string{"mcp_tool"}
	cases[0].ExpectedPolicy = "allow"
	if err := db.UpsertRedTeamProbePackWithCases(t.Context(), packs[0], cases); err != nil {
		t.Fatal(err)
	}
	for _, severity := range []string{"low", "medium", "high", "critical"} {
		if err := db.UpsertMCPToolContract(t.Context(), store.MCPToolContract{ID: "severity-" + severity, Namespace: "synthetic", Name: severity, RiskLevel: severity, Enabled: true}); err != nil {
			t.Fatal(err)
		}
	}
	r := httptest.NewRequest(http.MethodPost, "/synthetic-mcp-preview", nil)
	preview, err := s.redTeamDryRun(r, c)
	if err != nil {
		t.Fatal(err)
	}
	if preview["targets"] != 4 || preview["destructive_tool_targets"] != 2 || preview["active_eligible_targets"] != 0 {
		t.Errorf("wrong MCP preview targets=%v destructive=%v active=%v", preview["targets"], preview["destructive_tool_targets"], preview["active_eligible_targets"])
	}
	targets, selectedPacks, selectedCases, err := s.redTeamSelection(r, c)
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range targets {
		for _, policy := range []string{"allow", "approval", "block", "dry-run"} {
			cc := c
			cc.DestructiveToolPolicy = policy
			result, evidence, _ := evaluateRedTeamCase(target, packs[0], cases[0], cc)
			wantDecision, wantPolicy := "pass", "allow"
			if target.RiskLevel == "high" || target.RiskLevel == "critical" {
				switch policy {
				case "allow":
					wantDecision, wantPolicy = "fail", "tool_policy_missing"
				case "approval":
					wantPolicy = "approval_required"
				case "block":
					wantPolicy = "block"
				default:
					wantPolicy = "dry_run"
				}
			}
			if result.Decision != wantDecision || result.PolicyDecision != wantPolicy {
				t.Errorf("risk=%s policy=%s decision=%s/%s want=%s/%s", target.RiskLevel, policy, result.Decision, result.PolicyDecision, wantDecision, wantPolicy)
			}
			if len(evidence.ToolCalls) != 1 || evidence.ToolCalls[0]["dry_run"] != true {
				t.Fatal("MCP evidence lost simulation marker")
			}
		}
	}
	if _, err := s.prepareRedTeamSelectionPlan(r, c, "live", redTeamRunLimits{MaxCalls: 4, MaxOutputTokens: 32, BudgetLimitKRW: 10}, nil, targets, selectedPacks, selectedCases); err == nil {
		t.Fatal("MCP-only selection admitted as a live reviewed call")
	}
	result, err := s.runRedTeamSelection(r, c, "synthetic-key", targets, selectedPacks, selectedCases)
	if err != nil {
		t.Fatal(err)
	}
	summary := result["summary"].(map[string]any)
	if calls.Load() != 0 || summary["live_calls"] != 0 || summary["results"] != 4 {
		t.Fatalf("MCP simulation boundary failed: calls=%d summary=%v", calls.Load(), summary)
	}
}

func TestRedTeamSeverityCriticalLeakAndToolEscalation(t *testing.T) {
	for _, severity := range []string{"low", "medium", "high", "critical", " CRITICAL "} {
		want := "fail"
		if strings.EqualFold(strings.TrimSpace(severity), "critical") {
			want = "critical"
		}
		decision, _ := redteamRuleVerdict("allow", []string{"synthetic-leak"}, false, severity)
		if decision != want {
			t.Errorf("severity=%q leak decision=%s want=%s", severity, decision, want)
		}
		target := store.RedTeamTarget{TargetType: "mcp_tool", RiskLevel: "high"}
		result, _, _ := evaluateRedTeamCase(target, store.RedTeamProbePack{}, store.RedTeamProbeCase{Severity: severity}, store.RedTeamCampaign{DestructiveToolPolicy: "allow"})
		if result.Decision != want {
			t.Errorf("severity=%q unsafe tool decision=%s want=%s", severity, result.Decision, want)
		}
	}
}

func TestRedTeamSeverityLegacyCSVOmittedApproval(t *testing.T) {
	for _, variant := range []string{"no-column", "short-row", "explicit-false"} {
		t.Run(variant, func(t *testing.T) {
			s, db, _ := newRedTeamTestServer(t)
			before := seedProbeMetadata(t, db)
			header := []string{"pack_id", "pack_name", "pack_severity", "case_id", "case_key", "input_template"}
			row := []string{before.ID, before.Name, "low", "public-edited", "editable", "Synthetic edited prompt"}
			if variant != "no-column" {
				header = append(header, "requires_approval")
			}
			if variant == "explicit-false" {
				row = append(row, "false")
			}
			response := probeCSVImportResponse(s, probeCSVRecordsBody(t, [][]string{header, row}))
			if response.Code != http.StatusOK {
				t.Fatalf("import status=%d", response.Code)
			}
			after := probeMetadataPack(t, db, before.ID)
			if after.RequiresApproval != (variant != "explicit-false") {
				t.Errorf("approval=%v after %s", after.RequiresApproval, variant)
			}
			assertProbeMetadata(t, before, after, "Synthetic edited prompt")
		})
	}
}

func TestRedTeamSeverityLowRiskReviewedExecutionStaysSingleUse(t *testing.T) {
	for _, severity := range []string{"low", "medium"} {
		t.Run(severity, func(t *testing.T) {
			var calls atomic.Int32
			s, db, c := reviewedFixture(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1); redTeamAdmissionReply(w) })
			c.Status = "draft"
			pack := probeMetadataPack(t, db, "pack")
			pack.Severity, pack.RequiresApproval = severity, false
			if err := db.UpsertRedTeamProbePackWithCases(t.Context(), pack, nil); err != nil {
				t.Fatal(err)
			}
			denied := reviewedRequest(s, c, map[string]string{"proxy_key": "synthetic-key"}, "operator", true)
			if denied.Code != http.StatusConflict || calls.Load() != 0 {
				t.Fatal("unreviewed live execution was admitted")
			}
			review := issueReviewed(t, s, c, reviewedBody())
			if calls.Load() != 0 || review.LiveCalls != 1 {
				t.Fatal("issuing review performed a call or did not bind one call")
			}
			outcome := reviewedRequest(s, c, executionBody(review), "operator", true)
			if outcome.Code != http.StatusOK || calls.Load() != 1 {
				t.Fatalf("explicit reviewed execution status=%d calls=%d", outcome.Code, calls.Load())
			}
			replay := reviewedRequest(s, c, executionBody(review), "operator", true)
			if replay.Code != http.StatusConflict || calls.Load() != 1 {
				t.Fatal("review replay performed another call")
			}
		})
	}
}

func TestRedTeamSeverityExportRoundTripHonorsApprovalFloor(t *testing.T) {
	s, db, _ := newRedTeamTestServer(t)
	seedProbeMetadata(t, db)
	exported := httptest.NewRecorder()
	s.Routes().ServeHTTP(exported, httptest.NewRequest(http.MethodGet, "/admin/redteam/probe-packs/export?format=csv", nil))
	if exported.Code != http.StatusOK {
		t.Fatalf("export status=%d", exported.Code)
	}
	packs, err := db.ListRedTeamProbePacks(t.Context(), false)
	if err != nil {
		t.Fatal(err)
	}
	flags := map[string]bool{}
	for _, pack := range packs {
		flags[pack.ID] = pack.RequiresApproval || pack.Severity == "high" || pack.Severity == "critical"
	}
	for attempt := 0; attempt < 2; attempt++ {
		response := probeCSVImportResponse(s, exported.Body.String())
		if response.Code != http.StatusOK {
			t.Fatalf("import status=%d", response.Code)
		}
		after, err := db.ListRedTeamProbePacks(t.Context(), false)
		if err != nil {
			t.Fatal(err)
		}
		if len(after) != len(flags) {
			t.Fatal("roundtrip pack count changed")
		}
		for _, pack := range after {
			flag, found := flags[pack.ID]
			if !found || pack.RequiresApproval != flag {
				t.Errorf("pack %s approval changed to %v", pack.ID, pack.RequiresApproval)
			}
		}
	}
}
