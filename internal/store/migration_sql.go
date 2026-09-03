package store

import "strings"

// Reading the migration SQL back out.
//
// The schema exists as a list of DDL strings that only Migrate ever looks at. When an
// operator adds an index by hand in production, there is then no way to answer the
// question they actually have — "is this one of ours, or one I added?" — without opening
// the source. The drift report answers it for indexes that disagree; this answers it for
// everything, by showing the same list Migrate applies, in apply order.
//
// It renders through renderForDialect, so what an operator reads is the statement that
// ran on *this* database rather than the SQLite spelling of it.
//
// Two things it deliberately does not do: it does not read the database (it describes the
// build, and the live side is the drift report's job), and it does not execute anything.

// MigrationStatement is one statement from the declared schema, classified enough for a
// reader to find the one they are looking for.
type MigrationStatement struct {
	// Seq is the 1-based position in apply order. Order matters here: an ALTER TABLE only
	// makes sense after the CREATE TABLE it modifies.
	Seq int `json:"seq"`
	// Kind is "create_table", "create_index", "add_column" or "other".
	Kind  string `json:"kind"`
	Table string `json:"table,omitempty"`
	// Name is the index name, for create_index.
	Name string `json:"name,omitempty"`
	// Column is the added column, for add_column.
	Column  string   `json:"column,omitempty"`
	Columns []string `json:"columns,omitempty"`
	Unique  bool     `json:"unique,omitempty"`
	// SQL is what this dialect runs.
	SQL string `json:"sql"`
	// DeclaredSQL is the statement as written, present only when the dialect rewrote it,
	// so a reader can see that the difference is ours and not drift.
	DeclaredSQL string `json:"declared_sql,omitempty"`
}

// MigrationSQLReport is the whole declared schema.
type MigrationSQLReport struct {
	Dialect    string               `json:"dialect"`
	Statements []MigrationStatement `json:"statements"`
	Counts     MigrationSQLCounts   `json:"counts"`
	// Tables is every table the schema creates, in the order it creates them.
	Tables []string `json:"tables"`
	// PostMigration names the schema changes Migrate makes *after* running the list, which
	// are therefore not in it. Without this the report would read as the complete story
	// while quietly omitting the column-type changes.
	PostMigration []string `json:"post_migration,omitempty"`
}

// MigrationSQLCounts is the tally an operator reads before scrolling.
type MigrationSQLCounts struct {
	Total       int `json:"total"`
	CreateTable int `json:"create_table"`
	CreateIndex int `json:"create_index"`
	AddColumn   int `json:"add_column"`
	Other       int `json:"other"`
	Rewritten   int `json:"rewritten"`
}

// MigrationSQL returns the declared schema as this database runs it.
func (s *SQLStore) MigrationSQL() MigrationSQLReport {
	return migrationSQLFor(s.dialect)
}

func migrationSQLFor(dialect string) MigrationSQLReport {
	rep := MigrationSQLReport{Dialect: dialect}
	seenTable := map[string]bool{}

	for i, stmt := range migrationStatements() {
		item := MigrationStatement{Seq: i + 1, Kind: "other", SQL: renderForDialect(stmt, dialect)}
		if item.SQL != stmt {
			item.DeclaredSQL = stmt
			rep.Counts.Rewritten++
		}

		switch {
		case declCreateTableRe.MatchString(stmt):
			m := declCreateTableRe.FindStringSubmatch(stmt)
			item.Kind, item.Table = "create_table", normalizeIdent(m[1])
			if !seenTable[item.Table] {
				seenTable[item.Table] = true
				rep.Tables = append(rep.Tables, item.Table)
			}
			rep.Counts.CreateTable++
		case declAddColumnRe.MatchString(stmt):
			m := declAddColumnRe.FindStringSubmatch(stmt)
			item.Kind, item.Table, item.Column = "add_column", normalizeIdent(m[1]), normalizeIdent(m[2])
			rep.Counts.AddColumn++
		default:
			if info, ok := parseCreateIndex(stmt); ok {
				item.Kind, item.Table = "create_index", info.Table
				item.Name, item.Columns, item.Unique = info.Name, info.Columns, info.Unique
				rep.Counts.CreateIndex++
			} else {
				item.Table = otherStatementTable(stmt)
				rep.Counts.Other++
			}
		}
		rep.Statements = append(rep.Statements, item)
	}
	rep.Counts.Total = len(rep.Statements)
	rep.PostMigration = []string{
		"사전 릴리스 요청 탐색기의 구형 커서 인덱스를 안전한 부분 인덱스 생성 후 제거합니다.",
	}

	if dialect == "postgres" {
		rep.PostMigration = append(rep.PostMigration,
			"REAL 컬럼을 DOUBLE PRECISION 으로 넓힙니다 (information_schema 를 읽어 대상 결정).",
			"카운터 컬럼을 BIGINT 로 넓힙니다 (pgCounterColumns 목록).",
			"요청 탐색기 식별자 가드 통계가 없을 때만 request_logs 와 api_keys 를 ANALYZE 합니다.",
		)
	}
	return rep
}

// otherStatementTable pulls a table name out of a statement the three classifiers did not
// recognise, so an unclassified statement still lands under the table it belongs to when
// the list is grouped. An empty result means "could not tell", not "no table".
func otherStatementTable(stmt string) string {
	fields := strings.Fields(stmt)
	for i := 0; i < len(fields)-1; i++ {
		// UPDATE names its table directly; the rest introduce one. Scanning left to right
		// and stopping at the first match keeps a subquery's FROM from winning over the
		// statement's own target.
		switch strings.ToUpper(fields[i]) {
		case "UPDATE", "TABLE", "INTO", "FROM", "ON":
			return normalizeIdent(fields[i+1])
		}
	}
	return ""
}
