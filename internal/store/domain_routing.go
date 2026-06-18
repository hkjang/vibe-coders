package store

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

func (s *SQLStore) InsertDomainRoutingDecision(ctx context.Context, d DomainRoutingDecision, signals []DomainRoutingSignal) error {
	if d.CreatedAt == "" {
		d.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	tools, _ := json.Marshal(d.ToolNames)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, s.bind(`INSERT INTO domain_routing_decisions
		(id, request_id, user_id, team_id, query_hash, route, confidence, tool_names_json, evidence_score, evidence_count, fallback_used, blocked_by_governance, reason, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		d.ID, d.RequestID, d.UserID, d.TeamID, d.QueryHash, d.Route, d.Confidence, string(tools), d.EvidenceScore, d.EvidenceCount,
		boolInt(d.FallbackUsed), boolInt(d.BlockedByGovernance), d.Reason, d.CreatedAt); err != nil {
		return err
	}
	for _, sig := range signals {
		if sig.CreatedAt == "" {
			sig.CreatedAt = d.CreatedAt
		}
		if _, err := tx.ExecContext(ctx, s.bind(`INSERT INTO domain_routing_signals
			(id, decision_id, source, route, score, reason, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`),
			sig.ID, d.ID, sig.Source, sig.Route, sig.Score, sig.Reason, sig.CreatedAt); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *SQLStore) ListDomainRoutingDecisions(ctx context.Context, f DomainRoutingFilter) ([]DomainRoutingDecision, error) {
	limit := f.Limit
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	where := []string{"1=1"}
	args := []any{}
	if f.Route != "" {
		where = append(where, "route = ?")
		args = append(args, f.Route)
	}
	if f.RequestID != "" {
		where = append(where, "request_id = ?")
		args = append(args, f.RequestID)
	}
	if !f.Since.IsZero() {
		where = append(where, "created_at >= ?")
		args = append(args, f.Since.UTC().Format(time.RFC3339Nano))
	}
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, request_id, COALESCE(user_id, ''), COALESCE(team_id, ''), query_hash, route,
			confidence, COALESCE(tool_names_json, '[]'), evidence_score, evidence_count, fallback_used, blocked_by_governance, COALESCE(reason, ''), created_at
		FROM domain_routing_decisions WHERE `+strings.Join(where, " AND ")+` ORDER BY created_at DESC LIMIT ?`), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DomainRoutingDecision{}
	for rows.Next() {
		var d DomainRoutingDecision
		var tools string
		var fallback, blocked int
		if err := rows.Scan(&d.ID, &d.RequestID, &d.UserID, &d.TeamID, &d.QueryHash, &d.Route, &d.Confidence, &tools,
			&d.EvidenceScore, &d.EvidenceCount, &fallback, &blocked, &d.Reason, &d.CreatedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(tools), &d.ToolNames)
		if d.ToolNames == nil {
			d.ToolNames = []string{}
		}
		d.FallbackUsed = fallback == 1
		d.BlockedByGovernance = blocked == 1
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *SQLStore) DomainRoutingSignals(ctx context.Context, decisionID string) ([]DomainRoutingSignal, error) {
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, decision_id, source, route, score, COALESCE(reason, ''), created_at
		FROM domain_routing_signals WHERE decision_id = ? ORDER BY created_at ASC, source ASC`), decisionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DomainRoutingSignal{}
	for rows.Next() {
		var sig DomainRoutingSignal
		if err := rows.Scan(&sig.ID, &sig.DecisionID, &sig.Source, &sig.Route, &sig.Score, &sig.Reason, &sig.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, sig)
	}
	return out, rows.Err()
}

func (s *SQLStore) UpsertDomainExample(ctx context.Context, e DomainExample) error {
	if e.CreatedAt == "" {
		e.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO domain_examples
		(id, route, text, text_hash, source, confidence, approved, auto_promoted, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(route, text_hash) DO UPDATE SET
			confidence = CASE WHEN excluded.confidence > confidence THEN excluded.confidence ELSE confidence END,
			approved = CASE WHEN excluded.approved = 1 THEN 1 ELSE approved END,
			auto_promoted = CASE WHEN excluded.auto_promoted = 1 THEN 1 ELSE auto_promoted END`),
		e.ID, e.Route, e.Text, e.TextHash, e.Source, e.Confidence, boolInt(e.Approved), boolInt(e.AutoPromoted), e.CreatedAt)
	return err
}

func (s *SQLStore) ListDomainExamples(ctx context.Context, route string, limit int) ([]DomainExample, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	where := "1=1"
	args := []any{}
	if route != "" {
		where = "route = ?"
		args = append(args, route)
	}
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, route, text, text_hash, source, confidence, approved, auto_promoted, created_at
		FROM domain_examples WHERE `+where+` ORDER BY created_at DESC LIMIT ?`), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DomainExample{}
	for rows.Next() {
		var e DomainExample
		var approved, auto int
		if err := rows.Scan(&e.ID, &e.Route, &e.Text, &e.TextHash, &e.Source, &e.Confidence, &approved, &auto, &e.CreatedAt); err != nil {
			return nil, err
		}
		e.Approved = approved == 1
		e.AutoPromoted = auto == 1
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *SQLStore) EnqueueDomainReview(ctx context.Context, item DomainReviewQueueItem) error {
	if item.CreatedAt == "" {
		item.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	if item.Status == "" {
		item.Status = "pending"
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO domain_review_queue
		(id, decision_id, query_text, suggested_route, current_route, reason, status, created_at, reviewed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		item.ID, item.DecisionID, item.QueryText, item.SuggestedRoute, item.CurrentRoute, item.Reason, item.Status, item.CreatedAt, item.ReviewedAt)
	return err
}

func (s *SQLStore) ListDomainReviewQueue(ctx context.Context, f DomainRoutingFilter) ([]DomainReviewQueueItem, error) {
	limit := f.Limit
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	where := []string{"1=1"}
	args := []any{}
	if f.Status != "" {
		where = append(where, "status = ?")
		args = append(args, f.Status)
	}
	if !f.Since.IsZero() {
		where = append(where, "created_at >= ?")
		args = append(args, f.Since.UTC().Format(time.RFC3339Nano))
	}
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, decision_id, query_text, suggested_route, COALESCE(current_route, ''), COALESCE(reason, ''), status, created_at, COALESCE(reviewed_at, '')
		FROM domain_review_queue WHERE `+strings.Join(where, " AND ")+` ORDER BY created_at DESC LIMIT ?`), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DomainReviewQueueItem{}
	for rows.Next() {
		var item DomainReviewQueueItem
		if err := rows.Scan(&item.ID, &item.DecisionID, &item.QueryText, &item.SuggestedRoute, &item.CurrentRoute, &item.Reason, &item.Status, &item.CreatedAt, &item.ReviewedAt); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *SQLStore) SetDomainReviewStatus(ctx context.Context, id, status string) error {
	_, err := s.db.ExecContext(ctx, s.bind(`UPDATE domain_review_queue SET status = ?, reviewed_at = ? WHERE id = ?`),
		status, time.Now().UTC().Format(time.RFC3339Nano), id)
	return err
}
