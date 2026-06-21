package store

import (
	"context"
	"database/sql"
	"time"
)

// Text2SQLSavedReport is a recurring question promoted to a reusable asset — a saved
// report or dashboard card — so a frequently-asked Text2SQL question becomes a
// standardized, named artifact instead of being re-typed each time.
type Text2SQLSavedReport struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	Question          string `json:"question"`
	SQL               string `json:"sql"`
	SchemaName        string `json:"schema_name"`
	Kind              string `json:"kind"` // report | dashboard_card
	CreatedBy         string `json:"created_by"`
	CreatedAt         string `json:"created_at"`
	ScheduleInterval  string `json:"schedule_interval"` // e.g. "24h"; empty = manual only
	ScheduleEnabled   bool   `json:"schedule_enabled"`
	DeliverMattermost bool   `json:"deliver_mattermost"`
	LastRunAt         string `json:"last_run_at"`
	// Team sharing / approval workflow.
	Team           string `json:"team"`
	Visibility     string `json:"visibility"`      // private | team
	ApprovalStatus string `json:"approval_status"` // none | pending | approved | rejected
	ApprovedBy     string `json:"approved_by"`
	ApprovedAt     string `json:"approved_at"`
}

// UpsertText2SQLSavedReport stores (or replaces) a saved report.
func (s *SQLStore) UpsertText2SQLSavedReport(ctx context.Context, r Text2SQLSavedReport) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if r.CreatedAt == "" {
		r.CreatedAt = now
	}
	if r.Kind == "" {
		r.Kind = "report"
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO text2sql_saved_reports
		(id, name, question, sql, schema_name, kind, created_by, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name = excluded.name, question = excluded.question, sql = excluded.sql,
			schema_name = excluded.schema_name, kind = excluded.kind`),
		r.ID, r.Name, r.Question, r.SQL, r.SchemaName, r.Kind, r.CreatedBy, r.CreatedAt)
	return err
}

const savedReportColumns = `id, name, COALESCE(question,''), COALESCE(sql,''), COALESCE(schema_name,''),
	COALESCE(kind,'report'), COALESCE(created_by,''), created_at,
	COALESCE(schedule_interval,''), COALESCE(schedule_enabled,0), COALESCE(deliver_mattermost,0), COALESCE(last_run_at,''),
	COALESCE(team,''), COALESCE(visibility,'private'), COALESCE(approval_status,'none'), COALESCE(approved_by,''), COALESCE(approved_at,'')`

func scanSavedReport(rows interface{ Scan(...any) error }) (Text2SQLSavedReport, error) {
	var r Text2SQLSavedReport
	var schedEnabled, deliverMM int
	err := rows.Scan(&r.ID, &r.Name, &r.Question, &r.SQL, &r.SchemaName, &r.Kind, &r.CreatedBy, &r.CreatedAt,
		&r.ScheduleInterval, &schedEnabled, &deliverMM, &r.LastRunAt,
		&r.Team, &r.Visibility, &r.ApprovalStatus, &r.ApprovedBy, &r.ApprovedAt)
	r.ScheduleEnabled = schedEnabled == 1
	r.DeliverMattermost = deliverMM == 1
	return r, err
}

// GetText2SQLSavedReport returns one saved report by id.
func (s *SQLStore) GetText2SQLSavedReport(ctx context.Context, id string) (Text2SQLSavedReport, bool, error) {
	row := s.db.QueryRowContext(ctx, s.bind(`SELECT `+savedReportColumns+` FROM text2sql_saved_reports WHERE id = ?`), id)
	r, err := scanSavedReport(row)
	if err == sql.ErrNoRows {
		return Text2SQLSavedReport{}, false, nil
	}
	if err != nil {
		return Text2SQLSavedReport{}, false, err
	}
	return r, true, nil
}

// SubmitReportForTeam marks a saved report as pending team approval, tagging the owning team.
func (s *SQLStore) SubmitReportForTeam(ctx context.Context, id, team string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE text2sql_saved_reports
		SET team = ?, approval_status = 'pending', visibility = 'private' WHERE id = ?`), team, id)
	return err
}

