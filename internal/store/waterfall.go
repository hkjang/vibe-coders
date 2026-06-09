package store

import (
	"context"
	"math"
	"sort"
	"time"
)

// WaterfallSpan is one transaction (request) within a session, positioned on a
// shared wall-clock timeline. Offsets/durations are pre-computed server-side in
// milliseconds so the UI can render a Gantt/waterfall bar without parsing timestamps.
type WaterfallSpan struct {
	Seq            int     `json:"seq"` // 1-based chronological index
	RequestID      string  `json:"request_id"`
	TraceID        string  `json:"trace_id"`
	Model          string  `json:"model"`           // model actually sent upstream
	RequestedModel string  `json:"requested_model"` // model the client asked for (before routing rewrite)
	Provider       string  `json:"provider"`
	Endpoint       string  `json:"endpoint"`
	StatusCode     int     `json:"status_code"`
	StartOffsetMS  int64   `json:"start_offset_ms"` // from session start (first request)
	TTFBMS         int64   `json:"ttfb_ms"`         // time to first chunk (streaming); 0 if non-stream
	TotalMS        int64   `json:"total_ms"`        // upstream round-trip latency
	GapBeforeMS    int64   `json:"gap_before_ms"`   // idle / client "think" time since previous activity ended
	Category       string  `json:"category"`        // error | fallback | cache | complex | normal
	Complexity     int     `json:"complexity"`
	TotalTokens    int64   `json:"total_tokens"`
	CostKRW        float64 `json:"cost_krw"`
	ToolCalls      int64   `json:"tool_calls"`
	ToolErrors     int64   `json:"tool_errors"`
	FallbackFrom   string  `json:"fallback_from"`
	Slow           bool    `json:"slow"` // total_ms >= the slow threshold
	CreatedAt      string  `json:"created_at"`
}

// WaterfallBottleneck calls out the single worst span and the longest idle gap,
// so the operator does not have to eyeball the chart to find where time went.
type WaterfallBottleneck struct {
	SlowestSeq    int     `json:"slowest_seq"`     // seq of the slowest request (0 = none)
	SlowestMS     int64   `json:"slowest_ms"`      // its total latency
	SlowestPct    float64 `json:"slowest_pct"`     // slowest_ms / wall_ms * 100
	LongestGapSeq int     `json:"longest_gap_seq"` // seq of the request preceded by the largest gap
	LongestGapMS  int64   `json:"longest_gap_ms"`  // that gap's duration
	LongestGapPct float64 `json:"longest_gap_pct"` // longest_gap_ms / wall_ms * 100
}

// WaterfallTrace is the full waterfall for one session: the spans plus aggregate
// timing (wall clock vs. busy upstream time vs. idle think time).
type WaterfallTrace struct {
	SessionID    string              `json:"session_id"`
	Requests     int                 `json:"requests"`
	WallMS       int64               `json:"wall_ms"`    // first start → last end
	BusyMS       int64               `json:"busy_ms"`    // union of upstream busy intervals
	IdleMS       int64               `json:"idle_ms"`    // wall − busy (think/idle time)
	BusyRatio    float64             `json:"busy_ratio"` // busy / wall (0..1)
	TotalCostKRW float64             `json:"total_cost_krw"`
	TotalTokens  int64               `json:"total_tokens"`
	ToolCalls    int64               `json:"tool_calls"`
	WaitMS       int64               `json:"wait_ms"`    // Σ ttfb — total time spent waiting for first tokens
	StreamMS     int64               `json:"stream_ms"`  // Σ (total − ttfb) — total streaming/receive time
	SlowMS       int64               `json:"slow_ms"`    // the threshold used to flag slow spans
	SlowCount    int                 `json:"slow_count"` // spans with total_ms >= SlowMS
	Bottleneck   WaterfallBottleneck `json:"bottleneck"`
	Categories   map[string]int      `json:"categories"` // category → count
	StartedAt    string              `json:"started_at"`
	Truncated    bool                `json:"truncated"`
	Spans        []WaterfallSpan     `json:"spans"`
}

