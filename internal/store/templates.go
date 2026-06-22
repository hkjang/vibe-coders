package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// PromptTemplate is a centrally-managed standard prompt (e.g. 리팩터링, 테스트 생성,
// 보안 점검, 문서화) that teams reuse instead of re-inventing prompts per request.
type PromptTemplate struct {
	ID          string   `json:"id"` // slug
	Name        string   `json:"name"`
	Category    string   `json:"category"`
	Description string   `json:"description"`
	Body        string   `json:"body"`
	Enabled     bool     `json:"enabled"`
	UseCount    int64    `json:"use_count"`
	LastUsedAt  string   `json:"last_used_at"`
	CreatedAt   string   `json:"created_at"`
	UpdatedAt   string   `json:"updated_at"`
	// Asset library v2
	Tags       []string `json:"tags"`
	Status     string   `json:"status"`      // draft | pending | approved | standard
	ApprovedBy string   `json:"approved_by"`
	ApprovedAt string   `json:"approved_at"`
	Note       string   `json:"note"`
	// Computed from request_logs (not stored in table)
	SuccessRate  float64 `json:"success_rate,omitempty"`
	AvgCostKRW   float64 `json:"avg_cost_krw,omitempty"`
	AvgLatencyMS float64 `json:"avg_latency_ms,omitempty"`
	CallCount    int64   `json:"call_count,omitempty"`
}

const templateCols = `id, name, category, COALESCE(description, ''), body, enabled, use_count,
	COALESCE(last_used_at, ''), created_at, updated_at,
	COALESCE(tags, ''), COALESCE(status, 'draft'),
	COALESCE(approved_by, ''), COALESCE(approved_at, ''), COALESCE(note, '')`

func scanTemplate(rows interface{ Scan(...any) error }) (PromptTemplate, error) {
	var t PromptTemplate
	var enabled int
	var tagsRaw string
	if err := rows.Scan(
		&t.ID, &t.Name, &t.Category, &t.Description, &t.Body, &enabled, &t.UseCount,
		&t.LastUsedAt, &t.CreatedAt, &t.UpdatedAt,
		&tagsRaw, &t.Status, &t.ApprovedBy, &t.ApprovedAt, &t.Note,
	); err != nil {
		return PromptTemplate{}, err
	}
	t.Enabled = enabled == 1
	t.Tags = parseTags(tagsRaw)
	if t.Status == "" {
		t.Status = "draft"
	}
	return t, nil
}

