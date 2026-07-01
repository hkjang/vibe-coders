package proxy

import (
	"testing"

	"vibe-coders/internal/store"
)

func TestRedTeamFactRow(t *testing.T) {
	row := redTeamFactRow(store.RedTeamDashboardRow{
		TargetID: "t1", TargetType: "model", TargetRef: "model:openai:gpt-4o",
		OwnerTeam: "platform", PackID: "p1", PackCategory: "data_leakage",
		Decision: "critical", Severity: "critical", RiskScore: 70,
		CreatedAt: "2026-07-01T03:15:56.123456789Z",
	})

	if row["target_ref"] != "model:openai:gpt-4o" || row["decision"] != "critical" || row["risk_score"] != 70 {
		t.Fatalf("unexpected fact row: %+v", row)
	}
	// Nanosecond timestamp normalized to RFC3339 seconds for ClickHouse best_effort parsing.
	if row["ts"] != "2026-07-01T03:15:56Z" {
		t.Fatalf("ts = %v, want normalized RFC3339", row["ts"])
	}
	// No content fields leak into the fact row.
	for k := range row {
		switch k {
		case "prompt", "response", "masked_prompt", "masked_response", "input", "output":
			t.Fatalf("fact row must not carry content field %q", k)
		}
	}
}

func TestRedTeamFactRowRawTimestampFallback(t *testing.T) {
	// Unparseable timestamp is passed through unchanged rather than dropped.
	row := redTeamFactRow(store.RedTeamDashboardRow{CreatedAt: "not-a-time"})
	if row["ts"] != "not-a-time" {
		t.Fatalf("ts fallback = %v, want raw passthrough", row["ts"])
	}
}
