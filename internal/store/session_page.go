package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

type SessionPageQuery struct {
	Since, Until  time.Time
	Search        string
	Limit, Offset int
	Teams         []string
	TeamScoped    bool
}
type SessionPageTotals struct {
	Sessions, Requests, Errors, Tokens int64
	Cost                               float64
}

// SessionPage applies the request visibility boundary before search, aggregates,
// count and pagination. The one statement shares a snapshot for rows and totals.
// Prompts are only looked up for the bounded visible page, never searched.
func (s *SQLStore) SessionPage(ctx context.Context, q SessionPageQuery) ([]SessionSummary, SessionPageTotals, error) {
	query, args, err := s.sessionPageSQL(q)
	if err != nil {
		return nil, SessionPageTotals{}, err
	}
	rows, err := s.db.QueryContext(ctx, s.bind(renderForDialect(query, s.dialect)), args...)
	if err != nil {
		return nil, SessionPageTotals{}, err
	}
	defer rows.Close()
	out := []SessionSummary{}
	var total SessionPageTotals
	for rows.Next() {
		var id, first, last, message sql.NullString
		var requests, models, keys, failures, tokens sql.NullInt64
		var cost sql.NullFloat64
		if err := rows.Scan(&total.Sessions, &total.Requests, &total.Errors, &total.Tokens, &total.Cost, &id, &requests, &first, &last, &models, &keys, &failures, &tokens, &cost, &message); err != nil {
			return nil, total, err
		}
		if requests.Valid {
			out = append(out, SessionSummary{SessionID: id.String, Requests: int(requests.Int64), FirstSeen: first.String, LastSeen: last.String, Models: int(models.Int64), APIKeys: int(keys.Int64), Errors: int(failures.Int64), TotalTokens: int(tokens.Int64), CostKRW: cost.Float64, LastMessage: message.String})
		}
	}
	return out, total, rows.Err()
}
func (s *SQLStore) sessionPageSQL(q SessionPageQuery) (string, []any, error) {
	if q.Since.IsZero() || !q.Until.After(q.Since) || q.Until.Sub(q.Since) > 366*24*time.Hour || q.Limit < 1 || q.Limit > 100 || q.Offset < 0 || q.Offset > 1_000_000 || !utf8.ValidString(q.Search) || len(q.Search) > 256 || strings.TrimSpace(q.Search) != q.Search || strings.IndexFunc(q.Search, unicode.IsControl) >= 0 {
		return "", nil, errors.New("invalid session page query")
	}
	window, args := metadataTimestampWindowSQL("r.created_at", q.Since, q.Until)
	where, args := appendRequestTeamCondition([]string{"r.session_id <> ''", window}, args, "", q.Teams, q.TeamScoped)
	if q.Search != "" {
		where = append(where, s.metadataLowerSQL("r.session_id")+" LIKE "+s.metadataLowerSQL("?")+" ESCAPE '!'")
		args = append(args, "%"+strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(q.Search)+"%")
	}
	orderID := "session_id COLLATE BINARY"
	if s.dialect == "postgres" {
		orderID = `session_id COLLATE "C"`
	}
	// Aggregate usage separately: multiple usage records may contribute tokens and
	// cost, but must never multiply request/error/model counts.
	statement := `WITH scoped AS (
 SELECT r.id,r.session_id,r.created_at,r.model,r.api_key_id,r.status_code FROM request_logs r WHERE ` + strings.Join(where, " AND ") + `
 ), usage AS (
 SELECT t.request_id,SUM(t.total_tokens) AS tokens,SUM(t.estimated_cost) AS cost
 FROM token_usage t JOIN scoped r ON r.id=t.request_id GROUP BY t.request_id
 ), grouped AS (
 SELECT r.session_id,COUNT(*) AS requests,MIN(` + metadataTimestampOrderSQL("r.created_at") + `) || 'Z' AS first_seen,MAX(` + metadataTimestampOrderSQL("r.created_at") + `) || 'Z' AS last_seen,
 COUNT(DISTINCT r.model) AS models,COUNT(DISTINCT r.api_key_id) AS api_keys,
 SUM(CASE WHEN r.status_code >= 400 THEN 1 ELSE 0 END) AS errors,
 COALESCE(SUM(u.tokens),0) AS tokens,COALESCE(SUM(u.cost),0) AS cost
 FROM scoped r LEFT JOIN usage u ON u.request_id=r.id GROUP BY r.session_id
 ), page AS (SELECT * FROM grouped ORDER BY last_seen DESC,` + orderID + ` DESC LIMIT ? OFFSET ?)
 SELECT c.sessions,c.requests,c.errors,c.tokens,c.cost,
 CASE WHEN length(CAST(p.session_id AS BLOB))<=4096 THEN p.session_id ELSE '' END,
 p.requests,p.first_seen,p.last_seen,p.models,p.api_keys,p.errors,p.tokens,p.cost,
 COALESCE((SELECT CASE WHEN length(CAST(pl.redacted_text AS BLOB))<=8192 THEN pl.redacted_text ELSE '' END
 FROM prompt_logs pl JOIN scoped pr ON pr.id=pl.request_id
 WHERE pr.session_id=p.session_id AND LOWER(pl.role)='user'
 ORDER BY ` + metadataTimestampOrderSQL("pl.created_at") + ` DESC,pl.id DESC LIMIT 1),'')
 FROM (SELECT COUNT(*) AS sessions,COALESCE(SUM(requests),0) AS requests,COALESCE(SUM(errors),0) AS errors,COALESCE(SUM(tokens),0) AS tokens,COALESCE(SUM(cost),0) AS cost FROM grouped) c
 LEFT JOIN page p ON 1=1 ORDER BY p.last_seen DESC,p.` + orderID + ` DESC`
	args = append(args, q.Limit, q.Offset)
	return statement, args, nil
}
