package store

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"
)

// What to index next.
//
// Drift answers "does the database match what we declared". This answers the other half:
// "is what we declared the right set". The two are separate questions and a database can
// be perfectly in sync and still be missing the index that matters.
//
// Everything here is grounded in something the database itself reports, not in a
// hand-written list of suspicions:
//
//   - Postgres counts sequential scans and index scans per table, and index scans per
//     index. A table being read by scanning it is the definition of a missing index, and
//     an index nobody has scanned is write cost with no read benefit.
//   - A table with no index other than the one enforcing its primary key can only be
//     searched by scanning, whatever the driver.
//
// SQLite keeps no such counters. Rather than invent numbers for it, the report says so
// and falls back to what is still knowable there.
//
// Nothing here executes DDL. Each item carries the statement an operator would run, for
// them to review — an index is a write-path cost and a storage cost, and which of those
// is worth paying is not a decision this code should make on its own.

// IndexAdvice is one recommendation.
type IndexAdvice struct {
	// Kind is "add" (an index worth creating) or "drop" (one that is not earning its
	// write cost).
	Kind string `json:"kind"`
	// Severity is "high", "medium" or "low", ordering the list for someone who will only
	// act on the top of it.
	Severity string   `json:"severity"`
	Table    string   `json:"table"`
	Index    string   `json:"index,omitempty"`
	Columns  []string `json:"columns,omitempty"`
	Reason   string   `json:"reason"`
	// Evidence is the measurement behind the reason, so the recommendation can be argued
	// with rather than taken on faith.
	Evidence string `json:"evidence"`
	SQL      string `json:"sql,omitempty"`
}

// IndexAdviceReport is the whole set, plus what the report could not see.
type IndexAdviceReport struct {
	Dialect string        `json:"dialect"`
	Items   []IndexAdvice `json:"items"`
	// Limitations records what this driver cannot answer, so an empty list is not read as
	// "nothing to do" when it really means "nothing measurable here".
	Limitations []string  `json:"limitations"`
	CheckedAt   time.Time `json:"checked_at"`
}

// tableStat is one row of Postgres' per-table access counters.
type tableStat struct {
	Table       string
	SeqScan     int64
	SeqTupRead  int64
	IdxScan     int64
	LiveTuples  int64
	HasNonPKIdx bool
}

// Thresholds. A table has to be big enough that scanning it is actually expensive, and
// have been read enough times that the counters mean something — a freshly started
// process has zero of everything, and recommending against that is noise.
const (
	adviceMinRows      = 5000
	adviceMinReads     = 100
	adviceMinIndexSize = 1 << 20 // 1 MiB; dropping a tiny unused index saves nothing
)

// IndexAdvice looks at what the database reports about its own access patterns.
func (s *SQLStore) IndexAdvice(ctx context.Context) (IndexAdviceReport, error) {
	report := IndexAdviceReport{
		Dialect:   s.dialect,
		Items:     []IndexAdvice{},
		CheckedAt: time.Now().UTC(),
	}

	live, err := s.LiveIndexes(ctx)
	if err != nil {
		return report, err
	}
	indexedTables := map[string]bool{}
	for _, idx := range live {
		if !idx.Implicit {
			indexedTables[idx.Table] = true
		}
	}

	if s.dialect != "postgres" {
		report.Limitations = append(report.Limitations,
			"SQLite keeps no per-table scan counters, so tables that are being scanned cannot be "+
				"identified here and unused indexes cannot be distinguished from unused-so-far ones. "+
				"Run this against the production Postgres for the full picture.")
		tables, err := s.liteTables(ctx)
		if err != nil {
			return report, err
		}
		for _, t := range tables {
			if indexedTables[t] {
				continue
			}
			report.Items = append(report.Items, IndexAdvice{
				Kind: "add", Severity: "low", Table: t,
				Reason:   "no index other than the primary key, so every lookup that is not by primary key scans the table",
				Evidence: "schema only; this driver reports no access counters",
			})
		}
		sortAdvice(report.Items)
		return report, nil
	}

	stats, err := s.postgresTableStats(ctx)
	if err != nil {
		return report, err
	}
	for i := range stats {
		stats[i].HasNonPKIdx = indexedTables[stats[i].Table]
	}

	for _, st := range stats {
		if advice, ok := adviceForTable(st); ok {
			report.Items = append(report.Items, advice)
		}
	}

	unused, err := s.postgresUnusedIndexes(ctx)
	if err != nil {
		return report, err
	}
	report.Items = append(report.Items, unused...)

	sortAdvice(report.Items)
	return report, nil
}