func parseTags(raw string) []string {
	if strings.TrimSpace(raw) == "" {
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

// ListPromptTemplates returns all templates ordered by status then category then name.
func (s *SQLStore) ListPromptTemplates(ctx context.Context, onlyEnabled bool) ([]PromptTemplate, error) {
	where := ""
	if onlyEnabled {
		where = "WHERE enabled = 1"
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+templateCols+`
		FROM prompt_templates `+where+` ORDER BY CASE status WHEN 'standard' THEN 0 WHEN 'approved' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, category, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PromptTemplate{}
	for rows.Next() {
		t, err := scanTemplate(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// ListPromptAssets returns templates with optional filters and request_logs metrics joined by prompt_name.
func (s *SQLStore) ListPromptAssets(ctx context.Context, statusFilter, tagFilter, categoryFilter, q string) ([]PromptTemplate, error) {
	var args []any
	conds := []string{}
	if statusFilter != "" {
		conds = append(conds, "pt.status = ?")
		args = append(args, statusFilter)
	}
	if categoryFilter != "" {
		conds = append(conds, "pt.category = ?")
		args = append(args, categoryFilter)
	}
	if tagFilter != "" {
		// comma-separated tags field contains the tag
		conds = append(conds, "(','||pt.tags||',' LIKE ?)")
		args = append(args, "%,"+tagFilter+",%")
	}
	if q != "" {
		conds = append(conds, "(LOWER(pt.name) LIKE ? OR LOWER(pt.description) LIKE ?)")
		lq := "%" + strings.ToLower(q) + "%"
		args = append(args, lq, lq)
	}
	where := ""
	if len(conds) > 0 {
		where = "WHERE " + strings.Join(conds, " AND ")
	}
	// Metrics window: last 90 days
	since90 := time.Now().UTC().Add(-90 * 24 * time.Hour).Format(time.RFC3339)
	metricsQ := s.bind(`SELECT r.prompt_name,
		COUNT(*) as calls,
		AVG(CASE WHEN r.status_code < 400 THEN 1.0 ELSE 0.0 END) as success_rate,
		COALESCE(AVG(t.estimated_cost), 0) as avg_cost_krw,
		COALESCE(AVG(r.latency_ms), 0) as avg_latency_ms
		FROM request_logs r
		LEFT JOIN token_usage t ON r.id = t.request_id
		WHERE r.prompt_name != '' AND r.created_at >= ?
		GROUP BY r.prompt_name`)
	mrows, err := s.db.QueryContext(ctx, metricsQ, since90)
	if err != nil {
		return nil, err
	}
	defer mrows.Close()
	type mEntry struct {
		calls        int64
		successRate  float64
		avgCostKRW   float64
		avgLatencyMS float64
	}
	metrics := map[string]mEntry{}
	for mrows.Next() {
		var name string
		var m mEntry
		if err := mrows.Scan(&name, &m.calls, &m.successRate, &m.avgCostKRW, &m.avgLatencyMS); err == nil {
			metrics[name] = m
		}
	}
	_ = mrows.Close()

	query := s.bind(`SELECT ` + templateCols + ` FROM prompt_templates pt ` + where + ` ORDER BY CASE pt.status WHEN 'standard' THEN 0 WHEN 'approved' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, pt.use_count DESC, pt.name`)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PromptTemplate{}
	for rows.Next() {
		t, err := scanTemplate(rows)
		if err != nil {
			return nil, err
		}
		// Prefer header-based attribution (prompt_name == asset id), fall back to
		// matching by display name for clients that don't send X-Prompt-Asset-Id.
		m, ok := metrics[t.ID]
		if !ok {
			m, ok = metrics[t.Name]
		}
		if ok {
			t.SuccessRate = m.successRate
			t.AvgCostKRW = m.avgCostKRW
			t.AvgLatencyMS = m.avgLatencyMS
			t.CallCount = m.calls
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// GetPromptTemplate returns a single template by id.
func (s *SQLStore) GetPromptTemplate(ctx context.Context, id string) (PromptTemplate, bool, error) {
	row := s.db.QueryRowContext(ctx, s.bind(`SELECT `+templateCols+`
		FROM prompt_templates WHERE id = ?`), id)
	t, err := scanTemplate(row)
	if errors.Is(err, sql.ErrNoRows) {
		return PromptTemplate{}, false, nil
	}
	if err != nil {
		return PromptTemplate{}, false, err
	}
	return t, true, nil
}

// UpsertPromptTemplate inserts or updates a template, preserving use_count.
func (s *SQLStore) UpsertPromptTemplate(ctx context.Context, t PromptTemplate) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if strings.TrimSpace(t.CreatedAt) == "" {
		t.CreatedAt = now
	}
	if strings.TrimSpace(t.Category) == "" {
		t.Category = "custom"
	}
	if strings.TrimSpace(t.Status) == "" {
		t.Status = "draft"
	}
	enabled := 0
	if t.Enabled {
		enabled = 1
	}
	tagsRaw := joinTags(t.Tags)
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO prompt_templates
		(id, name, category, description, body, enabled, use_count, last_used_at, created_at, updated_at, tags, status, approved_by, approved_at, note)
		VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name, category = excluded.category, description = excluded.description,
			body = excluded.body, enabled = excluded.enabled, updated_at = excluded.updated_at,
			tags = excluded.tags, note = excluded.note`),
		t.ID, t.Name, t.Category, t.Description, t.Body, enabled,
		t.CreatedAt, now, tagsRaw, t.Status, t.ApprovedBy, t.ApprovedAt, t.Note)
	return err
}

// ApprovePromptTemplate changes the status of a template (pending→approved→standard or →draft).
func (s *SQLStore) ApprovePromptTemplate(ctx context.Context, id, status, by, note string) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE prompt_templates
		SET status=?, approved_by=?, approved_at=?, note=CASE WHEN ?!='' THEN ? ELSE note END, updated_at=?
		WHERE id=?`), status, by, now, note, note, now, id)
	return err
}

// DeletePromptTemplate removes a template.
func (s *SQLStore) DeletePromptTemplate(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`DELETE FROM prompt_templates WHERE id = ?`), id)
	return err
}

// TouchPromptTemplate bumps use_count/last_used_at. Best-effort.
func (s *SQLStore) TouchPromptTemplate(ctx context.Context, id string) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE prompt_templates SET use_count = use_count + 1, last_used_at = ? WHERE id = ?`), now, id)
	return err
}

