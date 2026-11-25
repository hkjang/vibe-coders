package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"slices"
	"strings"
	"time"
)

const AppUIActionLimit = 10_000
const AppUIActionGroupLimit = 100

// Fixed operation classes, never labels derived from user input or response data.
func AppUIActionKinds() []string {
	return []string{"save", "delete", "approve", "reject", "revoke", "rotate", "rollback", "activate", "deactivate", "import", "export", "run_request", "test", "feedback"}
}

type AppUIAction struct {
	FeatureID string `json:"feature_id"`
	Action    string `json:"action"`
	Outcome   string `json:"outcome"`
	UIVersion string `json:"ui_version"`
}

func (a AppUIAction) Valid() bool {
	return len(a.FeatureID) <= 64 && appUITelemetryFeaturePattern.MatchString(a.FeatureID) &&
		a.UIVersion == NormalizeAppUIReleaseVersion(a.UIVersion) && slices.Contains(AppUIActionKinds(), a.Action) &&
		(a.Outcome == "success" || a.Outcome == "rejected" || a.Outcome == "unknown")
}

// Observations are lossy browser reports, not a source of truth for business
// state. Only immutable, anonymous categories and the receiving time are kept.
func (s *SQLStore) RecordAppUIAction(ctx context.Context, nonce string, event AppUIAction, now time.Time) (bool, error) {
	if !ValidAppUIDiagnosticID(nonce) || !event.Valid() || now.IsZero() || now.Unix() <= 0 {
		return false, ErrAppUITelemetryInvalidInput
	}
	digest := sha256.Sum256([]byte(nonce))
	hash := hex.EncodeToString(digest[:])
	tx, cleanup, err := s.lockAppUITelemetry(ctx)
	if err != nil {
		return false, err
	}
	defer cleanup()
	if err := s.purgeAppUITelemetryTx(ctx, tx, now); err != nil {
		return false, err
	}
	var previous AppUIAction
	err = tx.QueryRowContext(ctx, s.bind(`SELECT feature_id, action, outcome, ui_version FROM app_ui_actions WHERE event_hash = ?`), hash).
		Scan(&previous.FeatureID, &previous.Action, &previous.Outcome, &previous.UIVersion)
	if err == nil {
		if previous != event {
			return false, ErrAppUITelemetryVisitConflict
		}
		return true, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	reserved, err := tx.ExecContext(ctx, s.bind(`UPDATE app_ui_telemetry_capacity SET live_actions = live_actions + 1 WHERE singleton = 1 AND live_actions < ?`), AppUIActionLimit)
	if err != nil {
		return false, err
	}
	n, err := reserved.RowsAffected()
	if err != nil {
		return false, err
	}
	if n == 0 {
		return false, tx.Commit()
	}
	_, err = tx.ExecContext(ctx, s.bind(`INSERT INTO app_ui_actions (event_hash, feature_id, action, outcome, ui_version, received_epoch) VALUES (?, ?, ?, ?, ?, ?)`), hash, event.FeatureID, event.Action, event.Outcome, event.UIVersion, now.Unix())
	if err != nil {
		return false, err
	}
	return true, tx.Commit()
}

type AppUIActionCounts struct {
	Success  int64 `json:"success"`
	Rejected int64 `json:"rejected"`
	Unknown  int64 `json:"unknown"`
}
type AppUIActionGroup struct {
	FeatureID string `json:"feature_id"`
	Action    string `json:"action"`
	UIVersion string `json:"ui_version"`
	AppUIActionCounts
}
type AppUIActionsSummary struct {
	AppUIActionCounts
	Other  AppUIActionCounts  `json:"other"`
	Groups []AppUIActionGroup `json:"groups"`
}

func (s *SQLStore) AppUIActionsSummary(ctx context.Context, since, now time.Time, features []string) (AppUIActionsSummary, error) {
	out := AppUIActionsSummary{Groups: []AppUIActionGroup{}}
	if now.IsZero() || now.Unix() <= 0 || len(features) > 256 {
		return out, ErrAppUITelemetryInvalidInput
	}
	if len(features) == 0 || since.After(now) {
		return out, nil
	}
	args := []any{now.Add(-AppUITelemetryRetentionDays * 24 * time.Hour).Unix(), since.Unix(), now.Unix()}
	placeholders, seen := []string{}, map[string]bool{}
	for _, feature := range features {
		if len(feature) > 64 || !appUITelemetryFeaturePattern.MatchString(feature) || seen[feature] {
			return out, ErrAppUITelemetryInvalidInput
		}
		seen[feature] = true
		placeholders = append(placeholders, "?")
		args = append(args, feature)
	}
	where := ` FROM app_ui_actions WHERE received_epoch > ? AND received_epoch >= ? AND received_epoch <= ? AND feature_id IN (` + strings.Join(placeholders, ",") + `)`
	counts := `COALESCE(SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END),0), COALESCE(SUM(CASE WHEN outcome = 'rejected' THEN 1 ELSE 0 END),0), COALESCE(SUM(CASE WHEN outcome = 'unknown' THEN 1 ELSE 0 END),0)`
	options := &sql.TxOptions{ReadOnly: true}
	if s.dialect == "postgres" {
		options.Isolation = sql.LevelRepeatableRead
	}
	tx, err := s.db.BeginTx(ctx, options)
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	if err := tx.QueryRowContext(ctx, s.bind(`SELECT `+counts+where), args...).Scan(&out.Success, &out.Rejected, &out.Unknown); err != nil {
		return out, err
	}
	out.Other = out.AppUIActionCounts
	rows, err := tx.QueryContext(ctx, s.bind(`SELECT feature_id, action, ui_version, `+counts+where+` GROUP BY feature_id, action, ui_version ORDER BY COUNT(*) DESC, feature_id, action, ui_version LIMIT 100`), args...)
	if err != nil {
		return out, err
	}
	groupIndex := map[[3]string]int{}
	for rows.Next() {
		var group AppUIActionGroup
		if err := rows.Scan(&group.FeatureID, &group.Action, &group.UIVersion, &group.Success, &group.Rejected, &group.Unknown); err != nil {
			rows.Close()
			return out, err
		}
		group.UIVersion = NormalizeAppUIReleaseVersion(group.UIVersion)
		if !(AppUIAction{FeatureID: group.FeatureID, Action: group.Action, Outcome: "success", UIVersion: group.UIVersion}).Valid() {
			continue
		}
		key := [3]string{group.FeatureID, group.Action, group.UIVersion}
		if index, exists := groupIndex[key]; exists {
			// Different out-of-band version labels normalize to one anonymous
			// bucket. Never return duplicate UI keys or any untrusted label.
			out.Groups[index].Success += group.Success
			out.Groups[index].Rejected += group.Rejected
			out.Groups[index].Unknown += group.Unknown
		} else {
			groupIndex[key] = len(out.Groups)
			out.Groups = append(out.Groups, group)
		}
		out.Other.Success -= group.Success
		out.Other.Rejected -= group.Rejected
		out.Other.Unknown -= group.Unknown
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	return out, tx.Commit()
}

func (s *SQLStore) purgeAppUIActionsTx(ctx context.Context, tx *sql.Tx, cutoff int64) error {
	result, err := tx.ExecContext(ctx, s.bind(`DELETE FROM app_ui_actions WHERE received_epoch <= ?`), cutoff)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil || n == 0 {
		return err
	}
	_, err = tx.ExecContext(ctx, s.bind(`UPDATE app_ui_telemetry_capacity SET live_actions = live_actions - ? WHERE singleton = 1`), n)
	return err
}
