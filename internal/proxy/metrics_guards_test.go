package proxy

import (
	"strings"
	"testing"
)

func TestPrometheusGuardCounters(t *testing.T) {
	m := newMetrics()
	m.IncSkillBlocked()
	m.IncModelSunsetRewrite()
	m.IncModelSunsetBlock()
	m.IncLimitsClamped()
	m.IncLimitsRejected()

	out := m.Prometheus(0, 0, 0)
	for _, want := range []string{
		"proxy_skill_blocked_total 1",
		"proxy_model_sunset_rewrites_total 1",
		"proxy_model_sunset_blocked_total 1",
		"proxy_limits_clamped_total 1",
		"proxy_limits_rejected_total 1",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("Prometheus output missing %q", want)
		}
	}
}