// PromptTemplateHistory is one entry in a template's unified change log. Edit/create/
// rollback rows carry a full snapshot (HasSnapshot=true, monotonic VersionNum); status
// events (submit/approve/promote/reject) reuse the current VersionNum with no snapshot.
type PromptTemplateHistory struct {
	ID          string   `json:"id"`
	TemplateID  string   `json:"template_id"`
	Action      string   `json:"action"`
	VersionNum  int64    `json:"version_num"`
	Name        string   `json:"name,omitempty"`
	Category    string   `json:"category,omitempty"`
	Description string   `json:"description,omitempty"`
	Body        string   `json:"body,omitempty"`
	Tags        []string `json:"tags,omitempty"`
	FromStatus  string   `json:"from_status,omitempty"`
	ToStatus    string   `json:"to_status,omitempty"`
	Note        string   `json:"note,omitempty"`
	Actor       string   `json:"actor,omitempty"`
	HasSnapshot bool     `json:"has_snapshot"`
	CreatedAt   string   `json:"created_at"`
}

// maxPromptVersion returns the highest version_num recorded for a template (0 if none).
func (s *SQLStore) maxPromptVersion(ctx context.Context, templateID string) (int64, error) {
	var max sql.NullInt64
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT MAX(version_num) FROM prompt_template_history WHERE template_id = ?`), templateID).Scan(&max)
	if err != nil {
		return 0, err
	}
	if max.Valid {
		return max.Int64, nil
	}
	return 0, nil
}

// AddPromptTemplateHistory appends a change-log entry. When h.HasSnapshot is true the
// version_num is auto-incremented; otherwise it reuses the template's current version.
// The caller supplies h.ID (a slug/uuid). Returns the assigned version number.
func (s *SQLStore) AddPromptTemplateHistory(ctx context.Context, h PromptTemplateHistory) (int64, error) {
	cur, err := s.maxPromptVersion(ctx, h.TemplateID)
	if err != nil {
		return 0, err
	}
	if h.HasSnapshot {
		h.VersionNum = cur + 1
	} else {
		h.VersionNum = cur
	}
	snap := 0
	if h.HasSnapshot {
		snap = 1
	}
	if strings.TrimSpace(h.CreatedAt) == "" {
		h.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	_, err = s.db.ExecContext(ctx, s.bind(`INSERT INTO prompt_template_history
		(id, template_id, action, version_num, name, category, description, body, tags, from_status, to_status, note, actor, has_snapshot, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		h.ID, h.TemplateID, h.Action, h.VersionNum, h.Name, h.Category, h.Description, h.Body, joinTags(h.Tags),
		h.FromStatus, h.ToStatus, h.Note, h.Actor, snap, h.CreatedAt)
	return h.VersionNum, err
}

