package store

import (
	"context"
	"time"
)

// CanaryPolicyStat summarizes a canary policy's live enforcement vs shadow activity, so an
// operator can judge whether to ramp the rollout up.
type CanaryPolicyStat struct {
	PolicyID       string `json:"policy_id"`
	Name           string `json:"name"`
	RolloutPercent int    `json:"rollout_percent"`
	EnforcedActs   int    `json:"enforced_acts"`  // block/deny/approval decisions actually applied (in-slice)
	ShadowActs     int    `json:"shadow_acts"`    // canary_shadow decisions (out-of-slice, would-have-acted)
	SuggestedNext  int    `json:"suggested_next"` // recommended next rollout percent
}

// CanaryPolicyStats returns, for each enabled canary policy (rollout < 100), its enforced vs
// shadow decision counts since a cutoff. Newest/most-active first.
func (s *SQLStore) CanaryPolicyStats(ctx context.Context, since time.Time) ([]CanaryPolicyStat, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT p.id, p.name, COALESCE(p.rollout_percent, 100),
			COALESCE(SUM(CASE WHEN e.decision = 'canary_shadow' THEN 1 ELSE 0 END), 0) AS shadow_acts,
			COALESCE(SUM(CASE WHEN e.decision IN ('block', 'require_approval')
				OR e.decision LIKE 'deny_%' OR e.decision = 'secret_block' THEN 1 ELSE 0 END), 0) AS enforced_acts
		FROM policies p
		LEFT JOIN policy_decision_events e ON e.policy_id = p.id AND e.created_at >= ?
		WHERE p.enabled = 1 AND COALESCE(p.rollout_percent, 100) < 100
		GROUP BY p.id, p.name, p.rollout_percent
		ORDER BY (shadow_acts + enforced_acts) DESC, p.name ASC`),
		since.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CanaryPolicyStat{}
	for rows.Next() {
		var c CanaryPolicyStat
		if err := rows.Scan(&c.PolicyID, &c.Name, &c.RolloutPercent, &c.ShadowActs, &c.EnforcedActs); err != nil {
			return nil, err
		}
		c.SuggestedNext = nextRolloutStep(c.RolloutPercent)
		out = append(out, c)
	}
	return out, rows.Err()
}

// nextRolloutStep proposes the next canary step on a 10→25→50→100 ladder.
func nextRolloutStep(current int) int {
	switch {
	case current < 10:
		return 10
	case current < 25:
		return 25
	case current < 50:
		return 50
	default:
		return 100
	}
}
