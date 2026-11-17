package proxy

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"sort"
	"strings"
	"unicode/utf8"

	"vibe-coders/internal/store"
)

const redTeamReviewedMaxCases = 1000
const redTeamReviewedMaxOutput = 4096
const redTeamReviewedMaxPromptBytes = 64 << 10

type redTeamRunLimits struct {
	MaxCalls        int     `json:"max_calls"`
	MaxOutputTokens int     `json:"max_output_tokens"`
	BudgetLimitKRW  float64 `json:"budget_limit_krw"`
}

func (limits redTeamRunLimits) valid() bool {
	return limits.MaxCalls >= 1 && limits.MaxCalls <= redteamActiveMaxCalls &&
		limits.MaxOutputTokens >= 1 && limits.MaxOutputTokens <= redTeamReviewedMaxOutput &&
		limits.BudgetLimitKRW > 0 && limits.BudgetLimitKRW <= 1000000 &&
		!math.IsNaN(limits.BudgetLimitKRW) && !math.IsInf(limits.BudgetLimitKRW, 0)
}

// A reviewed runner executes these already loaded definitions. It does not
// reselect targets or silently resolve a different model after confirmation.
type redTeamRunPlan struct {
	Campaign        store.RedTeamCampaign
	Targets         []store.RedTeamTarget
	Packs           []store.RedTeamProbePack
	Cases           []store.RedTeamProbeCase
	Models          map[string][]string
	Limits          redTeamRunLimits
	Kind            string
	LiveCalls       int
	CaseExecutions  int
	InputBytes      int
	RequestedModels []string
	EstimatedCost   float64
	RuntimeRevision string
}

var errRedTeamRunSelection = errors.New("reviewed run selection is unavailable or exceeds safe bounds")

func (s *Server) prepareRedTeamRunPlan(r *http.Request, c store.RedTeamCampaign, kind string, limits redTeamRunLimits, requestedModels []string) (*redTeamRunPlan, error) {
	if !limits.valid() || (kind != "live" && kind != "simulation") ||
		(kind == "live" && normalizeRedTeamMode(c.ExecutionMode) != "active-controlled") {
		return nil, errRedTeamRunSelection
	}

	if len(requestedModels) > limits.MaxCalls {
		return nil, errRedTeamRunSelection
	}
	if !redTeamConcreteModels(requestedModels) {
		return nil, errRedTeamRunSelection
	}
	// The legacy catalog API caps at 1000. Reject a possibly truncated snapshot
	// rather than represent that prefix as the complete execution selection.
	catalog, err := s.db.ListRedTeamTargets(r.Context(), store.RedTeamTargetFilter{EnabledOnly: true, Limit: 1000})
	if err != nil {
		return nil, err
	}
	if len(catalog) >= 1000 {
		return nil, errRedTeamRunSelection
	}
	targets, packs, cases, err := s.redTeamSelectionFromTargets(r, c, catalog)
	if err != nil {
		return nil, err
	}
	if len(targets) == 0 || len(packs) == 0 || len(cases) == 0 || len(cases) > redTeamReviewedMaxCases {
		return nil, errRedTeamRunSelection
	}

	wanted := map[string]bool{}
	for _, id := range c.ProbePackIDs {
		wanted[id] = true
	}
	if len(wanted) > 0 && len(wanted) != len(packs) {
		return nil, errRedTeamRunSelection
	}
	sort.Slice(targets, func(i, j int) bool { return targets[i].ID < targets[j].ID })
	sort.Slice(packs, func(i, j int) bool { return packs[i].ID < packs[j].ID })
	sort.Slice(cases, func(i, j int) bool { return cases[i].ID < cases[j].ID })
	if redTeamRequiresApproval(packs) && c.Status != "approved" && c.ExecutionMode != "dry-run" {
		return nil, errRedTeamRunSelection
	}
	if c.BudgetLimitKRW > 0 && limits.BudgetLimitKRW > c.BudgetLimitKRW {
		return nil, errRedTeamRunSelection
	}
	plan := &redTeamRunPlan{Campaign: c, Targets: []store.RedTeamTarget{}, Packs: packs, Cases: cases, Models: map[string][]string{}, Limits: limits, Kind: kind, RequestedModels: requestedModels}
	if kind == "live" {
		plan.RuntimeRevision, err = s.redTeamRuntimeRevision(r)
		if err != nil {
			return nil, err
		}
	}
	packByCase := map[string]store.RedTeamProbePack{}
	for _, pack := range packs {
		for _, cs := range cases {
			if pack.ID == cs.PackID {
				packByCase[cs.ID] = pack
			}
		}
	}
	for _, target := range targets {
		before := plan.CaseExecutions
		// Inventory synchronization changes these timestamps without changing
		// execution content. Explicit campaign/pack/case revisions stay bound.
		target.CreatedAt, target.UpdatedAt = "", ""
		live := kind == "live" && redTeamActiveEligible(target, c, "review-placeholder")
		// Text2SQL is a multi-stage executor. Until generation/review/summary and
		// background calls share one reviewed budget, it is simulation-only here.
		if target.TargetType == "text2sql" {
			live = false
		}
		models := []string{}
		if live {
			if err := s.redTeamReviewProvider(r, target, c.ExternalProviderAllowed); err != nil {
				return nil, err
			}
			models = requestedModels
			if len(models) == 0 {
				models = redTeamCampaignModels(c)
			}
			if len(models) == 0 {
				if model, ok := pickRedTeamModel(target); ok {
					models = []string{model}
				}
			}
			if len(models) == 0 || len(models) > limits.MaxCalls {
				return nil, errRedTeamRunSelection
			}
			if !redTeamConcreteModels(models) {
				return nil, errRedTeamRunSelection
			}
			for _, model := range models {
				virtual, err := s.redTeamVirtualModel(r, model)
				if err != nil {
					return nil, err
				}
				if virtual {
					return nil, errRedTeamRunSelection
				}
			}
			plan.Models[target.ID] = models
		}
		for _, cs := range cases {
			if !redTeamCaseApplies(target, cs) {
				continue
			}
			multiplicity := 1
			if live {
				multiplicity = len(models)
				plan.LiveCalls += multiplicity
			}
			plan.CaseExecutions += multiplicity
			promptBytes := len(redTeamRenderTemplate(cs.InputTemplate, target, packByCase[cs.ID]))
			if promptBytes > redTeamReviewedMaxPromptBytes || plan.CaseExecutions > redTeamReviewedMaxCases || plan.LiveCalls > limits.MaxCalls {
				return nil, errRedTeamRunSelection
			}
			plan.InputBytes += promptBytes * multiplicity
		}
		if plan.CaseExecutions > before {
			plan.Targets = append(plan.Targets, target)
		}
	}
	if plan.CaseExecutions == 0 || (kind == "live" && plan.LiveCalls == 0) {
		return nil, errRedTeamRunSelection
	}
	plan.EstimatedCost = float64(plan.LiveCalls)*0.5 + float64(plan.CaseExecutions-plan.LiveCalls)*0.2
	if plan.EstimatedCost > limits.BudgetLimitKRW {
		return nil, errRedTeamRunSelection
	}
	return plan, nil
}

func redTeamConcreteModels(models []string) bool {
	seen := map[string]bool{}
	for _, model := range models {
		if model == "" || model != strings.TrimSpace(model) || strings.ContainsAny(model, "*?\r\n") || utf8.RuneCountInString(model) > 256 || seen[model] {
			return false
		}
		seen[model] = true
	}
	return true
}

func (plan *redTeamRunPlan) revision() string {
	encoded, err := json.Marshal(plan)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}
