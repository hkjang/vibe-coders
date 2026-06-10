package store

import (
	"context"
	"database/sql"
	"strings"
	"time"
)

// VCSEvent is a normalized version-control event (commit or merge request) ingested
// from GitLab / Bitbucket / a generic source and correlated to a coding session.
type VCSEvent struct {
	ID          string    `json:"id"`
	Provider    string    `json:"provider"` // gitlab | bitbucket | github | generic
	Kind        string    `json:"kind"`     // commit | merge_request
	Repo        string    `json:"repo"`
	Branch      string    `json:"branch"`
	Ref         string    `json:"ref"` // commit sha or MR id
	Title       string    `json:"title"`
	URL         string    `json:"url"`
	AuthorEmail string    `json:"author_email"`
	AuthorName  string    `json:"author_name"`
	State       string    `json:"state"` // MR: opened | merged | closed
	SessionID   string    `json:"session_id"`
	APIKeyID    string    `json:"api_key_id"`
	CreatedAt   time.Time `json:"created_at"`
}

func (s *SQLStore) InsertVCSEvent(ctx context.Context, e VCSEvent) error {
	if e.CreatedAt.IsZero() {
		e.CreatedAt = time.Now().UTC()
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO vcs_events
		(id, provider, kind, repo, branch, ref, title, url, author_email, author_name, state, session_id, api_key_id, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET state = excluded.state, title = excluded.title, session_id = excluded.session_id, api_key_id = excluded.api_key_id`),
		e.ID, e.Provider, e.Kind, e.Repo, e.Branch, e.Ref, e.Title, e.URL, e.AuthorEmail, e.AuthorName, e.State, e.SessionID, e.APIKeyID, formatTime(e.CreatedAt))
	return err
}

// VCSEventFilter scopes a VCS event listing.
type VCSEventFilter struct {
	SessionID string
	Repo      string
	APIKeyID  string
	Kind      string
	Limit     int
}

func (s *SQLStore) ListVCSEvents(ctx context.Context, f VCSEventFilter) ([]VCSEvent, error) {
	limit := f.Limit
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	where := []string{"1=1"}
	args := []any{}
	if f.SessionID != "" {
		where = append(where, "session_id = ?")
		args = append(args, f.SessionID)
	}
	if f.Repo != "" {
		where = append(where, "repo = ?")
		args = append(args, f.Repo)
	}
	if f.APIKeyID != "" {
		where = append(where, "api_key_id = ?")
		args = append(args, f.APIKeyID)
	}
	if f.Kind != "" {
		where = append(where, "kind = ?")
		args = append(args, f.Kind)
	}
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT id, provider, kind, COALESCE(repo,''), COALESCE(branch,''), COALESCE(ref,''),
			COALESCE(title,''), COALESCE(url,''), COALESCE(author_email,''), COALESCE(author_name,''),
			COALESCE(state,''), COALESCE(session_id,''), COALESCE(api_key_id,''), created_at
		FROM vcs_events WHERE `+strings.Join(where, " AND ")+`
		ORDER BY created_at DESC LIMIT ?`), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []VCSEvent{}
	for rows.Next() {
		var e VCSEvent
		var createdAt string
		if err := rows.Scan(&e.ID, &e.Provider, &e.Kind, &e.Repo, &e.Branch, &e.Ref, &e.Title, &e.URL,
			&e.AuthorEmail, &e.AuthorName, &e.State, &e.SessionID, &e.APIKeyID, &createdAt); err != nil {
			return nil, err
		}
		if parsed, perr := time.Parse(time.RFC3339Nano, createdAt); perr == nil {
			e.CreatedAt = parsed
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// SessionPrimaryAPIKey returns the most-used api_key_id for a session, used to link a
// VCS event (correlated to a session) back to the developer who drove it.
func (s *SQLStore) SessionPrimaryAPIKey(ctx context.Context, sessionID string) (string, error) {
	if sessionID == "" {
		return "", nil
	}
	var apiKeyID string
	err := s.db.QueryRowContext(ctx, s.bind(`
		SELECT COALESCE(NULLIF(api_key_id, ''), '') AS akid
		FROM request_logs WHERE COALESCE(NULLIF(session_id, ''), '') = ?
		GROUP BY akid ORDER BY COUNT(*) DESC LIMIT 1`), sessionID).Scan(&apiKeyID)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return apiKeyID, nil
}
