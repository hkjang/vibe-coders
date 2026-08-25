package proxy

import (
	"strings"
	"testing"
	"time"

	"vibe-coders/internal/config"
)

// Runtime overlay for the upstream resilience knobs.
//
// The breaker, the balancer, sticky sessions, the failover budget and the health
// demotion threshold are the controls an operator reaches for during an incident.
// Until now they were read straight off s.cfg, which is fixed at boot — so changing
// any of them meant a redeploy, at the exact moment a redeploy is least welcome.
//
// These tests pin the two halves of that: the overlay is what the code reads, and the
// admin apply pass is what fills the overlay.

func TestUpstreamConfFallsBackToBootConfig(t *testing.T) {
	s := &Server{cfg: config.Config{Upstream: config.UpstreamConfig{
		BreakerThreshold: 7, LoadBalance: "round_robin", StickyTTL: 9 * time.Minute,
	}}}
	got := s.upstreamConf()
	if got.BreakerThreshold != 7 || got.LoadBalance != "round_robin" || got.StickyTTL != 9*time.Minute {
		t.Fatalf("with no overlay stored, upstreamConf must return the boot config, got %+v", got)
	}
}

func TestBreakerAndBalancerReadTheOverlayNotBootConfig(t *testing.T) {
	s := &Server{cfg: config.Config{Upstream: config.UpstreamConfig{
		BreakerEnabled: true, BreakerThreshold: 5, BreakerCooldown: 30 * time.Second,
		LoadBalance: "first", StickySessions: true, StickyTTL: 30 * time.Minute,
		HealthDemoteThreshold: 0, FailoverBudget: 0,
	}}}

	// Boot values first, so a failure below cannot be the overlay being read all along.
	if enabled, threshold, cooldown := s.breakerConfig(); !enabled || threshold != 5 || cooldown != 30*time.Second {
		t.Fatalf("boot breaker config: got %v/%d/%v", enabled, threshold, cooldown)
	}
	if mode, sticky, ttl := s.balancerConfig(); mode != balanceFirst || !sticky || ttl != 30*time.Minute {
		t.Fatalf("boot balancer config: got %v/%v/%v", mode, sticky, ttl)
	}
	if got := s.healthDemoteThreshold(); got != 0 {
		t.Fatalf("boot health demote threshold: got %d", got)
	}

	// Now the operator changes them mid-incident.
	up := s.cfg.Upstream
	up.BreakerEnabled = false
	up.BreakerThreshold = 2
	up.BreakerCooldown = 5 * time.Second
	up.LoadBalance = "session_hash"
	up.StickySessions = false
	up.StickyTTL = 90 * time.Second
	up.HealthDemoteThreshold = 60
	s.upstreamRuntime.Store(&up)

	if enabled, threshold, cooldown := s.breakerConfig(); enabled || threshold != 2 || cooldown != 5*time.Second {
		t.Errorf("breakerConfig ignored the runtime overlay: got %v/%d/%v, want false/2/5s", enabled, threshold, cooldown)
	}
	if mode, sticky, ttl := s.balancerConfig(); mode != balanceSessionHash || sticky || ttl != 90*time.Second {
		t.Errorf("balancerConfig ignored the runtime overlay: got %v/%v/%v, want session_hash/false/1m30s", mode, sticky, ttl)
	}
	if got := s.healthDemoteThreshold(); got != 60 {
		t.Errorf("healthDemoteThreshold ignored the runtime overlay: got %d, want 60", got)
	}
}

func TestQuotaReservationsCanBeSwitchedAtRuntime(t *testing.T) {
	// s.db is nil here, so quotaReservationsEnabled() is false either way; assert on the
	// flag the overlay carries instead, which is the half this change owns.
	s := &Server{cfg: config.Config{Quota: config.QuotaConfig{ReservationsEnabled: false}}}
	if s.quotaConf().ReservationsEnabled {
		t.Fatal("boot config says reservations are off")
	}
	q := s.cfg.Quota
	q.ReservationsEnabled = true
	s.quotaRuntime.Store(&q)
	if !s.quotaConf().ReservationsEnabled {
		t.Error("quotaConf ignored the runtime overlay")
	}
}

