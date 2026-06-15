package store

import (
	"context"
	"time"
)

// Text2SQLReplayBundle is the full generation context captured for one Text2SQL query
// when replay bundles are enabled: the exact prompt sent upstream, the schema context,
// the glossary text, and the effective permission snapshot. Together with the generated
// SQL this lets an operator reproduce — and explain — why a given SQL was produced,
// beyond the hashes kept on the query log.
type Text2SQLReplayBundle struct {
	ID                 string `json:"id"` // == query log ID
	RequestID          string `json:"request_id"`
	SchemaName         string `json:"schema_name"`
	SchemaVersion      int    `json:"schema_version"`
	SystemPrompt       string `json:"system_prompt"`       // full generation messages JSON sent upstream
	SchemaContext      string `json:"schema_context"`      // schema/catalog text injected into the prompt
	GlossaryText       string `json:"glossary_text"`       // business-glossary block injected
	PermissionSnapshot string `json:"permission_snapshot"` // JSON of effective allow/blocked/aggregate/mask lists
	GeneratedSQL       string `json:"generated_sql"`
	CreatedAt          string `json:"created_at"`
}

// PutText2SQLReplayBundle stores (or replaces) the replay bundle for a query.
func (s *SQLStore) PutText2SQLReplayBundle(ctx context.Context, b Text2SQLReplayBundle) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO text2sql_replay_bundles
		(id, request_id, schema_name, schema_version, system_prompt, schema_context, glossary_text, permission_snapshot, generated_sql, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET system_prompt = excluded.system_prompt, schema_context = excluded.schema_context,
			glossary_text = excluded.glossary_text, permission_snapshot = excluded.permission_snapshot, generated_sql = excluded.generated_sql`),
		b.ID, b.RequestID, b.SchemaName, b.SchemaVersion, b.SystemPrompt, b.SchemaContext, b.GlossaryText, b.PermissionSnapshot, b.GeneratedSQL, now)
	return err
}

// PurgeText2SQLReplayBundles deletes replay bundles older than the retention window.
// Bundles hold full prompt/schema/permission context, so they should not be kept
// indefinitely; the retention worker calls this each cycle.
func (s *SQLStore) PurgeText2SQLReplayBundles(ctx context.Context, days int) (int64, error) {
	if days <= 0 {
		return 0, nil
	}
	cutoff := time.Now().UTC().AddDate(0, 0, -days).Format(time.RFC3339Nano)
	res, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM text2sql_replay_bundles WHERE created_at < ?`), cutoff)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// GetText2SQLReplayBundle fetches a replay bundle by query log ID or request ID.
func (s *SQLStore) GetText2SQLReplayBundle(ctx context.Context, idOrRequestID string) (Text2SQLReplayBundle, bool, error) {
	var b Text2SQLReplayBundle
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT id, COALESCE(request_id,''), COALESCE(schema_name,''), COALESCE(schema_version,0),
		COALESCE(system_prompt,''), COALESCE(schema_context,''), COALESCE(glossary_text,''), COALESCE(permission_snapshot,''), COALESCE(generated_sql,''), COALESCE(created_at,'')
		FROM text2sql_replay_bundles WHERE id = ? OR request_id = ? LIMIT 1`), idOrRequestID, idOrRequestID).
		Scan(&b.ID, &b.RequestID, &b.SchemaName, &b.SchemaVersion, &b.SystemPrompt, &b.SchemaContext, &b.GlossaryText, &b.PermissionSnapshot, &b.GeneratedSQL, &b.CreatedAt)
	if err != nil {
		return Text2SQLReplayBundle{}, false, nil
	}
	return b, true, nil
}
