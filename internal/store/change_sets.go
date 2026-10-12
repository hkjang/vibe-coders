package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"
)

var ErrChangeSetConflict = errors.New("change set changed concurrently")

// ChangeSetItem is one proposed change inside a change set. Kind "setting" is applied by the
// gateway; other kinds (policy/routing/skill) are recorded as advisory in this version.
type ChangeSetItem struct {
	Kind  string `json:"kind"` // setting | policy | routing | skill
	Key   string `json:"key"`
	Value string `json:"value"`
	Note  string `json:"note"`
}

// ChangeSet bundles several proposed changes into one reviewable, appliable, rollbackable unit.
type ChangeSet struct {
	ID          string          `json:"id"`
	Title       string          `json:"title"`
	Description string          `json:"description"`
	Status      string          `json:"status"` // draft | pending | approved | apply_pending | applied | rollback_pending | rolled_back
	Items       []ChangeSetItem `json:"items"`
	Prior       []ChangeSetItem `json:"prior"` // captured at apply time, for rollback
	CanaryScope string          `json:"canary_scope"`
	CreatedBy   string          `json:"created_by"`
	Reviewer    string          `json:"reviewer"`
	Note        string          `json:"note"`
	CreatedAt   string          `json:"created_at"`
	UpdatedAt   string          `json:"updated_at"`
	AppliedAt   string          `json:"applied_at"`
}

func (s *SQLStore) CreateChangeSet(ctx context.Context, cs ChangeSet) error {
	_, err := s.insertChangeSet(ctx, s.db, cs)
	return err
}

