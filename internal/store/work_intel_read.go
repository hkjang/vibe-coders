package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"vibe-coders/internal/workintel"
)

// Read side of work intelligence (docs/WORK_INTELLIGENCE_DESIGN.md, section 7).
//
// The dashboards read the aggregates: work_daily for the additive measures,
// work_daily_users for distinct users, work_session_segments for distinct
// sessions and work_sessions for what is only true of a whole session. Every
// such query starts from a day range, which is the leading column of those
// tables' keys.
//
// The facts (work_classifications) are read only when a question cannot be
// answered from the aggregates: a filter on something only a request has (its
// user, a tool it called, its status, method or confidence), a distinct count
// along a dimension the user and session aggregates do not carry (model,
// provider, action, client), or a list of the requests themselves. Those
// queries are bounded by day as well, or by a session id.
//
// request_logs is never read here.

// WorkFilter selects the rows of a period.
type WorkFilter struct {
	// From and To are Seoul calendar days (YYYY-MM-DD), inclusive.
	From, To string
	// Teams restricts to these teams. With TeamScoped the list is the caller's
	// whole world: an empty list then matches nothing rather than everything.
	Teams      []string
	TeamScoped bool
	// Categories restricts to these stored category ids (nil means all). A
	// grouping that folds categories ignores it: the fold names the ids it keeps.
	Categories []string
	Action     string
	Model      string
	Provider   string
	Client     string

	// The conditions below exist only on a request. Any of them makes a query
	// read the facts instead of the aggregates.
	User          string
	Tool          string
	Method        string
	Statuses      []string
	MinConfidence *float64
	MaxConfidence *float64
	// UpdatedThrough keeps facts last written at or before this time (the
	// fixed-width layout), which pins a selection to the moment it was reviewed.
	UpdatedThrough string
	// TopCategories names the top-level categories the Categories belong to. It
	// selects nothing more; it lets a read of the facts seek each day and
	// top-level category through the (day, top_category_id) index instead of
	// walking every fact of the period.
	TopCategories []string
}

// RowLevel reports whether the filter can only be evaluated on the facts.
func (f WorkFilter) RowLevel() bool {
	return f.User != "" || f.Tool != "" || f.Method != "" || len(f.Statuses) > 0 ||
		f.MinConfidence != nil || f.MaxConfidence != nil || f.UpdatedThrough != ""
}

// distinctFromFacts reports whether a distinct count has to come from the
// facts: the user and session aggregates carry day, category and team only.
func (f WorkFilter) distinctFromFacts() bool {
	return f.RowLevel() || f.Action != "" || f.Model != "" || f.Provider != "" || f.Client != ""
}

// WorkDim is a dimension a read can group by.
type WorkDim string

const (
	WorkDimDay      WorkDim = "day"
	WorkDimCategory WorkDim = "category"
	WorkDimTeam     WorkDim = "team"
	WorkDimModel    WorkDim = "model"
	WorkDimProvider WorkDim = "provider"
	WorkDimAction   WorkDim = "action"
	WorkDimClient   WorkDim = "client"
)

// WorkBucket is a run of days reported under one label (a week).
type WorkBucket struct {
	Label    string
	From, To string
}

// WorkGroup says how a read is grouped.
type WorkGroup struct {
	Dims []WorkDim
	// Fold maps stored category ids to the key they are reported under, so that
	// merged categories and a whole subtree count as one. With a fold, the
	// category dimension is that key and ids the fold does not name are left out.
	Fold map[string]string
	// Buckets, when set, replaces the day dimension by the label of the bucket a
	// day falls in. They must not overlap; days outside every bucket are left out.
	Buckets []WorkBucket
}

func (g WorkGroup) has(dim WorkDim) bool {
	for _, d := range g.Dims {
		if d == dim {
			return true
		}
	}
	return false
}

// WorkKey identifies one group of a read. Only the dimensions that were asked
// for are filled in.
type WorkKey struct {
	Day      string
	Category string
	Team     string
	Model    string
	Provider string
	Action   string
	Client   string
}

// WorkSums is the additive part of one group.
type WorkSums struct {
	WorkKey
	Requests  int64
	TokensIn  int64
	TokensOut int64
	CostKRW   float64
	MCPCalls  int64
	Errors    int64
	Retries   int64
	LatencyMS int64
	// Lat is the latency histogram (workintel.LatencyBounds), Method the counts
	// by rule/llm/cache/manual, Status those by review/unclassified/failed and
	// Conf the confidence buckets (workintel.ConfidenceLabels).
	Lat    [workintel.LatencyBuckets]int64
	Method [len(workDailyMethods)]int64
	Status [len(workDailyStatuses)]int64
	Conf   [workConfidenceBuckets]int64
}

// Add adds another group's measures to s, keeping s's key.
func (s *WorkSums) Add(o WorkSums) {
	s.Requests += o.Requests
	s.TokensIn += o.TokensIn
	s.TokensOut += o.TokensOut
	s.CostKRW += o.CostKRW
	s.MCPCalls += o.MCPCalls
	s.Errors += o.Errors
	s.Retries += o.Retries
	s.LatencyMS += o.LatencyMS
	for i := range s.Lat {
		s.Lat[i] += o.Lat[i]
	}
	for i := range s.Method {
		s.Method[i] += o.Method[i]
	}
	for i := range s.Status {
		s.Status[i] += o.Status[i]
	}
	for i := range s.Conf {
		s.Conf[i] += o.Conf[i]
	}
}

// WorkCount is a distinct count for one group.
type WorkCount struct {
	WorkKey
	Count int64
}

// workReadTable says which of a table's columns a filter can use.
type workReadTable struct {
	name  string
	facts bool
	// dims lists the dimensions the table carries besides day, category and team.
	action, model, provider, client bool
}

var (
	workReadDaily    = workReadTable{name: "work_daily", action: true, model: true, provider: true, client: true}
	workReadUsers    = workReadTable{name: "work_daily_users"}
	workReadSegments = workReadTable{name: "work_session_segments"}
	workReadFacts    = workReadTable{name: "work_classifications", facts: true, action: true, model: true, provider: true, client: true}
)

// workLikeEscape escapes a value for use inside a LIKE pattern with ESCAPE '!'.
func workLikeEscape(v string) string {
	return strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(v)
}

// workTeamCondition renders the team restriction. The second result is false
// when the restriction can match nothing.
func workTeamCondition(column string, teams []string, scoped bool) (string, []any, bool) {
	keys := make([]string, 0, len(teams))
	seen := map[string]bool{}
	for _, team := range teams {
		if team = strings.TrimSpace(team); team != "" && !seen[team] {
			seen[team] = true
			keys = append(keys, team)
		}
	}
	if len(keys) == 0 {
		return "", nil, !scoped
	}
	return column + " IN (" + placeholders(len(keys)) + ")", workAnyArgs(keys), true
}

