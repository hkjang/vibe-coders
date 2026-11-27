package proxy

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// CSV export of the work analytics. Each view is computed by the same function
// as its JSON read, so the file holds what the screen shows: the same filters,
// the same team scope, the same pseudonyms and the same withheld numbers (an
// empty cell where the JSON has null). Text
// cells go through csvTextCell, because a category name, a team or a title
// that begins with "=" would otherwise run as a formula in a spreadsheet.

const (
	workIntelExportDefaultRows = 1000
	workIntelExportMaxRows     = 10000
)

var workIntelExportViews = []string{"categories", "teams", "models", "sessions", "requests"}

func workIntelCSVInt(v int64) string { return strconv.FormatInt(v, 10) }

func workIntelCSVFloat(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

func workIntelCSVUsers(v *int64) string {
	if v == nil {
		// Withheld: the group is too small to state.
		return ""
	}
	return strconv.FormatInt(*v, 10)
}

func workIntelCSVOptional(v *float64) string {
	if v == nil {
		return ""
	}
	return workIntelCSVFloat(*v)
}

// workIntelCSVMetrics renders a Metrics object; a withheld one is six empty
// cells, as its JSON form is six nulls.
func workIntelCSVMetrics(m workMetrics) []string {
	if m.Suppressed {
		return []string{"", "", "", "", "", ""}
	}
	return []string{workIntelCSVInt(m.Sessions), workIntelCSVInt(m.Requests), workIntelCSVUsers(m.Users), workIntelCSVInt(m.Tokens),
		workIntelCSVFloat(m.CostKRW), workIntelCSVInt(m.MCPCalls)}
}

// workIntelCSVIntUnless and workIntelCSVFloatUnless render a measure of a row
// that may be withheld.
func workIntelCSVIntUnless(withheld bool, v int64) string {
	if withheld {
		return ""
	}
	return workIntelCSVInt(v)
}

func workIntelCSVFloatUnless(withheld bool, v float64) string {
	if withheld {
		return ""
	}
	return workIntelCSVFloat(v)
}

func workIntelCSVList(items []string) string {
	return csvTextCell(strings.Join(items, "|"))
}

func (s *Server) handleWorkIntelExport(w http.ResponseWriter, r *http.Request, _ string) {
	q, ok := s.workIntelAnalytics(w, r, workIntelQueryOptions{exportLimit: true})
	if !ok {
		return
	}
	view, err := workIntelOneOf(r, "view", workIntelExportViews, 32)
	if err == nil && view == "" {
		err = workIntelBadQuery{"view must be one of categories, teams, models, sessions, requests"}
	}
	var sessionOptions workSessionListOptions
	if err == nil && view == "sessions" {
		sessionOptions, err = workIntelSessionOptions(r)
	}
	parent := ""
	if err == nil {
		parent, err = workIntelText(r, "parent", 128)
	}
	if err != nil {
		workIntelError(w, http.StatusBadRequest, "work_intel_invalid_query", err.Error())
		return
	}
	ctx := r.Context()
	var header []string
	var rows [][]string
	metricColumns := []string{"sessions", "requests", "users", "tokens", "cost_krw", "mcp_calls"}
	switch view {
	case "categories":
		data, err := s.workIntelCategories(ctx, q, parent)
		if err != nil {
			workIntelFailed(w, r, "the export", err)
			return
		}
		header = append(append([]string{"category_id", "category", "level"}, metricColumns...), "share", "previous_sessions", "previous_requests", "delta", "suppressed")
		for _, row := range data.Rows {
			line := append([]string{csvTextCell(row.Category.ID), csvTextCell(row.Category.Name), strconv.Itoa(row.Category.Level)}, workIntelCSVMetrics(row.Current)...)
			previousSessions, previousRequests := "", ""
			if row.Previous != nil && !row.Previous.Suppressed {
				previousSessions, previousRequests = workIntelCSVInt(row.Previous.Sessions), workIntelCSVInt(row.Previous.Requests)
			}
			rows = append(rows, append(line, workIntelCSVOptional(row.Share), previousSessions, previousRequests, workIntelCSVOptional(row.Delta), strconv.FormatBool(row.Suppressed)))
		}
		for _, extra := range []struct {
			id, name string
			metrics  workMetrics
		}{{"(unclassified)", "미분류", data.Unclassified}, {"(failed)", "분류 실패", data.Failed}, {"(total)", "합계", data.Total}} {
			line := append([]string{csvTextCell(extra.id), csvTextCell(extra.name), ""}, workIntelCSVMetrics(extra.metrics)...)
			rows = append(rows, append(line, "", "", "", "", strconv.FormatBool(extra.metrics.Suppressed)))
		}
	case "teams":
		data, err := s.workIntelTeams(ctx, q)
		if err != nil {
			workIntelFailed(w, r, "the export", err)
			return
		}
		header = append(append([]string{"team"}, metricColumns...), "sessions_per_user", "diversity", "top_categories", "suppressed")
		for _, row := range data.Rows {
			top := make([]string, 0, len(row.TopCategories))
			for _, category := range row.TopCategories {
				top = append(top, category.Category.Name+"="+workIntelCSVFloat(category.Value))
			}
			line := append([]string{csvTextCell(row.Team)}, workIntelCSVMetrics(row.Current)...)
			rows = append(rows, append(line, workIntelCSVOptional(row.SessionsPerUser), workIntelCSVOptional(row.Diversity), workIntelCSVList(top), strconv.FormatBool(row.Suppressed)))
		}
	case "models":
		data, err := s.workIntelModels(ctx, q)
		if err != nil {
			workIntelFailed(w, r, "the export", err)
			return
		}
		header = []string{"category_id", "category", "model", "provider", "requests", "sessions", "share", "tokens_per_session", "cost_per_session",
			"latency_p50_ms", "latency_p95_ms", "error_rate", "retry_rate", "model_switch_rate", "feedback_positive", "feedback_negative", "low_sample",
			"suppressed"}
		for _, row := range data.Rows {
			out := row.Suppressed
			rows = append(rows, []string{csvTextCell(row.Category.ID), csvTextCell(row.Category.Name), csvTextCell(row.Model), csvTextCell(row.Provider),
				workIntelCSVIntUnless(out, row.Requests), workIntelCSVIntUnless(out, row.Sessions), workIntelCSVFloatUnless(out, row.Share),
				workIntelCSVFloatUnless(out, row.TokensPerSession), workIntelCSVFloatUnless(out, row.CostPerSession),
				workIntelCSVFloatUnless(out, row.LatencyP50MS), workIntelCSVFloatUnless(out, row.LatencyP95MS),
				workIntelCSVFloatUnless(out, row.ErrorRate), workIntelCSVFloatUnless(out, row.RetryRate), workIntelCSVFloatUnless(out, row.ModelSwitchRate),
				workIntelCSVIntUnless(out, row.FeedbackPositive), workIntelCSVIntUnless(out, row.FeedbackNegative), strconv.FormatBool(row.LowSample && !out),
				strconv.FormatBool(out)})
		}
	case "sessions":
		header = []string{"session_id", "session_kind", "team", "user", "client", "primary_category_id", "primary_category", "secondary_categories",
			"first_at", "last_at", "requests", "mcp_calls", "tokens_in", "tokens_out", "cost_krw", "duration_ms", "model_time_ms", "errors", "retries",
			"models", "model_switches", "policy_flags", "completion"}
		for offset := q.offset; len(rows) < q.limit; offset += workIntelMaxLimit {
			page := q.limit - len(rows)
			if page > workIntelMaxLimit {
				page = workIntelMaxLimit
			}
			data, err := s.workIntelSessions(ctx, q, sessionOptions, page, offset)
			if err != nil {
				workIntelFailed(w, r, "the export", err)
				return
			}
			for _, row := range data.Rows {
				secondary := make([]string, 0, len(row.Secondary))
				for _, category := range row.Secondary {
					secondary = append(secondary, category.Name)
				}
				rows = append(rows, []string{csvTextCell(row.SessionID), csvTextCell(row.SessionKind), csvTextCell(row.Team), csvTextCell(row.User),
					csvTextCell(row.Client), csvTextCell(row.Primary.ID), csvTextCell(row.Primary.Name), workIntelCSVList(secondary),
					csvTextCell(row.FirstAt), csvTextCell(row.LastAt), workIntelCSVInt(row.Requests), workIntelCSVInt(row.MCPCalls),
					workIntelCSVInt(row.TokensIn), workIntelCSVInt(row.TokensOut), workIntelCSVFloat(row.CostKRW), workIntelCSVInt(row.DurationMS),
					workIntelCSVInt(row.ModelTimeMS), workIntelCSVInt(row.Errors), workIntelCSVInt(row.Retries), workIntelCSVList(row.Models),
					workIntelCSVInt(row.ModelSwitches), workIntelCSVList(row.PolicyFlags), csvTextCell(row.Completion)})
			}
			if len(data.Rows) < page {
				break
			}
		}
	case "requests":
		header = []string{"request_id", "created_at", "session_id", "team", "user", "client", "model", "category_id", "category", "action_type",
			"confidence", "method", "status", "work_title", "tags", "technologies", "tokens", "cost_krw", "latency_ms", "is_error", "policy_version"}
		for offset := q.offset; len(rows) < q.limit; offset += workIntelMaxLimit {
			page := q.limit - len(rows)
			if page > workIntelMaxLimit {
				page = workIntelMaxLimit
			}
			data, err := s.workIntelRequests(ctx, q, page, offset)
			if err != nil {
				workIntelFailed(w, r, "the export", err)
				return
			}
			for _, row := range data.Rows {
				rows = append(rows, []string{csvTextCell(row.RequestID), csvTextCell(row.CreatedAt), csvTextCell(row.SessionID), csvTextCell(row.Team),
					csvTextCell(row.User), csvTextCell(row.Client), csvTextCell(row.Model), csvTextCell(row.Category.ID), csvTextCell(row.Category.Name),
					csvTextCell(row.ActionType), workIntelCSVFloat(row.Confidence), csvTextCell(row.Method), csvTextCell(row.Status),
					csvTextCell(row.WorkTitle), workIntelCSVList(row.Tags), workIntelCSVList(row.Technologies), workIntelCSVInt(row.Tokens),
					workIntelCSVFloat(row.CostKRW), workIntelCSVInt(row.LatencyMS), strconv.FormatBool(row.IsError), strconv.Itoa(row.PolicyVersion)})
			}
			if len(data.Rows) < page {
				break
			}
		}
	}
	if len(rows) > q.limit {
		rows = rows[:q.limit]
	}

	// Built in memory first: a failure half way must not leave a truncated file
	// that looks complete.
	var body bytes.Buffer
	// BOM so a spreadsheet opens the UTF-8 file with Korean text intact.
	body.Write([]byte{0xEF, 0xBB, 0xBF})
	writer := csv.NewWriter(&body)
	_ = writer.Write(header)
	for _, row := range rows {
		_ = writer.Write(row)
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		workIntelFailed(w, r, "the export", err)
		return
	}
	s.auditAdmin(r, "work_intel.export", "", auditJSON(map[string]any{
		"view": view, "from": q.from, "to": q.to, "rows": len(rows), "team_scoped": q.caller.scoped, "category": q.category,
		"team_filter": len(q.base.Teams) > 0 && !q.caller.scoped, "user_filter": q.base.User != ""}))
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=work-%s-%s.csv", view, time.Now().UTC().Format("20060102-150405")))
	_, _ = w.Write(body.Bytes())
}
