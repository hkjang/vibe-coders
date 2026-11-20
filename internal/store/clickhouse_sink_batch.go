package store

import (
	"context"
	"fmt"
	"time"
)

// ClickHouseSinkRange is the closed source interval of one sink attempt. A fixed
// upper bound prevents a busy source from extending an attempt indefinitely.
type ClickHouseSinkRange struct{ Dimension, Since, Until string }
type ClickHouseSinkCursor struct{ Position, ID string }
type ClickHouseSinkSummary struct {
	Rows  int64  `json:"rows"`
	First string `json:"first"`
	Last  string `json:"last"`
}
type ClickHouseSinkBatch struct {
	Rollups  []AnalyticsRollupRow
	Text2SQL []Text2SQLQueryLog
	RedTeam  []RedTeamDashboardRow
	Next     ClickHouseSinkCursor
}

func (b ClickHouseSinkBatch) Len() int { return len(b.Rollups) + len(b.Text2SQL) + len(b.RedTeam) }

func sinkBound(value string, daily bool) (string, error) {
	t, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		t, err = time.Parse("2006-01-02", value)
	}
	if err != nil {
		return "", fmt.Errorf("invalid sink interval")
	}
	if daily {
		if len(value) == 10 {
			return value, nil
		}
		return t.In(seoulZone).Format("2006-01-02"), nil
	}
	return appRequestFixedTime(t), nil
}
func (r ClickHouseSinkRange) Normalized() (ClickHouseSinkRange, error) {
	_, daily := rollupDimensions[r.Dimension]
	if !daily && r.Dimension != "text2sql_fact" && r.Dimension != "redteam_fact" {
		return r, fmt.Errorf("unsupported sink dimension")
	}
	var err error
	if r.Since, err = sinkBound(r.Since, daily); err != nil {
		return r, err
	}
	if r.Until, err = sinkBound(r.Until, daily); err != nil {
		return r, err
	}
	if r.Since > r.Until {
		return r, fmt.Errorf("invalid sink interval order")
	}
	return r, nil
}

const redTeamSinkFrom = `redteam_case_results r
 JOIN redteam_runs run ON r.run_id = run.id
 JOIN redteam_targets t ON run.target_id = t.id
 LEFT JOIN redteam_probe_cases cs ON r.case_id = cs.id
 LEFT JOIN redteam_probe_packs p ON cs.pack_id = p.id`

func sinkSource(r ClickHouseSinkRange) (from, where, position, id string, args []any, err error) {
	r, err = r.Normalized()
	if err != nil {
		return
	}
	switch r.Dimension {
	case "text2sql_fact":
		from = "text2sql_query_logs r"
		position = appRequestCreatedAtExpr("r.created_at")
		id = "r.id"
		where = "COALESCE(r.mode,'') <> 'shadow' AND "
	case "redteam_fact":
		from = redTeamSinkFrom
		position = appRequestCreatedAtExpr("r.created_at")
		id = "r.id"
	default:
		from = "analytics_daily r"
		position = "r.day"
		id = "r.dim_value"
		where = "r.dimension = ? AND "
		args = append(args, r.Dimension)
	}
	where += position + " >= ? AND " + position + " <= ?"
	args = append(args, r.Since, r.Until)
	return
}

// SummarizeClickHouseSink uses exactly the same source predicate as the sender.
// It reads local metadata only and never contacts or writes to ClickHouse.
func (s *SQLStore) SummarizeClickHouseSink(ctx context.Context, r ClickHouseSinkRange) (ClickHouseSinkSummary, error) {
	from, where, at, _, args, err := sinkSource(r)
	if err != nil {
		return ClickHouseSinkSummary{}, err
	}
	var out ClickHouseSinkSummary
	err = s.db.QueryRowContext(ctx, s.bind("SELECT COUNT(*),COALESCE(MIN("+at+"),''),COALESCE(MAX("+at+"),'') FROM "+from+" WHERE "+where), args...).Scan(&out.Rows, &out.First, &out.Last)
	return out, err
}

