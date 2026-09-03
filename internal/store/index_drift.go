package store

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Index drift.
//
// The schema is declared as a list of statements in migrationStatements() and applied at
// startup. Nothing ever checked that the database ended up matching it, and three things
// pull the two apart:
//
//   - An operator adds an index by hand to fix a slow query in production. It works, and
//     it is missing from every other environment and from the next fresh install.
//   - An operator drops one. Nothing fails; queries just get slower.
//   - A declared index changes columns. CREATE INDEX IF NOT EXISTS matches on the *name*
//     only, so a database that already has the old definition silently keeps it. This is
//     the dangerous one: the migration reports success and the index is wrong.
//
// The check reads the same list Migrate applies, so there is no second copy of the schema
// to keep in step. Both sides are CREATE INDEX statements — sqlite_master stores the
// original SQL and Postgres reconstructs it in pg_indexes.indexdef — so one parser covers
// both drivers.

// IndexInfo is one index, either declared by a migration or found in the database.
type IndexInfo struct {
	Name    string   `json:"name"`
	Table   string   `json:"table"`
	Columns []string `json:"columns"`
	Unique  bool     `json:"unique"`
	// Implicit marks an index the engine created for a PRIMARY KEY or UNIQUE constraint
	// rather than one somebody wrote a CREATE INDEX for. These are not drift: they follow
	// from the table definition, which the migrations do declare.
	Implicit bool   `json:"implicit"`
	Def      string `json:"definition,omitempty"`
}

// Signature is the part of an index that has to match for two definitions to be the same
// index. The name is excluded because it is the join key, not part of the comparison.
func (i IndexInfo) Signature() string {
	return fmt.Sprintf("%s(%s) unique=%v", i.Table, strings.Join(i.Columns, ","), i.Unique)
}

// IndexDriftItem is one disagreement between the declared schema and the database.
type IndexDriftItem struct {
	// Kind is "missing" (declared, absent from the database), "undeclared" (present in
	// the database, absent from the migrations) or "mismatched" (same name, different
	// definition).
	Kind     string     `json:"kind"`
	Name     string     `json:"name"`
	Table    string     `json:"table"`
	Declared *IndexInfo `json:"declared,omitempty"`
	Live     *IndexInfo `json:"live,omitempty"`
	Detail   string     `json:"detail"`
	// Fix is the statement that would resolve the drift, for an operator to review. It is
	// never executed by the gateway.
	Fix string `json:"fix,omitempty"`
}

// IndexDriftReport is the whole comparison.
type IndexDriftReport struct {
	Dialect       string           `json:"dialect"`
	DeclaredCount int              `json:"declared_count"`
	LiveCount     int              `json:"live_count"`
	ImplicitCount int              `json:"implicit_count"`
	Items         []IndexDriftItem `json:"items"`
	CheckedAt     time.Time        `json:"checked_at"`
}

// InSync reports whether the database matches what the migrations declare.
func (r IndexDriftReport) InSync() bool { return len(r.Items) == 0 }

var createIndexHeadRe = regexp.MustCompile(
	`(?is)^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)\s+ON\s+([^\s(]+)`)

// parseCreateIndex reads one CREATE INDEX statement. It returns ok=false for anything
// else, which is how the declared list is filtered down from every migration statement.
func parseCreateIndex(stmt string) (IndexInfo, bool) {
	m := createIndexHeadRe.FindStringSubmatch(stmt)
	if m == nil {
		return IndexInfo{}, false
	}
	cols, ok := indexColumnList(stmt[len(m[0]):])
	if !ok {
		return IndexInfo{}, false
	}
	return IndexInfo{
		Name:    normalizeIdent(m[2]),
		Table:   normalizeIdent(m[3]),
		Columns: cols,
		Unique:  strings.TrimSpace(m[1]) != "",
		Def:     strings.Join(strings.Fields(stmt), " "),
	}, true
}