// applyRuntimeSetting is the other half: the registry key has to actually reach the
// field. A key present in the registry but missing from the apply switch saves in the
// UI, reports source=admin, and changes nothing — the worst kind of silent failure for
// a control you are using during an outage.
func TestApplyRuntimeSettingWritesUpstreamAndQuotaFields(t *testing.T) {
	for _, tc := range []struct {
		key, val string
		check    func(config.UpstreamConfig, config.QuotaConfig) bool
		want     string
	}{
		{"upstream.breaker_enabled", "false", func(u config.UpstreamConfig, _ config.QuotaConfig) bool { return !u.BreakerEnabled }, "BreakerEnabled=false"},
		{"upstream.breaker_threshold", "3", func(u config.UpstreamConfig, _ config.QuotaConfig) bool { return u.BreakerThreshold == 3 }, "BreakerThreshold=3"},
		{"upstream.breaker_cooldown", "45s", func(u config.UpstreamConfig, _ config.QuotaConfig) bool { return u.BreakerCooldown == 45*time.Second }, "BreakerCooldown=45s"},
		{"upstream.failover_budget", "20s", func(u config.UpstreamConfig, _ config.QuotaConfig) bool { return u.FailoverBudget == 20*time.Second }, "FailoverBudget=20s"},
		{"upstream.health_demote_threshold", "70", func(u config.UpstreamConfig, _ config.QuotaConfig) bool { return u.HealthDemoteThreshold == 70 }, "HealthDemoteThreshold=70"},
		{"upstream.load_balance", "round_robin", func(u config.UpstreamConfig, _ config.QuotaConfig) bool { return u.LoadBalance == "round_robin" }, "LoadBalance=round_robin"},
		{"upstream.sticky_sessions", "false", func(u config.UpstreamConfig, _ config.QuotaConfig) bool { return !u.StickySessions }, "StickySessions=false"},
		{"upstream.sticky_ttl", "2m", func(u config.UpstreamConfig, _ config.QuotaConfig) bool { return u.StickyTTL == 2*time.Minute }, "StickyTTL=2m"},
		{"quota.reservations_enabled", "true", func(_ config.UpstreamConfig, q config.QuotaConfig) bool { return q.ReservationsEnabled }, "ReservationsEnabled=true"},
	} {
		up := config.UpstreamConfig{BreakerEnabled: true, StickySessions: true}
		quota := config.QuotaConfig{}
		var t2s config.Text2SQLConfig
		var ch config.ClickHouseConfig
		var carbon config.CarbonConfig
		var ins config.InsuranceConfig
		var cache config.CacheConfig
		var ret config.RetentionConfig
		var pricing config.PricingConfig
		var skills config.SkillsConfig
		var limits config.LimitsConfig
		var logging config.LoggingConfig
		var mcp config.MCPConfig
		applyRuntimeSetting(&t2s, &ch, &carbon, &ins, &cache, &ret, &pricing, &skills, &limits, &logging, &mcp, &up, &quota, tc.key, tc.val)
		if !tc.check(up, quota) {
			t.Errorf("applying %s=%q did not produce %s; the key is in the registry but not in the apply switch", tc.key, tc.val, tc.want)
		}
	}
}

// The help text under each key in the runtime settings screen comes from a map kept
// separate from the registry. Nothing connected the two, so a setting added without a
// description renders as a bare key — which for something like breaker_threshold tells
// an operator nothing about what raising it does.
func TestEverySettingHasADescription(t *testing.T) {
	missing := []string{}
	for _, d := range settingRegistry {
		if strings.TrimSpace(settingDescriptions[d.Key]) == "" {
			missing = append(missing, d.Key)
		}
	}
	if len(missing) > 0 {
		t.Errorf("%d setting(s) have no entry in settingDescriptions and will render as a bare key:\n  %s",
			len(missing), strings.Join(missing, "\n  "))
	}
	// And the reverse: a description for a key that no longer exists is dead weight that
	// reads as documentation.
	known := map[string]bool{}
	for _, d := range settingRegistry {
		known[d.Key] = true
	}
	for key := range settingDescriptions {
		if !known[key] {
			t.Errorf("settingDescriptions documents %q, which is not in the registry", key)
		}
	}
}