// ReadClickHouseSinkBatch uses a stable (time, identity) key, not OFFSET or a
// count-based cutoff. Tied timestamps and more than 5000 source rows are covered.
func (s *SQLStore) ReadClickHouseSinkBatch(ctx context.Context, r ClickHouseSinkRange, cursor ClickHouseSinkCursor, limit int) (ClickHouseSinkBatch, error) {
	if limit < 1 || limit > 1000 {
		return ClickHouseSinkBatch{}, fmt.Errorf("invalid sink batch size")
	}
	from, where, at, id, args, err := sinkSource(r)
	if err != nil {
		return ClickHouseSinkBatch{}, err
	}
	if cursor.Position != "" {
		where += " AND (" + at + " > ? OR (" + at + " = ? AND " + id + " > ?))"
		args = append(args, cursor.Position, cursor.Position, cursor.ID)
	}
	columns := "r.day,r.dimension,r.dim_value,r.requests,r.tokens,r.cost_krw,r.errors"
	switch r.Dimension {
	case "text2sql_fact":
		columns = `r.id,COALESCE(r.request_id,''),COALESCE(r.team,''),COALESCE(r.virtual_model,''),COALESCE(r.upstream_model,''),COALESCE(r.mode,''),COALESCE(r.schema_name,''),COALESCE(r.schema_version,0),r.valid,r.executed,r.row_count,COALESCE(r.explain_risk,0),r.cost_krw,COALESCE(r.generation_cost,0),COALESCE(r.summary_cost,0),r.latency_ms,COALESCE(r.failure_category,''),COALESCE(r.question,''),COALESCE(r.generated_sql,''),COALESCE(r.reject_reason,'')`
	case "redteam_fact":
		columns = `t.id,t.target_type,t.target_ref,t.owner_team,COALESCE(cs.pack_id,''),COALESCE(p.category,''),r.decision,r.severity,run.risk_score`
	}
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.bind("SELECT "+columns+","+at+","+id+" FROM "+from+" WHERE "+where+" ORDER BY "+at+","+id+" LIMIT ?"), args...)
	if err != nil {
		return ClickHouseSinkBatch{}, err
	}
	defer rows.Close()
	var out ClickHouseSinkBatch
	for rows.Next() {
		var next ClickHouseSinkCursor
		switch r.Dimension {
		case "text2sql_fact":
			var row Text2SQLQueryLog
			var valid, executed int
			err = rows.Scan(&row.ID, &row.RequestID, &row.Team, &row.VirtualModel, &row.UpstreamModel, &row.Mode, &row.SchemaName, &row.SchemaVersion, &valid, &executed, &row.RowCount, &row.ExplainRisk, &row.CostKRW, &row.GenerationCost, &row.SummaryCost, &row.LatencyMS, &row.FailureCategory, &row.Question, &row.GeneratedSQL, &row.RejectReason, &next.Position, &next.ID)
			if err == nil {
				row.CreatedAt, err = time.Parse(appRequestTimeLayout, next.Position)
			}
			row.Valid = valid == 1
			row.Executed = executed == 1
			out.Text2SQL = append(out.Text2SQL, row)
		case "redteam_fact":
			var row RedTeamDashboardRow
			err = rows.Scan(&row.TargetID, &row.TargetType, &row.TargetRef, &row.OwnerTeam, &row.PackID, &row.PackCategory, &row.Decision, &row.Severity, &row.RiskScore, &next.Position, &next.ID)
			row.CreatedAt = next.Position
			out.RedTeam = append(out.RedTeam, row)
		default:
			var row AnalyticsRollupRow
			err = rows.Scan(&row.Day, &row.Dimension, &row.DimValue, &row.Requests, &row.Tokens, &row.CostKRW, &row.Errors, &next.Position, &next.ID)
			out.Rollups = append(out.Rollups, row)
		}
		if err != nil {
			return ClickHouseSinkBatch{}, err
		}
		out.Next = next
	}
	return out, rows.Err()
}
