package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"vibe-coders/internal/workintel"
)

// WorkPolicyDraft is the one editable classification policy document. Its
// shape belongs to internal/workintel; the store keeps it consistent and
// guards concurrent edits with the revision.
type WorkPolicyDraft struct {
	ConfigJSON string `json:"-"`
	Revision   int    `json:"revision"`
	UpdatedBy  string `json:"updated_by"`
	UpdatedAt  string `json:"updated_at"`
}

// WorkPolicyVersion is a published snapshot of the policy. The worker always
// classifies with the highest version.
type WorkPolicyVersion struct {
	Version     int    `json:"version"`
	ConfigJSON  string `json:"-"`
	Note        string `json:"note"`
	PublishedBy string `json:"published_by"`
	PublishedAt string `json:"published_at"`
}

// WorkPolicyPublish describes one publication.
type WorkPolicyPublish struct {
	ConfigJSON string
	Note       string
	Actor      string
	// ExpectedDraftRevision, when positive, makes the publication fail with
	// ErrWorkPolicyConflict unless the draft still has this revision: what is
	// published is then exactly what the administrator reviewed.
	ExpectedDraftRevision int
	// ReplaceDraft also writes ConfigJSON to the draft (a rollback publishes an
	// old version and continues editing from it).
	ReplaceDraft bool
}

const workPolicySeedActor = "system"

// ensureWorkPolicySeeded writes the built-in policy as the draft and as
// version 1 when there is none. Both inserts are no-ops when another instance
// got there first, so every instance starting at once ends with one draft and
// one version 1.
func (s *SQLStore) ensureWorkPolicySeeded(ctx context.Context, q workQuerier) error {
	encoded, err := json.Marshal(workintel.DefaultPolicy())
	if err != nil {
		return err
	}
	now := workIntelTime(time.Now())
	if _, err := q.ExecContext(ctx, s.bind(`INSERT INTO work_intel_policy (id, config_json, revision, updated_by, updated_at)
		VALUES (?, ?, 1, ?, ?) ON CONFLICT(id) DO NOTHING`), workPolicyDraftID, string(encoded), workPolicySeedActor, now); err != nil {
		return err
	}
	// Only an empty history is seeded: a database whose versions start above 1
	// must not grow a "version 1" that was never published.
	_, err = q.ExecContext(ctx, s.bind(`INSERT INTO work_intel_policy_versions (version, config_json, note, published_by, published_at)
		SELECT 1, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM work_intel_policy_versions)
		ON CONFLICT(version) DO NOTHING`), string(encoded), "기본 정책", workPolicySeedActor, now)
	return err
}

func (s *SQLStore) readWorkPolicyDraft(ctx context.Context, q workQuerier) (WorkPolicyDraft, bool, error) {
	var out WorkPolicyDraft
	err := q.QueryRowContext(ctx, s.bind(`SELECT config_json, revision, COALESCE(updated_by, ''), updated_at
		FROM work_intel_policy WHERE id = ?`), workPolicyDraftID).
		Scan(&out.ConfigJSON, &out.Revision, &out.UpdatedBy, &out.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return WorkPolicyDraft{}, false, nil
	}
	return out, err == nil, err
}

// GetWorkPolicyDraft returns the draft. On first use it seeds the draft and
// version 1 from the built-in policy.
func (s *SQLStore) GetWorkPolicyDraft(ctx context.Context) (WorkPolicyDraft, error) {
	draft, found, err := s.readWorkPolicyDraft(ctx, s.db)
	if err != nil || found {
		return draft, err
	}
	if err := s.ensureWorkPolicySeeded(ctx, s.db); err != nil {
		return WorkPolicyDraft{}, err
	}
	draft, found, err = s.readWorkPolicyDraft(ctx, s.db)
	if err == nil && !found {
		err = errors.New("work policy draft is missing after seeding")
	}
	return draft, err
}

