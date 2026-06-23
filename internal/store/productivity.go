package store

import (
	"context"
	"sort"
	"time"
)

// ProductivityRow correlates a repo's AI gateway usage with its delivery output (VCS commits /
// merge requests) over a window — the basis for "did AI spend translate into shipped work?".
type ProductivityRow struct {
	Repo          string  `json:"repo"`
	AIRequests    int64   `json:"ai_requests"`
	AITokens      int64   `json:"ai_tokens"`
	AICostKRW     float64 `json:"ai_cost_krw"`
	Commits       int64   `json:"commits"`
	MergeRequests int64   `json:"merge_requests"`
	Merged        int64   `json:"merged"`
}

// ProductivityByRepo joins AI usage (request_logs/token_usage, attributed via X-Vibe-Repo) with
// VCS activity (vcs_events) per repo since a cutoff. Repos with activity on either side appear.
func (s *SQLStore) ProductivityByRepo(ctx context.Context, since time.Time, limit int) ([]ProductivityRow, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	sinceStr := since.UTC().Format(time.RFC3339Nano)
	rows := map[string]*ProductivityRow{}
	get := func(repo string) *ProductivityRow {
		if rows[repo] == nil {
			rows[repo] = &ProductivityRow{Repo: repo}
		}
		return rows[repo]
	}

	aiRows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT r.repo, COUNT(r.id), COALESCE(SUM(t.total_tokens), 0), COALESCE(SUM(t.estimated_cost), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE COALESCE(r.repo, '') <> '' AND r.created_at >= ?
		GROUP BY r.repo`), sinceStr)
	if err != nil {
		return nil, err
	}
	for aiRows.Next() {
		var repo string
		var reqs, toks int64
		var cost float64
		if err := aiRows.Scan(&repo, &reqs, &toks, &cost); err != nil {
			aiRows.Close()
			return nil, err
		}
		row := get(repo)
		row.AIRequests, row.AITokens, row.AICostKRW = reqs, toks, cost
	}
	aiRows.Close()

	vcsRows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT repo,
			COALESCE(SUM(CASE WHEN kind = 'commit' THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN kind = 'merge_request' THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN state = 'merged' THEN 1 ELSE 0 END), 0)
		FROM vcs_events
		WHERE COALESCE(repo, '') <> '' AND created_at >= ?
		GROUP BY repo`), sinceStr)
	if err != nil {
		return nil, err
	}
	for vcsRows.Next() {
		var repo string
		var commits, mrs, merged int64
		if err := vcsRows.Scan(&repo, &commits, &mrs, &merged); err != nil {
			vcsRows.Close()
			return nil, err
		}
		row := get(repo)
		row.Commits, row.MergeRequests, row.Merged = commits, mrs, merged
	}
	vcsRows.Close()

	out := make([]ProductivityRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, *r)
	}
	// Rank by AI activity (the gateway's vantage point).
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].AIRequests != out[j].AIRequests {
			return out[i].AIRequests > out[j].AIRequests
		}
		return out[i].Repo < out[j].Repo
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}
