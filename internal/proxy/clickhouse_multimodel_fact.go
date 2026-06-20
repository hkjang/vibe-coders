package proxy

import (
	"context"
	"strings"
	"time"

	"vibe-coders/internal/store"
)

// multiModelFactDDL — one table holding multi-model comparison facts, discriminated by
// row_type: "run" (one per execution), "result" (one per model), "choice" (one per
// human/auto selection). No prompt text — only identity, metrics, scores. For long-term
// "which model keeps winning" analysis.
const multiModelFactDDL = `CREATE TABLE IF NOT EXISTS %s (
	event_date Date,
	event_time DateTime64(3),
	row_type LowCardinality(String),
	run_id String,
	team LowCardinality(String),
	task_type LowCardinality(String),
	created_by String,
	model LowCardinality(String),
	provider LowCardinality(String),
	status LowCardinality(String),
	latency_ms Int64,
	cost_krw Float64,
	input_tokens Int64,
	output_tokens Int64,
	judge_score Float64,
	verdict LowCardinality(String),
	model_count Int32,
	success_count Int32,
	selected_model LowCardinality(String),
	reason String,
	promoted UInt8,
	ingested_at DateTime64(3)
) ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_date, row_type, model)`

// emitMultiModelFacts ships a run row + one result row per model (best-effort, off the request
// path). Judge scores are attached when a judgement set is available. No-op when unconfigured.
func (s *Server) emitMultiModelFacts(run store.MultiModelTestRun, results []store.MultiModelTestResult, judgements []store.MultiModelTestJudgement) {
	ch := s.chConf()
	table := strings.TrimSpace(ch.MultiModelFactTable)
	if ch.URL == "" || table == "" {
		return
	}
	now := time.Now().UTC()
	ts := now
	if parsed, err := time.Parse(time.RFC3339Nano, run.CreatedAt); err == nil {
		ts = parsed.UTC()
	}
	base := func(rowType string) map[string]any {
		return map[string]any{
			"event_date": ts.Format("2006-01-02"), "event_time": ts.Format(time.RFC3339Nano),
			"row_type": rowType, "run_id": run.ID, "team": run.Team, "created_by": run.CreatedBy,
			"task_type": "", "model": "", "provider": "", "status": "", "latency_ms": 0, "cost_krw": 0.0,
			"input_tokens": 0, "output_tokens": 0, "judge_score": 0.0, "verdict": "", "model_count": 0,
			"success_count": 0, "selected_model": "", "reason": "", "promoted": 0,
			"ingested_at": now.Format(time.RFC3339Nano),
		}
	}
	scoreByModel := map[string]store.MultiModelTestJudgement{}
	for _, j := range judgements {
		scoreByModel[j.Model] = j
	}
	rows := []map[string]any{}
	runRow := base("run")
	runRow["model_count"] = run.ModelCount
	runRow["success_count"] = run.Success
	rows = append(rows, runRow)
	for _, res := range results {
		rr := base("result")
		rr["model"] = res.Model
		rr["provider"] = res.Provider
		rr["status"] = res.Status
		rr["latency_ms"] = res.LatencyMS
		rr["cost_krw"] = res.CostKRW
		rr["input_tokens"] = res.InputTokens
		rr["output_tokens"] = res.OutputTokens
		if j, ok := scoreByModel[res.Model]; ok {
			rr["judge_score"] = j.TotalScore
			rr["verdict"] = j.Verdict
		}
		rows = append(rows, rr)
	}
	s.shipMultiModelFacts(table, rows)
}

// emitMultiModelChoiceFact records a human/auto model selection (promotion to routing or
// Golden Workflow) for "which model do people actually pick" analysis.
func (s *Server) emitMultiModelChoiceFact(runID, team, taskType, selectedModel, reason string, promoted bool) {
	ch := s.chConf()
	table := strings.TrimSpace(ch.MultiModelFactTable)
	if ch.URL == "" || table == "" || selectedModel == "" {
		return
	}
	now := time.Now().UTC()
	p := 0
	if promoted {
		p = 1
	}
	row := map[string]any{
		"event_date": now.Format("2006-01-02"), "event_time": now.Format(time.RFC3339Nano),
		"row_type": "choice", "run_id": runID, "team": team, "created_by": "", "task_type": taskType,
		"model": selectedModel, "provider": "", "status": "", "latency_ms": 0, "cost_krw": 0.0,
		"input_tokens": 0, "output_tokens": 0, "judge_score": 0.0, "verdict": "", "model_count": 0,
		"success_count": 0, "selected_model": selectedModel, "reason": reason, "promoted": p,
		"ingested_at": now.Format(time.RFC3339Nano),
	}
	s.shipMultiModelFacts(table, []map[string]any{row})
}

func (s *Server) shipMultiModelFacts(table string, rows []map[string]any) {
	if len(rows) == 0 {
		return
	}
	ch := s.chConf()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		payload, _, err := insertJSONEachRow(ctx, s.client, ch, table, rows)
		if err != nil {
			_ = s.db.RecordClickHouseFactRetry(context.Background(), table, payload, len(rows), err.Error())
		}
	}()
}
