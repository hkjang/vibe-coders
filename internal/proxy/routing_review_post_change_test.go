package proxy

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

func TestRoutingReviewedMutationPostChangeRedTeam(t *testing.T) {
	for _, operation := range []string{"edit", "order"} {
		t.Run(operation, func(t *testing.T) {
			for _, mode := range []string{"enabled", "disabled", "kill_switch", "denied", "conflict", "invalid"} {
				t.Run(mode, func(t *testing.T) {
					redteamKillSwitch.Store(mode == "kill_switch")
					t.Cleanup(func() { redteamKillSwitch.Store(false) })
					db, s, snapshot := routingOrderFixture(t)
					s.cfg.RedTeam = config.RedTeamConfig{PostChangeEnabled: mode != "disabled", PostChangeCooldown: time.Hour, PostChangeMaxTargets: 1}
					s.cfg.Auth.Enabled, s.cfg.Auth.JWTSecret = true, "synthetic-reviewed-post-change-jwt"
					scopes := []string{"routing:read", "routing:write"}
					if mode == "denied" {
						scopes = []string{"routing:read"}
					}
					token := issueLLMScopedTestToken(t, db, s, "post-change-reviewer", "operator", "", scopes, time.Now().UTC())
					// More targets than the configured bound; dry-run must never call
					// this synthetic upstream (routingOrderFixture checks the count).
					if err := db.UpsertProvider(t.Context(), store.ProviderConfig{Name: "reviewed-provider", BaseURL: s.cfg.Upstream.BaseURL, Enabled: true, ModelPatterns: "public-first,public-second"}); err != nil {
						t.Fatal(err)
					}
					path, action, ref := "/admin/routing-rules/order-z-first?review=edit", "routing_rule.reviewed_update", "order-z-first"
					body := routingDraftWriteBody(t, snapshot.Revision)
					if operation == "order" {
						path, action, ref = "/admin/routing-rules", "routing_rule.reorder", "routing-rules"
						body = routingOrderBody(t, snapshot, false)
					}
					status := 200
					switch mode {
					case "denied":
						status = 401
					case "conflict":
						if err := db.UpsertRoutingRule(t.Context(), store.RoutingRule{ID: "concurrent-rule", TargetModel: "other-model"}); err != nil {
							t.Fatal(err)
						}
						status = 409
					case "invalid":
						body, status = `{}`, 400
					}
					before, err := db.GetRoutingOrderSnapshot(t.Context())
					if err != nil {
						t.Fatal(err)
					}
					response := routingCreateRequest(t, s, "PATCH", path, body, token)
					if response.Code != status {
						t.Fatalf("reviewed %s status=%d, want=%d", operation, response.Code, status)
					}
					after, err := db.GetRoutingOrderSnapshot(t.Context())
					if err != nil || (status == 200) == reflect.DeepEqual(before, after) {
						t.Fatal("stored rules do not match the mutation outcome")
					}
					campaigns, err := db.ListRedTeamCampaigns(t.Context(), 20)
					if err != nil {
						t.Fatal(err)
					}
					runs, err := db.ListRedTeamRuns(t.Context(), 20)
					if err != nil {
						t.Fatal(err)
					}
					if mode != "enabled" {
						if len(campaigns) != 0 || len(runs) != 0 {
							t.Fatal("disabled, stopped or rejected change created a security campaign")
						}
						return
					}
					if len(campaigns) != 1 || len(runs) != 1 {
						t.Fatalf("successful reviewed change must run one bounded security simulation: campaigns=%d, runs=%d", len(campaigns), len(runs))
					}
					campaign := campaigns[0]
					if campaign.TriggerSource != "post-change" || campaign.TriggerAction != action || campaign.TriggerRef != ref || campaign.Status != "completed" || campaign.Scope != "provider" || campaign.ExecutionMode != "dry-run" || campaign.ExternalProviderAllowed || campaign.DestructiveToolPolicy != "dry-run" || campaign.Concurrency != 1 {
						t.Fatal("reviewed save changed the configured simulation safety boundary")
					}
					if !reflect.DeepEqual(campaign.ProbePackIDs, []string{"rtp_model_routing_abuse", "rtp_header_trust", "rtp_policy_bypass"}) || runs[0].CampaignID != campaign.ID || runs[0].Mode != "dry-run" {
						t.Fatal("reviewed save omitted the existing routing security checks")
					}
					audits, err := db.ListAdminAudit(t.Context(), 20)
					if err != nil {
						t.Fatal(err)
					}
					mutation, completion := 0, 0
					for _, row := range audits {
						if row.Action == action {
							mutation++
						}
						if row.Action == "redteam.post_change.completed" && strings.Contains(row.AfterValue, campaign.ID) {
							completion++
						}
					}
					if mutation != 1 || completion != 1 {
						t.Fatal("reviewed mutation and completed security simulation must both be audited")
					}
					if replay := routingCreateRequest(t, s, "PATCH", path, body, token); replay.Code != 409 {
						t.Fatal("stale reviewed mutation was accepted")
					}
					campaigns, err = db.ListRedTeamCampaigns(t.Context(), 20)
					if err != nil || len(campaigns) != 1 {
						t.Fatal("stale retry created another campaign")
					}
				})
			}
		})
	}
}