// highComplexityThreshold marks a request "complex" in the waterfall (matches the
// premium tier cutoff used by complexity routing).
const highComplexityThreshold = 70

// Waterfall assembles the transaction waterfall for one session, ordered by start time.
// sessionID "no-session" groups the requests that carried no session header.
// slowMS flags spans with total_ms >= slowMS; pass 0 to auto-pick max(3000, p95).
func (s *SQLStore) Waterfall(ctx context.Context, sessionID string, limit int, slowMS int64) (WaterfallTrace, error) {
	trace := WaterfallTrace{SessionID: sessionID, Categories: map[string]int{}, Spans: []WaterfallSpan{}}
	if limit <= 0 || limit > 2000 {
		limit = 500
	}
	query := s.bind(`
		SELECT r.id, r.trace_id, COALESCE(r.model, ''), COALESCE(r.requested_model, ''),
			COALESCE(r.provider, ''), r.endpoint, r.status_code,
			r.latency_ms, COALESCE(r.first_chunk_ms, 0), COALESCE(r.complexity, 0),
			COALESCE(r.failover, 0), COALESCE(r.fallback_from, ''), COALESCE(r.route_reason, ''),
			COALESCE(t.total_tokens, 0), COALESCE(t.estimated_cost, 0),
			(SELECT COUNT(*) FROM tool_invocations ti WHERE ti.request_id = r.id AND ti.source = 'call'),
			(SELECT COUNT(*) FROM tool_invocations ti WHERE ti.request_id = r.id AND ti.is_error = 1),
			r.created_at
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE COALESCE(NULLIF(r.session_id, ''), 'no-session') = ?
		ORDER BY r.created_at ASC
		LIMIT ?`)
	rows, err := s.db.QueryContext(ctx, query, sessionID, limit+1)
	if err != nil {
		return trace, err
	}
	defer rows.Close()

	type raw struct {
		span      WaterfallSpan
		t         time.Time
		hasT      bool
		failover  bool
		routeCach bool
	}
	var items []raw
	for rows.Next() {
		var sp WaterfallSpan
		var failoverInt int
		var routeReason string
		if err := rows.Scan(&sp.RequestID, &sp.TraceID, &sp.Model, &sp.RequestedModel,
			&sp.Provider, &sp.Endpoint, &sp.StatusCode,
			&sp.TotalMS, &sp.TTFBMS, &sp.Complexity,
			&failoverInt, &sp.FallbackFrom, &routeReason,
			&sp.TotalTokens, &sp.CostKRW,
			&sp.ToolCalls, &sp.ToolErrors,
			&sp.CreatedAt); err != nil {
			return trace, err
		}
		r := raw{span: sp, failover: failoverInt == 1, routeCach: routeReason == "cache"}
		if parsed, perr := time.Parse(time.RFC3339Nano, sp.CreatedAt); perr == nil {
			r.t = parsed
			r.hasT = true
		}
		items = append(items, r)
	}
	if err := rows.Err(); err != nil {
		return trace, err
	}
	if len(items) > limit {
		items = items[:limit]
		trace.Truncated = true
	}
	if len(items) == 0 {
		return trace, nil
	}

	t0 := items[0].t
	trace.StartedAt = items[0].span.CreatedAt

	var prevEndMax int64 // running max end offset, for gap + interval-union busy time
	var mergeStart, mergeEnd int64 = -1, -1
	var busy, maxEnd int64
	bn := WaterfallBottleneck{}

	for i := range items {
		sp := items[i].span
		sp.Seq = i + 1
		// clamp TTFB to total (a streamed first chunk can never exceed total latency)
		if sp.TTFBMS > sp.TotalMS {
			sp.TTFBMS = sp.TotalMS
		}
		if sp.TTFBMS < 0 {
			sp.TTFBMS = 0
		}
		// start offset from session start
		if items[i].hasT && !t0.IsZero() {
			off := items[i].t.Sub(t0).Milliseconds()
			if off < 0 {
				off = 0
			}
			sp.StartOffsetMS = off
		}
		start := sp.StartOffsetMS
		end := start + sp.TotalMS

		// gap (idle/think) since the most recent activity ended
		if i == 0 {
			sp.GapBeforeMS = 0
		} else {
			gap := start - prevEndMax
			if gap < 0 {
				gap = 0
			}
			sp.GapBeforeMS = gap
		}
		if end > prevEndMax {
			prevEndMax = end
		}
		if end > maxEnd {
			maxEnd = end
		}

		// union-of-intervals busy time (handles overlapping/concurrent requests)
		if mergeStart < 0 {
			mergeStart, mergeEnd = start, end
		} else if start <= mergeEnd {
			if end > mergeEnd {
				mergeEnd = end
			}
		} else {
			busy += mergeEnd - mergeStart
			mergeStart, mergeEnd = start, end
		}

		// phase totals + bottleneck tracking
		trace.WaitMS += sp.TTFBMS
		trace.StreamMS += sp.TotalMS - sp.TTFBMS
		if sp.TotalMS > bn.SlowestMS {
			bn.SlowestMS = sp.TotalMS
			bn.SlowestSeq = sp.Seq
		}
		if sp.GapBeforeMS > bn.LongestGapMS {
			bn.LongestGapMS = sp.GapBeforeMS
			bn.LongestGapSeq = sp.Seq
		}

		sp.Category = waterfallCategory(sp.StatusCode, items[i].failover, items[i].routeCach, sp.Provider, sp.FallbackFrom, sp.Complexity)
		trace.Categories[sp.Category]++
		trace.TotalCostKRW += sp.CostKRW
		trace.TotalTokens += sp.TotalTokens
		trace.ToolCalls += sp.ToolCalls
		trace.Spans = append(trace.Spans, sp)
	}
	if mergeStart >= 0 {
		busy += mergeEnd - mergeStart
	}

	trace.Requests = len(trace.Spans)
	trace.WallMS = maxEnd
	trace.BusyMS = busy
	trace.IdleMS = trace.WallMS - busy
	if trace.IdleMS < 0 {
		trace.IdleMS = 0
	}
	if trace.WallMS > 0 {
		trace.BusyRatio = float64(busy) / float64(trace.WallMS)
		bn.SlowestPct = float64(bn.SlowestMS) / float64(trace.WallMS) * 100
		bn.LongestGapPct = float64(bn.LongestGapMS) / float64(trace.WallMS) * 100
	}
	trace.Bottleneck = bn

	// slow threshold: explicit, else max(3000, p95 of total_ms)
	if slowMS <= 0 {
		slowMS = autoSlowThreshold(trace.Spans)
	}
	trace.SlowMS = slowMS
	for i := range trace.Spans {
		if trace.Spans[i].TotalMS >= slowMS {
			trace.Spans[i].Slow = true
			trace.SlowCount++
		}
	}
	return trace, nil
}

// waterfallCategory classifies a span for coloring. Priority mirrors XView:
// error > fallback > cache > complex > normal.
func waterfallCategory(status int, failover, routeCache bool, provider, fallbackFrom string, complexity int) string {
	if status >= 400 {
		return "error"
	}
	if failover || fallbackFrom != "" {
		return "fallback"
	}
	if routeCache || provider == "cache" {
		return "cache"
	}
	if complexity >= highComplexityThreshold {
		return "complex"
	}
	return "normal"
}

// autoSlowThreshold picks a "slow request" cutoff when the caller did not specify
// one: the larger of 3000ms and the p95 of the session's total latencies.
func autoSlowThreshold(spans []WaterfallSpan) int64 {
	const floor int64 = 3000
	if len(spans) == 0 {
		return floor
	}
	totals := make([]int64, 0, len(spans))
	for _, sp := range spans {
		totals = append(totals, sp.TotalMS)
	}
	sort.Slice(totals, func(i, j int) bool { return totals[i] < totals[j] })
	idx := int(math.Ceil(0.95*float64(len(totals)))) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(totals) {
		idx = len(totals) - 1
	}
	p95 := totals[idx]
	if p95 > floor {
		return p95
	}
	return floor
}
