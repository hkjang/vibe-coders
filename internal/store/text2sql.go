package store

import (
	"context"
	"time"
)

// Text2SQLQueryLog records one Text2SQL request: the natural-language question, the
// generated SQL, validation outcome, optional execution result, and cost — with
// both the user-facing virtual model and the real upstream model that produced it.
type Text2SQLQueryLog struct {
	ID              string    `json:"id"`
	RequestID       string    `json:"request_id"`
	APIKeyID        string    `json:"api_key_id"`
	Team            string    `json:"team"`
	VirtualModel    string    `json:"virtual_model"`
	UpstreamModel   string    `json:"upstream_model"`
	Mode            string    `json:"mode"`
	Question        string    `json:"question"`
	GeneratedSQL    string    `json:"generated_sql"`
	SchemaName      string    `json:"schema_name"`
	SchemaVersion   int       `json:"schema_version"`
	PermissionHash  string    `json:"permission_hash"`
	GlossaryHash    string    `json:"glossary_hash"`
	Valid           bool      `json:"valid"`
	RejectReason    string    `json:"reject_reason"`
	Executed        bool      `json:"executed"`
	RowCount        int64     `json:"row_count"`
	Error           string    `json:"error"`
	FailureCategory string    `json:"failure_category"`
	ExplainCost     float64   `json:"explain_cost"`
	ExplainRisk     int       `json:"explain_risk"`
	CostKRW         float64   `json:"cost_krw"`
	GenerationCost  float64   `json:"generation_cost"` // SQL-generation upstream cost
	SummaryCost     float64   `json:"summary_cost"`    // result-summary model cost
	LatencyMS       int64     `json:"latency_ms"`
	CreatedAt       time.Time `json:"created_at"`
}

// Text2SQLSpan records one internal pipeline stage for a Text2SQL request.
type Text2SQLSpan struct {
	ID            string    `json:"id"`
	RequestID     string    `json:"request_id"`
	Text2SQLLogID string    `json:"text2sql_log_id"`
	TraceID       string    `json:"trace_id"`
	Stage         string    `json:"stage"`
	Status        string    `json:"status"`
	LatencyMS     int64     `json:"latency_ms"`
	Model         string    `json:"model"`
	CostKRW       float64   `json:"cost_krw"`
	RejectReason  string    `json:"reject_reason"`
	InputHash     string    `json:"input_hash"`
	OutputHash    string    `json:"output_hash"`
	Detail        string    `json:"detail"`
	CreatedAt     time.Time `json:"created_at"`
}

