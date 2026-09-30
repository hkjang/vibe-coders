package store

import (
	"context"
	"database/sql/driver"
	"time"
)

// SaveRequestNote preserves selected columns at the database write, not from a
// previously read browser projection. This is not a revision/CAS check. A missing
// row is created with empty preserved fields. The returned row belongs to this
// committed transaction; a read or commit failure returns no success snapshot.
func (s *SQLStore) SaveRequestNote(ctx context.Context, note RequestNote, preserveNote, preserveTags bool) (RequestNote, error) {
	if preserveNote {
		note.Note = ""
	}
	if preserveTags {
		note.Tags = nil
	}
	if note.UpdatedAt.IsZero() {
		note.UpdatedAt = time.Now().UTC()
	}
	// Own the connection until commit/cleanup finishes. Some SQLite commit
	// failures leave a transaction open after database/sql marks Tx as done.
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return RequestNote{}, err
	}
	defer conn.Close()
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return RequestNote{}, err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, s.bind(`INSERT INTO request_notes (request_id, tags, note, created_by, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(request_id) DO UPDATE SET
		tags = CASE WHEN ? THEN request_notes.tags ELSE excluded.tags END,
		note = CASE WHEN ? THEN request_notes.note ELSE excluded.note END,
		created_by = excluded.created_by, updated_at = excluded.updated_at`),
		note.RequestID, joinTags(note.Tags), note.Note, note.CreatedBy, formatTime(note.UpdatedAt), preserveTags, preserveNote)
	if err != nil {
		return RequestNote{}, err
	}
	var saved RequestNote
	var tags, updatedAt string
	err = tx.QueryRowContext(ctx, s.bind(`SELECT request_id, COALESCE(tags, ''), COALESCE(note, ''), COALESCE(created_by, ''), updated_at
		FROM request_notes WHERE request_id = ?`), note.RequestID).
		Scan(&saved.RequestID, &tags, &saved.Note, &saved.CreatedBy, &updatedAt)
	if err != nil {
		return RequestNote{}, err
	}
	saved.Tags = splitTags(tags)
	if saved.UpdatedAt, err = time.Parse(time.RFC3339Nano, updatedAt); err != nil {
		return RequestNote{}, err
	}
	if err := tx.Commit(); err != nil {
		// Rollback may still work for a canceled commit; after a driver commit
		// failure it is ErrTxDone. Clean up only this pinned connection, never
		// return an open failed transaction to the shared pool.
		_ = tx.Rollback()
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		if _, cleanupErr := conn.ExecContext(cleanupCtx, "ROLLBACK"); cleanupErr != nil {
			_ = conn.Raw(func(any) error { return driver.ErrBadConn })
		}
		return RequestNote{}, err
	}
	return saved, nil
}
