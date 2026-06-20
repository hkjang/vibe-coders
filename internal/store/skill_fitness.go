package store

import (
	"context"
	"time"
)

// SkillFitnessEvidence records that a skill's allowed models were validated by a multi-model
// test, a Golden Workflow, or a Prompt Lab test case — the basis for the model-fitness
// promotion gate.
type SkillFitnessEvidence struct {
	ID        string  `json:"id"`
	SkillName string  `json:"skill_name"`
	Kind      string  `json:"kind"` // multimodel | golden | testcase
	RefID     string  `json:"ref_id"`
	Passed    bool    `json:"passed"`
	Score     float64 `json:"score"`
	Note      string  `json:"note"`
	CreatedBy string  `json:"created_by"`
	CreatedAt string  `json:"created_at"`
}

func (s *SQLStore) AddSkillFitnessEvidence(ctx context.Context, e SkillFitnessEvidence) error {
	e.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	passed := 0
	if e.Passed {
		passed = 1
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO skill_fitness_evidence
		(id, skill_name, kind, ref_id, passed, score, note, created_by, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		e.ID, e.SkillName, e.Kind, e.RefID, passed, e.Score, e.Note, e.CreatedBy, e.CreatedAt)
	return err
}

func (s *SQLStore) ListSkillFitnessEvidence(ctx context.Context, skillName string) ([]SkillFitnessEvidence, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, skill_name, kind, ref_id, passed, score, note, created_by, created_at
		FROM skill_fitness_evidence WHERE skill_name = ? ORDER BY created_at DESC`), skillName)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SkillFitnessEvidence{}
	for rows.Next() {
		var e SkillFitnessEvidence
		var passed int
		if err := rows.Scan(&e.ID, &e.SkillName, &e.Kind, &e.RefID, &passed, &e.Score, &e.Note, &e.CreatedBy, &e.CreatedAt); err != nil {
			return nil, err
		}
		e.Passed = passed != 0
		out = append(out, e)
	}
	return out, rows.Err()
}

// CountPassingSkillFitnessEvidence returns how many distinct passing evidence records a skill
// has (the model-fitness gate threshold is checked against this).
func (s *SQLStore) CountPassingSkillFitnessEvidence(ctx context.Context, skillName string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT COUNT(*) FROM skill_fitness_evidence WHERE skill_name = ? AND passed = 1`), skillName).Scan(&n)
	return n, err
}
