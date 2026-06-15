package store

import (
	"context"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Text2SQLReportCandidate is a recurring natural-language question worth promoting to
// a saved dashboard or scheduled report (it is asked often enough to be standardized).
type Text2SQLReportCandidate struct {
	Question  string `json:"question"`
	Count     int64  `json:"count"`
	LastSeen  string `json:"last_seen"`
	SampleSQL string `json:"sample_sql"`
	// RecommendedProduct classifies the best data-product shape for this recurring
	// question from its SQL: "dashboard" (aggregation), "data_mart" (multi-table join),
	// or "api" (point/list lookup).
	RecommendedProduct string `json:"recommended_product"`
}

// recommendDataProduct infers a data-product type from a SQL query's shape.
func recommendDataProduct(sql string) string {
	lower := strings.ToLower(sql)
	hasAgg := strings.Contains(lower, "group by") ||
		strings.Contains(lower, "count(") || strings.Contains(lower, "sum(") ||
		strings.Contains(lower, "avg(") || strings.Contains(lower, "min(") || strings.Contains(lower, "max(")
	joins := strings.Count(lower, " join ")
	switch {
	case hasAgg:
		return "dashboard"
	case joins >= 2:
		return "data_mart"
	default:
		return "api"
	}
}

// Text2SQLGlossaryCandidate is a token that appears often in questions but is not yet a
// defined business-glossary term — a candidate the operator may want to map.
type Text2SQLGlossaryCandidate struct {
	Term  string `json:"term"`
	Count int64  `json:"count"`
}

var minerWordRe = regexp.MustCompile(`[\p{L}\p{N}]{2,}`)

// minerStopwords are high-frequency, low-signal tokens excluded from glossary mining.
var minerStopwords = map[string]bool{
	// Korean
	"알려줘": true, "보여줘": true, "조회": true, "얼마": true, "개수": true, "건수": true,
	"목록": true, "리스트": true, "현황": true, "정보": true, "데이터": true, "기준": true,
	"각각": true, "전체": true, "별로": true, "관련": true, "대해": true, "에서": true,
	// English
	"the": true, "and": true, "for": true, "with": true, "show": true, "list": true,
	"how": true, "many": true, "what": true, "count": true, "all": true, "from": true,
	"give": true, "tell": true, "per": true,
}

// fetchMiningRows returns recent non-shadow questions (and a sample SQL) for mining.
func (s *SQLStore) fetchMiningRows(ctx context.Context, since time.Time, limit int) ([]struct {
	Question, SQL, CreatedAt string
	Valid                    bool
}, error) {
	if limit <= 0 || limit > 20000 {
		limit = 5000
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT COALESCE(question,''), COALESCE(generated_sql,''), valid, created_at
		FROM text2sql_query_logs WHERE created_at >= ? AND COALESCE(mode,'') <> 'shadow' AND COALESCE(question,'') <> ''
		ORDER BY created_at DESC LIMIT ?`), since.UTC().Format(time.RFC3339Nano), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []struct {
		Question, SQL, CreatedAt string
		Valid                    bool
	}
	for rows.Next() {
		var q, sql, createdAt string
		var valid int
		if err := rows.Scan(&q, &sql, &valid, &createdAt); err != nil {
			return nil, err
		}
		out = append(out, struct {
			Question, SQL, CreatedAt string
			Valid                    bool
		}{q, sql, createdAt, valid == 1})
	}
	return out, rows.Err()
}

func normalizeQuestion(q string) string {
	return strings.ToLower(strings.Join(strings.Fields(q), " "))
}

// Text2SQLReportCandidates groups recurring questions (normalized) seen since `since`
// and returns those asked at least minCount times — candidates for a saved report.
func (s *SQLStore) Text2SQLReportCandidates(ctx context.Context, since time.Time, minCount, limit int) ([]Text2SQLReportCandidate, error) {
	rows, err := s.fetchMiningRows(ctx, since, 20000)
	if err != nil {
		return nil, err
	}
	if minCount < 2 {
		minCount = 2
	}
	type agg struct {
		display   string
		count     int64
		lastSeen  string
		sampleSQL string
	}
	byNorm := map[string]*agg{}
	for _, r := range rows {
		if !r.Valid {
			continue
		}
		key := normalizeQuestion(r.Question)
		if key == "" {
			continue
		}
		a := byNorm[key]
		if a == nil {
			a = &agg{display: strings.TrimSpace(r.Question), lastSeen: r.CreatedAt, sampleSQL: r.SQL}
			byNorm[key] = a
		}
		a.count++
		if r.CreatedAt > a.lastSeen {
			a.lastSeen = r.CreatedAt
		}
	}
	out := []Text2SQLReportCandidate{}
	for _, a := range byNorm {
		if a.count >= int64(minCount) {
			out = append(out, Text2SQLReportCandidate{
				Question: a.display, Count: a.count, LastSeen: a.lastSeen, SampleSQL: a.sampleSQL,
				RecommendedProduct: recommendDataProduct(a.sampleSQL),
			})
		}
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

// Text2SQLGlossaryCandidates extracts frequent question tokens (excluding stopwords and
// already-defined glossary terms) seen since `since`, as candidate business terms.
// Counting is per-question-distinct so one chatty question can't inflate a token.
func (s *SQLStore) Text2SQLGlossaryCandidates(ctx context.Context, since time.Time, minCount, limit int) ([]Text2SQLGlossaryCandidate, error) {
	rows, err := s.fetchMiningRows(ctx, since, 20000)
	if err != nil {
		return nil, err
	}
	if minCount < 2 {
		minCount = 2
	}
	// Exclude terms already in the glossary (any scope).
	known := map[string]bool{}
	if terms, err := s.ListText2SQLBusinessTerms(ctx, ""); err == nil {
		for _, t := range terms {
			known[strings.ToLower(strings.TrimSpace(t.Term))] = true
		}
	}
	counts := map[string]int64{}
	for _, r := range rows {
		seen := map[string]bool{}
		for _, tok := range minerWordRe.FindAllString(strings.ToLower(r.Question), -1) {
			if seen[tok] || minerStopwords[tok] || known[tok] {
				continue
			}
			seen[tok] = true
			counts[tok]++
		}
	}
	out := []Text2SQLGlossaryCandidate{}
	for term, n := range counts {
		if n >= int64(minCount) {
			out = append(out, Text2SQLGlossaryCandidate{Term: term, Count: n})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Term < out[j].Term
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}
