package store

import (
	"context"
	"time"
)

// AppPermission is an explicit per-app access grant to a specific user or team, additive to a
// work app's coarse allowed_teams/allowed_roles gate — so an app can be shared with named people
// or teams without widening its role/team CSV.
type AppPermission struct {
	ID          string `json:"id"`
	AppID       string `json:"app_id"`
	SubjectType string `json:"subject_type"` // user | team
	SubjectID   string `json:"subject_id"`
	GrantedBy   string `json:"granted_by"`
	CreatedAt   string `json:"created_at"`
}

// GrantAppPermission adds (idempotently) an explicit allow grant for a user/team on an app.
func (s *SQLStore) GrantAppPermission(ctx context.Context, p AppPermission) error {
	if p.CreatedAt == "" {
		p.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO ai_app_permissions
		(id, app_id, subject_type, subject_id, granted_by, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(app_id, subject_type, subject_id) DO NOTHING`),
		p.ID, p.AppID, p.SubjectType, p.SubjectID, p.GrantedBy, p.CreatedAt)
	return err
}

// RevokeAppPermission removes an explicit grant.
func (s *SQLStore) RevokeAppPermission(ctx context.Context, appID, subjectType, subjectID string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM ai_app_permissions
		WHERE app_id = ? AND subject_type = ? AND subject_id = ?`), appID, subjectType, subjectID)
	return err
}

// ListAppPermissions returns all explicit grants for an app.
func (s *SQLStore) ListAppPermissions(ctx context.Context, appID string) ([]AppPermission, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, app_id, subject_type, subject_id, granted_by, created_at
		FROM ai_app_permissions WHERE app_id = ? ORDER BY subject_type, subject_id`), appID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AppPermission{}
	for rows.Next() {
		var p AppPermission
		if err := rows.Scan(&p.ID, &p.AppID, &p.SubjectType, &p.SubjectID, &p.GrantedBy, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// AppGrantsSubject reports whether an app has an explicit allow grant for the given user or team.
func (s *SQLStore) AppGrantsSubject(ctx context.Context, appID, userID, teamID string) (bool, error) {
	row := s.db.QueryRowContext(ctx, s.bind(`SELECT COUNT(*) FROM ai_app_permissions
		WHERE app_id = ? AND ((subject_type = 'user' AND subject_id = ?) OR (subject_type = 'team' AND subject_id = ?))`),
		appID, userID, teamID)
	var n int
	if err := row.Scan(&n); err != nil {
		return false, err
	}
	return n > 0, nil
}
