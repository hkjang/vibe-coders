package store

import (
	"context"
	"database/sql"
	"strings"
	"time"
)

func (s *SQLStore) GetRequestNote(ctx context.Context, requestID string) (RequestNote, bool, error) {
	var n RequestNote
	var tags sql.NullString
	var note sql.NullString
	var createdBy sql.NullString
	var updatedAt string
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT request_id, tags, note, created_by, updated_at FROM request_notes WHERE request_id = ?`), requestID).
		Scan(&n.RequestID, &tags, &note, &createdBy, &updatedAt)
	if err == sql.ErrNoRows {
		return RequestNote{RequestID: requestID, Tags: []string{}}, false, nil
	}
	if err != nil {
		return RequestNote{}, false, err
	}
	n.Tags = splitTags(tags.String)
	n.Note = note.String
	n.CreatedBy = createdBy.String
	if parsed, err := time.Parse(time.RFC3339Nano, updatedAt); err == nil {
		n.UpdatedAt = parsed
	}
	return n, true, nil
}

func (s *SQLStore) UpsertRequestNote(ctx context.Context, note RequestNote) error {
	if note.UpdatedAt.IsZero() {
		note.UpdatedAt = time.Now().UTC()
	}
	tags := joinTags(note.Tags)
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO request_notes (request_id, tags, note, created_by, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(request_id) DO UPDATE SET tags = excluded.tags, note = excluded.note, created_by = excluded.created_by, updated_at = excluded.updated_at`),
		note.RequestID, tags, note.Note, note.CreatedBy, formatTime(note.UpdatedAt))
	return err
}

func (s *SQLStore) DeleteRequestNote(ctx context.Context, requestID string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM request_notes WHERE request_id = ?`), requestID)
	return err
}

func (s *SQLStore) ListRequestNotes(ctx context.Context, requestIDs []string) (map[string]RequestNote, error) {
	result := map[string]RequestNote{}
	if len(requestIDs) == 0 {
		return result, nil
	}
	placeholders := make([]string, len(requestIDs))
	args := make([]any, len(requestIDs))
	for i, id := range requestIDs {
		placeholders[i] = "?"
		args[i] = id
	}
	query := s.bind(`SELECT request_id, tags, note, created_by, updated_at FROM request_notes WHERE request_id IN (` + strings.Join(placeholders, ",") + `)`)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var n RequestNote
		var tags sql.NullString
		var note sql.NullString
		var createdBy sql.NullString
		var updatedAt string
		if err := rows.Scan(&n.RequestID, &tags, &note, &createdBy, &updatedAt); err != nil {
			return nil, err
		}
		n.Tags = splitTags(tags.String)
		n.Note = note.String
		n.CreatedBy = createdBy.String
		if parsed, err := time.Parse(time.RFC3339Nano, updatedAt); err == nil {
			n.UpdatedAt = parsed
		}
		result[n.RequestID] = n
	}
	return result, rows.Err()
}

func splitTags(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return []string{}
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func joinTags(tags []string) string {
	cleaned := make([]string, 0, len(tags))
	for _, t := range tags {
		t = strings.TrimSpace(t)
		if t != "" {
			cleaned = append(cleaned, t)
		}
	}
	return strings.Join(cleaned, ",")
}

// SearchRequestsByTag returns request rows whose note has the given tag.
func (s *SQLStore) SearchRequestsByTag(ctx context.Context, tag string, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 100
	}
	pattern := "%" + tag + "%"
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT request_id FROM request_notes WHERE tags LIKE ? ORDER BY updated_at DESC LIMIT ?`), pattern, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// ---------- saved filters ----------

func (s *SQLStore) ListSavedFilters(ctx context.Context) ([]SavedFilter, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, view, params, COALESCE(created_by, ''), created_at FROM saved_filters ORDER BY view, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []SavedFilter{}
	for rows.Next() {
		var f SavedFilter
		var createdAt string
		if err := rows.Scan(&f.ID, &f.Name, &f.View, &f.Params, &f.CreatedBy, &createdAt); err != nil {
			return nil, err
		}
		if parsed, err := time.Parse(time.RFC3339Nano, createdAt); err == nil {
			f.CreatedAt = parsed
		}
		result = append(result, f)
	}
	return result, rows.Err()
}

func (s *SQLStore) UpsertSavedFilter(ctx context.Context, f SavedFilter) error {
	if f.CreatedAt.IsZero() {
		f.CreatedAt = time.Now().UTC()
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO saved_filters (id, name, view, params, created_by, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name = excluded.name, view = excluded.view, params = excluded.params, created_by = excluded.created_by`),
		f.ID, f.Name, f.View, f.Params, f.CreatedBy, formatTime(f.CreatedAt))
	return err
}

func (s *SQLStore) DeleteSavedFilter(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM saved_filters WHERE id = ?`), id)
	return err
}
