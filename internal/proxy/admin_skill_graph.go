package proxy

import (
	"net/http"
	"strings"
)

// graphNode / graphEdge form the Skill Dependency Graph: how skills depend on models, tools and
// teams, and which policies govern those models/tools — so an operator sees a change's blast
// radius before making it.
type graphNode struct {
	ID    string `json:"id"`
	Type  string `json:"type"` // skill | model | tool | team | policy
	Label string `json:"label"`
	Risk  string `json:"risk,omitempty"`
}

type graphEdge struct {
	From string `json:"from"`
	To   string `json:"to"`
	Kind string `json:"kind"` // uses_model | uses_tool | allowed_team | governs_model | governs_tool
}

// policyGov is the set of models/tools one policy governs (from its rule conditions/actions).
type policyGov struct {
	id     string
	name   string
	models []string
	tools  []string
}

// handleSkillDependencyGraph builds the dependency graph for production skills. Read-only.
// GET /admin/skills/dependency-graph[?skill=name]
func (s *Server) handleSkillDependencyGraph(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(r) {
		writeOpenAIError(w, http.StatusUnauthorized, "invalid admin token", "invalid_request_error", "invalid_api_key")
		return
	}
	ctx := r.Context()
	focus := strings.TrimSpace(r.URL.Query().Get("skill"))

	skills, err := s.db.ListSkills(ctx, "production")
	if err != nil {
		writeOpenAIError(w, http.StatusInternalServerError, err.Error(), "server_error", "skills_failed")
		return
	}

	// Index what each policy governs (models via condition/deny/allow, tools via mcp_tool).
	govs := []policyGov{}
	if policies, err := s.db.ListPolicies(ctx); err == nil {
		for _, p := range policies {
			if !p.Enabled {
				continue
			}
			g := policyGov{id: p.ID, name: p.Name}
			for _, rule := range p.Rules {
				if m := toStr(rule.Conditions["model"]); m != "" {
					g.models = append(g.models, m)
				}
				g.models = append(g.models, valueStringList(rule.Actions["deny_models"])...)
				g.models = append(g.models, valueStringList(rule.Actions["allow_models"])...)
				if t := toStr(rule.Conditions["mcp_tool"]); t != "" {
					g.tools = append(g.tools, t)
				}
			}
			if len(g.models) > 0 || len(g.tools) > 0 {
				govs = append(govs, g)
			}
		}
	}

	nodes := map[string]graphNode{}
	addNode := func(n graphNode) {
		if _, ok := nodes[n.ID]; !ok {
			nodes[n.ID] = n
		}
	}
	edges := []graphEdge{}
	skillViews := []map[string]any{}

	for _, sk := range skills {
		if focus != "" && !strings.EqualFold(sk.Name, focus) {
			continue
		}
		models := splitCSV(sk.AllowedModels)
		tools := splitCSV(sk.AllowedTools)
		teams := splitCSV(sk.AllowedTeams)
		skillID := "skill:" + sk.Name
		addNode(graphNode{ID: skillID, Type: "skill", Label: sk.Name, Risk: sk.RiskLevel})

		for _, m := range models {
			id := "model:" + m
			addNode(graphNode{ID: id, Type: "model", Label: m})
			edges = append(edges, graphEdge{From: skillID, To: id, Kind: "uses_model"})
		}
		for _, t := range tools {
			id := "tool:" + t
			addNode(graphNode{ID: id, Type: "tool", Label: t})
			edges = append(edges, graphEdge{From: skillID, To: id, Kind: "uses_tool"})
		}
		for _, tm := range teams {
			id := "team:" + tm
			addNode(graphNode{ID: id, Type: "team", Label: tm})
			edges = append(edges, graphEdge{From: skillID, To: id, Kind: "allowed_team"})
		}

		// Policies that govern any model/tool this skill depends on (transitive blast radius).
		governing := []map[string]any{}
		seen := map[string]bool{}
		for _, g := range govs {
			via := ""
			for _, pm := range g.models {
				if listMatchesAny(pm, models) || containsFold(models, pm) {
					via = "model:" + pm
					break
				}
			}
			if via == "" {
				for _, pt := range g.tools {
					if containsFold(tools, pt) {
						via = "tool:" + pt
						break
					}
				}
			}
			if via != "" && !seen[g.id] {
				seen[g.id] = true
				pid := "policy:" + g.id
				addNode(graphNode{ID: pid, Type: "policy", Label: g.name})
				edges = append(edges, graphEdge{From: pid, To: skillID, Kind: "governs"})
				governing = append(governing, map[string]any{"id": g.id, "name": g.name, "via": via})
			}
		}

		skillViews = append(skillViews, map[string]any{
			"name": sk.Name, "risk_level": sk.RiskLevel,
			"models": models, "tools": tools, "teams": teams,
			"governing_policies": governing,
		})
	}

	nodeList := make([]graphNode, 0, len(nodes))
	for _, n := range nodes {
		nodeList = append(nodeList, n)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"nodes":  nodeList,
		"edges":  edges,
		"skills": skillViews,
		"note":   "production Skill의 모델·도구·팀 의존성과 이를 관할하는 정책을 보여줍니다. 모델/도구/정책 변경 시 영향받는 Skill 범위를 파악하세요.",
	})
}
