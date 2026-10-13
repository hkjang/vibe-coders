package proxy

import (
	"testing"
	"time"

	"vibe-coders/internal/store"
)

func TestSelfServiceRotationQuotaContinuity(t *testing.T) {
	for _, mode := range []string{"tokens", "cost", "reserved-tokens", "reserved-cost"} {
		t.Run(mode, func(t *testing.T) {
			server, db := boundaryFixture(t, 40, 4)
			quotaConfig := server.quotaConf()
			quotaConfig.ReservationsEnabled = true
			server.quotaRuntime.Store(&quotaConfig)
			if !server.quotaReservationsEnabled() {
				t.Fatal("reservation fixture inactive")
			}
			key, _, err := db.GetAPIKey(t.Context(), "k1")
			if err != nil {
				t.Fatal("key unavailable")
			}
			key.Role = "developer"
			if err := db.UpsertAPIKey(t.Context(), key); err != nil {
				t.Fatal("role fixture failed")
			}
			q := store.QuotaRecord{ID: "rotation-quota", Scope: "api_key", ScopeValue: key.ID, Period: "daily", Enabled: true}
			if mode == "tokens" || mode == "reserved-tokens" {
				q.TokenLimit = 100
			} else {
				q.KRWLimit = 10
			}
			if err := db.UpsertQuota(t.Context(), q); err != nil {
				t.Fatal("quota fixture failed")
			}
			// Prime the definitions cache before rotation; relationship changes must
			// take effect without waiting for the quota-definition TTL.
			if _, err := server.checkQuotas(t.Context(), key.ID, "", nil); err != nil {
				t.Fatal("quota read failed")
			}
			created := store.AuthEvent{ID: "quota-created", EventType: "api_key_created", APIKeyID: "quota-replacement", ActorUserID: key.UserID}
			rotated := store.AuthEvent{ID: "quota-rotated", EventType: "api_key_rotated", APIKeyID: key.ID, ActorUserID: key.UserID}
			next, err := db.RotateAPIKey(t.Context(), key, created.APIKeyID, "quota-new-hash", time.Hour, created, rotated)
			if err != nil {
				t.Fatal("rotation failed")
			}
			now := time.Now().UTC()
			if mode == "reserved-tokens" || mode == "reserved-cost" {
				if err := db.ReserveQuota(t.Context(), store.QuotaReservation{RequestID: "rotation-live", APIKeyID: next.ID, Tokens: 60, CostKRW: 6, ExpiresAt: now.Add(time.Minute)}); err != nil {
					t.Fatal("reservation failed")
				}
			} else {
				if err := db.InsertLogRecord(t.Context(), store.LogRecord{
					Request: store.RequestLog{ID: "rotation-usage", TraceID: "rotation-usage", APIKeyID: next.ID, Endpoint: "/v1/chat/completions", CreatedAt: now},
					Usage:   &store.TokenUsage{ID: "rotation-tokens", RequestID: "rotation-usage", TotalTokens: 60, EstimatedCost: 6, CreatedAt: now},
				}); err != nil {
					t.Fatal("usage failed")
				}
			}
			for _, id := range []string{key.ID, next.ID} {
				decision, err := server.checkQuotas(t.Context(), id, "", nil)
				if err != nil || decision.Allowed || decision.Quota.ID != q.ID || decision.Tokens != 100 || decision.CostKRW != 10 {
					t.Fatal("rotation reset, bypassed or double-counted quota usage")
				}
			}
			decision, err := server.checkQuotas(t.Context(), "unrelated-key", "", nil)
			if err != nil || !decision.Allowed {
				t.Fatal("rotation quota leaked to unrelated credential")
			}
			q.Enabled = false
			if err := db.UpsertQuota(t.Context(), q); err != nil {
				t.Fatal("quota disable failed")
			}
			decision, err = server.checkQuotas(t.Context(), next.ID, "", nil)
			if err != nil || !decision.Allowed {
				t.Fatal("disabled family quota remained active")
			}
		})
	}
}
