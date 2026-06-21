package store

import (
	"context"
	"time"
)

// SkillAccessRequest is a user's request to use a skill their team isn't yet allowed.
type SkillAccessRequest struct {
	ID        string `json:"id"`
	SkillName string `json:"skill_name"`
	UserID    string `json:"user_id"`
	Team      string `json:"team"`
	Status    string `json:"status"` // pending | approved | denied
	Reason    string `json:"reason"`
	DecidedBy string `json:"decided_by"`
	CreatedAt string `json:"created_at"`
}

// SkillFeedback is a user's rating/comment on a skill.
type SkillFeedback struct {
	ID        string `json:"id"`
	SkillName string `json:"skill_name"`
	UserID    string `json:"user_id"`
	Rating    int    `json:"rating"` // 1..5
	Comment   string `json:"comment"`
	CreatedAt string `json:"created_at"`
}

func (s *SQLStore) AddSkillAccessRequest(ctx context.Context, rq SkillAccessRequest) error {
	if rq.Status == "" {
		rq.Status = "pending"
	}
	rq.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO skill_access_requests
		(id, skill_name, user_id, team, status, reason, decided_by, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
		rq.ID, rq.SkillName, rq.UserID, rq.Team, rq.Status, rq.Reason, rq.DecidedBy, rq.CreatedAt)
	return err
}

// ListSkillAccessRequests returns access requests, optionally filtered by skill, newest first.
func (s *SQLStore) ListSkillAccessRequests(ctx context.Context, skillName string) ([]SkillAccessRequest, error) {
	q := `SELECT id, skill_name, user_id, team, status, reason, decided_by, created_at FROM skill_access_requests`
	args := []any{}
	if skillName != "" {
		q += " WHERE skill_name = ?"
		args = append(args, skillName)
	}
	q += " ORDER BY created_at DESC LIMIT 200"
	rows, err := s.db.QueryContext(ctx, s.bind(q), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SkillAccessRequest{}
	for rows.Next() {
		var rq SkillAccessRequest
		if err := rows.Scan(&rq.ID, &rq.SkillName, &rq.UserID, &rq.Team, &rq.Status, &rq.Reason, &rq.DecidedBy, &rq.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, rq)
	}
	return out, rows.Err()
}

func (s *SQLStore) AddSkillFeedback(ctx context.Context, fb SkillFeedback) error {
	fb.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO skill_feedback (id, skill_name, user_id, rating, comment, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`), fb.ID, fb.SkillName, fb.UserID, fb.Rating, fb.Comment, fb.CreatedAt)
	return err
}

// SkillFeedbackStat is the aggregated satisfaction for one skill.
type SkillFeedbackStat struct {
	SkillName string  `json:"skill_name"`
	Count     int     `json:"count"`
	AvgRating float64 `json:"avg_rating"`
}

// SkillFeedbackStats returns per-skill feedback aggregates (all skills).
func (s *SQLStore) SkillFeedbackStats(ctx context.Context) (map[string]SkillFeedbackStat, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT skill_name, COUNT(*), COALESCE(AVG(rating), 0) FROM skill_feedback GROUP BY skill_name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]SkillFeedbackStat{}
	for rows.Next() {
		var st SkillFeedbackStat
		if err := rows.Scan(&st.SkillName, &st.Count, &st.AvgRating); err != nil {
			return nil, err
		}
		out[st.SkillName] = st
	}
	return out, rows.Err()
}