// workConditions renders the filter for one table. prefix is the table alias
// with its dot, or empty. withCategories is false when a fold selects the
// categories instead. The last result is false when nothing can match.
func (f WorkFilter) workConditions(t workReadTable, prefix string, withCategories bool) ([]string, []any, bool) {
	conds := []string{prefix + "day >= ?", prefix + "day <= ?"}
	args := []any{f.From, f.To}
	if days := workDaysBetween(f.From, f.To); t.facts && len(f.TopCategories) > 0 && len(days) > 0 && len(days) <= workSeekDays {
		// Equality on the day is what lets the index continue into the category.
		conds = []string{prefix + "day IN (" + placeholders(len(days)) + ")", prefix + "top_category_id IN (" + placeholders(len(f.TopCategories)) + ")"}
		args = append(workAnyArgs(days), workAnyArgs(f.TopCategories)...)
	}
	cond, teamArgs, possible := workTeamCondition(prefix+"team", f.Teams, f.TeamScoped)
	if !possible {
		return nil, nil, false
	}
	if cond != "" {
		conds = append(conds, cond)
		args = append(args, teamArgs...)
	}
	if withCategories && f.Categories != nil {
		if len(f.Categories) == 0 {
			return nil, nil, false
		}
		conds = append(conds, prefix+"category_id IN ("+placeholders(len(f.Categories))+")")
		args = append(args, workAnyArgs(f.Categories)...)
	}
	equal := func(have bool, column, value string) {
		if have && value != "" {
			conds = append(conds, prefix+column+" = ?")
			args = append(args, value)
		}
	}
	equal(t.action, "action_type", f.Action)
	equal(t.model, "model", f.Model)
	equal(t.provider, "provider", f.Provider)
	equal(t.client, "client", f.Client)
	if !t.facts {
		return conds, args, true
	}
	equal(true, "user_key", f.User)
	equal(true, "method", f.Method)
	if len(f.Statuses) > 0 {
		conds = append(conds, prefix+"status IN ("+placeholders(len(f.Statuses))+")")
		args = append(args, workAnyArgs(f.Statuses)...)
	}
	if f.MinConfidence != nil {
		conds = append(conds, prefix+"confidence >= ?")
		args = append(args, *f.MinConfidence)
	}
	if f.MaxConfidence != nil {
		conds = append(conds, prefix+"confidence <= ?")
		args = append(args, *f.MaxConfidence)
	}
	if f.UpdatedThrough != "" {
		conds = append(conds, prefix+"updated_at <= ?")
		args = append(args, f.UpdatedThrough)
	}
	if f.Tool != "" {
		// tool_sig is the sorted list of called tools, "server/tool" or "tool",
		// joined by commas. The filter names a tool with or without its server.
		tool := workLikeEscape(f.Tool)
		conds = append(conds, "((',' || "+prefix+"tool_sig || ',') LIKE ? ESCAPE '!' OR (',' || "+prefix+"tool_sig || ',') LIKE ? ESCAPE '!')")
		args = append(args, "%,"+tool+",%", "%/"+tool+",%")
	}
	return conds, args, true
}

// workSeekDays bounds the days a read enumerates to seek by day and category.
const workSeekDays = 400

// workDaysBetween lists the days of an inclusive range, or nothing when the
// bounds are not days.
func workDaysBetween(from, to string) []string {
	first, ok1 := workIntelDayStart(from)
	last, ok2 := workIntelDayStart(to)
	if !ok1 || !ok2 || last.Before(first) {
		return nil
	}
	out := []string{}
	for day := first; !day.After(last) && len(out) <= workSeekDays; day = day.AddDate(0, 0, 1) {
		out = append(out, day.Format("2006-01-02"))
	}
	return out
}

