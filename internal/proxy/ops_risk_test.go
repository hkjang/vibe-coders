package proxy

import (
	"testing"

	"vibe-coders/internal/store"
)

func TestOpsRiskScore(t *testing.T) {
	// Hardened deployment → low risk.
	clean := OpsStatus{
		Security: OpsSecurityStatus{AuthEnabled: true, DevSecret: false, PricingConfigured: true},
		Disk:     OpsDiskStatus{Available: true, UsedPercent: 40},
	}
	if r := opsRiskScore(clean); r.Score != 0 || r.Tier != "low" {
		t.Errorf("clean deployment score = %d tier %s, want 0/low (factors %+v)", r.Score, r.Tier, r.Factors)
	}

	// Risky deployment: dev secret + auth off + log drops + disk full + no pricing.
	risky := OpsStatus{
		Security: OpsSecurityStatus{AuthEnabled: false, DevSecret: true, PricingConfigured: false},
		Logging:  OpsLoggingStatus{Dropped: 5000},
		Fallback: OpsFallbackStatus{Exists: true, Lines: 50},
		Disk:     OpsDiskStatus{Available: true, UsedPercent: 95},
	}
	r := opsRiskScore(risky)
	if r.Score < 60 {
		t.Errorf("risky deployment score = %d, want >= 60", r.Score)
	}
	if r.Tier != "critical" {
		t.Errorf("risky tier = %s, want critical", r.Tier)
	}
	// dev_secret must be a critical factor.
	foundDevSecret := false
	for _, f := range r.Factors {
		if f.Key == "dev_secret" && f.Severity == "critical" {
			foundDevSecret = true
		}
	}
	if !foundDevSecret {
		t.Error("expected a critical dev_secret factor")
	}

	// Degraded provider contributes.
	degraded := OpsStatus{
		Security:  OpsSecurityStatus{AuthEnabled: true, PricingConfigured: true},
		Disk:      OpsDiskStatus{Available: true, UsedPercent: 10},
		Providers: []store.ProviderHealthScore{{Provider: "openai", Requests: 100, Score: 30}},
	}
	if r := opsRiskScore(degraded); r.Score == 0 {
		t.Error("expected non-zero score for a degraded provider")
	}
}
