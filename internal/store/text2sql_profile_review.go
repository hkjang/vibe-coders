package store

import (
	"context"
	"database/sql"
	"errors"
)

var ErrText2SQLProfileConflict = errors.New("text2sql profile changed since review")
var ErrText2SQLProfileUnchanged = errors.New("text2sql profile review has no changes")

const Text2SQLProfileAbsentRevision = "absent"

func (s *SQLStore) lockText2SQLProfiles(ctx context.Context, tx *sql.Tx) error {
	lock := `UPDATE text2sql_profiles SET enabled = enabled WHERE 0`
	if s.dialect == "postgres" {
		// Stabilizes existing and absent identifiers against ordinary writers,
		// while leaving runtime SELECTs available.
		lock = `LOCK TABLE text2sql_profiles IN SHARE ROW EXCLUSIVE MODE`
	}
	_, err := tx.ExecContext(ctx, lock)
	return err
}

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
		if err := s.lockText2SQLProfiles(ctx, tx); err != nil {
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

// DeleteText2SQLProfileReviewed removes exactly the reviewed persisted mapping
// and its audit in one transaction. It does not disable the virtual model.
func (s *SQLStore) DeleteText2SQLProfileReviewed(ctx context.Context, model, revision string, audit AdminAuditLog) error {
	if model == "" || len(revision) != 64 || audit.AdminID == "" || audit.Action != "text2sql.profile.reviewed_delete" {
		return errors.New("invalid reviewed profile deletion identity or audit")
	}
	return s.withAdminAuditTransaction(ctx, audit, func(tx *sql.Tx) error {
		if err := s.lockText2SQLProfiles(ctx, tx); err != nil {
			return err
		}
		current, err := scanText2SQLProfile(tx.QueryRowContext(ctx, s.bind(
			`SELECT `+text2SQLProfileColumns+` FROM text2sql_profiles WHERE virtual_model = ?`), model))
		if errors.Is(err, sql.ErrNoRows) {
			return ErrText2SQLProfileConflict
		}
		if err != nil {
			return err
		}
		if current.Revision != revision {
			return ErrText2SQLProfileConflict
		}
		result, err := tx.ExecContext(ctx, s.bind(`DELETE FROM text2sql_profiles WHERE virtual_model = ?`), model)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count != 1 {
			return ErrText2SQLProfileConflict
		}
		return nil
	})
}
