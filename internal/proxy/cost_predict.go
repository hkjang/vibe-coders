package proxy

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/audit"
	"vibe-coders/internal/config"
	"vibe-coders/internal/store"
)

const costSnapshotTTL = 15 * time.Second

// costSnapshot caches rolling per-model stats plus the cost-guard config (both
// refreshed together on a short TTL so a request never hits the DB on the hot path).
type costSnapshot struct {
	byModel        map[string]store.ModelStat
	guardEnabled   bool
	guardThreshold float64 // KRW; 0 disables the gate even when enabled
	fetchedAt      time.Time
}

func (s *Server) costSnapshotCached(ctx context.Context) *costSnapshot {
	if c := s.costCache.Load(); c != nil && time.Since(c.fetchedAt) < costSnapshotTTL {
		return c
	}
	snap := &costSnapshot{byModel: map[string]store.ModelStat{}, fetchedAt: time.Now()}
	if stats, err := s.db.ModelStats(ctx, time.Now().Add(-7*24*time.Hour)); err == nil {
		snap.byModel = stats
	}
	if f, found, err := s.db.GetFlag(ctx, "cost_guard_enabled"); err == nil && found {
		snap.guardEnabled = f.Value == "true" || f.Value == "1"
	}
	if f, found, err := s.db.GetFlag(ctx, "cost_guard_threshold_krw"); err == nil && found {
		if v, perr := parseFloat(f.Value); perr == nil {
			snap.guardThreshold = v
		}
	}
	s.costCache.Store(snap)
	return snap
}

func (s *Server) invalidateCostCache() { s.costCache.Store(nil) }

// CostEstimate is a pre-call prediction for one chat request.
type CostEstimate struct {
	Model        string  `json:"model"`
	InputTokens  int     `json:"input_tokens"`
	OutputTokens int     `json:"output_tokens"`
	CostKRW      float64 `json:"cost_krw"`
	LatencyMS    float64 `json:"latency_ms"`
	Priced       bool    `json:"priced"`
	Basis        string  `json:"basis"` // history | max_tokens | default
}

const defaultExpectedOutputTokens = 600

// predictCost estimates input/output tokens, KRW cost, and latency for a model.
// Output tokens come from the historical average when there is enough data, else
// the request's max_tokens, else a conservative default.
func predictCost(model string, inputTokens, maxTokens int, snap *costSnapshot, pricing map[string]config.ModelPrice) CostEstimate {
	est := CostEstimate{Model: model, InputTokens: inputTokens}
	stat, ok := snap.byModel[model]
	switch {
	case ok && stat.Samples >= 5 && stat.AvgOutputTokens > 0:
		est.OutputTokens = int(stat.AvgOutputTokens + 0.5)
		est.Basis = "history"
		est.LatencyMS = stat.AvgLatencyMS
	case maxTokens > 0:
		est.OutputTokens = maxTokens
		est.Basis = "max_tokens"
	default:
		est.OutputTokens = defaultExpectedOutputTokens
		est.Basis = "default"
	}
	est.Priced = audit.ModelPriced(model, pricing)
	if est.Priced {
		est.CostKRW = audit.EstimateCostKRW(model, audit.Usage{
			PromptTokens:     inputTokens,
			CompletionTokens: est.OutputTokens,
		}, pricing)
	}
	return est
}

// parseMaxTokens extracts max_tokens / max_completion_tokens from a chat body.
func parseMaxTokens(body []byte) int {
	var root map[string]any
	if json.Unmarshal(body, &root) != nil {
		return 0
	}
	for _, key := range []string{"max_tokens", "max_completion_tokens", "max_output_tokens"} {
		if v, ok := root[key]; ok {
			if f, ok := v.(float64); ok && f > 0 {
				return int(f)
			}
		}
	}
	return 0
}

func parseFloat(s string) (float64, error) { return strconv.ParseFloat(strings.TrimSpace(s), 64) }
