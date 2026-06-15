package store

import (
	"context"
	"sort"
	"strings"
	"time"
)

// anomalyRow is the minimal projection of a Text2SQL log used by the detectors.
type anomalyRow struct {
	APIKeyID, Team, Question, RejectReason, FailureCategory, CreatedAt string
	Valid                                                              bool
	ExplainRisk                                                        int
}

func (s *SQLStore) fetchAnomalyRows(ctx context.Context, since time.Time, limit int) ([]anomalyRow, error) {
	if limit <= 0 || limit > 20000 {
		limit = 10000
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT COALESCE(api_key_id,''), COALESCE(team,''), COALESCE(question,''),
		COALESCE(reject_reason,''), COALESCE(failure_category,''), valid, explain_risk, created_at
		FROM text2sql_query_logs WHERE created_at >= ? AND COALESCE(mode,'') <> 'shadow'
		ORDER BY created_at ASC LIMIT ?`), since.UTC().Format(time.RFC3339Nano), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []anomalyRow{}
	for rows.Next() {
		var a anomalyRow
		var valid int
		if err := rows.Scan(&a.APIKeyID, &a.Team, &a.Question, &a.RejectReason, &a.FailureCategory, &valid, &a.ExplainRisk, &a.CreatedAt); err != nil {
			return nil, err
		}
		a.Valid = valid == 1
		out = append(out, a)
	}
	return out, rows.Err()
}

// Text2SQLUsageSmell flags an anomalous usage pattern for a subject (detection only —
// no request is ever blocked by this).
type Text2SQLUsageSmell struct {
	Subject  string `json:"subject"` // api_key_id
	Category string `json:"category"`
	Count    int64  `json:"count"`
	Sample   string `json:"sample"`
}

var broadScopePhrases = []string{
	"전체 스키마", "스키마 전체", "모든 테이블", "전체 테이블", "테이블 전부", "모든 컬럼", "전체 컬럼",
	"all tables", "every table", "whole schema", "entire schema", "all columns", "dump",
}

func isPermissionProbe(r anomalyRow) bool {
	if r.FailureCategory == "permission_denied" {
		return true
	}
	reason := strings.ToLower(r.RejectReason)
	return strings.Contains(reason, "not allowed") || strings.Contains(reason, "sensitive") || strings.Contains(reason, "권한")
}

func isBroadScope(question string) bool {
	q := strings.ToLower(question)
	for _, p := range broadScopePhrases {
		if strings.Contains(q, p) {
			return true
		}
	}
	return false
}

// Text2SQLUsageSmells detects, per API key, anomalous usage over a window: excessive
// repetition of the same question, repeated permission-denied probing, and requests
// for whole-schema scope. Returns patterns at/above the given thresholds.
func (s *SQLStore) Text2SQLUsageSmells(ctx context.Context, since time.Time, repeatMin, probeMin int) ([]Text2SQLUsageSmell, error) {
	rows, err := s.fetchAnomalyRows(ctx, since, 20000)
	if err != nil {
		return nil, err
	}
	if repeatMin < 2 {
		repeatMin = 8
	}
	if probeMin < 2 {
		probeMin = 5
	}
	repeat := map[string]int64{} // key: apikey\x00normquestion
	repeatSample := map[string]string{}
	probe := map[string]int64{}
	broad := map[string]int64{}
	broadSample := map[string]string{}
	for _, r := range rows {
		if r.APIKeyID == "" {
			continue
		}
		nq := normalizeQuestion(r.Question)
		rk := r.APIKeyID + "\x00" + nq
		repeat[rk]++
		if repeatSample[rk] == "" {
			repeatSample[rk] = strings.TrimSpace(r.Question)
		}
		if isPermissionProbe(r) {
			probe[r.APIKeyID]++
		}
		if isBroadScope(r.Question) {
			broad[r.APIKeyID]++
			if broadSample[r.APIKeyID] == "" {
				broadSample[r.APIKeyID] = strings.TrimSpace(r.Question)
			}
		}
	}
	out := []Text2SQLUsageSmell{}
	for rk, n := range repeat {
		if n >= int64(repeatMin) {
			subject := rk[:strings.IndexByte(rk, 0)]
			out = append(out, Text2SQLUsageSmell{Subject: subject, Category: "excessive_repetition", Count: n, Sample: repeatSample[rk]})
		}
	}
	for k, n := range probe {
		if n >= int64(probeMin) {
			out = append(out, Text2SQLUsageSmell{Subject: k, Category: "permission_probing", Count: n})
		}
	}
	for k, n := range broad {
		out = append(out, Text2SQLUsageSmell{Subject: k, Category: "broad_scope", Count: n, Sample: broadSample[k]})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Category < out[j].Category
	})
	return out, nil
}

// Text2SQLRiskExposure is a per-team accumulation of risk signals over a window — a
// report-only "cumulative risk budget" view (it never blocks a request).
type Text2SQLRiskExposure struct {
	Team      string `json:"team"`
	Total     int64  `json:"total"`
	Rejected  int64  `json:"rejected"`
	HighRisk  int64  `json:"high_risk"` // EXPLAIN risk >= 70
	Probes    int64  `json:"probes"`
	RiskScore int64  `json:"risk_score"` // weighted: rejected*1 + highRisk*2 + probes*3
}

// Text2SQLRiskExposureByTeam aggregates risk signals per team since `since`.
func (s *SQLStore) Text2SQLRiskExposureByTeam(ctx context.Context, since time.Time) ([]Text2SQLRiskExposure, error) {
	rows, err := s.fetchAnomalyRows(ctx, since, 20000)
	if err != nil {
		return nil, err
	}
	byTeam := map[string]*Text2SQLRiskExposure{}
	for _, r := range rows {
		team := r.Team
		if team == "" {
			team = "(none)"
		}
		e := byTeam[team]
		if e == nil {
			e = &Text2SQLRiskExposure{Team: team}
			byTeam[team] = e
		}
		e.Total++
		if !r.Valid {
			e.Rejected++
		}
		if r.ExplainRisk >= 70 {
			e.HighRisk++
		}
		if isPermissionProbe(r) {
			e.Probes++
		}
	}
	out := []Text2SQLRiskExposure{}
	for _, e := range byTeam {
		e.RiskScore = e.Rejected + e.HighRisk*2 + e.Probes*3
		out = append(out, *e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].RiskScore > out[j].RiskScore })
	return out, nil
}

// Text2SQLPromptDNA is the aggregate "fingerprint" of a recurring question: how often
// it is asked, by how many distinct users, its cost, and its risk/exec profile, with
// human-readable labels (repeated / high_cost / risky).
type Text2SQLPromptDNA struct {
	Question     string   `json:"question"`
	Count        int64    `json:"count"`
	DistinctUser int64    `json:"distinct_users"`
	AvgCostKRW   float64  `json:"avg_cost_krw"`
	RejectRate   float64  `json:"reject_rate"`
	ExecRate     float64  `json:"exec_rate"`
	Labels       []string `json:"labels"`
}

// Text2SQLPromptDNAReport profiles recurring questions over a window: frequency,
// distinct users, average cost, and reject/exec rates, labeling each.
func (s *SQLStore) Text2SQLPromptDNAReport(ctx context.Context, since time.Time, minCount, limit int) ([]Text2SQLPromptDNA, error) {
	if minCount < 2 {
		minCount = 2
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT COALESCE(question,''), COALESCE(api_key_id,''), valid, executed, cost_krw
		FROM text2sql_query_logs WHERE created_at >= ? AND COALESCE(mode,'') <> 'shadow' AND COALESCE(question,'') <> ''`),
		since.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type agg struct {
		display  string
		count    int64
		rejected int64
		executed int64
		cost     float64
		users    map[string]bool
	}
	byNorm := map[string]*agg{}
	for rows.Next() {
		var q, apiKey string
		var valid, executed int
		var cost float64
		if err := rows.Scan(&q, &apiKey, &valid, &executed, &cost); err != nil {
			return nil, err
		}
		key := normalizeQuestion(q)
		if key == "" {
			continue
		}
		a := byNorm[key]
		if a == nil {
			a = &agg{display: strings.TrimSpace(q), users: map[string]bool{}}
			byNorm[key] = a
		}
		a.count++
		if valid == 0 {
			a.rejected++
		}
		if executed == 1 {
			a.executed++
		}
		a.cost += cost
		if apiKey != "" {
			a.users[apiKey] = true
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// A "high cost" question is one whose average cost is in the top tier; compute the
	// overall average as a simple reference point.
	var totalCost float64
	var totalCount int64
	for _, a := range byNorm {
		totalCost += a.cost
		totalCount += a.count
	}
	avgAll := 0.0
	if totalCount > 0 {
		avgAll = totalCost / float64(totalCount)
	}
	out := []Text2SQLPromptDNA{}
	for _, a := range byNorm {
		if a.count < int64(minCount) {
			continue
		}
		avg := a.cost / float64(a.count)
		rejectRate := float64(a.rejected) / float64(a.count)
		dna := Text2SQLPromptDNA{
			Question: a.display, Count: a.count, DistinctUser: int64(len(a.users)),
			AvgCostKRW: avg, RejectRate: rejectRate, ExecRate: float64(a.executed) / float64(a.count),
		}
		dna.Labels = append(dna.Labels, "repeated")
		if avgAll > 0 && avg >= avgAll*2 {
			dna.Labels = append(dna.Labels, "high_cost")
		}
		if rejectRate >= 0.3 {
			dna.Labels = append(dna.Labels, "risky")
		}
		out = append(out, dna)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Question < out[j].Question
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// Text2SQLRiskyCountByAPIKey counts an API key's risky requests since `since` — rejected,
// high EXPLAIN risk (>=70), or classified failures — for cumulative-risk enforcement.
func (s *SQLStore) Text2SQLRiskyCountByAPIKey(ctx context.Context, apiKeyID string, since time.Time) (int64, error) {
	if apiKeyID == "" {
		return 0, nil
	}
	var n int64
	err := s.db.QueryRowContext(ctx, s.bind(`SELECT COUNT(*) FROM text2sql_query_logs
		WHERE api_key_id = ? AND created_at >= ? AND COALESCE(mode,'') <> 'shadow'
		AND (valid = 0 OR explain_risk >= 70 OR COALESCE(failure_category,'') <> '')`),
		apiKeyID, since.UTC().Format(time.RFC3339Nano)).Scan(&n)
	return n, err
}

// Text2SQLIntentDrift flags an API key whose questions escalate from benign lookups
// toward higher-risk scope within the window (detection only).
type Text2SQLIntentDrift struct {
	Subject    string `json:"subject"`
	FirstSeen  string `json:"first_seen"`
	DriftSeen  string `json:"drift_seen"`
	FromSample string `json:"from_sample"`
	ToSample   string `json:"to_sample"`
	Reason     string `json:"reason"`
}

// driftEscalation scores a question's risk posture: 0 benign, higher = riskier.
func driftPosture(r anomalyRow) (int, string) {
	if isBroadScope(r.Question) {
		return 3, "broad_scope"
	}
	if isPermissionProbe(r) {
		return 2, "permission_denied"
	}
	if r.ExplainRisk >= 70 {
		return 2, "high_explain_risk"
	}
	return 0, ""
}

// Text2SQLIntentDrifts detects, per API key, a transition from an initial benign
// question to a later higher-risk one in the same window — a possible intent shift.
func (s *SQLStore) Text2SQLIntentDrifts(ctx context.Context, since time.Time) ([]Text2SQLIntentDrift, error) {
	rows, err := s.fetchAnomalyRows(ctx, since, 20000) // ASC order (oldest first)
	if err != nil {
		return nil, err
	}
	type state struct {
		firstSeen, firstSample string
		benignSeen             bool
	}
	st := map[string]*state{}
	out := []Text2SQLIntentDrift{}
	flagged := map[string]bool{}
	for _, r := range rows {
		if r.APIKeyID == "" || flagged[r.APIKeyID] {
			continue
		}
		s := st[r.APIKeyID]
		if s == nil {
			s = &state{firstSeen: r.CreatedAt, firstSample: strings.TrimSpace(r.Question)}
			st[r.APIKeyID] = s
		}
		posture, reason := driftPosture(r)
		if posture == 0 {
			s.benignSeen = true
			if s.firstSample == "" {
				s.firstSample = strings.TrimSpace(r.Question)
			}
			continue
		}
		// Risky question after at least one benign one → drift.
		if s.benignSeen {
			out = append(out, Text2SQLIntentDrift{
				Subject: r.APIKeyID, FirstSeen: s.firstSeen, DriftSeen: r.CreatedAt,
				FromSample: s.firstSample, ToSample: strings.TrimSpace(r.Question), Reason: reason,
			})
			flagged[r.APIKeyID] = true
		}
	}
	return out, nil
}