// SaveWorkPolicyDraft stores configJSON on top of expectedRevision and
// returns the saved draft with its new revision. It returns
// ErrWorkPolicyConflict when the draft has moved on. The caller validates the
// document; the store does not interpret it.
func (s *SQLStore) SaveWorkPolicyDraft(ctx context.Context, configJSON string, expectedRevision int, actor string) (WorkPolicyDraft, error) {
	if _, err := s.GetWorkPolicyDraft(ctx); err != nil {
		return WorkPolicyDraft{}, err
	}
	now := workIntelTime(time.Now())
	res, err := s.db.ExecContext(ctx, s.bind(`UPDATE work_intel_policy SET config_json = ?, revision = revision + 1, updated_by = ?, updated_at = ?
		WHERE id = ? AND revision = ?`), cleanArgs([]any{configJSON, actor, now, workPolicyDraftID, expectedRevision})...)
	if err != nil {
		return WorkPolicyDraft{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return WorkPolicyDraft{}, ErrWorkPolicyConflict
	}
	return WorkPolicyDraft{ConfigJSON: configJSON, Revision: expectedRevision + 1, UpdatedBy: actor, UpdatedAt: now}, nil
}

// PublishWorkPolicy publishes configJSON as the next version.
func (s *SQLStore) PublishWorkPolicy(ctx context.Context, configJSON, note, actor string) (WorkPolicyVersion, error) {
	return s.PublishWorkPolicyChecked(ctx, WorkPolicyPublish{ConfigJSON: configJSON, Note: note, Actor: actor})
}

// PublishWorkPolicyChecked publishes a version in one transaction. The draft
// row is locked first, which both serializes publishers (version numbers are
// consecutive and never reused) and lets ExpectedDraftRevision be checked
// against the same row the publication was reviewed from.
func (s *SQLStore) PublishWorkPolicyChecked(ctx context.Context, in WorkPolicyPublish) (WorkPolicyVersion, error) {
	if in.ConfigJSON == "" {
		return WorkPolicyVersion{}, errors.New("work policy document is empty")
	}
	if _, err := s.GetWorkPolicyDraft(ctx); err != nil {
		return WorkPolicyVersion{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return WorkPolicyVersion{}, err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, s.bind(`UPDATE work_intel_policy SET revision = revision WHERE id = ?`), workPolicyDraftID); err != nil {
		return WorkPolicyVersion{}, err
	}
	draft, found, err := s.readWorkPolicyDraft(ctx, tx)
	if err != nil {
		return WorkPolicyVersion{}, err
	}
	if !found {
		return WorkPolicyVersion{}, errors.New("work policy draft is missing")
	}
	if in.ExpectedDraftRevision > 0 && draft.Revision != in.ExpectedDraftRevision {
		return WorkPolicyVersion{}, ErrWorkPolicyConflict
	}

	out := WorkPolicyVersion{ConfigJSON: in.ConfigJSON, Note: in.Note, PublishedBy: in.Actor, PublishedAt: workIntelTime(time.Now())}
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) + 1 FROM work_intel_policy_versions`).Scan(&out.Version); err != nil {
		return WorkPolicyVersion{}, err
	}
	if _, err := tx.ExecContext(ctx, s.bind(`INSERT INTO work_intel_policy_versions (version, config_json, note, published_by, published_at)
		VALUES (?, ?, ?, ?, ?)`), cleanArgs([]any{out.Version, out.ConfigJSON, out.Note, out.PublishedBy, out.PublishedAt})...); err != nil {
		return WorkPolicyVersion{}, err
	}
	if in.ReplaceDraft {
		if _, err := tx.ExecContext(ctx, s.bind(`UPDATE work_intel_policy SET config_json = ?, revision = revision + 1, updated_by = ?, updated_at = ?
			WHERE id = ?`), cleanArgs([]any{in.ConfigJSON, in.Actor, out.PublishedAt, workPolicyDraftID})...); err != nil {
			return WorkPolicyVersion{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return WorkPolicyVersion{}, err
	}
	return out, nil
}

// ListWorkPolicyVersions returns the published versions, newest first, with
// their documents (the console diffs consecutive versions). limit <= 0 means
// 100.
func (s *SQLStore) ListWorkPolicyVersions(ctx context.Context, limit int) ([]WorkPolicyVersion, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	if _, err := s.LatestWorkPolicyVersion(ctx); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT version, config_json, COALESCE(note, ''), COALESCE(published_by, ''), published_at
		FROM work_intel_policy_versions ORDER BY version DESC LIMIT ?`), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WorkPolicyVersion{}
	for rows.Next() {
		var v WorkPolicyVersion
		if err := rows.Scan(&v.Version, &v.ConfigJSON, &v.Note, &v.PublishedBy, &v.PublishedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// GetWorkPolicyVersion returns one published version.
func (s *SQLStore) GetWorkPolicyVersion(ctx context.Context, version int) (WorkPolicyVersion, bool, error) {
	var v WorkPolicyVersion
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT version, config_json, COALESCE(note, ''), COALESCE(published_by, ''), published_at
		FROM work_intel_policy_versions WHERE version = ?`), version).
		Scan(&v.Version, &v.ConfigJSON, &v.Note, &v.PublishedBy, &v.PublishedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return WorkPolicyVersion{}, false, nil
	}
	return v, err == nil, err
}

// LatestWorkPolicyVersionNumber returns the highest published version, or 0
// when nothing has been published yet. It is the cheap check a cached engine
// is validated with.
func (s *SQLStore) LatestWorkPolicyVersionNumber(ctx context.Context) (int, error) {
	var version int
	err := s.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM work_intel_policy_versions`).Scan(&version)
	return version, err
}

// LatestWorkPolicyVersion returns the policy in force. On first use it seeds
// the draft and version 1 from the built-in policy.
func (s *SQLStore) LatestWorkPolicyVersion(ctx context.Context) (WorkPolicyVersion, error) {
	for attempt := 0; attempt < 2; attempt++ {
		var v WorkPolicyVersion
		err := s.db.QueryRowContext(ctx, `SELECT version, config_json, COALESCE(note, ''), COALESCE(published_by, ''), published_at
			FROM work_intel_policy_versions ORDER BY version DESC LIMIT 1`).
			Scan(&v.Version, &v.ConfigJSON, &v.Note, &v.PublishedBy, &v.PublishedAt)
		if err == nil {
			return v, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return WorkPolicyVersion{}, err
		}
		if err := s.ensureWorkPolicySeeded(ctx, s.db); err != nil {
			return WorkPolicyVersion{}, err
		}
	}
	return WorkPolicyVersion{}, errors.New("work policy version is missing after seeding")
}
