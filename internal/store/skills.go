package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// Skill is a reusable AI task manual (instructions + metadata) with a lifecycle status and
// policy hints (allowed models/tools) for governed execution.
type Skill struct {
	Name          string `json:"name"`
	Description   string `json:"description"`
	Version       string `json:"version"`
	Owner         string `json:"owner"`
	Status        string `json:"status"`      // draft|staging|production|deprecated
	RiskLevel     string `json:"risk_level"`  // low|medium|high
	AllowedModels string `json:"allowed_models"` // comma-separated globs; empty = no restriction
	AllowedTools  string `json:"allowed_tools"`  // comma-separated tool/server names; empty = no restriction
	Instructions  string `json:"instructions"`
	Metadata      string `json:"metadata"` // JSON object
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`
	UpdatedBy     string `json:"updated_by"`
}

// SkillRun is one execution-log record for a skill.
type SkillRun struct {
	ID           string  `json:"id"`
	SkillName    string  `json:"skill_name"`
	SkillVersion string  `json:"skill_version"`
	Actor        string  `json:"actor"`
	InputHash    string  `json:"input_hash"`
	ToolsUsed    string  `json:"tools_used"`
	Model        string  `json:"model"`
	Status       string  `json:"status"`
	CostKRW      float64 `json:"cost_krw"`
	LatencyMS    int64   `json:"latency_ms"`
	CreatedAt    string  `json:"created_at"`
}

func normalizeSkill(s *Skill) {
	if strings.TrimSpace(s.Version) == "" {
		s.Version = "0.1.0"
	}
	if strings.TrimSpace(s.Status) == "" {
		s.Status = "draft"
	}
	if strings.TrimSpace(s.RiskLevel) == "" {
		s.RiskLevel = "low"
	}
	if strings.TrimSpace(s.Metadata) == "" {
		s.Metadata = "{}"
	}
}

// UpsertSkill inserts or updates a skill by name.
func (s *SQLStore) UpsertSkill(ctx context.Context, sk Skill, updatedBy string) (Skill, error) {
	normalizeSkill(&sk)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	sk.UpdatedAt = now
	sk.UpdatedBy = updatedBy
	var createdAt string
	row := s.db.QueryRowContext(ctx, s.bind(`SELECT created_at FROM skills WHERE name = ?`), sk.Name)
	switch err := row.Scan(&createdAt); {
	case errors.Is(err, sql.ErrNoRows):
		sk.CreatedAt = now
	case err != nil:
		return Skill{}, err
	default:
		sk.CreatedAt = createdAt
	}
	if _, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO skills
		(name, description, version, owner, status, risk_level, allowed_models, allowed_tools, instructions, metadata, created_at, updated_at, updated_by)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(name) DO UPDATE SET
			description = excluded.description, version = excluded.version, owner = excluded.owner,
			status = excluded.status, risk_level = excluded.risk_level, allowed_models = excluded.allowed_models,
			allowed_tools = excluded.allowed_tools, instructions = excluded.instructions, metadata = excluded.metadata,
			updated_at = excluded.updated_at, updated_by = excluded.updated_by`),
		sk.Name, sk.Description, sk.Version, sk.Owner, sk.Status, sk.RiskLevel, sk.AllowedModels, sk.AllowedTools,
		sk.Instructions, sk.Metadata, sk.CreatedAt, sk.UpdatedAt, sk.UpdatedBy); err != nil {
		return Skill{}, err
	}
	return sk, nil
}

// GetSkill returns one skill by name.
func (s *SQLStore) GetSkill(ctx context.Context, name string) (Skill, bool, error) {
	var sk Skill
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT name, description, version, owner, status, risk_level, allowed_models, allowed_tools, instructions, metadata, created_at, updated_at, COALESCE(updated_by,'')
		FROM skills WHERE name = ?`), name).
		Scan(&sk.Name, &sk.Description, &sk.Version, &sk.Owner, &sk.Status, &sk.RiskLevel, &sk.AllowedModels, &sk.AllowedTools, &sk.Instructions, &sk.Metadata, &sk.CreatedAt, &sk.UpdatedAt, &sk.UpdatedBy)
	if errors.Is(err, sql.ErrNoRows) {
		return Skill{}, false, nil
	}
	if err != nil {
		return Skill{}, false, err
	}
	return sk, true, nil
}

// ListSkills returns skills, optionally filtered by status, name-ordered.
func (s *SQLStore) ListSkills(ctx context.Context, status string) ([]Skill, error) {
	q := `SELECT name, description, version, owner, status, risk_level, allowed_models, allowed_tools, instructions, metadata, created_at, updated_at, COALESCE(updated_by,'')
		FROM skills`
	args := []any{}
	if status != "" {
		q += " WHERE status = ?"
		args = append(args, status)
	}
	q += " ORDER BY name"
	rows, err := s.db.QueryContext(ctx, s.bind(q), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Skill{}
	for rows.Next() {
		var sk Skill
		if err := rows.Scan(&sk.Name, &sk.Description, &sk.Version, &sk.Owner, &sk.Status, &sk.RiskLevel, &sk.AllowedModels, &sk.AllowedTools, &sk.Instructions, &sk.Metadata, &sk.CreatedAt, &sk.UpdatedAt, &sk.UpdatedBy); err != nil {
			return nil, err
		}
		out = append(out, sk)
	}
	return out, rows.Err()
}

// DeleteSkill removes a skill by name.
func (s *SQLStore) DeleteSkill(ctx context.Context, name string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM skills WHERE name = ?`), name)
	return err
}

// RecordSkillRun appends a skill execution-log entry.
func (s *SQLStore) RecordSkillRun(ctx context.Context, run SkillRun) error {
	if strings.TrimSpace(run.ID) == "" {
		run.ID = newStoreID("skrun")
	}
	if strings.TrimSpace(run.CreatedAt) == "" {
		run.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO skill_runs (id, skill_name, skill_version, actor, input_hash, tools_used, model, status, cost_krw, latency_ms, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		run.ID, run.SkillName, run.SkillVersion, run.Actor, run.InputHash, run.ToolsUsed, run.Model, run.Status, run.CostKRW, run.LatencyMS, run.CreatedAt)
	return err
}

// ListSkillRuns returns recent skill runs (optionally for one skill), newest first.
func (s *SQLStore) ListSkillRuns(ctx context.Context, skillName string, limit int) ([]SkillRun, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	q := `SELECT id, skill_name, skill_version, actor, input_hash, tools_used, model, status, cost_krw, latency_ms, created_at FROM skill_runs`
	args := []any{}
	if skillName != "" {
		q += " WHERE skill_name = ?"
		args = append(args, skillName)
	}
	q += " ORDER BY created_at DESC LIMIT ?"
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(q), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SkillRun{}
	for rows.Next() {
		var r SkillRun
		if err := rows.Scan(&r.ID, &r.SkillName, &r.SkillVersion, &r.Actor, &r.InputHash, &r.ToolsUsed, &r.Model, &r.Status, &r.CostKRW, &r.LatencyMS, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
