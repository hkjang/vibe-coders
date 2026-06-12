package store

import (
	"context"
	"sort"
	"strings"
	"time"
)

// UserProductivityRow is one developer's observed AI activity plus a heuristic
// 0-100 productivity score (documented weights; NOT a model-derived metric).
type UserProductivityRow struct {
	APIKeyID    string  `json:"api_key_id"`
	Name        string  `json:"name"`
	Team        string  `json:"team"`
	Requests    int64   `json:"requests"`
	Sessions    int64   `json:"sessions"`
	ActiveDays  int64   `json:"active_days"`
	Commits     int64   `json:"commits"`
	MergedMRs   int64   `json:"merged_mrs"`
	ToolCalls   int64   `json:"tool_calls"`
	SuccessRate float64 `json:"success_rate"`
	CostKRW     float64 `json:"cost_krw"`
	Score       int     `json:"score"`
}

// TeamBenchmarkRow compares teams on cost and observed productivity.
type TeamBenchmarkRow struct {
	Team        string  `json:"team"`
	ActiveUsers int64   `json:"active_users"`
	Requests    int64   `json:"requests"`
	Tokens      int64   `json:"tokens"`
	CostKRW     float64 `json:"cost_krw"`
	SuccessRate float64 `json:"success_rate"`
	Commits     int64   `json:"commits"`
	MergedMRs   int64   `json:"merged_mrs"`
	Score       int     `json:"score"` // request-weighted average of member scores
}

// productivity score caps: value at which each component saturates (per window).
const (
	prodCapRequests   = 300.0
	prodCapActiveDays = 20.0
	prodCapCommits    = 30.0
	prodCapMergedMRs  = 10.0
)

func prodNorm(x float64, cap float64) float64 {
	if cap <= 0 || x <= 0 {
		return 0
	}
	if x >= cap {
		return 1
	}
	return x / cap
}

// productivityScore is the documented heuristic:
// 30% activity (requests) + 20% consistency (active days) + 20% commits +
// 15% merged MRs + 15% success rate.
func productivityScore(r UserProductivityRow) int {
	s := 100 * (0.30*prodNorm(float64(r.Requests), prodCapRequests) +
		0.20*prodNorm(float64(r.ActiveDays), prodCapActiveDays) +
		0.20*prodNorm(float64(r.Commits), prodCapCommits) +
		0.15*prodNorm(float64(r.MergedMRs), prodCapMergedMRs) +
		0.15*r.SuccessRate)
	return int(s + 0.5)
}

