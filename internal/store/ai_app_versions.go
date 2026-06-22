package store

import (
	"context"
	"encoding/json"
	"time"
)

// WorkAppVersion is an immutable snapshot of a work app's definition captured at publish time, so
// the app's release history (what was shipped, by whom, when) is auditable and restorable.
type WorkAppVersion struct {
	ID           string         `json:"id"`
	AppID        string         `json:"app_id"`
	Version      int            `json:"version"`
	Title        string         `json:"title"`
	Description  string         `json:"description"`
	Icon         string         `json:"icon"`
	Components   []AppComponent `json:"components"`
	AllowedTeams string         `json:"allowed_teams"`
	AllowedRoles string         `json:"allowed_roles"`
	PublishedBy  string         `json:"published_by"`
	PublishedAt  string         `json:"published_at"`
	Note         string         `json:"note"`
}

// PublishWorkAppVersion snapshots the app's current definition as the next version and marks the
// app active (visible to users). Returns the new version number.
func (s *SQLStore) PublishWorkAppVersion(ctx context.Context, app WorkApp, publishedBy, note string) (int, error) {
	var maxVer int
	row := s.db.QueryRowContext(ctx, s.bind(`SELECT COALESCE(MAX(version), 0) FROM ai_app_versions WHERE app_id = ?`), app.ID)
	if err := row.Scan(&maxVer); err != nil {
		return 0, err
	}
	version := maxVer + 1
	comp, _ := json.Marshal(app.Components)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO ai_app_versions
		(id, app_id, version, title, description, icon, components, allowed_teams, allowed_roles, published_by, published_at, note)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		newVersionID(app.ID, version), app.ID, version, app.Title, app.Description, app.Icon, string(comp),
		app.AllowedTeams, app.AllowedRoles, publishedBy, now, note); err != nil {
		return 0, err
	}
	// Publishing makes the app active (visible to permitted users).
	if _, err := s.db.ExecContext(ctx, s.bind(`UPDATE work_apps SET status = 'active', updated_at = ? WHERE id = ?`), now, app.ID); err != nil {
		return 0, err
	}
	return version, nil
}

// ListWorkAppVersions returns an app's version history, newest first.
func (s *SQLStore) ListWorkAppVersions(ctx context.Context, appID string) ([]WorkAppVersion, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, app_id, version, title, description, icon, components, allowed_teams, allowed_roles, published_by, published_at, note
		FROM ai_app_versions WHERE app_id = ? ORDER BY version DESC`), appID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WorkAppVersion{}
	for rows.Next() {
		var v WorkAppVersion
		var comp string
		if err := rows.Scan(&v.ID, &v.AppID, &v.Version, &v.Title, &v.Description, &v.Icon, &comp,
			&v.AllowedTeams, &v.AllowedRoles, &v.PublishedBy, &v.PublishedAt, &v.Note); err != nil {
			return nil, err
		}
		if comp != "" {
			_ = json.Unmarshal([]byte(comp), &v.Components)
		}
		if v.Components == nil {
			v.Components = []AppComponent{}
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func newVersionID(appID string, version int) string {
	return "appver_" + appID + "_" + itoaStore(version)
}