// workFoldExpr renders the key a stored category id is reported under: a CASE
// over the ids of each key, and the empty string for every other id.
func workFoldExpr(column string, fold map[string]string) (string, []any) {
	byKey := map[string][]string{}
	for id, key := range fold {
		if key != "" {
			byKey[key] = append(byKey[key], id)
		}
	}
	if len(byKey) == 0 {
		return "''", nil
	}
	keys := make([]string, 0, len(byKey))
	for key := range byKey {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var b strings.Builder
	args := []any{}
	b.WriteString("CASE")
	for _, key := range keys {
		ids := byKey[key]
		sort.Strings(ids)
		b.WriteString(" WHEN " + column + " IN (" + placeholders(len(ids)) + ") THEN CAST(? AS TEXT)")
		args = append(args, workAnyArgs(ids)...)
		args = append(args, key)
	}
	b.WriteString(" ELSE '' END")
	return b.String(), args
}

// workBucketExpr renders the label of the bucket a day falls in.
func workBucketExpr(column string, buckets []WorkBucket) (string, []any) {
	var b strings.Builder
	args := []any{}
	b.WriteString("CASE")
	for _, bucket := range buckets {
		b.WriteString(" WHEN " + column + " >= ? AND " + column + " <= ? THEN CAST(? AS TEXT)")
		args = append(args, bucket.From, bucket.To, bucket.Label)
	}
	b.WriteString(" ELSE '' END")
	return b.String(), args
}

// workDimExprs renders the group expressions of a read, in the order of
// g.Dims, with the arguments they bind.
func workDimExprs(g WorkGroup, t workReadTable, prefix string) ([]string, []any, error) {
	exprs := make([]string, 0, len(g.Dims))
	args := []any{}
	for _, dim := range g.Dims {
		switch dim {
		case WorkDimDay:
			if len(g.Buckets) > 0 {
				expr, exprArgs := workBucketExpr(prefix+"day", g.Buckets)
				exprs, args = append(exprs, expr), append(args, exprArgs...)
				continue
			}
			exprs = append(exprs, prefix+"day")
		case WorkDimCategory:
			if g.Fold != nil {
				expr, exprArgs := workFoldExpr(prefix+"category_id", g.Fold)
				exprs, args = append(exprs, expr), append(args, exprArgs...)
				continue
			}
			exprs = append(exprs, prefix+"category_id")
		case WorkDimTeam:
			exprs = append(exprs, prefix+"team")
		case WorkDimModel, WorkDimProvider, WorkDimAction, WorkDimClient:
			column := map[WorkDim]string{WorkDimModel: "model", WorkDimProvider: "provider", WorkDimAction: "action_type", WorkDimClient: "client"}[dim]
			have := map[WorkDim]bool{WorkDimModel: t.model, WorkDimProvider: t.provider, WorkDimAction: t.action, WorkDimClient: t.client}[dim]
			if !have {
				return nil, nil, fmt.Errorf("work intel: %s has no %s dimension", t.name, dim)
			}
			exprs = append(exprs, prefix+column)
		default:
			return nil, nil, fmt.Errorf("work intel: unknown dimension %q", dim)
		}
	}
	return exprs, args, nil
}

// scanTargets returns the scan destinations of a key for the dimensions of g.
func (k *WorkKey) scanTargets(g WorkGroup) []any {
	targets := make([]any, 0, len(g.Dims))
	for _, dim := range g.Dims {
		switch dim {
		case WorkDimDay:
			targets = append(targets, &k.Day)
		case WorkDimCategory:
			targets = append(targets, &k.Category)
		case WorkDimTeam:
			targets = append(targets, &k.Team)
		case WorkDimModel:
			targets = append(targets, &k.Model)
		case WorkDimProvider:
			targets = append(targets, &k.Provider)
		case WorkDimAction:
			targets = append(targets, &k.Action)
		case WorkDimClient:
			targets = append(targets, &k.Client)
		}
	}
	return targets
}

// dropped reports whether a group fell outside the fold or the buckets.
func (k WorkKey) dropped(g WorkGroup) bool {
	return (g.Fold != nil && g.has(WorkDimCategory) && k.Category == "") ||
		(len(g.Buckets) > 0 && g.has(WorkDimDay) && k.Day == "")
}

func workOrdinals(n int) string {
	parts := make([]string, n)
	for i := range parts {
		parts[i] = strconv.Itoa(i + 1)
	}
	return strings.Join(parts, ", ")
}

// workFactSumExprs are the measures of work_daily computed from facts, in the
// order of workDailySumColumns. They restate workDailyRebuildSelect, so a read
// from the facts and a read from a rebuilt day agree.
var workFactSumExprs = func() []string {
	sum := func(cond string) string { return "COALESCE(SUM(CASE WHEN " + cond + " THEN 1 ELSE 0 END), 0)" }
	cols := []string{"COUNT(*)", "COALESCE(SUM(tokens_in), 0)", "COALESCE(SUM(tokens_out), 0)", "COALESCE(SUM(cost_krw), 0)",
		"COALESCE(SUM(mcp_calls), 0)", "COALESCE(SUM(is_error), 0)", "COALESCE(SUM(is_retry), 0)", "COALESCE(SUM(latency_ms), 0)"}
	for i := 0; i < workintel.LatencyBuckets; i++ {
		var cond []string
		if i > 0 {
			cond = append(cond, "latency_ms > "+strconv.FormatInt(workintel.LatencyBounds[i-1], 10))
		}
		if i < len(workintel.LatencyBounds) {
			cond = append(cond, "latency_ms <= "+strconv.FormatInt(workintel.LatencyBounds[i], 10))
		}
		cols = append(cols, sum(strings.Join(cond, " AND ")))
	}
	for _, m := range workDailyMethods {
		cols = append(cols, sum("method = '"+m+"'"))
	}
	for _, st := range workDailyStatuses {
		cols = append(cols, sum("status = '"+st+"'"))
	}
	bound := func(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }
	for i := 0; i < workConfidenceBuckets; i++ {
		var cond []string
		if i > 0 {
			cond = append(cond, "confidence >= "+bound(workConfidenceBounds[i-1]))
		}
		if i < len(workConfidenceBounds) {
			cond = append(cond, "confidence < "+bound(workConfidenceBounds[i]))
		}
		cols = append(cols, sum(strings.Join(cond, " AND ")))
	}
	return cols
}()

var workDailySumExprs = func() []string {
	cols := make([]string, len(workDailySumColumns))
	for i, c := range workDailySumColumns {
		cols[i] = "COALESCE(SUM(" + c + "), 0)"
	}
	return cols
}()

func (s *WorkSums) sumTargets() []any {
	targets := []any{&s.Requests, &s.TokensIn, &s.TokensOut, &s.CostKRW, &s.MCPCalls, &s.Errors, &s.Retries, &s.LatencyMS}
	for i := range s.Lat {
		targets = append(targets, &s.Lat[i])
	}
	for i := range s.Method {
		targets = append(targets, &s.Method[i])
	}
	for i := range s.Status {
		targets = append(targets, &s.Status[i])
	}
	for i := range s.Conf {
		targets = append(targets, &s.Conf[i])
	}
	return targets
}

// workQueryRows runs a read and hands every row to scan.
func (s *SQLStore) workQueryRows(ctx context.Context, query string, args []any, scan func(workRowScanner) error) error {
	rows, err := s.db.QueryContext(ctx, s.bind(query), cleanArgs(args)...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := scan(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}

// WorkSums returns the additive measures of a period, grouped. It reads
// work_daily, or the facts when the filter has a row-level condition.
func (s *SQLStore) WorkSums(ctx context.Context, f WorkFilter, g WorkGroup) ([]WorkSums, error) {
	table, sums := workReadDaily, workDailySumExprs
	if f.RowLevel() {
		table, sums = workReadFacts, workFactSumExprs
	}
	out := []WorkSums{}
	conds, whereArgs, possible := f.workConditions(table, "", g.Fold == nil || !g.has(WorkDimCategory))
	if !possible {
		return out, nil
	}
	dims, dimArgs, err := workDimExprs(g, table, "")
	if err != nil {
		return nil, err
	}
	query := "SELECT " + strings.Join(append(append([]string{}, dims...), sums...), ", ") +
		" FROM " + table.name + " WHERE " + strings.Join(conds, " AND ")
	if len(dims) > 0 {
		query += " GROUP BY " + workOrdinals(len(dims))
	}
	err = s.workQueryRows(ctx, query, append(dimArgs, whereArgs...), func(row workRowScanner) error {
		var sum WorkSums
		if err := row.Scan(append(sum.WorkKey.scanTargets(g), sum.sumTargets()...)...); err != nil {
			return err
		}
		if !sum.WorkKey.dropped(g) && sum.Requests > 0 {
			out = append(out, sum)
		}
		return nil
	})
	return out, err
}

// WorkSessionCounts returns the number of distinct work sessions of a period,
// grouped. A session is identified by its id and team. It reads
// work_session_segments, or the facts when the filter or the grouping needs a
// dimension the segments do not carry.
func (s *SQLStore) WorkSessionCounts(ctx context.Context, f WorkFilter, g WorkGroup) ([]WorkCount, error) {
	table := workReadSegments
	if f.distinctFromFacts() || g.has(WorkDimModel) || g.has(WorkDimProvider) || g.has(WorkDimAction) || g.has(WorkDimClient) {
		table = workReadFacts
	}
	out := []WorkCount{}
	conds, whereArgs, possible := f.workConditions(table, "", g.Fold == nil || !g.has(WorkDimCategory))
	if !possible {
		return out, nil
	}
	if table.facts {
		// A request without a session id belongs to no session.
		conds = append(conds, "session_id <> ''")
	}
	dims, dimArgs, err := workDimExprs(g, table, "")
	if err != nil {
		return nil, err
	}
	inner := make([]string, 0, len(dims)+2)
	outer := make([]string, 0, len(dims))
	for i, expr := range dims {
		inner = append(inner, fmt.Sprintf("%s AS d%d", expr, i))
		outer = append(outer, fmt.Sprintf("d%d", i))
	}
	inner = append(inner, "session_id AS sid", "team AS tid")
	query := "SELECT " + strings.Join(append(append([]string{}, outer...), "COUNT(*)"), ", ") +
		" FROM (SELECT DISTINCT " + strings.Join(inner, ", ") + " FROM " + table.name +
		" WHERE " + strings.Join(conds, " AND ") + ") x"
	if len(outer) > 0 {
		query += " GROUP BY " + strings.Join(outer, ", ")
	}
	err = s.workQueryRows(ctx, query, append(dimArgs, whereArgs...), func(row workRowScanner) error {
		var c WorkCount
		if err := row.Scan(append(c.WorkKey.scanTargets(g), &c.Count)...); err != nil {
			return err
		}
		if !c.WorkKey.dropped(g) && c.Count > 0 {
			out = append(out, c)
		}
		return nil
	})
	return out, err
}

// WorkUserCounts returns the number of distinct users of a period, grouped. It
// reads work_daily_users, or the facts when the filter or the grouping needs a
// dimension that table does not carry.
func (s *SQLStore) WorkUserCounts(ctx context.Context, f WorkFilter, g WorkGroup) ([]WorkCount, error) {
	table := workReadUsers
	if f.distinctFromFacts() || g.has(WorkDimModel) || g.has(WorkDimProvider) || g.has(WorkDimAction) || g.has(WorkDimClient) {
		table = workReadFacts
	}
	out := []WorkCount{}
	conds, whereArgs, possible := f.workConditions(table, "", g.Fold == nil || !g.has(WorkDimCategory))
	if !possible {
		return out, nil
	}
	dims, dimArgs, err := workDimExprs(g, table, "")
	if err != nil {
		return nil, err
	}
	query := "SELECT " + strings.Join(append(append([]string{}, dims...), "COUNT(DISTINCT user_key)"), ", ") +
		" FROM " + table.name + " WHERE " + strings.Join(conds, " AND ")
	if len(dims) > 0 {
		query += " GROUP BY " + workOrdinals(len(dims))
	}
	err = s.workQueryRows(ctx, query, append(dimArgs, whereArgs...), func(row workRowScanner) error {
		var c WorkCount
		if err := row.Scan(append(c.WorkKey.scanTargets(g), &c.Count)...); err != nil {
			return err
		}
		if !c.WorkKey.dropped(g) && c.Count > 0 {
			out = append(out, c)
		}
		return nil
	})
	return out, err
}

// WorkCategoryFirstDays returns, per stored category id, the first day of the
// filter's period on which it was used. Only the period, the teams and the
// categories of the filter apply.
func (s *SQLStore) WorkCategoryFirstDays(ctx context.Context, f WorkFilter) (map[string]string, error) {
	out := map[string]string{}
	conds, args, possible := WorkFilter{From: f.From, To: f.To, Teams: f.Teams, TeamScoped: f.TeamScoped, Categories: f.Categories}.
		workConditions(workReadDaily, "", true)
	if !possible {
		return out, nil
	}
	err := s.workQueryRows(ctx, "SELECT category_id, MIN(day) FROM work_daily WHERE "+strings.Join(conds, " AND ")+" GROUP BY category_id", args,
		func(row workRowScanner) error {
			var id, day string
			if err := row.Scan(&id, &day); err != nil {
				return err
			}
			out[id] = day
			return nil
		})
	return out, err
}

// WorkUserKeys returns the distinct users active in a period (teams and
// categories of the filter apply), at most limit of them.
func (s *SQLStore) WorkUserKeys(ctx context.Context, f WorkFilter, limit int) ([]string, error) {
	if limit <= 0 || limit > 50000 {
		limit = 50000
	}
	out := []string{}
	conds, args, possible := WorkFilter{From: f.From, To: f.To, Teams: f.Teams, TeamScoped: f.TeamScoped, Categories: f.Categories}.
		workConditions(workReadUsers, "", true)
	if !possible {
		return out, nil
	}
	err := s.workQueryRows(ctx, "SELECT DISTINCT user_key FROM work_daily_users WHERE "+strings.Join(conds, " AND ")+" LIMIT ?", append(args, limit),
		func(row workRowScanner) error {
			var key string
			if err := row.Scan(&key); err != nil {
				return err
			}
			out = append(out, key)
			return nil
		})
	return out, err
}

// ---- Sessions ----

// WorkCountCap is where the count of a list stops. A list is paged; counting
// an arbitrarily long one in full would cost a scan for a number nobody pages to.
const WorkCountCap = 100000

// WorkSessionRow is one session head as the session list shows it.
type WorkSessionRow struct {
	SessionID         string
	Team              string
	Kind              string
	UserKey           string
	Client            string
	FirstAt           string
	LastAt            string
	Requests          int64
	MCPCalls          int64
	TokensIn          int64
	TokensOut         int64
	CostKRW           float64
	LatencyMS         int64
	Errors            int64
	Retries           int64
	Models            []string
	ModelSwitches     int64
	PolicyFlags       []string
	Completion        string
	CategoryCounts    map[string]int64
	PrimaryCategoryID string
}

const workSessionRowColumns = `s.session_id, s.team, s.session_kind, s.user_key, s.client, s.first_at, s.last_at, s.requests,
	s.mcp_calls, s.tokens_in, s.tokens_out, s.cost_krw, s.latency_ms, s.errors, s.retries, s.models, s.model_switches,
	s.policy_flags, s.completion, s.category_counts, s.primary_category_id`

func scanWorkSessionRow(row workRowScanner) (WorkSessionRow, error) {
	var out WorkSessionRow
	var models, flags, counts string
	err := row.Scan(&out.SessionID, &out.Team, &out.Kind, &out.UserKey, &out.Client, &out.FirstAt, &out.LastAt, &out.Requests,
		&out.MCPCalls, &out.TokensIn, &out.TokensOut, &out.CostKRW, &out.LatencyMS, &out.Errors, &out.Retries, &models, &out.ModelSwitches,
		&flags, &out.Completion, &counts, &out.PrimaryCategoryID)
	if err != nil {
		return out, err
	}
	out.Models, out.PolicyFlags, out.CategoryCounts = decodeList(models), workSplitFlags(flags), workDecodeCounts(counts)
	return out, nil
}

// WorkSessionQuery selects a page of sessions.
type WorkSessionQuery struct {
	// Filter.From/To select the sessions that were active in the period (their
	// span overlaps it). The category and request-level conditions keep the
	// sessions that have at least one matching request in the period.
	Filter WorkFilter
	// Completion restricts to one completion state.
	Completion string
	// SortBy is last_at, requests, cost_krw, duration_ms or errors.
	SortBy string
	Desc   bool
	Limit  int
	Offset int
}

// workDayRange returns the instants a day range covers as stored timestamps:
// the start of From and the start of the day after To.
func workDayRange(from, to string) (start, end string, err error) {
	first, ok := workIntelDayStart(from)
	if !ok {
		return "", "", fmt.Errorf("work intel: %q is not a day (YYYY-MM-DD)", from)
	}
	last, ok := workIntelDayStart(to)
	if !ok {
		return "", "", fmt.Errorf("work intel: %q is not a day (YYYY-MM-DD)", to)
	}
	return workIntelTime(first), workIntelTime(last.AddDate(0, 0, 1)), nil
}

func (s *SQLStore) workSessionConditions(q WorkSessionQuery) ([]string, []any, bool, error) {
	f := q.Filter
	start, end, err := workDayRange(f.From, f.To)
	if err != nil {
		return nil, nil, false, err
	}
	conds := []string{"s.last_at >= ?", "s.first_at < ?"}
	args := []any{start, end}
	cond, teamArgs, possible := workTeamCondition("s.team", f.Teams, f.TeamScoped)
	if !possible {
		return nil, nil, false, nil
	}
	if cond != "" {
		conds = append(conds, cond)
		args = append(args, teamArgs...)
	}
	if f.User != "" {
		conds = append(conds, "s.user_key = ?")
		args = append(args, f.User)
	}
	if q.Completion != "" {
		conds = append(conds, "s.completion = ?")
		args = append(args, q.Completion)
	}
	// What remains is true of requests, not of the session as a whole: the
	// session qualifies when one of its requests in the period matches.
	inner := f
	inner.Teams, inner.TeamScoped, inner.User = nil, false, ""
	switch {
	case inner.distinctFromFacts():
		sub, subArgs, ok := inner.workConditions(workReadFacts, "c.", true)
		if !ok {
			return nil, nil, false, nil
		}
		conds = append(conds, "EXISTS (SELECT 1 FROM work_classifications c WHERE c.session_id = s.session_id AND c.team = s.team AND "+strings.Join(sub, " AND ")+")")
		args = append(args, subArgs...)
	case inner.Categories != nil:
		sub, subArgs, ok := inner.workConditions(workReadSegments, "g.", true)
		if !ok {
			return nil, nil, false, nil
		}
		conds = append(conds, "EXISTS (SELECT 1 FROM work_session_segments g WHERE g.session_id = s.session_id AND g.team = s.team AND "+strings.Join(sub, " AND ")+")")
		args = append(args, subArgs...)
	}
	return conds, args, true, nil
}

// ListWorkSessions returns a page of sessions and the number of sessions that
// match, which stops at WorkCountCap.
func (s *SQLStore) ListWorkSessions(ctx context.Context, q WorkSessionQuery) ([]WorkSessionRow, int64, error) {
	out := []WorkSessionRow{}
	conds, args, possible, err := s.workSessionConditions(q)
	if err != nil || !possible {
		return out, 0, err
	}
	if q.Limit <= 0 || q.Limit > WorkIntelMaxBatch {
		q.Limit = 50
	}
	if q.Offset < 0 {
		q.Offset = 0
	}
	where := strings.Join(conds, " AND ")
	var count int64
	if err := s.db.QueryRowContext(ctx, s.bind("SELECT COUNT(*) FROM (SELECT 1 FROM work_sessions s WHERE "+where+" LIMIT ?) capped"),
		cleanArgs(append(append([]any{}, args...), WorkCountCap))...).Scan(&count); err != nil {
		return nil, 0, err
	}
	order := "s.last_at"
	switch q.SortBy {
	case "requests":
		order = "s.requests"
	case "cost_krw":
		order = "s.cost_krw"
	case "errors":
		order = "s.errors"
	case "duration_ms":
		// The span is the difference of two stored timestamps; each database has
		// its own way of subtracting them.
		order = "(julianday(s.last_at) - julianday(s.first_at))"
		if s.dialect == "postgres" {
			order = "(CAST(s.last_at AS timestamptz) - CAST(s.first_at AS timestamptz))"
		}
	}
	direction := " ASC"
	if q.Desc {
		direction = " DESC"
	}
	query := "SELECT " + workSessionRowColumns + " FROM work_sessions s WHERE " + where +
		" ORDER BY " + order + direction + ", s.session_id ASC, s.team ASC LIMIT ? OFFSET ?"
	err = s.workQueryRows(ctx, query, append(append([]any{}, args...), q.Limit, q.Offset), func(row workRowScanner) error {
		session, err := scanWorkSessionRow(row)
		if err == nil {
			out = append(out, session)
		}
		return err
	})
	return out, count, err
}

// WorkSessionHeads returns the heads of one session id: one per team that used
// the id, newest first, restricted to the given teams.
func (s *SQLStore) WorkSessionHeads(ctx context.Context, sessionID string, teams []string, scoped bool) ([]WorkSessionRow, error) {
	out := []WorkSessionRow{}
	conds := []string{"s.session_id = ?"}
	args := []any{sessionID}
	cond, teamArgs, possible := workTeamCondition("s.team", teams, scoped)
	if !possible {
		return out, nil
	}
	if cond != "" {
		conds = append(conds, cond)
		args = append(args, teamArgs...)
	}
	err := s.workQueryRows(ctx, "SELECT "+workSessionRowColumns+" FROM work_sessions s WHERE "+strings.Join(conds, " AND ")+
		" ORDER BY s.last_at DESC, s.team ASC", args, func(row workRowScanner) error {
		session, err := scanWorkSessionRow(row)
		if err == nil {
			out = append(out, session)
		}
		return err
	})
	return out, err
}

// WorkSegmentRow is what one session did in one category on one day.
type WorkSegmentRow struct {
	CategoryID string
	Day        string
	FirstAt    string
	LastAt     string
	Requests   int64
	CostKRW    float64
}

// WorkSessionSegments returns the segments of one session of one team, oldest first.
func (s *SQLStore) WorkSessionSegments(ctx context.Context, sessionID, team string) ([]WorkSegmentRow, error) {
	out := []WorkSegmentRow{}
	err := s.workQueryRows(ctx, `SELECT category_id, day, first_at, last_at, requests, cost_krw
		FROM work_session_segments WHERE session_id = ? AND team = ? ORDER BY first_at ASC, category_id ASC`, []any{sessionID, team},
		func(row workRowScanner) error {
			var seg WorkSegmentRow
			if err := row.Scan(&seg.CategoryID, &seg.Day, &seg.FirstAt, &seg.LastAt, &seg.Requests, &seg.CostKRW); err != nil {
				return err
			}
			out = append(out, seg)
			return nil
		})
	return out, err
}

// ---- Requests ----

// WorkFactQuery selects a page of facts, newest first.
type WorkFactQuery struct {
	Filter WorkFilter
	Limit  int
	Offset int
}

// ListWorkFacts returns a page of the facts of a period, newest first, and the
// number of facts that match, which stops at WorkCountCap.
func (s *SQLStore) ListWorkFacts(ctx context.Context, q WorkFactQuery) ([]WorkClassification, int64, error) {
	out := []WorkClassification{}
	conds, args, possible := q.Filter.workConditions(workReadFacts, "", true)
	if !possible {
		return out, 0, nil
	}
	if q.Limit <= 0 || q.Limit > WorkIntelMaxBatch {
		q.Limit = 50
	}
	if q.Offset < 0 {
		q.Offset = 0
	}
	where := strings.Join(conds, " AND ")
	var count int64
	if err := s.db.QueryRowContext(ctx, s.bind("SELECT COUNT(*) FROM (SELECT 1 FROM work_classifications WHERE "+where+" LIMIT ?) capped"),
		cleanArgs(append(append([]any{}, args...), WorkCountCap))...).Scan(&count); err != nil {
		return nil, 0, err
	}
	// The day comes first so the day index delivers the order and only the rows
	// of the newest days are sorted; the day follows from created_at, so this is
	// the order of created_at.
	query := "SELECT " + workFactColumns + " FROM work_classifications WHERE " + where +
		" ORDER BY day DESC, created_at DESC, request_id DESC LIMIT ? OFFSET ?"
	err := s.workQueryRows(ctx, query, append(append([]any{}, args...), q.Limit, q.Offset), func(row workRowScanner) error {
		fact, err := scanWorkFact(row)
		if err == nil {
			out = append(out, fact)
		}
		return err
	})
	return out, count, err
}

// WorkSessionFacts returns up to limit facts of one session of one team, in
// the order the requests were ingested.
func (s *SQLStore) WorkSessionFacts(ctx context.Context, sessionID, team string, limit int) ([]WorkClassification, error) {
	if limit <= 0 || limit > WorkIntelMaxBatch {
		limit = 200
	}
	out := []WorkClassification{}
	err := s.workQueryRows(ctx, `SELECT `+workFactColumns+` FROM work_classifications
		WHERE session_id = ? AND team = ? ORDER BY ingested_at ASC, request_id ASC LIMIT ?`, []any{sessionID, team, limit},
		func(row workRowScanner) error {
			fact, err := scanWorkFact(row)
			if err == nil {
				out = append(out, fact)
			}
			return err
		})
	return out, err
}

// WorkFactSummary describes the facts a filter selects.
type WorkFactSummary struct {
	Total    int64
	ByStatus map[string]int64
	ByMethod map[string]int64
	// NeedsLLM counts the facts still waiting for the semantic step.
	NeedsLLM int64
	// Days lists the days that have matching facts, oldest first.
	Days []string
}

// WorkFactSummary counts the facts of a period by status and method.
func (s *SQLStore) WorkFactSummary(ctx context.Context, f WorkFilter) (WorkFactSummary, error) {
	out := WorkFactSummary{ByStatus: map[string]int64{}, ByMethod: map[string]int64{}, Days: []string{}}
	conds, args, possible := f.workConditions(workReadFacts, "", true)
	if !possible {
		return out, nil
	}
	days := map[string]bool{}
	err := s.workQueryRows(ctx, "SELECT day, status, method, needs_llm, COUNT(*) FROM work_classifications WHERE "+
		strings.Join(conds, " AND ")+" GROUP BY day, status, method, needs_llm", args, func(row workRowScanner) error {
		var day, status, method string
		var needsLLM int
		var n int64
		if err := row.Scan(&day, &status, &method, &needsLLM, &n); err != nil {
			return err
		}
		out.Total += n
		out.ByStatus[status] += n
		out.ByMethod[method] += n
		if needsLLM != 0 {
			out.NeedsLLM += n
		}
		days[day] = true
		return nil
	})
	for day := range days {
		out.Days = append(out.Days, day)
	}
	sort.Strings(out.Days)
	return out, err
}

// WorkTextProbeCap is how many selected facts WorkFactsWithoutText looks up
// in prompt_logs at most.
const WorkTextProbeCap = 50000

// WorkFactsWithoutText counts the facts a filter selects whose request has no
// stored user prompt text any more. Prompts are purged earlier than requests,
// so for an older period this is most of them. Each fact is looked up in
// prompt_logs through its request index, so the lookup is bounded: at most
// probeCap facts of the selection are looked at (WorkTextProbeCap when it is
// not positive), and capped reports that the selection was larger, in which
// case the count is a lower bound. It belongs to a reviewed preview, not to a
// dashboard.
func (s *SQLStore) WorkFactsWithoutText(ctx context.Context, f WorkFilter, exceptMethod string, exceptStatuses []string, probeCap int) (count int64, capped bool, err error) {
	if probeCap <= 0 {
		probeCap = WorkTextProbeCap
	}
	conds, args, possible := f.workConditions(workReadFacts, "c.", true)
	if !possible {
		return 0, false, nil
	}
	if exceptMethod != "" {
		conds = append(conds, "c.method <> ?")
		args = append(args, exceptMethod)
	}
	if len(exceptStatuses) > 0 {
		conds = append(conds, "c.status NOT IN ("+placeholders(len(exceptStatuses))+")")
		args = append(args, workAnyArgs(exceptStatuses)...)
	}
	// One more than the cap is selected, to tell whether there were more.
	args = append(args, probeCap+1)
	var probed int64
	err = s.db.QueryRowContext(ctx, s.bind("SELECT COUNT(*), COALESCE(SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM prompt_logs p WHERE p.request_id = x.request_id"+
		" AND LOWER(p.role) IN ('user', 'input') AND TRIM(COALESCE(p.redacted_text, '')) <> '') THEN 1 ELSE 0 END), 0)"+
		" FROM (SELECT c.request_id FROM work_classifications c WHERE "+strings.Join(conds, " AND ")+" LIMIT ?) x"),
		cleanArgs(args)...).Scan(&probed, &count)
	return count, probed > int64(probeCap), err
}

// WorkFactPage returns the next facts of one day after a (created_at,
// request_id) checkpoint, in that order. It is how a job walks a selection in
// chunks and resumes where it stopped.
func (s *SQLStore) WorkFactPage(ctx context.Context, f WorkFilter, day, afterCreatedAt, afterRequestID string, limit int) ([]WorkClassification, error) {
	if limit <= 0 || limit > WorkIntelMaxBatch {
		limit = 200
	}
	f.From, f.To = day, day
	out := []WorkClassification{}
	conds, args, possible := f.workConditions(workReadFacts, "", true)
	if !possible {
		return out, nil
	}
	conds = append(conds, "(created_at > ? OR (created_at = ? AND request_id > ?))")
	args = append(args, afterCreatedAt, afterCreatedAt, afterRequestID, limit)
	err := s.workQueryRows(ctx, "SELECT "+workFactColumns+" FROM work_classifications WHERE "+strings.Join(conds, " AND ")+
		" ORDER BY created_at ASC, request_id ASC LIMIT ?", args, func(row workRowScanner) error {
		fact, err := scanWorkFact(row)
		if err == nil {
			out = append(out, fact)
		}
		return err
	})
	return out, err
}

// WorkHintCount is a category a model proposed that the policy does not have.
type WorkHintCount struct {
	Hint  string `json:"hint"`
	Count int64  `json:"count"`
}

// WorkCategoryHints returns the most frequent new-category hints among the
// facts a filter selects.
func (s *SQLStore) WorkCategoryHints(ctx context.Context, f WorkFilter, limit int) ([]WorkHintCount, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	out := []WorkHintCount{}
	conds, args, possible := f.workConditions(workReadFacts, "", true)
	if !possible {
		return out, nil
	}
	conds = append(conds, "new_category_hint <> ''")
	err := s.workQueryRows(ctx, "SELECT new_category_hint, COUNT(*) FROM work_classifications WHERE "+strings.Join(conds, " AND ")+
		" GROUP BY new_category_hint ORDER BY COUNT(*) DESC, new_category_hint ASC LIMIT ?", append(args, limit), func(row workRowScanner) error {
		var hint WorkHintCount
		if err := row.Scan(&hint.Hint, &hint.Count); err != nil {
			return err
		}
		out = append(out, hint)
		return nil
	})
	return out, err
}

// ---- Models ----

// WorkModelSessions is the session side of one category and model.
type WorkModelSessions struct {
	Category string
	Model    string
	Provider string
	Sessions int64
	// Switched counts the sessions that changed model at least once.
	Switched int64
}

// WorkModelSessions counts, per folded category, model and provider, the
// sessions that used the model for that work and how many of them switched
// models. Which model served which request is only known per request, so this
// reads the facts of the period.
func (s *SQLStore) WorkModelSessions(ctx context.Context, f WorkFilter, fold map[string]string) ([]WorkModelSessions, error) {
	out := []WorkModelSessions{}
	conds, args, possible := f.workConditions(workReadFacts, "", false)
	if !possible || len(fold) == 0 {
		return out, nil
	}
	key, keyArgs := workFoldExpr("category_id", fold)
	query := "SELECT x.k, x.model, x.provider, COUNT(*), COALESCE(SUM(CASE WHEN s.model_switches > 0 THEN 1 ELSE 0 END), 0)" +
		" FROM (SELECT DISTINCT " + key + " AS k, model, provider, session_id, team FROM work_classifications WHERE " +
		strings.Join(conds, " AND ") + " AND session_id <> '') x" +
		" LEFT JOIN work_sessions s ON s.session_id = x.session_id AND s.team = x.team" +
		" GROUP BY x.k, x.model, x.provider"
	err := s.workQueryRows(ctx, query, append(keyArgs, args...), func(row workRowScanner) error {
		var m WorkModelSessions
		if err := row.Scan(&m.Category, &m.Model, &m.Provider, &m.Sessions, &m.Switched); err != nil {
			return err
		}
		if m.Category != "" {
			out = append(out, m)
		}
		return nil
	})
	return out, err
}

// WorkModelFeedback is the feedback given on the requests of one category and model.
type WorkModelFeedback struct {
	Category string
	Model    string
	Provider string
	Positive int64
	Negative int64
}

// WorkModelFeedback counts positive and negative feedback per folded category,
// model and provider. Feedback is joined to the classified request it was given
// on; the day range bounds the facts.
func (s *SQLStore) WorkModelFeedback(ctx context.Context, f WorkFilter, fold map[string]string) ([]WorkModelFeedback, error) {
	out := []WorkModelFeedback{}
	conds, args, possible := f.workConditions(workReadFacts, "c.", false)
	if !possible || len(fold) == 0 {
		return out, nil
	}
	key, keyArgs := workFoldExpr("c.category_id", fold)
	query := "SELECT " + key + ", c.model, c.provider, COALESCE(SUM(CASE WHEN fb.rating > 0 THEN 1 ELSE 0 END), 0)," +
		" COALESCE(SUM(CASE WHEN fb.rating < 0 THEN 1 ELSE 0 END), 0)" +
		" FROM llm_feedback fb JOIN work_classifications c ON c.request_id = fb.request_id WHERE " +
		strings.Join(conds, " AND ") + " GROUP BY 1, 2, 3"
	err := s.workQueryRows(ctx, query, append(keyArgs, args...), func(row workRowScanner) error {
		var m WorkModelFeedback
		if err := row.Scan(&m.Category, &m.Model, &m.Provider, &m.Positive, &m.Negative); err != nil {
			return err
		}
		if m.Category != "" {
			out = append(out, m)
		}
		return nil
	})
	return out, err
}

// ---- Productivity ----

// WorkCategorySessions is the session picture of one folded category.
type WorkCategorySessions struct {
	Category string
	Sessions int64
	// Confirmed counts the sessions whose completion was confirmed by feedback.
	Confirmed int64
	// ModelTimeMS is the summed latency of the category's requests.
	ModelTimeMS int64
}

// WorkCategorySessions returns, per folded category, the sessions that worked
// on it in the period, how many of them are confirmed as completed, and the
// model time spent. It reads the session segments, or the facts when the
// filter needs something only a request has.
func (s *SQLStore) WorkCategorySessions(ctx context.Context, f WorkFilter, fold map[string]string) ([]WorkCategorySessions, error) {
	out := []WorkCategorySessions{}
	table := workReadSegments
	if f.distinctFromFacts() {
		table = workReadFacts
	}
	conds, args, possible := f.workConditions(table, "g.", false)
	if !possible || len(fold) == 0 {
		return out, nil
	}
	if table.facts {
		conds = append(conds, "g.session_id <> ''")
	}
	key, keyArgs := workFoldExpr("g.category_id", fold)
	query := "SELECT x.k, COUNT(*), COALESCE(SUM(CASE WHEN s.completion = '" + WorkCompletionConfirmed + "' THEN 1 ELSE 0 END), 0), COALESCE(SUM(x.lat), 0)" +
		" FROM (SELECT " + key + " AS k, g.session_id AS sid, g.team AS tid, SUM(g.latency_ms) AS lat FROM " + table.name + " g WHERE " +
		strings.Join(conds, " AND ") + " GROUP BY 1, 2, 3) x" +
		" LEFT JOIN work_sessions s ON s.session_id = x.sid AND s.team = x.tid GROUP BY x.k"
	err := s.workQueryRows(ctx, query, append(keyArgs, args...), func(row workRowScanner) error {
		var c WorkCategorySessions
		if err := row.Scan(&c.Category, &c.Sessions, &c.Confirmed, &c.ModelTimeMS); err != nil {
			return err
		}
		if c.Category != "" {
			out = append(out, c)
		}
		return nil
	})
	return out, err
}

// ---- Repeated patterns (automation candidates) ----

// WorkPatternStats are the counts of a repeated request pattern, overall or
// for one team.
type WorkPatternStats struct {
	Team       string  `json:"team,omitempty"`
	Repeats    int64   `json:"repeats"`
	Users      int64   `json:"users"`
	Sessions   int64   `json:"sessions"`
	ActiveDays int64   `json:"active_days"`
	MCPCalls   int64   `json:"mcp_calls"`
	LatencyMS  int64   `json:"latency_ms"`
	CostKRW    float64 `json:"cost_krw"`
	// Flagged counts the requests a DLP or secret policy acted on.
	Flagged int64 `json:"flagged"`
	// Actions, ToolSigs and Hours count a team's requests of the pattern by
	// action type, by the set of tools they called and by UTC hour of the day.
	// They are kept per team (not on the total), so a view confined to some
	// teams can describe the pattern by those teams' requests alone. ToolSigs
	// keeps the workPatternTeamSigs most common sets.
	Actions  map[string]int64 `json:"actions,omitempty"`
	ToolSigs map[string]int64 `json:"tool_sigs,omitempty"`
	Hours    map[string]int64 `json:"hours,omitempty"`
}

// workPatternTeamSigs bounds the tool sets kept per team of a pattern.
const workPatternTeamSigs = 20

// WorkPattern is one prompt fingerprint that repeated within a category.
type WorkPattern struct {
	Fingerprint string
	CategoryID  string
	// ActionType is the action most of the pattern's requests asked for.
	ActionType string
	Total      WorkPatternStats
	// Teams splits the pattern by team, largest first.
	Teams []WorkPatternStats
	// Tools lists the tools the pattern called, most used first.
	Tools []string
	// SameToolSequence is the number of requests that called the most common
	// set of tools; HourConcentration the share of requests in the busiest hour
	// of the day.
	SameToolSequence  int64
	HourConcentration float64
}

const workPatternStatColumns = `COUNT(*), COUNT(DISTINCT user_key), COUNT(DISTINCT CASE WHEN session_id <> '' THEN session_id END),
	COUNT(DISTINCT day), COALESCE(SUM(mcp_calls), 0), COALESCE(SUM(latency_ms), 0), COALESCE(SUM(cost_krw), 0),
	COALESCE(SUM(CASE WHEN policy_flags <> '' THEN 1 ELSE 0 END), 0)`

func (st *WorkPatternStats) scanTargets() []any {
	return []any{&st.Repeats, &st.Users, &st.Sessions, &st.ActiveDays, &st.MCPCalls, &st.LatencyMS, &st.CostKRW, &st.Flagged}
}

// workPatternChunk bounds the fingerprints of one IN list.
const workPatternChunk = 200

// WorkPatterns returns the prompt fingerprints that repeated at least
// minRepeats times within one category during the period, most repeated
// first, at most limit of them. The first query walks the facts of the period
// by day; the detail queries then look the chosen fingerprints up through the
// fingerprint index.
func (s *SQLStore) WorkPatterns(ctx context.Context, from, to string, minRepeats, limit int) ([]WorkPattern, error) {
	if minRepeats < 2 {
		minRepeats = 2
	}
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	type pairKey struct{ fingerprint, category string }
	patterns := []*WorkPattern{}
	index := map[pairKey]*WorkPattern{}
	err := s.workQueryRows(ctx, `SELECT fingerprint, category_id, `+workPatternStatColumns+`
		FROM work_classifications WHERE day >= ? AND day <= ? AND fingerprint <> ''
		GROUP BY fingerprint, category_id HAVING COUNT(*) >= ?
		ORDER BY COUNT(*) DESC, fingerprint ASC, category_id ASC LIMIT ?`, []any{from, to, minRepeats, limit},
		func(row workRowScanner) error {
			p := &WorkPattern{Teams: []WorkPatternStats{}, Tools: []string{}}
			if err := row.Scan(append([]any{&p.Fingerprint, &p.CategoryID}, p.Total.scanTargets()...)...); err != nil {
				return err
			}
			patterns = append(patterns, p)
			index[pairKey{p.Fingerprint, p.CategoryID}] = p
			return nil
		})
	if err != nil || len(patterns) == 0 {
		return []WorkPattern{}, err
	}
	fingerprints := []string{}
	seen := map[string]bool{}
	for _, p := range patterns {
		if !seen[p.Fingerprint] {
			seen[p.Fingerprint] = true
			fingerprints = append(fingerprints, p.Fingerprint)
		}
	}

	type count struct {
		value string
		n     int64
	}
	actions := map[pairKey][]count{}
	sigs := map[pairKey][]count{}
	hours := map[pairKey][]count{}
	// The same counts per team: pattern → team → value → requests.
	type teamCounts map[string]map[string]int64
	perTeam := map[string]map[pairKey]teamCounts{"action_type": {}, "tool_sig": {}, "hour": {}}
	for _, chunk := range workChunks(fingerprints, workPatternChunk) {
		in := placeholders(len(chunk))
		args := append(workAnyArgs(chunk), from, to)
		if err := s.workQueryRows(ctx, `SELECT fingerprint, category_id, team, `+workPatternStatColumns+`
			FROM work_classifications WHERE fingerprint IN (`+in+`) AND day >= ? AND day <= ?
			GROUP BY fingerprint, category_id, team`, args, func(row workRowScanner) error {
			var key pairKey
			var st WorkPatternStats
			if err := row.Scan(append([]any{&key.fingerprint, &key.category, &st.Team}, st.scanTargets()...)...); err != nil {
				return err
			}
			if p := index[key]; p != nil {
				p.Teams = append(p.Teams, st)
			}
			return nil
		}); err != nil {
			return nil, err
		}
		for _, detail := range []struct {
			name, column string
			into         map[pairKey][]count
		}{
			{"action_type", "action_type", actions},
			{"tool_sig", "tool_sig", sigs},
			// Timestamps are stored in UTC with a fixed width, so characters 12-13
			// are the hour. The share of the busiest hour is the same in any zone
			// that differs from UTC by whole hours.
			{"hour", "SUBSTR(created_at, 12, 2)", hours},
		} {
			whole := map[pairKey]map[string]int64{}
			if err := s.workQueryRows(ctx, `SELECT fingerprint, category_id, team, `+detail.column+`, COUNT(*)
				FROM work_classifications WHERE fingerprint IN (`+in+`) AND day >= ? AND day <= ?
				GROUP BY fingerprint, category_id, team, `+detail.column, args, func(row workRowScanner) error {
				var key pairKey
				var team string
				var c count
				if err := row.Scan(&key.fingerprint, &key.category, &team, &c.value, &c.n); err != nil {
					return err
				}
				if index[key] == nil {
					return nil
				}
				if whole[key] == nil {
					whole[key] = map[string]int64{}
				}
				whole[key][c.value] += c.n
				byTeam := perTeam[detail.name][key]
				if byTeam == nil {
					byTeam = teamCounts{}
					perTeam[detail.name][key] = byTeam
				}
				if byTeam[team] == nil {
					byTeam[team] = map[string]int64{}
				}
				byTeam[team][c.value] += c.n
				return nil
			}); err != nil {
				return nil, err
			}
			for key, values := range whole {
				for value, n := range values {
					detail.into[key] = append(detail.into[key], count{value, n})
				}
			}
		}
	}

	largest := func(counts []count) (string, int64) {
		best, bestN := "", int64(0)
		for _, c := range counts {
			if c.n > bestN || (c.n == bestN && c.value < best) {
				best, bestN = c.value, c.n
			}
		}
		return best, bestN
	}
	out := make([]WorkPattern, 0, len(patterns))
	for _, p := range patterns {
		key := pairKey{p.Fingerprint, p.CategoryID}
		sort.Slice(p.Teams, func(i, j int) bool {
			if p.Teams[i].Repeats != p.Teams[j].Repeats {
				return p.Teams[i].Repeats > p.Teams[j].Repeats
			}
			return p.Teams[i].Team < p.Teams[j].Team
		})
		for i := range p.Teams {
			team := p.Teams[i].Team
			p.Teams[i].Actions = perTeam["action_type"][key][team]
			p.Teams[i].ToolSigs = workPatternTopCounts(perTeam["tool_sig"][key][team], workPatternTeamSigs)
			p.Teams[i].Hours = perTeam["hour"][key][team]
		}
		p.ActionType, _ = largest(actions[key])
		_, p.SameToolSequence = largest(sigs[key])
		if _, busiest := largest(hours[key]); p.Total.Repeats > 0 {
			p.HourConcentration = float64(busiest) / float64(p.Total.Repeats)
		}
		uses := map[string]int64{}
		for _, sig := range sigs[key] {
			for _, tool := range strings.Split(sig.value, ",") {
				if tool = strings.TrimSpace(tool); tool != "" {
					uses[tool] += sig.n
				}
			}
		}
		for tool := range uses {
			p.Tools = append(p.Tools, tool)
		}
		sort.Slice(p.Tools, func(i, j int) bool {
			if uses[p.Tools[i]] != uses[p.Tools[j]] {
				return uses[p.Tools[i]] > uses[p.Tools[j]]
			}
			return p.Tools[i] < p.Tools[j]
		})
		out = append(out, *p)
	}
	return out, nil
}

// workPatternTopCounts keeps the n largest counts, ties by value.
func workPatternTopCounts(counts map[string]int64, n int) map[string]int64 {
	if len(counts) <= n {
		return counts
	}
	values := make([]string, 0, len(counts))
	for value := range counts {
		values = append(values, value)
	}
	sort.Slice(values, func(i, j int) bool {
		if counts[values[i]] != counts[values[j]] {
			return counts[values[i]] > counts[values[j]]
		}
		return values[i] < values[j]
	})
	out := make(map[string]int64, n)
	for _, value := range values[:n] {
		out[value] = counts[value]
	}
	return out
}

// ---- Stored generation: automation candidates and insights ----

// Review states of an automation candidate. Recording one changes nothing
// else: no candidate is ever registered or run by the gateway.
const (
	WorkReviewNew       = "new"
	WorkReviewReviewing = "reviewing"
	WorkReviewAccepted  = "accepted"
	WorkReviewDismissed = "dismissed"
)

// WorkAutomationCandidate is one row of work_automation_candidates. The
// payload belongs to the proxy package.
type WorkAutomationCandidate struct {
	ID           string
	PayloadJSON  string
	ReviewStatus string
	ReviewNote   string
	ReviewedBy   string
	ReviewedAt   string
	ComputedAt   string
}

// WorkInsightRow is one row of work_insights.
type WorkInsightRow struct {
	ID           string
	Kind         string
	Severity     string
	Title        string
	Body         string
	EvidenceJSON string
	LinkJSON     string
	PeriodFrom   string
	PeriodTo     string
	CreatedAt    string
}

// ReplaceWorkGeneration stores one generation of automation candidates and
// insights in place of the previous one, in one transaction: a reader sees the
// old generation or the new one, never a mixture.
//
// A candidate whose id was already stored keeps its review state; candidates
// that no longer repeat are removed with whatever was recorded on them.
func (s *SQLStore) ReplaceWorkGeneration(ctx context.Context, at time.Time, candidates []WorkAutomationCandidate, insights []WorkInsightRow) error {
	stamp := workIntelTime(at)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	args := make([]any, 0, len(candidates)*3)
	for _, c := range candidates {
		if c.ID == "" {
			return errors.New("work intel: automation candidate without an id")
		}
		args = append(args, c.ID, c.PayloadJSON, stamp)
	}
	if _, err := s.workBatchExec(ctx, tx, `INSERT INTO work_automation_candidates (id, payload_json, computed_at)`, workRowPlaceholder(3),
		`ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, computed_at = excluded.computed_at`, 3, args); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, s.bind(`DELETE FROM work_automation_candidates WHERE computed_at <> ?`), stamp); err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM work_insights`); err != nil {
		return err
	}
	args = make([]any, 0, len(insights)*10)
	for _, in := range insights {
		if in.ID == "" {
			return errors.New("work intel: insight without an id")
		}
		args = append(args, in.ID, in.Kind, in.Severity, in.Title, in.Body, in.EvidenceJSON, in.LinkJSON, in.PeriodFrom, in.PeriodTo, stamp)
	}
	if _, err := s.workBatchExec(ctx, tx, `INSERT INTO work_insights (id, kind, severity, title, body, evidence_json, link_json, period_from, period_to, created_at)`,
		workRowPlaceholder(10), `ON CONFLICT(id) DO NOTHING`, 10, args); err != nil {
		return err
	}
	return tx.Commit()
}

const workCandidateColumns = `id, payload_json, review_status, review_note, reviewed_by, reviewed_at, computed_at`

func scanWorkCandidate(row workRowScanner) (WorkAutomationCandidate, error) {
	var c WorkAutomationCandidate
	err := row.Scan(&c.ID, &c.PayloadJSON, &c.ReviewStatus, &c.ReviewNote, &c.ReviewedBy, &c.ReviewedAt, &c.ComputedAt)
	return c, err
}

// ListWorkAutomationCandidates returns the stored candidates in a fixed order.
func (s *SQLStore) ListWorkAutomationCandidates(ctx context.Context) ([]WorkAutomationCandidate, error) {
	out := []WorkAutomationCandidate{}
	err := s.workQueryRows(ctx, `SELECT `+workCandidateColumns+` FROM work_automation_candidates ORDER BY id ASC LIMIT 1000`, nil,
		func(row workRowScanner) error {
			c, err := scanWorkCandidate(row)
			if err == nil {
				out = append(out, c)
			}
			return err
		})
	return out, err
}

// GetWorkAutomationCandidate returns one stored candidate.
func (s *SQLStore) GetWorkAutomationCandidate(ctx context.Context, id string) (WorkAutomationCandidate, bool, error) {
	c, err := scanWorkCandidate(s.db.QueryRowContext(ctx, s.bind(`SELECT `+workCandidateColumns+` FROM work_automation_candidates WHERE id = ?`), id))
	if errors.Is(err, sql.ErrNoRows) {
		return WorkAutomationCandidate{}, false, nil
	}
	return c, err == nil, err
}

// SetWorkAutomationReview records a review decision on a candidate. It reports
// false when the candidate does not exist (any more).
func (s *SQLStore) SetWorkAutomationReview(ctx context.Context, id, status, note, actor string) (WorkAutomationCandidate, bool, error) {
	res, err := s.db.ExecContext(ctx, s.bind(`UPDATE work_automation_candidates SET review_status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ?
		WHERE id = ?`), cleanArgs([]any{status, note, actor, workIntelTime(time.Now()), id})...)
	if err != nil {
		return WorkAutomationCandidate{}, false, err
	}
	if n, err := res.RowsAffected(); err != nil || n == 0 {
		return WorkAutomationCandidate{}, false, err
	}
	return s.GetWorkAutomationCandidate(ctx, id)
}

// ListWorkInsights returns the stored generation of insights ordered by id.
// The writer numbers the ids, so this is the order it ranked them in.
func (s *SQLStore) ListWorkInsights(ctx context.Context) ([]WorkInsightRow, error) {
	out := []WorkInsightRow{}
	err := s.workQueryRows(ctx, `SELECT id, kind, severity, title, body, evidence_json, link_json, period_from, period_to, created_at
		FROM work_insights ORDER BY id ASC LIMIT 500`, nil, func(row workRowScanner) error {
		var in WorkInsightRow
		if err := row.Scan(&in.ID, &in.Kind, &in.Severity, &in.Title, &in.Body, &in.EvidenceJSON, &in.LinkJSON, &in.PeriodFrom, &in.PeriodTo, &in.CreatedAt); err != nil {
			return err
		}
		out = append(out, in)
		return nil
	})
	return out, err
}
