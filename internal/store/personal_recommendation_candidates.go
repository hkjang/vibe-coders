package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"
	"time"
)

// UserText2SQLReportCandidate is a privacy-preserving recommendation signal for a
// repeated Text2SQL question. It exposes a fingerprint and aggregate metrics, not
// the raw question or generated SQL.
type UserText2SQLReportCandidate struct {
	Fingerprint        string  `json:"fingerprint"`
	SchemaName         string  `json:"schema_name"`
	Count              int64   `json:"count"`
	SuccessRate        float64 `json:"success_rate"`
	AvgCostKRW         float64 `json:"avg_cost_krw"`
	LastSeen           string  `json:"last_seen"`
	RecommendedProduct string  `json:"recommended_product"`
}

// UserMCPAffinity is a user's aggregate MCP tool usage signal.
type UserMCPAffinity struct {
	ServerLabel         string  `json:"server_label"`
	ToolName            string  `json:"tool_name"`
	Ref                 string  `json:"ref"`
	Calls               int64   `json:"calls"`
	Errors              int64   `json:"errors"`
	SuccessRate         float64 `json:"success_rate"`
	ErrorRate           float64 `json:"error_rate"`
	AvgRequestLatencyMS float64 `json:"avg_request_latency_ms"`
	LastUsedAt          string  `json:"last_used_at"`
}

func personalSignalFingerprint(prefix, value string) string {
	sum := sha256.Sum256([]byte(value))
	return prefix + "_" + hex.EncodeToString(sum[:])[:16]
}

// UserText2SQLReportCandidates finds repeated, mostly-successful Text2SQL questions
// for one user. Raw question and SQL text are used only in-memory to aggregate and
// infer the product shape; persisted recommendations should store only the fingerprint.
func (s *SQLStore) UserText2SQLReportCandidates(ctx context.Context, userID string, since time.Time, minCount, limit int) ([]UserText2SQLReportCandidate, error) {
	if minCount < 2 {
		minCount = 3
	}
	if limit <= 0 || limit > 20 {
		limit = 5
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT COALESCE(q.question, ''), COALESCE(q.generated_sql, ''), COALESCE(q.schema_name, ''),
			q.valid, COALESCE(q.cost_krw, 0), q.created_at
		FROM text2sql_query_logs q
		JOIN api_keys k ON k.id = q.api_key_id
		WHERE k.user_id = ? AND q.created_at >= ? AND COALESCE(q.mode, '') <> 'shadow' AND COALESCE(q.question, '') <> ''
		ORDER BY q.created_at DESC`), userID, since.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type agg struct {
		schema    string
		count     int64
		successes int64
		cost      float64
		lastSeen  string
		sampleSQL string
	}
	byNorm := map[string]*agg{}
	for rows.Next() {
		var question, sql, schema, createdAt string
		var valid int
		var cost float64
		if err := rows.Scan(&question, &sql, &schema, &valid, &cost, &createdAt); err != nil {
			return nil, err
		}
		norm := normalizeQuestion(question)
		if norm == "" {
			continue
		}
		key := strings.TrimSpace(schema) + "\x00" + norm
		a := byNorm[key]
		if a == nil {
			a = &agg{schema: strings.TrimSpace(schema), lastSeen: createdAt, sampleSQL: sql}
			byNorm[key] = a
		}
		a.count++
		if valid == 1 {
			a.successes++
		}
		a.cost += cost
		if createdAt > a.lastSeen {
			a.lastSeen = createdAt
		}
		if a.sampleSQL == "" && sql != "" {
			a.sampleSQL = sql
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := []UserText2SQLReportCandidate{}
	for key, a := range byNorm {
		if a.count < int64(minCount) {
			continue
		}
		successRate := float64(a.successes) / float64(a.count)
		if successRate < 0.8 {
			continue
		}
		out = append(out, UserText2SQLReportCandidate{
			Fingerprint:        personalSignalFingerprint("t2sql", key),
			SchemaName:         a.schema,
			Count:              a.count,
			SuccessRate:        successRate,
			AvgCostKRW:         a.cost / float64(a.count),
			LastSeen:           a.lastSeen,
			RecommendedProduct: recommendDataProduct(a.sampleSQL),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		if out[i].AvgCostKRW != out[j].AvgCostKRW {
			return out[i].AvgCostKRW > out[j].AvgCostKRW
		}
		return out[i].Fingerprint < out[j].Fingerprint
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// UserMCPAffinities returns the user's most successful repeated MCP tool calls.
func (s *SQLStore) UserMCPAffinities(ctx context.Context, userID string, since time.Time, minCalls, limit int) ([]UserMCPAffinity, error) {
	if minCalls < 1 {
		minCalls = 2
	}
	if limit <= 0 || limit > 20 {
		limit = 5
	}
	rows, err := s.db.QueryContext(ctx, s.bind(`
		SELECT COALESCE(NULLIF(ti.server_label, ''), '(none)'), ti.tool_name,
			COUNT(*),
			COALESCE(SUM(CASE WHEN ti.is_error = 1 THEN 1 ELSE 0 END), 0),
			COALESCE(AVG(r.latency_ms), 0),
			MAX(ti.created_at)
		FROM tool_invocations ti
		JOIN request_logs r ON r.id = ti.request_id
		JOIN api_keys k ON k.id = r.api_key_id
		WHERE k.user_id = ? AND ti.created_at >= ? AND ti.is_mcp = 1 AND ti.source = 'call' AND COALESCE(ti.tool_name, '') <> ''
		GROUP BY COALESCE(NULLIF(ti.server_label, ''), '(none)'), ti.tool_name
		HAVING COUNT(*) >= ?
		ORDER BY COUNT(*) DESC, MAX(ti.created_at) DESC
		LIMIT ?`), userID, since.UTC().Format(time.RFC3339Nano), minCalls, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []UserMCPAffinity{}
	for rows.Next() {
		var a UserMCPAffinity
		if err := rows.Scan(&a.ServerLabel, &a.ToolName, &a.Calls, &a.Errors, &a.AvgRequestLatencyMS, &a.LastUsedAt); err != nil {
			return nil, err
		}
		a.Ref = a.ServerLabel + "/" + a.ToolName
		if a.Calls > 0 {
			a.ErrorRate = float64(a.Errors) / float64(a.Calls)
			a.SuccessRate = 1 - a.ErrorRate
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
