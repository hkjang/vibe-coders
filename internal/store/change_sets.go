package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

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
	Status      string          `json:"status"` // draft | pending | approved | applied | rolled_back
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
	if cs.Status == "" {
		cs.Status = "draft"
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	cs.CreatedAt, cs.UpdatedAt = now, now
	items, _ := json.Marshal(cs.Items)
	prior, _ := json.Marshal(cs.Prior)
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO change_sets
		(id, title, description, status, items, prior, canary_scope, created_by, reviewer, note, created_at, updated_at, applied_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		cs.ID, cs.Title, cs.Description, cs.Status, string(items), string(prior), cs.CanaryScope, cs.CreatedBy, cs.Reviewer, cs.Note, cs.CreatedAt, cs.UpdatedAt, cs.AppliedAt)
	return err
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

func (s *SQLStore) DeleteChangeSet(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM change_sets WHERE id = ?`), id)
	return err
}