// indexColumnList extracts the key columns from what follows the table name. It has to
// find the balanced parenthesis group rather than the last ")" in the statement, because
// a partial index ends in "WHERE ..." and an expression index nests parentheses of its
// own — both would make a greedy match swallow the wrong text.
func indexColumnList(rest string) ([]string, bool) {
	start := strings.Index(rest, "(")
	if start < 0 {
		return nil, false
	}
	depth, end := 0, -1
	for i := start; i < len(rest); i++ {
		switch rest[i] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				end = i
			}
		}
		if end >= 0 {
			break
		}
	}
	if end < 0 {
		return nil, false
	}
	var cols []string
	depth = 0
	field := strings.Builder{}
	flush := func() {
		if c := normalizeIndexColumn(field.String()); c != "" {
			cols = append(cols, c)
		}
		field.Reset()
	}
	for i := start + 1; i < end; i++ {
		switch c := rest[i]; c {
		case '(':
			depth++
			field.WriteByte(c)
		case ')':
			depth--
			field.WriteByte(c)
		case ',':
			if depth == 0 {
				flush()
			} else {
				field.WriteByte(c)
			}
		default:
			field.WriteByte(c)
		}
	}
	flush()
	if len(cols) == 0 {
		return nil, false
	}
	return cols, true
}

// normalizeIndexColumn strips the decoration that differs between how a migration writes
// a column and how the database reports it back — quoting, ASC/DESC, null ordering, an
// operator class Postgres appends — so that identical indexes compare equal.
func normalizeIndexColumn(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	for _, suffix := range []string{" nulls first", " nulls last"} {
		s = strings.TrimSuffix(s, suffix)
		s = strings.TrimSpace(s)
	}
	for _, suffix := range []string{" asc", " desc"} {
		s = strings.TrimSuffix(s, suffix)
		s = strings.TrimSpace(s)
	}
	// Postgres appends the operator class for non-default collations, e.g. "name
	// text_pattern_ops". Only trim it when the column is a plain identifier, so an
	// expression index keeps its text intact.
	if fields := strings.Fields(s); len(fields) == 2 && strings.HasSuffix(fields[1], "_ops") {
		s = fields[0]
	}
	// Expressions are not identifiers. Passing one through normalizeIdent would
	// mistake a dot inside a string literal (for example the RFC3339 fraction
	// separator) for a schema qualifier and discard most of the expression.
	// PostgreSQL annotates text literals in reconstructed expression indexes with
	// ::text while SQLite preserves the submitted SQL. Removing only that implicit
	// cast plus insignificant whitespace makes the same portable expression compare
	// equally without hiding changed operators or literals.
	if strings.Contains(s, "(") {
		s = strings.ReplaceAll(s, "::text", "")
		return strings.Join(strings.Fields(s), "")
	}
	return normalizeIdent(s)
}

// normalizeIdent unquotes and lowercases an identifier, and drops a schema qualifier —
// Postgres reports "public.request_logs" where the migration says "request_logs".
func normalizeIdent(raw string) string {
	s := strings.TrimSpace(raw)
	s = strings.Trim(s, `"`+"`"+`[]`)
	if idx := strings.LastIndex(s, "."); idx >= 0 {
		s = s[idx+1:]
	}
	s = strings.Trim(s, `"`+"`"+`[]`)
	return strings.ToLower(s)
}