// UserProductivity aggregates per-key activity since `since` and scores it.
func (s *SQLStore) UserProductivity(ctx context.Context, since time.Time, limit int) ([]UserProductivityRow, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	sinceStr := since.UTC().Format(time.RFC3339Nano)
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT COALESCE(NULLIF(r.api_key_id, ''), 'anonymous') AS akid,
			COALESCE(NULLIF((SELECT k.name FROM api_keys k WHERE k.id = r.api_key_id), ''), COALESCE(NULLIF(r.api_key_id, ''), 'anonymous')) AS name,
			`+requestTeamExpr+` AS team,
			COUNT(*) AS requests,
			COUNT(DISTINCT COALESCE(NULLIF(r.session_id, ''), r.id)) AS sessions,
			COUNT(DISTINCT substr(r.created_at, 1, 10)) AS active_days,
			SUM(CASE WHEN r.status_code >= 200 AND r.status_code < 300 AND COALESCE(r.error, '') = '' THEN 1 ELSE 0 END) AS successes,
			COALESCE(SUM(t.estimated_cost), 0) AS cost,
			(SELECT COUNT(*) FROM tool_invocations ti WHERE ti.api_key_id = r.api_key_id AND ti.source = 'call' AND ti.created_at >= ?) AS tool_calls
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE r.created_at >= ? AND r.endpoint LIKE '%chat/completions%'
		GROUP BY akid
		ORDER BY requests DESC
		LIMIT ?`), sinceStr, sinceStr, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []UserProductivityRow{}
	for rows.Next() {
		var r UserProductivityRow
		var successes int64
		if err := rows.Scan(&r.APIKeyID, &r.Name, &r.Team, &r.Requests, &r.Sessions, &r.ActiveDays, &successes, &r.CostKRW, &r.ToolCalls); err != nil {
			return nil, err
		}
		if r.Requests > 0 {
			r.SuccessRate = float64(successes) / float64(r.Requests)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// VCS delivery: commits + merged MRs per api key (separate cheap query)
	vcsRows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT COALESCE(NULLIF(api_key_id, ''), ''),
			SUM(CASE WHEN kind IN ('commit', 'push') THEN 1 ELSE 0 END),
			SUM(CASE WHEN kind = 'merge_request' AND state = 'merged' THEN 1 ELSE 0 END)
		FROM vcs_events WHERE created_at >= ? GROUP BY api_key_id`), sinceStr)
	if err != nil {
		return nil, err
	}
	defer vcsRows.Close()
	commitsBy := map[string][2]int64{}
	for vcsRows.Next() {
		var akid string
		var commits, merged int64
		if err := vcsRows.Scan(&akid, &commits, &merged); err != nil {
			return nil, err
		}
		commitsBy[akid] = [2]int64{commits, merged}
	}
	if err := vcsRows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		if v, ok := commitsBy[out[i].APIKeyID]; ok {
			out[i].Commits, out[i].MergedMRs = v[0], v[1]
		}
		out[i].Score = productivityScore(out[i])
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	return out, nil
}

