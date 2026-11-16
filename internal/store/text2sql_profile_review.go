package store

import (
	"context"
	"database/sql"
	"errors"
)

var ErrText2SQLProfileConflict = errors.New("text2sql profile changed since review")
var ErrText2SQLProfileUnchanged = errors.New("text2sql profile review has no changes")

const Text2SQLProfileAbsentRevision = "absent"

// SaveText2SQLProfileReviewed serializes the short profile write against ordinary
// INSERT/UPDATE/DELETE writers, including legacy calls and other server processes.
// No external DB connection or model invocation occurs inside this transaction.
func (s *SQLStore) SaveText2SQLProfileReviewed(ctx context.Context, p Text2SQLProfile, revision string, audit AdminAuditLog) (Text2SQLProfile, error) {
	if p.VirtualModel == "" || revision == "" || audit.AdminID == "" || audit.Action != "text2sql.profile.reviewed_upsert" {
		return Text2SQLProfile{}, errors.New("invalid reviewed profile identity or audit")
	}
	if p.Mode == "" {
		p.Mode = "preview"
	}
	var saved Text2SQLProfile
	err := s.withAdminAuditTransaction(ctx, audit, func(tx *sql.Tx) error {
		lock := `UPDATE text2sql_profiles SET enabled = enabled WHERE 0`
		if s.dialect == "postgres" {
			// Allows ordinary runtime SELECTs while stabilizing existing and absent
			// identifiers. Normal legacy writes participate through their SQL locks.
			lock = `LOCK TABLE text2sql_profiles IN SHARE ROW EXCLUSIVE MODE`
		}
		if _, err := tx.ExecContext(ctx, lock); err != nil {
			return err
		}
		current, err := scanText2SQLProfile(tx.QueryRowContext(ctx, s.bind(
			`SELECT `+text2SQLProfileColumns+` FROM text2sql_profiles WHERE virtual_model = ?`), p.VirtualModel))
		found := err == nil
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		expected := Text2SQLProfileAbsentRevision
		if found {
			expected = current.Revision
		}
		if revision != expected {
			return ErrText2SQLProfileConflict
		}
		if found && current.Mode == p.Mode && current.UpstreamModel == p.UpstreamModel &&
			current.SummaryModel == p.SummaryModel && current.SchemaName == p.SchemaName &&
			current.ExecConnectionID == p.ExecConnectionID && current.Enabled == p.Enabled {
			return ErrText2SQLProfileUnchanged
		}
		saved, err = s.writeText2SQLProfile(ctx, tx, p)
		return err
	})
	if err != nil {
		return Text2SQLProfile{}, err
	}
	return saved, nil
}