// adviceForTable turns one table's access counters into advice, or reports that there is
// nothing to say about it. Split out from the query so the judgement can be tested with
// fabricated counters: reproducing "a table with fifty thousand rows that has been
// scanned two hundred times" against a real database means generating that traffic, and a
// test that slow does not get run.
func adviceForTable(st tableStat) (IndexAdvice, bool) {
	// Counters mean nothing until the table has actually been read. A process that just
	// started has zero of everything.
	if st.SeqScan+st.IdxScan < adviceMinReads {
		return IndexAdvice{}, false
	}
	if st.LiveTuples < adviceMinRows {
		return IndexAdvice{}, false
	}
	if !st.HasNonPKIdx {
		return IndexAdvice{
			Kind: "add", Severity: "high", Table: st.Table,
			Reason: "read regularly and has no index other than the primary key, so every " +
				"lookup that is not by primary key reads the whole table",
			Evidence: fmt.Sprintf("%d rows, %d sequential scans, %d index scans",
				st.LiveTuples, st.SeqScan, st.IdxScan),
		}, true
	}
	if st.SeqScan <= st.IdxScan {
		return IndexAdvice{}, false
	}
	// Rows read per scan separates "scanned because it is small" from "scanned because
	// nothing could be used".
	perScan := int64(0)
	if st.SeqScan > 0 {
		perScan = st.SeqTupRead / st.SeqScan
	}
	severity := "medium"
	if st.SeqScan > 10*st.IdxScan && st.LiveTuples >= 10*adviceMinRows {
		severity = "high"
	}
	return IndexAdvice{
		Kind: "add", Severity: severity, Table: st.Table,
		Reason: "scanned more often than it is looked up by index; the columns its queries " +
			"filter and sort on are the ones to index",
		Evidence: fmt.Sprintf("%d rows, %d sequential scans reading %d rows each, %d index scans",
			st.LiveTuples, st.SeqScan, perScan, st.IdxScan),
	}, true
}

func sortAdvice(items []IndexAdvice) {
	rank := map[string]int{"high": 0, "medium": 1, "low": 2}
	sort.SliceStable(items, func(i, j int) bool {
		if rank[items[i].Severity] != rank[items[j].Severity] {
			return rank[items[i].Severity] < rank[items[j].Severity]
		}
		if items[i].Table != items[j].Table {
			return items[i].Table < items[j].Table
		}
		return items[i].Index < items[j].Index
	})
}

func (s *SQLStore) liteTables(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, normalizeIdent(name))
	}
	return out, rows.Err()
}

func (s *SQLStore) postgresTableStats(ctx context.Context) ([]tableStat, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT relname,
			COALESCE(seq_scan, 0), COALESCE(seq_tup_read, 0), COALESCE(idx_scan, 0), COALESCE(n_live_tup, 0)
		FROM pg_stat_user_tables
		WHERE schemaname = current_schema()`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []tableStat
	for rows.Next() {
		var st tableStat
		if err := rows.Scan(&st.Table, &st.SeqScan, &st.SeqTupRead, &st.IdxScan, &st.LiveTuples); err != nil {
			return nil, err
		}
		st.Table = normalizeIdent(st.Table)
		out = append(out, st)
	}
	return out, rows.Err()
}

// postgresUnusedIndexes finds indexes nothing has read. Constraint-backed indexes are
// excluded: a primary key or unique index is there to enforce correctness, and its scan
// count says nothing about whether it should exist.
func (s *SQLStore) postgresUnusedIndexes(ctx context.Context) ([]IndexAdvice, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT si.indexrelname, si.relname,
			COALESCE(si.idx_scan, 0), pg_relation_size(si.indexrelid),
			COALESCE(st.seq_scan, 0) + COALESCE(st.idx_scan, 0)
		FROM pg_stat_user_indexes si
		JOIN pg_stat_user_tables st ON st.relid = si.relid
		LEFT JOIN pg_constraint con ON con.conindid = si.indexrelid
		WHERE si.schemaname = current_schema() AND con.conindid IS NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []IndexAdvice
	for rows.Next() {
		var name, table string
		var scans, size, tableReads int64
		if err := rows.Scan(&name, &table, &scans, &size, &tableReads); err != nil {
			return nil, err
		}
		// Zero scans on a table nobody has read yet means nothing.
		if scans > 0 || tableReads < adviceMinReads || size < adviceMinIndexSize {
			continue
		}
		name, table = normalizeIdent(name), normalizeIdent(table)
		out = append(out, IndexAdvice{
			Kind: "drop", Severity: "medium", Table: table, Index: name,
			Reason: "never used for a read while its table was read, so it costs write time and " +
				"storage without speeding anything up",
			Evidence: fmt.Sprintf("0 index scans across %d reads of %s, %s on disk",
				tableReads, table, humanBytes(size)),
			SQL: "DROP INDEX " + name,
		})
	}
	return out, rows.Err()
}

func humanBytes(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.1f GiB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MiB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KiB", float64(n)/(1<<10))
	default:
		return fmt.Sprintf("%d B", n)
	}
}

// Columns returns the advice's columns as a readable list, for the console.
func (a IndexAdvice) ColumnList() string { return strings.Join(a.Columns, ", ") }
