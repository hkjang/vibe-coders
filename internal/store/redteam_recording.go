package store

import (
	"context"
	"database/sql"
	"errors"
)

type redTeamExecer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

// SaveRedTeamCaseBundle acknowledges a complete result and its evidence together.
// No network/model calls or automatic retries occur inside this transaction.
func (s *SQLStore) SaveRedTeamCaseBundle(ctx context.Context, result RedTeamCaseResult, evidence RedTeamEvidence, remediation RedTeamRemediation) error {
	if result.ID == "" || result.RunID == "" || evidence.ResultID != result.ID || evidence.ID == "" ||
		(remediation.ActionType != "" && (remediation.ID == "" || remediation.ResultID != result.ID)) {
		return errors.New("invalid redteam result bundle")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	query := `SELECT id FROM redteam_runs WHERE id = ? AND status = 'running'`
	if s.dialect == "postgres" {
		query += " FOR UPDATE"
	}
	var runID string
	if err := tx.QueryRowContext(ctx, s.bind(query), result.RunID).Scan(&runID); err != nil {
		return err
	}
	if err := s.insertRedTeamCaseResult(ctx, tx, result); err != nil {
		return err
	}
	if err := s.insertRedTeamEvidence(ctx, tx, evidence); err != nil {
		return err
	}
	if remediation.ActionType != "" {
		if err := s.insertRedTeamRemediation(ctx, tx, remediation); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// FinalizeRedTeamExecution commits acknowledged run summaries, campaign status
// and eligible baselines together. Missing rows and uncertain commits are errors.
// Results are already acknowledged per bundle; this is not a whole-run rollback.
func (s *SQLStore) FinalizeRedTeamExecution(ctx context.Context, campaignID, status, approvedBy string, runs []RedTeamRun, baselines []RedTeamBaseline) error {
	if campaignID == "" || (status != "completed" && status != "stopped") || (status != "completed" && len(baselines) > 0) {
		return errors.New("invalid redteam finalization")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	seen := map[string]bool{}
	for _, run := range runs {
		if run.ID == "" || run.CampaignID != campaignID || seen[run.ID] {
			return errors.New("invalid redteam run identity")
		}
		seen[run.ID] = true
		query := `SELECT campaign_id FROM redteam_runs WHERE id = ?`
		if s.dialect == "postgres" {
			query += " FOR UPDATE"
		}
		var owner string
		if err := tx.QueryRowContext(ctx, s.bind(query), run.ID).Scan(&owner); err != nil {
			return err
		}
		if owner != campaignID {
			return errors.New("redteam run campaign mismatch")
		}
		result, err := s.updateRedTeamRun(ctx, tx, run)
		if err != nil {
			return err
		}
		if err := redTeamExactlyOneRow(result); err != nil {
			return err
		}
	}
	result, err := s.updateRedTeamCampaignStatus(ctx, tx, campaignID, status, approvedBy)
	if err != nil {
		return err
	}
	if err := redTeamExactlyOneRow(result); err != nil {
		return err
	}
	for _, baseline := range baselines {
		if err := s.upsertRedTeamBaseline(ctx, tx, baseline); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func redTeamExactlyOneRow(result sql.Result) error {
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return errors.New("redteam recording row unavailable")
	}
	return nil
}
