package store

import (
	"context"
	"fmt"
	"sort"
	"time"
)

// WorkMapTaskType is a per-node breakdown entry: how many requests of a heuristic
// task class (refactor/generate/debug/...) ran under a work-map node.
type WorkMapTaskType struct {
	TaskType string `json:"task_type"`
	Requests int64  `json:"requests"`
}

// WorkMapNode is a single node of the AI Work Map: a consolidated, multi-metric
// summary of what AI work is happening under one value of a work dimension
// (project / team / repo / ...). Read-only; nothing enforces on it.
type WorkMapNode struct {
	Subject        string            `json:"subject"`
	Requests       int64             `json:"requests"`
	Errors         int64             `json:"errors"`
	ErrorRate      float64           `json:"error_rate"`
	TotalTokens    int64             `json:"total_tokens"`
	CostKRW        float64           `json:"cost_krw"`
	DistinctUsers  int64             `json:"distinct_users"`
	DistinctModels int64             `json:"distinct_models"`
	TopModel       string            `json:"top_model"`
	TopTaskType    string            `json:"top_task_type"`
	TaskTypes      []WorkMapTaskType `json:"task_types"`
}

// WorkMap builds the AI Work Map over a window: for each value of the work dimension
// it summarizes volume, tokens, cost, distinct users/models, error rate, the dominant
// model, and a breakdown of heuristic task types. It complements (rather than
// duplicates) cost allocation (single metric) and the credit score (reliability/cost):
// this answers "what kind of AI work is happening where, and by whom".
func (s *SQLStore) WorkMap(ctx context.Context, dimension string, since time.Time, limit int) ([]WorkMapNode, error) {
	col, ok := costAllocationColumns[dimension]
	if !ok {
		return nil, fmt.Errorf("unsupported work-map dimension %q", dimension)
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	sinceStr := since.UTC().Format(time.RFC3339Nano)

	// Query A: scalar metrics per node, top-N by volume.
	queryA := s.bind(fmt.Sprintf(`
		SELECT COALESCE(NULLIF(%s, ''), '(unset)') AS key,
			COUNT(r.id),
			COALESCE(SUM(CASE WHEN r.status_code >= 400 THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(t.total_tokens), 0),
			COALESCE(SUM(t.estimated_cost), 0),
			COUNT(DISTINCT r.api_key_id),
			COUNT(DISTINCT r.model)
		FROM request_logs r
		LEFT JOIN token_usage t ON t.request_id = r.id
		WHERE r.created_at >= ?
		GROUP BY COALESCE(NULLIF(%s, ''), '(unset)')
		ORDER BY COUNT(r.id) DESC
		LIMIT %d
	`, col, col, limit))

	rows, err := s.db.QueryContext(ctx, queryA, sinceStr)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	nodes := map[string]*WorkMapNode{}
	order := []string{}
	for rows.Next() {
		var n WorkMapNode
		if err := rows.Scan(&n.Subject, &n.Requests, &n.Errors, &n.TotalTokens, &n.CostKRW, &n.DistinctUsers, &n.DistinctModels); err != nil {
			return nil, err
		}
		if n.Requests > 0 {
			n.ErrorRate = float64(n.Errors) / float64(n.Requests)
		}
		node := n
		nodes[n.Subject] = &node
		order = append(order, n.Subject)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(order) == 0 {
		return []WorkMapNode{}, nil
	}

	// Query B: task-type breakdown; fold into the nodes we kept.
	queryB := s.bind(fmt.Sprintf(`
		SELECT COALESCE(NULLIF(%s, ''), '(unset)') AS key,
			COALESCE(NULLIF(r.task_type, ''), '(unknown)'),
			COUNT(r.id)
		FROM request_logs r
		WHERE r.created_at >= ?
		GROUP BY COALESCE(NULLIF(%s, ''), '(unset)'), COALESCE(NULLIF(r.task_type, ''), '(unknown)')
	`, col, col))
	tRows, err := s.db.QueryContext(ctx, queryB, sinceStr)
	if err != nil {
		return nil, err
	}
	defer tRows.Close()
	for tRows.Next() {
		var subject, taskType string
		var cnt int64
		if err := tRows.Scan(&subject, &taskType, &cnt); err != nil {
			return nil, err
		}
		if node := nodes[subject]; node != nil {
			node.TaskTypes = append(node.TaskTypes, WorkMapTaskType{TaskType: taskType, Requests: cnt})
		}
	}
	if err := tRows.Err(); err != nil {
		return nil, err
	}

	// Query C: dominant model per node.
	queryC := s.bind(fmt.Sprintf(`
		SELECT COALESCE(NULLIF(%s, ''), '(unset)') AS key,
			COALESCE(NULLIF(r.model, ''), '(unset)'),
			COUNT(r.id)
		FROM request_logs r
		WHERE r.created_at >= ?
		GROUP BY COALESCE(NULLIF(%s, ''), '(unset)'), COALESCE(NULLIF(r.model, ''), '(unset)')
	`, col, col))
	mRows, err := s.db.QueryContext(ctx, queryC, sinceStr)
	if err != nil {
		return nil, err
	}
	defer mRows.Close()
	topModelCnt := map[string]int64{}
	for mRows.Next() {
		var subject, model string
		var cnt int64
		if err := mRows.Scan(&subject, &model, &cnt); err != nil {
			return nil, err
		}
		if node := nodes[subject]; node != nil && cnt > topModelCnt[subject] {
			topModelCnt[subject] = cnt
			node.TopModel = model
		}
	}
	if err := mRows.Err(); err != nil {
		return nil, err
	}

	// Finalize: sort task types desc, pick dominant, keep top 5; preserve node order.
	out := make([]WorkMapNode, 0, len(order))
	for _, subject := range order {
		node := nodes[subject]
		sort.Slice(node.TaskTypes, func(i, j int) bool {
			if node.TaskTypes[i].Requests != node.TaskTypes[j].Requests {
				return node.TaskTypes[i].Requests > node.TaskTypes[j].Requests
			}
			return node.TaskTypes[i].TaskType < node.TaskTypes[j].TaskType
		})
		if len(node.TaskTypes) > 0 {
			node.TopTaskType = node.TaskTypes[0].TaskType
		}
		if len(node.TaskTypes) > 5 {
			node.TaskTypes = node.TaskTypes[:5]
		}
		out = append(out, *node)
	}
	return out, nil
}
