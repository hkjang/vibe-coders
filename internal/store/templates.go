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
	metricsQ := s.bind(`SELECT prompt_name,
		COUNT(*) as calls,
		AVG(CASE WHEN status_code < 400 THEN 1.0 ELSE 0.0 END) as success_rate,
		COALESCE(AVG(cost_krw), 0) as avg_cost_krw,
		COALESCE(AVG(latency_ms), 0) as avg_latency_ms
		FROM request_logs
		WHERE prompt_name != '' AND created_at >= ?
		GROUP BY prompt_name`)
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
		if m, ok := metrics[t.Name]; ok {
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
