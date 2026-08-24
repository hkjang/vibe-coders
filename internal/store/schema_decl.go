package store

import (
	"regexp"
	"sort"
	"strings"
)

// Reading the declared schema.
//
// migrationStatements() is the only description of this schema that exists, and it is a
// list of DDL strings rather than a structure anything can ask questions of. Both the
// index checks need to ask: which tables are there, which columns do they have, and what
// is already indexed by virtue of being a key.
//
// Parsing DDL is only safe because this is DDL we wrote, in a narrow subset — no
// generated columns, no CHECK constraints spanning lines, no dialect-specific syntax.
// Anything the parser does not recognise is dropped rather than guessed at, so a caller
// sees a column it does not know about as absent, not as something invented.

// TableDecl is one table as the migrations declare it.
type TableDecl struct {
	Name    string
	Columns []string
	// PrimaryKey and Unique are the column groups the engine indexes without being asked.
	// A lookup on the first column of one of these is already index-supported.
	PrimaryKey []string
	Unique     [][]string
}

// HasColumn reports whether the table declares this column.
func (t TableDecl) HasColumn(name string) bool {
	for _, c := range t.Columns {
		if c == name {
			return true
		}
	}
	return false
}

var (
	declCreateTableRe = regexp.MustCompile(`(?is)^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\((.*)\)\s*$`)
	declAddColumnRe   = regexp.MustCompile(`(?is)^\s*ALTER\s+TABLE\s+([a-z_][a-z0-9_]*)\s+ADD\s+COLUMN\s+([a-z_][a-z0-9_]*)`)
	declTablePKRe     = regexp.MustCompile(`(?is)^PRIMARY\s+KEY\s*\((.*)\)$`)
	declTableUniqueRe = regexp.MustCompile(`(?is)^UNIQUE\s*\((.*)\)$`)
)

// DeclaredTables reads every table the migrations create, in the order a caller is most
// likely to want them: by name.
func DeclaredTables() map[string]TableDecl {
	tables := map[string]TableDecl{}
	for _, stmt := range migrationStatements() {
		if m := declCreateTableRe.FindStringSubmatch(stmt); m != nil {
			name := normalizeIdent(m[1])
			if _, dup := tables[name]; dup {
				// CREATE TABLE IF NOT EXISTS twice: the second is dead. Keep the first,
				// which is the one the database will have.
				continue
			}
			tables[name] = parseTableBody(name, m[2])
			continue
		}
		if m := declAddColumnRe.FindStringSubmatch(stmt); m != nil {
			name := normalizeIdent(m[1])
			t, ok := tables[name]
			if !ok {
				continue
			}
			col := normalizeIdent(m[2])
			if !t.HasColumn(col) {
				t.Columns = append(t.Columns, col)
				tables[name] = t
			}
		}
	}
	for name, t := range tables {
		sort.Strings(t.Columns)
		tables[name] = t
	}
	return tables
}

func parseTableBody(name, body string) TableDecl {
	t := TableDecl{Name: name}
	for _, part := range splitTopLevel(body) {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if m := declTablePKRe.FindStringSubmatch(part); m != nil {
			t.PrimaryKey = splitIdents(m[1])
			continue
		}
		if m := declTableUniqueRe.FindStringSubmatch(part); m != nil {
			t.Unique = append(t.Unique, splitIdents(m[1]))
			continue
		}
		upper := strings.ToUpper(part)
		// Other table-level constraints declare no column of their own.
		if strings.HasPrefix(upper, "FOREIGN KEY") || strings.HasPrefix(upper, "CHECK") ||
			strings.HasPrefix(upper, "CONSTRAINT") {
			continue
		}
		fields := strings.Fields(part)
		if len(fields) < 2 {
			continue
		}
		col := normalizeIdent(fields[0])
		if col == "" {
			continue
		}
		t.Columns = append(t.Columns, col)
		if strings.Contains(upper, "PRIMARY KEY") {
			t.PrimaryKey = []string{col}
		}
		if strings.Contains(upper, "UNIQUE") {
			t.Unique = append(t.Unique, []string{col})
		}
	}
	return t
}

// splitTopLevel splits a comma-separated DDL body, ignoring commas inside parentheses so
// that "PRIMARY KEY (a, b)" stays one part.
func splitTopLevel(body string) []string {
	var parts []string
	depth := 0
	cur := strings.Builder{}
	for i := 0; i < len(body); i++ {
		switch c := body[i]; c {
		case '(':
			depth++
			cur.WriteByte(c)
		case ')':
			depth--
			cur.WriteByte(c)
		case ',':
			if depth == 0 {
				parts = append(parts, cur.String())
				cur.Reset()
			} else {
				cur.WriteByte(c)
			}
		default:
			cur.WriteByte(c)
		}
	}
	parts = append(parts, cur.String())
	return parts
}

func splitIdents(list string) []string {
	var out []string
	for _, raw := range strings.Split(list, ",") {
		if id := normalizeIdent(raw); id != "" {
			out = append(out, id)
		}
	}
	return out
}

// IndexedLeadingColumns returns, per table, the columns a lookup can use an index for
// without scanning: the first column of every declared index, primary key and unique
// constraint. A filter on any other column has no index to start from.
func IndexedLeadingColumns() map[string]map[string]bool {
	out := map[string]map[string]bool{}
	add := func(table, col string) {
		if table == "" || col == "" {
			return
		}
		if out[table] == nil {
			out[table] = map[string]bool{}
		}
		out[table][col] = true
	}
	for _, idx := range DeclaredIndexes() {
		add(idx.Table, idx.Columns[0])
	}
	for name, t := range DeclaredTables() {
		if len(t.PrimaryKey) > 0 {
			add(name, t.PrimaryKey[0])
		}
		for _, u := range t.Unique {
			if len(u) > 0 {
				add(name, u[0])
			}
		}
	}
	return out
}