// ListPromptTemplateHistory returns a template's change log, newest first.
func (s *SQLStore) ListPromptTemplateHistory(ctx context.Context, templateID string) ([]PromptTemplateHistory, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, template_id, action, version_num, name, category,
		description, body, tags, from_status, to_status, note, actor, has_snapshot, created_at
		FROM prompt_template_history WHERE template_id = ? ORDER BY created_at DESC, version_num DESC`), templateID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PromptTemplateHistory{}
	for rows.Next() {
		var h PromptTemplateHistory
		var tagsRaw string
		var snap int
		if err := rows.Scan(&h.ID, &h.TemplateID, &h.Action, &h.VersionNum, &h.Name, &h.Category,
			&h.Description, &h.Body, &tagsRaw, &h.FromStatus, &h.ToStatus, &h.Note, &h.Actor, &snap, &h.CreatedAt); err != nil {
			return nil, err
		}
		h.Tags = parseTags(tagsRaw)
		h.HasSnapshot = snap == 1
		out = append(out, h)
	}
	return out, rows.Err()
}

// GetPromptTemplateVersionSnapshot returns the snapshot rows for a specific version.
func (s *SQLStore) GetPromptTemplateVersionSnapshot(ctx context.Context, templateID string, versionNum int64) (PromptTemplateHistory, bool, error) {
	row := s.db.QueryRowContext(ctx, s.bind(`SELECT id, template_id, action, version_num, name, category,
		description, body, tags, from_status, to_status, note, actor, has_snapshot, created_at
		FROM prompt_template_history WHERE template_id = ? AND version_num = ? AND has_snapshot = 1
		ORDER BY created_at DESC LIMIT 1`), templateID, versionNum)
	var h PromptTemplateHistory
	var tagsRaw string
	var snap int
	err := row.Scan(&h.ID, &h.TemplateID, &h.Action, &h.VersionNum, &h.Name, &h.Category,
		&h.Description, &h.Body, &tagsRaw, &h.FromStatus, &h.ToStatus, &h.Note, &h.Actor, &snap, &h.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return PromptTemplateHistory{}, false, nil
	}
	if err != nil {
		return PromptTemplateHistory{}, false, err
	}
	h.Tags = parseTags(tagsRaw)
	h.HasSnapshot = snap == 1
	return h, true, nil
}

// PromptAssetUsageRow is one team/key usage bucket for an asset.
type PromptAssetUsageRow struct {
	Team    string  `json:"team"`
	Calls   int64   `json:"calls"`
	Errors  int64   `json:"errors"`
	CostKRW float64 `json:"cost_krw"`
}

// PromptAssetUsage returns per-team usage of an asset over the last 90 days, matching
// request_logs.prompt_name against any of the supplied keys (asset id and/or name).
func (s *SQLStore) PromptAssetUsage(ctx context.Context, keys []string) ([]PromptAssetUsageRow, error) {
	clean := make([]string, 0, len(keys))
	for _, k := range keys {
		if strings.TrimSpace(k) != "" {
			clean = append(clean, k)
		}
	}
	if len(clean) == 0 {
		return []PromptAssetUsageRow{}, nil
	}
	placeholders := make([]string, len(clean))
	args := make([]any, 0, len(clean)+1)
	since90 := time.Now().UTC().Add(-90 * 24 * time.Hour).Format(time.RFC3339)
	args = append(args, since90)
	for i, k := range clean {
		placeholders[i] = "?"
		args = append(args, k)
	}
	teamExpr := `COALESCE(NULLIF((SELECT k.team FROM api_keys k WHERE k.id = r.api_key_id), ''), 'unassigned')`
	query := s.bind(`SELECT ` + teamExpr + ` AS team,
		COUNT(*) AS calls,
		SUM(CASE WHEN r.status_code >= 400 THEN 1 ELSE 0 END) AS errors,
		COALESCE(SUM(r.cost_krw), 0) AS cost_krw
		FROM request_logs r
		WHERE r.created_at >= ? AND r.prompt_name IN (` + strings.Join(placeholders, ",") + `)
		GROUP BY team ORDER BY calls DESC`)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PromptAssetUsageRow{}
	for rows.Next() {
		var u PromptAssetUsageRow
		if err := rows.Scan(&u.Team, &u.Calls, &u.Errors, &u.CostKRW); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// PromptAssetStats returns summary counts by status for the asset library overview.
func (s *SQLStore) PromptAssetStats(ctx context.Context) (map[string]int64, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT COALESCE(status,'draft'), COUNT(*) FROM prompt_templates GROUP BY COALESCE(status,'draft')`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int64{"draft": 0, "pending": 0, "approved": 0, "standard": 0}
	for rows.Next() {
		var st string
		var cnt int64
		if err := rows.Scan(&st, &cnt); err == nil {
			out[st] = cnt
		}
	}
	return out, rows.Err()
}
