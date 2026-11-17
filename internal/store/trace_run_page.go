package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

var ErrTraceRunQuery = errors.New("invalid trace run query")

type TraceRunQuery struct {
	TraceID, Kind string
	Limit, Offset int
	Teams         []string
	TeamScoped    bool
}
type TraceRunMetadata struct {
	ID, ResourceID, ResourceName, OwnerID, Status, CreatedAt string
	LatencyMS                                                int64
	CostKRW                                                  float64
}

// TraceRunPage reads only metadata and counts/pages the same exact trace and
// caller team scope in one SQL statement. Legacy trace exports are unchanged.
func (s *SQLStore) TraceRunPage(ctx context.Context, q TraceRunQuery) ([]TraceRunMetadata, int64, error) {
	statement, args, err := traceRunPageQuery(q, s.dialect)
	if err != nil {
		return nil, 0, err
	}
	rows, err := s.db.QueryContext(ctx, s.bind(renderForDialect(statement, s.dialect)), args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	result := []TraceRunMetadata{}
	var total int64
	for rows.Next() {
		var id, resourceID, title, owner, status, at sql.NullString
		var latency sql.NullInt64
		var cost sql.NullFloat64
		if err := rows.Scan(&total, &id, &resourceID, &title, &owner, &status, &latency, &cost, &at); err != nil {
			return nil, 0, err
		}
		if latency.Valid {
			result = append(result, TraceRunMetadata{ID: id.String, ResourceID: resourceID.String, ResourceName: title.String, OwnerID: owner.String, Status: status.String, LatencyMS: latency.Int64, CostKRW: cost.Float64, CreatedAt: at.String})
		}
	}
	return result, total, rows.Err()
}

func traceRunPageQuery(q TraceRunQuery, dialect string) (string, []any, error) {
	if !utf8.ValidString(q.TraceID) || len(q.TraceID) == 0 || len(q.TraceID) > 1024 || strings.TrimSpace(q.TraceID) != q.TraceID || strings.IndexFunc(q.TraceID, unicode.IsControl) >= 0 || q.Limit < 1 || q.Limit > 100 || q.Offset < 0 || q.Offset > 1_000_000 {
		return "", nil, ErrTraceRunQuery
	}
	var table, resource, definitions, name string
	switch q.Kind {
	case "workflow":
		table, resource, definitions, name = "workflow_runs", "workflow_id", "workflows", "name"
	case "app":
		table, resource, definitions, name = "ai_app_runs", "app_id", "work_apps", "title"
	default:
		return "", nil, ErrTraceRunQuery
	}
	where := []string{"trace_id = ?", traceRunIndexPredicateForDialect(dialect)}
	args := []any{q.TraceID}
	if q.TeamScoped {
		teams := []string{}
		for _, team := range q.Teams {
			if team != "" && strings.TrimSpace(team) == team {
				teams = append(teams, team)
			}
		}
		if len(teams) == 0 {
			where = append(where, "1 = 0")
		} else {
			where = append(where, "team IN ("+strings.TrimSuffix(strings.Repeat("?,", len(teams)), ",")+")")
			for _, team := range teams {
				args = append(args, team)
			}
		}
	}
	// Only fixed internal identifiers enter SQL. Bound expressions keep unusually
	// large legacy values out of API buffers without dropping rows from the count.
	bounded := func(field string, max int) string {
		length := "length(CAST(" + field + " AS BLOB))"
		if dialect == "postgres" {
			length = "octet_length(" + field + ")"
		}
		return fmt.Sprintf("CASE WHEN %s <= %d THEN %s ELSE '' END", length, max, field)
	}
	statement := `WITH matching AS (
  SELECT id,` + resource + ` AS resource_id,user_id,status,latency_ms,cost_krw,created_at
  FROM ` + table + ` WHERE ` + strings.Join(where, " AND ") + `
 ), page AS (
  SELECT * FROM matching ORDER BY ` + metadataTimestampOrderSQL("created_at") + ` DESC,id DESC LIMIT ? OFFSET ?
 ) SELECT c.total,` + bounded("p.id", 4096) + `,` + bounded("p.resource_id", 4096) + `,` + bounded("d."+name, 1024) + `,` + bounded("p.user_id", 4096) + `,` + bounded("p.status", 64) + `,p.latency_ms,p.cost_krw,` + bounded("p.created_at", 64) + `
 FROM (SELECT COUNT(*) AS total FROM matching) c LEFT JOIN page p ON 1=1
 LEFT JOIN ` + definitions + ` d ON d.id=p.resource_id
 ORDER BY ` + metadataTimestampOrderSQL("p.created_at") + ` DESC,p.id DESC`
	args = append(args, q.Limit, q.Offset)
	return statement, args, nil
}

func traceRunIndexPredicate() string { return "length(CAST(trace_id AS BLOB)) BETWEEN 1 AND 1024" }

// Keep the read predicate identical to the partial index expression. PostgreSQL
// BYTEA input syntax is not a text byte counter (literal backslashes can fail).
func traceRunIndexPredicateForDialect(dialect string) string {
	if dialect == "postgres" {
		return "octet_length(trace_id) BETWEEN 1 AND 1024"
	}
	return traceRunIndexPredicate()
}
