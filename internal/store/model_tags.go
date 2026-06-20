package store

import (
	"context"
	"time"
)

// ModelUsageTag captures task-fit guidance for a model: what it's good for, what to avoid it
// for, and a short risk note. Used to keep multi-model comparison "use-case specific" rather
// than crowning one global winner.
type ModelUsageTag struct {
	Model     string `json:"model"`
	GoodFor   string `json:"good_for"`   // comma-separated task types
	AvoidFor  string `json:"avoid_for"`  // comma-separated task types
	RiskNote  string `json:"risk_note"`
	UpdatedBy string `json:"updated_by"`
	UpdatedAt string `json:"updated_at"`
}

func (s *SQLStore) UpsertModelUsageTag(ctx context.Context, t ModelUsageTag) error {
	t.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO model_usage_tags
		(model, good_for, avoid_for, risk_note, updated_by, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(model) DO UPDATE SET
			good_for = excluded.good_for, avoid_for = excluded.avoid_for,
			risk_note = excluded.risk_note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`),
		t.Model, t.GoodFor, t.AvoidFor, t.RiskNote, t.UpdatedBy, t.UpdatedAt)
	return err
}

func (s *SQLStore) ListModelUsageTags(ctx context.Context) ([]ModelUsageTag, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT model, good_for, avoid_for, risk_note, updated_by, updated_at
		FROM model_usage_tags ORDER BY model ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ModelUsageTag{}
	for rows.Next() {
		var t ModelUsageTag
		if err := rows.Scan(&t.Model, &t.GoodFor, &t.AvoidFor, &t.RiskNote, &t.UpdatedBy, &t.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *SQLStore) DeleteModelUsageTag(ctx context.Context, model string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM model_usage_tags WHERE model = ?`), model)
	return err
}
