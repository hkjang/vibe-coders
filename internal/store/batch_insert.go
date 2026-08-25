package store

import (
	"context"
	"database/sql"
	"strings"
)

// Writing many rows of one shape.
//
// A request can carry more than one of several things — a prompt per message in the
// conversation, an evaluation per rubric dimension, a tool invocation per call — and each
// was written with its own INSERT inside the logging transaction. On SQLite that is a
// function call per row. On PostgreSQL it is a network round trip per row: a twenty-turn
// conversation cost twenty of them for its prompts alone, and a request with the default
// evaluators cost six more.
//
// The rows of one kind share a column list, so they can go in one statement.
//
// batchParamLimit bounds how many bound parameters go into a single statement. PostgreSQL
// accepts 65535 and current SQLite builds 32766, but SQLite compiled with the older
// default accepts 999, so the conservative number is the one that works everywhere. Rows
// beyond it are written in further statements, which is still far fewer than one each.
const batchParamLimit = 900

// batchInsert writes every row in args as one statement per chunk. args is a flat list:
// perRow values for the first row, then perRow for the next, and so on. header is the
// INSERT up to and including the column list, and rowPlaceholder is one row's "(?, ?, …)".
func batchInsert(ctx context.Context, tx *sql.Tx, bind func(string) string, header, rowPlaceholder string, perRow int, args []any) error {
	if len(args) == 0 {
		return nil
	}
	if perRow <= 0 || len(args)%perRow != 0 {
		// A caller that miscounts would otherwise write rows with values shifted between
		// columns, which no constraint would catch.
		return errBatchArgsMismatch
	}
	rows := len(args) / perRow
	perStatement := batchParamLimit / perRow
	if perStatement < 1 {
		perStatement = 1
	}
	for start := 0; start < rows; start += perStatement {
		end := start + perStatement
		if end > rows {
			end = rows
		}
		placeholders := make([]string, 0, end-start)
		for i := start; i < end; i++ {
			placeholders = append(placeholders, rowPlaceholder)
		}
		stmt := bind(header + " VALUES " + strings.Join(placeholders, ", "))
		if _, err := tx.ExecContext(ctx, stmt, args[start*perRow:end*perRow]...); err != nil {
			return err
		}
	}
	return nil
}

type batchArgsError struct{}

func (batchArgsError) Error() string {
	return "batchInsert: argument count is not a multiple of the columns per row"
}

var errBatchArgsMismatch = batchArgsError{}
