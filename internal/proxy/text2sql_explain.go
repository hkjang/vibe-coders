package proxy

import (
	"encoding/json"
	"fmt"
	"strings"
)

// explainPlan is the salient subset of a PostgreSQL EXPLAIN (FORMAT JSON) plan,
// flattened across the plan tree.
type explainPlan struct {
	TotalCost     float64
	PlanRows      float64
	NodeTypes     []string
	HasSeqScan    bool
	HasNestedLoop bool
}

// explainRisk is the scored risk of running a plan.
type explainRisk struct {
	Score   int      `json:"score"` // 0-100, higher = riskier
	Cost    float64  `json:"cost"`
	Rows    float64  `json:"rows"`
	Reasons []string `json:"reasons"`
}

// parseExplainPlan parses EXPLAIN (FORMAT JSON) output, walking the whole plan
// tree to collect the top-level cost/rows and the set of node types present.
func parseExplainPlan(raw []byte) (explainPlan, error) {
	var top []struct {
		Plan json.RawMessage `json:"Plan"`
	}
	if err := json.Unmarshal(raw, &top); err != nil {
		return explainPlan{}, err
	}
	if len(top) == 0 {
		return explainPlan{}, fmt.Errorf("empty EXPLAIN output")
	}
	var node struct {
		NodeType  string          `json:"Node Type"`
		TotalCost float64         `json:"Total Cost"`
		PlanRows  float64         `json:"Plan Rows"`
		Plans     json.RawMessage `json:"Plans"`
	}
	if err := json.Unmarshal(top[0].Plan, &node); err != nil {
		return explainPlan{}, err
	}
	p := explainPlan{TotalCost: node.TotalCost, PlanRows: node.PlanRows}
	seen := map[string]bool{}
	var walk func(raw json.RawMessage)
	walk = func(raw json.RawMessage) {
		if len(raw) == 0 {
			return
		}
		var n struct {
			NodeType string          `json:"Node Type"`
			Plans    json.RawMessage `json:"Plans"`
		}
		if json.Unmarshal(raw, &n) != nil {
			return
		}
		if n.NodeType != "" && !seen[n.NodeType] {
			seen[n.NodeType] = true
			p.NodeTypes = append(p.NodeTypes, n.NodeType)
		}
		lower := strings.ToLower(n.NodeType)
		if strings.Contains(lower, "seq scan") {
			p.HasSeqScan = true
		}
		if strings.Contains(lower, "nested loop") {
			p.HasNestedLoop = true
		}
		var children []json.RawMessage
		if json.Unmarshal(n.Plans, &children) == nil {
			for _, c := range children {
				walk(c)
			}
		}
	}
	walk(top[0].Plan)
	return p, nil
}

// scoreExplainPlan turns a plan into a 0-100 risk score with reasons. maxCost is the
// configured cost ceiling (0 disables the cost contribution).
func scoreExplainPlan(p explainPlan, maxCost float64) explainRisk {
	r := explainRisk{Cost: p.TotalCost, Rows: p.PlanRows}
	score := 0
	if maxCost > 0 {
		ratio := p.TotalCost / maxCost
		switch {
		case ratio >= 1:
			score += 50
			r.Reasons = append(r.Reasons, fmt.Sprintf("예상 비용 %.0f 이 상한 %.0f 을 초과", p.TotalCost, maxCost))
		case ratio >= 0.5:
			score += 25
			r.Reasons = append(r.Reasons, "예상 비용이 상한의 절반을 초과")
		}
	}
	if p.HasSeqScan && p.PlanRows >= 100000 {
		score += 25
		r.Reasons = append(r.Reasons, fmt.Sprintf("대용량 Seq Scan (예상 %.0f 행)", p.PlanRows))
	} else if p.HasSeqScan {
		score += 10
		r.Reasons = append(r.Reasons, "Seq Scan 사용")
	}
	if p.HasNestedLoop && p.PlanRows >= 100000 {
		score += 20
		r.Reasons = append(r.Reasons, "대용량 Nested Loop 조인")
	}
	if score > 100 {
		score = 100
	}
	r.Score = score
	return r
}

// parseExplainCost keeps the original cost-only accessor (used by the cost guard).
func parseExplainCost(raw []byte) (float64, error) {
	p, err := parseExplainPlan(raw)
	if err != nil {
		return 0, err
	}
	return p.TotalCost, nil
}