func (s *SQLStore) insertChangeSet(ctx context.Context, exec adminAuditExecer, cs ChangeSet) (ChangeSet, error) {
	if cs.Status == "" {
		cs.Status = "draft"
	}
	if cs.Items == nil {
		cs.Items = []ChangeSetItem{}
	}
	if cs.Prior == nil {
		cs.Prior = []ChangeSetItem{}
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	cs.CreatedAt, cs.UpdatedAt = now, now
	items, _ := json.Marshal(cs.Items)
	prior, _ := json.Marshal(cs.Prior)
	_, err := exec.ExecContext(ctx, s.bind(`INSERT INTO change_sets
		(id, title, description, status, items, prior, canary_scope, created_by, reviewer, note, created_at, updated_at, applied_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		cs.ID, cs.Title, cs.Description, cs.Status, string(items), string(prior), cs.CanaryScope, cs.CreatedBy, cs.Reviewer, cs.Note, cs.CreatedAt, cs.UpdatedAt, cs.AppliedAt)
	if err != nil {
		return ChangeSet{}, err
	}
	return cs, nil
}

func scanChangeSet(sc interface{ Scan(...any) error }) (ChangeSet, error) {
	var cs ChangeSet
	var items, prior string
	if err := sc.Scan(&cs.ID, &cs.Title, &cs.Description, &cs.Status, &items, &prior, &cs.CanaryScope, &cs.CreatedBy, &cs.Reviewer, &cs.Note, &cs.CreatedAt, &cs.UpdatedAt, &cs.AppliedAt); err != nil {
		return ChangeSet{}, err
	}
	if items != "" {
		_ = json.Unmarshal([]byte(items), &cs.Items)
	}
	if prior != "" {
		_ = json.Unmarshal([]byte(prior), &cs.Prior)
	}
	if cs.Items == nil {
		cs.Items = []ChangeSetItem{}
	}
	if cs.Prior == nil {
		cs.Prior = []ChangeSetItem{}
	}
	return cs, nil
}

func (s *SQLStore) ListChangeSets(ctx context.Context) ([]ChangeSet, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, title, description, status, items, prior, canary_scope, created_by, reviewer, note, created_at, updated_at, applied_at
		FROM change_sets ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ChangeSet{}
	for rows.Next() {
		cs, err := scanChangeSet(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, cs)
	}
	return out, rows.Err()
}

func (s *SQLStore) GetChangeSet(ctx context.Context, id string) (ChangeSet, bool, error) {
	row := s.db.QueryRowContext(ctx, s.bind(`SELECT id, title, description, status, items, prior, canary_scope, created_by, reviewer, note, created_at, updated_at, applied_at
		FROM change_sets WHERE id = ?`), id)
	cs, err := scanChangeSet(row)
	if errors.Is(err, sql.ErrNoRows) {
		return ChangeSet{}, false, nil
	}
	if err != nil {
		return ChangeSet{}, false, err
	}
	return cs, true, nil
}

// UpdateChangeSet persists status/reviewer/note/prior/applied_at transitions.
func (s *SQLStore) UpdateChangeSet(ctx context.Context, cs ChangeSet) error {
	prior, _ := json.Marshal(cs.Prior)
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE change_sets SET status = ?, reviewer = ?, note = ?, prior = ?,
		applied_at = ?, updated_at = ? WHERE id = ?`),
		cs.Status, cs.Reviewer, cs.Note, string(prior), cs.AppliedAt, time.Now().UTC().Format(time.RFC3339Nano), cs.ID)
	return err
}

// StageChangeSetSettings writes every setting and moves the change set to its durable pending
// marker in one transaction. The marker makes the operation resumable: once this commits, callers
// only need to reload the runtime and finalize the status; they must not write the settings again.
func (s *SQLStore) StageChangeSetSettings(ctx context.Context, cs ChangeSet, expectedStatus, changedBy, reason string, settings []AdminSetting) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := s.stageChangeSetSettingsTx(ctx, tx, cs, expectedStatus, changedBy, reason, settings, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *SQLStore) stageChangeSetSettingsTx(ctx context.Context, tx *sql.Tx, cs ChangeSet, expectedStatus, changedBy, reason string, settings []AdminSetting, now string) error {
	if cs.ID == "" || expectedStatus == "" || cs.Status == "" {
		return fmt.Errorf("change set id, expected status, and pending status are required")
	}
	prior, err := json.Marshal(cs.Prior)
	if err != nil {
		return err
	}
	// Lock the change set before its settings; all setting keys are then visited
	// in the same order even when two different sets contain reversed item lists.
	query := `UPDATE change_sets SET status = ?, reviewer = ?, note = ?, prior = ?,
		applied_at = ?, updated_at = ? WHERE id = ? AND status = ?`
	args := []any{cs.Status, cs.Reviewer, cs.Note, string(prior), cs.AppliedAt, now, cs.ID, expectedStatus}
	if cs.UpdatedAt != "" {
		query += ` AND updated_at = ?`
		args = append(args, cs.UpdatedAt)
	}
	result, err := tx.ExecContext(ctx, s.bind(query), args...)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return fmt.Errorf("%w: pending snapshot is no longer current", ErrChangeSetConflict)
	}
	ordered := append([]AdminSetting(nil), settings...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Key < ordered[j].Key })
	seen := make(map[string]struct{}, len(settings))
	for _, setting := range ordered {
		if setting.Key == "" {
			return fmt.Errorf("admin setting key is required")
		}
		if _, exists := seen[setting.Key]; exists {
			return fmt.Errorf("duplicate admin setting key %q", setting.Key)
		}
		seen[setting.Key] = struct{}{}
		if err := s.upsertAdminSettingTx(ctx, tx, setting, changedBy, reason, now); err != nil {
			return err
		}
	}

	return nil
}

// FinalizeChangeSetStatus completes a pending transition after the runtime snapshot was reloaded.
// It is idempotent for an already-finalized status, which makes recovery safe after a response or
// database acknowledgment is lost.
func (s *SQLStore) FinalizeChangeSetStatus(ctx context.Context, id, expectedStatus, finalStatus string) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := s.db.ExecContext(ctx, s.bind(`UPDATE change_sets SET status = ?, updated_at = ?
		WHERE id = ? AND status = ?`), finalStatus, now, id, expectedStatus)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 1 {
		return nil
	}
	var current string
	if err := s.db.QueryRowContext(ctx, s.bind(`SELECT status FROM change_sets WHERE id = ?`), id).Scan(&current); err != nil {
		return err
	}
	if current == finalStatus {
		return nil
	}
	return fmt.Errorf("%w: %s expected status %s, current status %s", ErrChangeSetConflict, id, expectedStatus, current)
}

func (s *SQLStore) DeleteChangeSet(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM change_sets WHERE id = ?`), id)
	return err
}