func (s *SQLStore) InsertText2SQLLog(ctx context.Context, l Text2SQLQueryLog) error {
	if l.CreatedAt.IsZero() {
		l.CreatedAt = time.Now().UTC()
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO text2sql_query_logs
		(id, request_id, api_key_id, team, virtual_model, upstream_model, mode, question, generated_sql, schema_name, schema_version, permission_hash, glossary_hash, valid, reject_reason, executed, row_count, error, failure_category, explain_cost, explain_risk, cost_krw, generation_cost, summary_cost, latency_ms, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		l.ID, l.RequestID, l.APIKeyID, l.Team, l.VirtualModel, l.UpstreamModel, l.Mode, l.Question, l.GeneratedSQL,
		l.SchemaName, l.SchemaVersion, l.PermissionHash, l.GlossaryHash,
		boolInt(l.Valid), l.RejectReason, boolInt(l.Executed), l.RowCount, l.Error, l.FailureCategory, l.ExplainCost, l.ExplainRisk, l.CostKRW, l.GenerationCost, l.SummaryCost, l.LatencyMS, formatTime(l.CreatedAt))
	return err
}

func (s *SQLStore) InsertText2SQLSpans(ctx context.Context, spans []Text2SQLSpan) error {
	for _, sp := range spans {
		if sp.CreatedAt.IsZero() {
			sp.CreatedAt = time.Now().UTC()
		}
		if _, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO text2sql_spans
			(id, request_id, text2sql_log_id, trace_id, stage, status, latency_ms, model, cost_krw, reject_reason, input_hash, output_hash, detail, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
			sp.ID, sp.RequestID, sp.Text2SQLLogID, sp.TraceID, sp.Stage, sp.Status, sp.LatencyMS, sp.Model, sp.CostKRW,
			sp.RejectReason, sp.InputHash, sp.OutputHash, sp.Detail, formatTime(sp.CreatedAt)); err != nil {
			return err
		}
	}
	return nil
}

func (s *SQLStore) Text2SQLSpansForRequest(ctx context.Context, requestID string) ([]Text2SQLSpan, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, request_id, text2sql_log_id, COALESCE(trace_id,''), stage, status, latency_ms,
		COALESCE(model,''), COALESCE(cost_krw,0), COALESCE(reject_reason,''), COALESCE(input_hash,''), COALESCE(output_hash,''), COALESCE(detail,''), created_at
		FROM text2sql_spans WHERE request_id = ? ORDER BY created_at ASC`), requestID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Text2SQLSpan{}
	for rows.Next() {
		var sp Text2SQLSpan
		var createdAt string
		if err := rows.Scan(&sp.ID, &sp.RequestID, &sp.Text2SQLLogID, &sp.TraceID, &sp.Stage, &sp.Status, &sp.LatencyMS,
			&sp.Model, &sp.CostKRW, &sp.RejectReason, &sp.InputHash, &sp.OutputHash, &sp.Detail, &createdAt); err != nil {
			return nil, err
		}
		if ts, ok := parseStoredTime(createdAt); ok {
			sp.CreatedAt = ts
		}
		out = append(out, sp)
	}
	return out, rows.Err()
}

// ListText2SQLLogs returns recent Text2SQL query logs, newest first.
func (s *SQLStore) ListText2SQLLogs(ctx context.Context, limit int) ([]Text2SQLQueryLog, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, COALESCE(request_id,''), COALESCE(api_key_id,''), COALESCE(team,''),
		COALESCE(virtual_model,''), COALESCE(upstream_model,''), COALESCE(mode,''), COALESCE(question,''), COALESCE(generated_sql,''),
		COALESCE(schema_name,''), COALESCE(schema_version,0), COALESCE(permission_hash,''), COALESCE(glossary_hash,''),
		valid, COALESCE(reject_reason,''), executed, row_count, COALESCE(error,''), COALESCE(failure_category,''), explain_cost, explain_risk, cost_krw, COALESCE(generation_cost,0), COALESCE(summary_cost,0), latency_ms, created_at
		FROM text2sql_query_logs WHERE COALESCE(mode,'') <> 'shadow' ORDER BY created_at DESC LIMIT ?`), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Text2SQLQueryLog{}
	for rows.Next() {
		var l Text2SQLQueryLog
		var valid, executed int
		var createdAt string
		if err := rows.Scan(&l.ID, &l.RequestID, &l.APIKeyID, &l.Team, &l.VirtualModel, &l.UpstreamModel, &l.Mode,
			&l.Question, &l.GeneratedSQL, &l.SchemaName, &l.SchemaVersion, &l.PermissionHash, &l.GlossaryHash,
			&valid, &l.RejectReason, &executed, &l.RowCount, &l.Error, &l.FailureCategory, &l.ExplainCost, &l.ExplainRisk, &l.CostKRW, &l.GenerationCost, &l.SummaryCost, &l.LatencyMS, &createdAt); err != nil {
			return nil, err
		}
		l.Valid = valid == 1
		l.Executed = executed == 1
		if ts, ok := parseStoredTime(createdAt); ok {
			l.CreatedAt = ts
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// ListText2SQLLogsSince returns non-shadow Text2SQL logs created strictly after `since`,
// oldest first — used to ship per-query facts to ClickHouse incrementally.
func (s *SQLStore) ListText2SQLLogsSince(ctx context.Context, since time.Time, limit int) ([]Text2SQLQueryLog, error) {
	if limit <= 0 || limit > 10000 {
		limit = 5000
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, COALESCE(request_id,''), COALESCE(api_key_id,''), COALESCE(team,''),
		COALESCE(virtual_model,''), COALESCE(upstream_model,''), COALESCE(mode,''), COALESCE(question,''), COALESCE(generated_sql,''),
		COALESCE(schema_name,''), COALESCE(schema_version,0), COALESCE(permission_hash,''), COALESCE(glossary_hash,''),
		valid, COALESCE(reject_reason,''), executed, row_count, COALESCE(error,''), COALESCE(failure_category,''), explain_cost, explain_risk, cost_krw, COALESCE(generation_cost,0), COALESCE(summary_cost,0), latency_ms, created_at
		FROM text2sql_query_logs WHERE created_at > ? AND COALESCE(mode,'') <> 'shadow' ORDER BY created_at ASC LIMIT ?`), since.UTC().Format(time.RFC3339Nano), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Text2SQLQueryLog{}
	for rows.Next() {
		var l Text2SQLQueryLog
		var valid, executed int
		var createdAt string
		if err := rows.Scan(&l.ID, &l.RequestID, &l.APIKeyID, &l.Team, &l.VirtualModel, &l.UpstreamModel, &l.Mode,
			&l.Question, &l.GeneratedSQL, &l.SchemaName, &l.SchemaVersion, &l.PermissionHash, &l.GlossaryHash,
			&valid, &l.RejectReason, &executed, &l.RowCount, &l.Error, &l.FailureCategory, &l.ExplainCost, &l.ExplainRisk, &l.CostKRW, &l.GenerationCost, &l.SummaryCost, &l.LatencyMS, &createdAt); err != nil {
			return nil, err
		}
		l.Valid = valid == 1
		l.Executed = executed == 1
		if ts, ok := parseStoredTime(createdAt); ok {
			l.CreatedAt = ts
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// Text2SQLStats summarises recent Text2SQL activity for the admin tab.
type Text2SQLStats struct {
	Total     int64   `json:"total"`
	Valid     int64   `json:"valid"`
	Executed  int64   `json:"executed"`
	Errors    int64   `json:"errors"`
	CostKRW   float64 `json:"cost_krw"`
	ValidRate float64 `json:"valid_rate"`
}

// RiskyText2SQLLogs returns the queue of Text2SQL requests that warrant operator
// attention: rejected, high EXPLAIN risk, or classified as a failure — newest first.
func (s *SQLStore) RiskyText2SQLLogs(ctx context.Context, since time.Time, minRisk, limit int) ([]Text2SQLQueryLog, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, COALESCE(request_id,''), COALESCE(api_key_id,''), COALESCE(team,''),
		COALESCE(virtual_model,''), COALESCE(upstream_model,''), COALESCE(mode,''), COALESCE(question,''), COALESCE(generated_sql,''),
		COALESCE(schema_name,''), COALESCE(schema_version,0), COALESCE(permission_hash,''), COALESCE(glossary_hash,''),
		valid, COALESCE(reject_reason,''), executed, row_count, COALESCE(error,''), COALESCE(failure_category,''), explain_cost, explain_risk, cost_krw, COALESCE(generation_cost,0), COALESCE(summary_cost,0), latency_ms, created_at
		FROM text2sql_query_logs
		WHERE created_at >= ? AND COALESCE(mode,'') <> 'shadow' AND (valid = 0 OR explain_risk >= ? OR COALESCE(failure_category,'') <> '')
		ORDER BY created_at DESC LIMIT ?`), since.UTC().Format(time.RFC3339Nano), minRisk, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Text2SQLQueryLog{}
	for rows.Next() {
		var l Text2SQLQueryLog
		var valid, executed int
		var createdAt string
		if err := rows.Scan(&l.ID, &l.RequestID, &l.APIKeyID, &l.Team, &l.VirtualModel, &l.UpstreamModel, &l.Mode,
			&l.Question, &l.GeneratedSQL, &l.SchemaName, &l.SchemaVersion, &l.PermissionHash, &l.GlossaryHash,
			&valid, &l.RejectReason, &executed, &l.RowCount, &l.Error, &l.FailureCategory, &l.ExplainCost, &l.ExplainRisk, &l.CostKRW, &l.GenerationCost, &l.SummaryCost, &l.LatencyMS, &createdAt); err != nil {
			return nil, err
		}
		l.Valid = valid == 1
		l.Executed = executed == 1
		if ts, ok := parseStoredTime(createdAt); ok {
			l.CreatedAt = ts
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// Text2SQLFailureBucket counts Text2SQL failures by standard category.
type Text2SQLFailureBucket struct {
	Category string `json:"category"`
	Count    int64  `json:"count"`
}

// Text2SQLFailureBreakdownSince groups failed Text2SQL requests by failure_category.
func (s *SQLStore) Text2SQLFailureBreakdownSince(ctx context.Context, since time.Time) ([]Text2SQLFailureBucket, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT COALESCE(NULLIF(failure_category,''),'(none)'), COUNT(*)
		FROM text2sql_query_logs WHERE created_at >= ? AND COALESCE(mode,'') <> 'shadow' AND COALESCE(failure_category,'') <> ''
		GROUP BY COALESCE(NULLIF(failure_category,''),'(none)') ORDER BY COUNT(*) DESC`), since.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Text2SQLFailureBucket{}
	for rows.Next() {
		var b Text2SQLFailureBucket
		if err := rows.Scan(&b.Category, &b.Count); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// Text2SQLModelMetric is per-upstream-model Text2SQL quality derived from the logs.
type Text2SQLModelMetric struct {
	UpstreamModel string  `json:"upstream_model"`
	Total         int64   `json:"total"`
	Valid         int64   `json:"valid"`
	Executed      int64   `json:"executed"`
	Errors        int64   `json:"errors"`
	ValidRate     float64 `json:"valid_rate"`
	AvgCostKRW    float64 `json:"avg_cost_krw"`
	AvgLatencyMS  float64 `json:"avg_latency_ms"`
}

// Text2SQLStageMetric aggregates per-stage span telemetry for operational tuning.
type Text2SQLStageMetric struct {
	Stage        string  `json:"stage"`
	Status       string  `json:"status"`
	Model        string  `json:"model"`
	Count        int64   `json:"count"`
	ErrorCount   int64   `json:"error_count"`
	TotalCostKRW float64 `json:"total_cost_krw"`
	AvgCostKRW   float64 `json:"avg_cost_krw"`
	AvgLatencyMS float64 `json:"avg_latency_ms"`
	MaxLatencyMS int64   `json:"max_latency_ms"`
	ErrorRate    float64 `json:"error_rate"`
}

// Text2SQLModelMetricsSince ranks upstream models by how well they generate SQL.
func (s *SQLStore) Text2SQLModelMetricsSince(ctx context.Context, since time.Time) ([]Text2SQLModelMetric, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT COALESCE(NULLIF(upstream_model,''),'(unknown)'),
			COUNT(*),
			COALESCE(SUM(CASE WHEN valid = 1 THEN 1 ELSE 0 END),0),
			COALESCE(SUM(CASE WHEN executed = 1 THEN 1 ELSE 0 END),0),
			COALESCE(SUM(CASE WHEN COALESCE(error,'') <> '' THEN 1 ELSE 0 END),0),
			COALESCE(AVG(cost_krw),0),
			COALESCE(AVG(latency_ms),0)
		FROM text2sql_query_logs WHERE created_at >= ?
		GROUP BY COALESCE(NULLIF(upstream_model,''),'(unknown)')
		ORDER BY COUNT(*) DESC`), since.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Text2SQLModelMetric{}
	for rows.Next() {
		var m Text2SQLModelMetric
		if err := rows.Scan(&m.UpstreamModel, &m.Total, &m.Valid, &m.Executed, &m.Errors, &m.AvgCostKRW, &m.AvgLatencyMS); err != nil {
			return nil, err
		}
		if m.Total > 0 {
			m.ValidRate = float64(m.Valid) / float64(m.Total)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// Text2SQLStageMetricsSince ranks Text2SQL pipeline stages by total cost and latency.
func (s *SQLStore) Text2SQLStageMetricsSince(ctx context.Context, since time.Time) ([]Text2SQLStageMetric, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT stage,
			COALESCE(NULLIF(status,''),'unknown'),
			COALESCE(NULLIF(model,''),''),
			COUNT(*),
			COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END),0),
			COALESCE(SUM(cost_krw),0),
			COALESCE(AVG(cost_krw),0),
			COALESCE(AVG(latency_ms),0),
			COALESCE(MAX(latency_ms),0)
		FROM text2sql_spans
		WHERE created_at >= ?
		GROUP BY stage, COALESCE(NULLIF(status,''),'unknown'), COALESCE(NULLIF(model,''),'')
		ORDER BY COALESCE(SUM(cost_krw),0) DESC, COALESCE(AVG(latency_ms),0) DESC, COUNT(*) DESC`), since.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Text2SQLStageMetric{}
	for rows.Next() {
		var m Text2SQLStageMetric
		if err := rows.Scan(&m.Stage, &m.Status, &m.Model, &m.Count, &m.ErrorCount, &m.TotalCostKRW, &m.AvgCostKRW, &m.AvgLatencyMS, &m.MaxLatencyMS); err != nil {
			return nil, err
		}
		if m.Count > 0 {
			m.ErrorRate = float64(m.ErrorCount) / float64(m.Count)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// Text2SQLStatsSince aggregates Text2SQL logs since a time.
func (s *SQLStore) Text2SQLStatsSince(ctx context.Context, since time.Time) (Text2SQLStats, error) {
	var st Text2SQLStats
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT COUNT(*),
		COALESCE(SUM(CASE WHEN valid = 1 THEN 1 ELSE 0 END),0),
		COALESCE(SUM(CASE WHEN executed = 1 THEN 1 ELSE 0 END),0),
		COALESCE(SUM(CASE WHEN COALESCE(error,'') <> '' THEN 1 ELSE 0 END),0),
		COALESCE(SUM(cost_krw),0)
		FROM text2sql_query_logs WHERE created_at >= ? AND COALESCE(mode,'') <> 'shadow'`), since.UTC().Format(time.RFC3339Nano)).
		Scan(&st.Total, &st.Valid, &st.Executed, &st.Errors, &st.CostKRW)
	if err != nil {
		return st, err
	}
	if st.Total > 0 {
		st.ValidRate = float64(st.Valid) / float64(st.Total)
	}
	return st, nil
}