// DecideTeamReport approves (→ visibility=team) or rejects (→ private) a pending report.
func (s *SQLStore) DecideTeamReport(ctx context.Context, id string, approve bool, by string) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if approve {
		_, err := s.db.ExecContext(ctx, s.bind(`UPDATE text2sql_saved_reports
			SET approval_status = 'approved', visibility = 'team', approved_by = ?, approved_at = ? WHERE id = ?`), by, now, id)
		return err
	}
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE text2sql_saved_reports
		SET approval_status = 'rejected', visibility = 'private', approved_by = ?, approved_at = ? WHERE id = ?`), by, now, id)
	return err
}

// ListTeamReports returns a team's shared (approved) and pending reports, newest first.
func (s *SQLStore) ListTeamReports(ctx context.Context, team string) ([]Text2SQLSavedReport, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT `+savedReportColumns+`
		FROM text2sql_saved_reports
		WHERE team = ? AND approval_status IN ('pending','approved')
		ORDER BY CASE approval_status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC`), team)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Text2SQLSavedReport{}
	for rows.Next() {
		r, err := scanSavedReport(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ListText2SQLSavedReports returns saved reports, newest first.
func (s *SQLStore) ListText2SQLSavedReports(ctx context.Context) ([]Text2SQLSavedReport, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+savedReportColumns+` FROM text2sql_saved_reports ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Text2SQLSavedReport{}
	for rows.Next() {
		r, err := scanSavedReport(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ListText2SQLSavedReportsByCreatedBy returns one user's saved reports, newest first.
func (s *SQLStore) ListText2SQLSavedReportsByCreatedBy(ctx context.Context, createdBy string) ([]Text2SQLSavedReport, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT `+savedReportColumns+` FROM text2sql_saved_reports WHERE created_by = ? ORDER BY created_at DESC`), createdBy)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Text2SQLSavedReport{}
	for rows.Next() {
		r, err := scanSavedReport(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// SetText2SQLReportSchedule configures a report's schedule (interval like "24h"),
// enable flag, and Mattermost delivery — without touching the report content.
func (s *SQLStore) SetText2SQLReportSchedule(ctx context.Context, id, interval string, enabled, deliverMattermost bool) error {
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE text2sql_saved_reports
		SET schedule_interval = ?, schedule_enabled = ?, deliver_mattermost = ? WHERE id = ?`),
		interval, boolInt(enabled), boolInt(deliverMattermost), id)
	return err
}

// MarkText2SQLReportRun records when a scheduled report last ran.
func (s *SQLStore) MarkText2SQLReportRun(ctx context.Context, id, ts string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE text2sql_saved_reports SET last_run_at = ? WHERE id = ?`), ts, id)
	return err
}

// DueText2SQLReports returns enabled, scheduled reports whose interval has elapsed
// since last_run_at (or that have never run).
func (s *SQLStore) DueText2SQLReports(ctx context.Context, now time.Time) ([]Text2SQLSavedReport, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+savedReportColumns+` FROM text2sql_saved_reports
		WHERE COALESCE(schedule_enabled,0) = 1 AND COALESCE(schedule_interval,'') <> ''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	all := []Text2SQLSavedReport{}
	for rows.Next() {
		r, err := scanSavedReport(rows)
		if err != nil {
			return nil, err
		}
		all = append(all, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	due := []Text2SQLSavedReport{}
	for _, r := range all {
		interval, perr := time.ParseDuration(r.ScheduleInterval)
		if perr != nil || interval <= 0 {
			continue
		}
		if r.LastRunAt == "" {
			due = append(due, r)
			continue
		}
		last, lerr := time.Parse(time.RFC3339Nano, r.LastRunAt)
		if lerr != nil || !now.Before(last.Add(interval)) {
			due = append(due, r)
		}
	}
	return due, nil
}

// DeleteText2SQLSavedReport removes a saved report.
func (s *SQLStore) DeleteText2SQLSavedReport(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM text2sql_saved_reports WHERE id = ?`), id)
	return err
}