// DeclaredIndexes returns every index the migrations create, parsed from the same list
// Migrate applies.
func DeclaredIndexes() []IndexInfo {
	var out []IndexInfo
	for _, stmt := range migrationStatements() {
		if info, ok := parseCreateIndex(stmt); ok {
			out = append(out, info)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// LiveIndexes reads the indexes the database actually has.
func (s *SQLStore) LiveIndexes(ctx context.Context) ([]IndexInfo, error) {
	if s.dialect == "postgres" {
		return s.livePostgresIndexes(ctx)
	}
	return s.liveSQLiteIndexes(ctx)
}

func (s *SQLStore) liveSQLiteIndexes(ctx context.Context) ([]IndexInfo, error) {
	// sqlite_master.sql is NULL for the indexes SQLite creates itself to enforce a
	// PRIMARY KEY or UNIQUE column; those are reported as implicit rather than parsed.
	rows, err := s.db.QueryContext(ctx, `SELECT name, tbl_name, COALESCE(sql, '')
		FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex%'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []IndexInfo
	for rows.Next() {
		var name, table, ddl string
		if err := rows.Scan(&name, &table, &ddl); err != nil {
			return nil, err
		}
		if strings.TrimSpace(ddl) == "" {
			out = append(out, IndexInfo{Name: normalizeIdent(name), Table: normalizeIdent(table), Implicit: true})
			continue
		}
		info, ok := parseCreateIndex(ddl)
		if !ok {
			// Unparseable rather than absent: reporting it as implicit keeps it out of
			// the drift list, where it would read as an index nobody declared.
			out = append(out, IndexInfo{Name: normalizeIdent(name), Table: normalizeIdent(table), Implicit: true, Def: ddl})
			continue
		}
		out = append(out, info)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s *SQLStore) livePostgresIndexes(ctx context.Context) ([]IndexInfo, error) {
	// current_schema() rather than 'public': the test suite and multi-tenant installs
	// put the gateway in its own schema via search_path, and hardcoding public would
	// report every index as missing there.
	// Joined on oid throughout. Joining pg_indexes to pg_class by *name* looks equivalent
	// and is not: index names are unique per schema, not per database, so an install that
	// shares a database with other schemas matches every one of their same-named indexes
	// and multiplies the result. Invalid concurrent-build shells are deliberately omitted:
	// a declared one is therefore reported as missing, and Migrate removes/rebuilds it.
	rows, err := s.db.QueryContext(ctx, `SELECT ic.relname, tc.relname,
			pg_get_indexdef(i.indexrelid), COALESCE(con.contype::text, '')
		FROM pg_index i
		JOIN pg_class ic ON ic.oid = i.indexrelid
		JOIN pg_class tc ON tc.oid = i.indrelid
		JOIN pg_namespace n ON n.oid = ic.relnamespace
		LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid
		WHERE n.nspname = current_schema() AND i.indisvalid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []IndexInfo
	for rows.Next() {
		var name, table, ddl, constraintType string
		if err := rows.Scan(&name, &table, &ddl, &constraintType); err != nil {
			return nil, err
		}
		implicit := constraintType != ""
		info, ok := parseCreateIndex(ddl)
		if !ok {
			out = append(out, IndexInfo{Name: normalizeIdent(name), Table: normalizeIdent(table), Implicit: true, Def: ddl})
			continue
		}
		info.Implicit = implicit
		out = append(out, info)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// IndexDrift compares the declared schema against the live database.
func (s *SQLStore) IndexDrift(ctx context.Context) (IndexDriftReport, error) {
	live, err := s.LiveIndexes(ctx)
	if err != nil {
		return IndexDriftReport{}, err
	}
	declared := DeclaredIndexes()

	report := IndexDriftReport{
		Dialect:       s.dialect,
		DeclaredCount: len(declared),
		CheckedAt:     time.Now().UTC(),
		Items:         []IndexDriftItem{},
	}

	liveByName := map[string]IndexInfo{}
	for _, idx := range live {
		if idx.Implicit {
			report.ImplicitCount++
			continue
		}
		report.LiveCount++
		liveByName[idx.Name] = idx
	}

	declaredByName := map[string]IndexInfo{}
	for _, want := range declared {
		declaredByName[want.Name] = want
		got, ok := liveByName[want.Name]
		if !ok {
			d := want
			report.Items = append(report.Items, IndexDriftItem{
				Kind: "missing", Name: want.Name, Table: want.Table, Declared: &d,
				Detail: "the migrations declare this index but the database does not have it",
				Fix:    want.Def,
			})
			continue
		}
		if got.Signature() != want.Signature() {
			d, l := want, got
			report.Items = append(report.Items, IndexDriftItem{
				Kind: "mismatched", Name: want.Name, Table: want.Table, Declared: &d, Live: &l,
				Detail: fmt.Sprintf("the database has %s where the migrations declare %s; "+
					"CREATE INDEX IF NOT EXISTS matches on name only, so the migration reported "+
					"success without changing it", got.Signature(), want.Signature()),
				Fix: fmt.Sprintf("DROP INDEX %s; %s", want.Name, want.Def),
			})
		}
	}

	for _, got := range live {
		if got.Implicit {
			continue
		}
		if _, ok := declaredByName[got.Name]; ok {
			continue
		}
		l := got
		report.Items = append(report.Items, IndexDriftItem{
			Kind: "undeclared", Name: got.Name, Table: got.Table, Live: &l,
			Detail: "this index exists only in this database; a fresh install and every other " +
				"environment will not have it",
			Fix: "add to migrationStatements(): " + got.Def,
		})
	}

	sort.Slice(report.Items, func(i, j int) bool {
		if report.Items[i].Kind != report.Items[j].Kind {
			return driftRank(report.Items[i].Kind) < driftRank(report.Items[j].Kind)
		}
		return report.Items[i].Name < report.Items[j].Name
	})
	return report, nil
}

// driftRank orders the report worst-first: a mismatched index is silently wrong, a
// missing one is silently slow, and an undeclared one only bites the next environment.
func driftRank(kind string) int {
	switch kind {
	case "mismatched":
		return 0
	case "missing":
		return 1
	default:
		return 2
	}
}