// TeamBenchmark rolls user productivity + usage up to teams.
func (s *SQLStore) TeamBenchmark(ctx context.Context, since time.Time) ([]TeamBenchmarkRow, error) {
	users, err := s.UserProductivity(ctx, since, 500)
	if err != nil {
		return nil, err
	}
	type acc struct {
		row         TeamBenchmarkRow
		scoreWeight float64
		scoreSum    float64
		successSum  float64
	}
	byTeam := map[string]*acc{}
	order := []string{}
	for _, u := range users {
		team := u.Team
		if strings.TrimSpace(team) == "" {
			team = "unassigned"
		}
		a := byTeam[team]
		if a == nil {
			a = &acc{row: TeamBenchmarkRow{Team: team}}
			byTeam[team] = a
			order = append(order, team)
		}
		a.row.ActiveUsers++
		a.row.Requests += u.Requests
		a.row.CostKRW += u.CostKRW
		a.row.Commits += u.Commits
		a.row.MergedMRs += u.MergedMRs
		a.scoreSum += float64(u.Score) * float64(u.Requests)
		a.scoreWeight += float64(u.Requests)
		a.successSum += u.SuccessRate * float64(u.Requests)
	}
	// tokens per team (one aggregate query; user rows don't carry tokens)
	tokRows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT `+requestTeamExpr+` AS team, COALESCE(SUM(t.total_tokens), 0)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE r.created_at >= ? AND r.endpoint LIKE '%chat/completions%'
		GROUP BY team`), since.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	defer tokRows.Close()
	for tokRows.Next() {
		var team string
		var tokens int64
		if err := tokRows.Scan(&team, &tokens); err != nil {
			return nil, err
		}
		if a, ok := byTeam[team]; ok {
			a.row.Tokens = tokens
		}
	}
	if err := tokRows.Err(); err != nil {
		return nil, err
	}
	out := make([]TeamBenchmarkRow, 0, len(order))
	for _, team := range order {
		a := byTeam[team]
		if a.scoreWeight > 0 {
			a.row.Score = int(a.scoreSum/a.scoreWeight + 0.5)
			a.row.SuccessRate = a.successSum / a.scoreWeight
		}
		out = append(out, a.row)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].CostKRW > out[j].CostKRW })
	return out, nil
}

// Incident is a clustered provider disruption inferred from failover/5xx spikes.
type Incident struct {
	Provider      string `json:"provider"`
	StartedAt     string `json:"started_at"`
	EndedAt       string `json:"ended_at"`
	Failovers     int64  `json:"failovers"`
	Errors5xx     int64  `json:"errors_5xx"`
	AffectedUsers int64  `json:"affected_users"`
	Requests      int64  `json:"requests"`
	Ongoing       bool   `json:"ongoing"` // last bucket touches the most recent hour
}

// Incidents clusters hourly failover/5xx spikes per provider since `since`.
// A bucket qualifies when failovers >= minEvents or 5xx >= minEvents; adjacent
// qualifying hours for the same provider merge into one incident.
func (s *SQLStore) Incidents(ctx context.Context, since time.Time, minEvents int64) ([]Incident, error) {
	if minEvents <= 0 {
		minEvents = 5
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT COALESCE(NULLIF(r.fallback_from, ''), COALESCE(NULLIF(r.provider, ''), '(unknown)')) AS prov,
			substr(r.created_at, 1, 13) AS bucket,
			SUM(COALESCE(r.failover, 0)) AS failovers,
			SUM(CASE WHEN r.status_code >= 500 THEN 1 ELSE 0 END) AS errors5xx,
			COUNT(*) AS requests
		FROM request_logs r
		WHERE r.created_at >= ?
		GROUP BY prov, bucket
		HAVING SUM(COALESCE(r.failover, 0)) >= ? OR SUM(CASE WHEN r.status_code >= 500 THEN 1 ELSE 0 END) >= ?
		ORDER BY prov, bucket`), since.UTC().Format(time.RFC3339Nano), minEvents, minEvents)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type bucketRow struct {
		prov, bucket                  string
		failovers, errors5x, requests int64
	}
	var buckets []bucketRow
	for rows.Next() {
		var b bucketRow
		if err := rows.Scan(&b.prov, &b.bucket, &b.failovers, &b.errors5x, &b.requests); err != nil {
			return nil, err
		}
		buckets = append(buckets, b)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	nowBucket := time.Now().UTC().Format("2006-01-02T15")
	incidents := []Incident{}
	var cur *Incident
	var lastBucket string
	flush := func() {
		if cur != nil {
			incidents = append(incidents, *cur)
			cur = nil
		}
	}
	for _, b := range buckets {
		consecutive := cur != nil && cur.Provider == b.prov && isNextHour(lastBucket, b.bucket)
		if !consecutive {
			flush()
			cur = &Incident{Provider: b.prov, StartedAt: b.bucket + ":00:00Z"}
		}
		cur.EndedAt = b.bucket + ":59:59Z"
		cur.Failovers += b.failovers
		cur.Errors5xx += b.errors5x
		cur.Requests += b.requests
		cur.Ongoing = b.bucket == nowBucket
		lastBucket = b.bucket
	}
	flush()

	// exact affected-user counts per incident (few incidents → cheap)
	for i := range incidents {
		var affected int64
		err := s.db.QueryRowContext(ctx, s.bind(`
			SELECT COUNT(DISTINCT COALESCE(NULLIF(api_key_id, ''), 'anonymous'))
			FROM request_logs
			WHERE created_at >= ? AND created_at <= ?
				AND (COALESCE(NULLIF(fallback_from, ''), COALESCE(NULLIF(provider, ''), '(unknown)')) = ?)
				AND (COALESCE(failover, 0) = 1 OR status_code >= 500)`),
			incidents[i].StartedAt, incidents[i].EndedAt, incidents[i].Provider).Scan(&affected)
		if err == nil {
			incidents[i].AffectedUsers = affected
		}
	}
	sort.SliceStable(incidents, func(i, j int) bool { return incidents[i].StartedAt > incidents[j].StartedAt })
	return incidents, nil
}

// isNextHour reports whether b is exactly one hour after a ("YYYY-MM-DDTHH").
func isNextHour(a, b string) bool {
	ta, errA := time.Parse("2006-01-02T15", a)
	tb, errB := time.Parse("2006-01-02T15", b)
	return errA == nil && errB == nil && tb.Sub(ta) == time.Hour
}
