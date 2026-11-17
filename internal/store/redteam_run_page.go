package store

import (
	"context"
	"database/sql"
	"errors"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

var ErrRedTeamRunPage = errors.New("invalid redteam run page")

type RedTeamRunQuery struct {
	Limit, Offset                               int
	Status, Mode, Kind, Sort                    string
	RunID, CampaignID, SourceResultID, ReviewID string
	From, To                                    time.Time
}

// Identifiers only, never prompt text, credentials, SQL or arbitrary search.
func ValidRedTeamRunRef(value string) bool {
	if value == "" {
		return true
	}
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > 256 {
		return false
	}
	for _, c := range value {
		if !unicode.IsLetter(c) && !unicode.IsDigit(c) && !strings.ContainsRune("._:-", c) {
			return false
		}
	}
	return true
}

func redTeamRunPageOrder(sort string) (string, error) {
	if sort == "" {
		sort = "created_at:desc"
	}
	parts := strings.Split(sort, ",")
	if len(parts) > 3 {
		return "", ErrRedTeamRunPage
	}
	seen, orders := map[string]bool{}, []string{}
	for _, part := range parts {
		pair := strings.Split(part, ":")
		if len(pair) != 2 || seen[pair[0]] || (pair[1] != "asc" && pair[1] != "desc") {
			return "", ErrRedTeamRunPage
		}
		field := pair[0]
		switch field {
		case "created_at":
			field = metadataTimestampOrderSQL("created_at")
		case "id", "status", "total_cases", "failed_cases", "risk_score", "cost_krw":
		default:
			return "", ErrRedTeamRunPage
		}
		seen[pair[0]] = true
		orders = append(orders, field+" "+strings.ToUpper(pair[1]))
	}
	if !seen["id"] {
		orders = append(orders, "id DESC")
	}
	return strings.Join(orders, ", "), nil
}

// Read the count and rows from one database snapshot, with identical bound
// filters. Legacy ListRedTeamRuns and its bounded response stay unchanged.
func (s *SQLStore) RedTeamRunPage(ctx context.Context, query RedTeamRunQuery) ([]RedTeamRun, int, error) {
	if query.Limit < 1 || query.Limit > 100 || query.Offset < 0 || query.Offset > 1_000_000 ||
		!slices.Contains([]string{"", "running", "passed", "failed", "warning", "stopped"}, query.Status) ||
		!slices.Contains([]string{"", "dry-run", "active-controlled"}, query.Mode) ||
		!slices.Contains([]string{"", "campaign", "replay"}, query.Kind) ||
		query.From.IsZero() != query.To.IsZero() || (!query.From.IsZero() && !query.From.Before(query.To)) {
		return nil, 0, ErrRedTeamRunPage
	}
	for _, id := range []string{query.RunID, query.CampaignID, query.SourceResultID, query.ReviewID} {
		if !ValidRedTeamRunRef(id) {
			return nil, 0, ErrRedTeamRunPage
		}
	}
	order, err := redTeamRunPageOrder(query.Sort)
	if err != nil {
		return nil, 0, err
	}
	clauses, args := []string{"1 = 1"}, []any{}
	for _, filter := range []struct{ field, value string }{
		{"id", query.RunID}, {"campaign_id", query.CampaignID}, {"source_result_id", query.SourceResultID}, {"review_id", query.ReviewID}, {"status", query.Status}, {"mode", query.Mode},
	} {
		if filter.value != "" {
			clauses = append(clauses, filter.field+" = ?")
			args = append(args, filter.value)
		}
	}
	if query.Kind == "campaign" {
		clauses = append(clauses, "source_result_id = ''")
	}
	if query.Kind == "replay" {
		clauses = append(clauses, "source_result_id <> ''")
	}
	if !query.From.IsZero() {
		where, values := metadataTimestampWindowSQL("created_at", query.From, query.To)
		clauses = append(clauses, where)
		args = append(args, values...)
	}
	where := " WHERE " + strings.Join(clauses, " AND ")
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable, ReadOnly: true})
	if err != nil {
		return nil, 0, err
	}
	defer tx.Rollback()
	var total int
	if err := tx.QueryRowContext(ctx, s.bind("SELECT COUNT(*) FROM redteam_runs"+where), args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := tx.QueryContext(ctx, s.bind(`SELECT id,campaign_id,target_id,started_at,ended_at,status,total_cases,failed_cases,risk_score,cost_krw,mode,created_at,source_result_id,review_id
		FROM redteam_runs`+where+" ORDER BY "+order+" LIMIT ? OFFSET ?"), append(args, query.Limit, query.Offset)...)
	if err != nil {
		return nil, 0, err
	}
	items := []RedTeamRun{}
	for rows.Next() {
		row, scanErr := scanRedTeamRun(rows)
		if scanErr != nil {
			rows.Close()
			return nil, 0, scanErr
		}
		items = append(items, row)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, 0, err
	}
	if err := tx.Commit(); err != nil {
		return nil, 0, err
	}
	return items, total, nil
}
