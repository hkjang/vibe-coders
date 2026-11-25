package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"
	"time"
)

const AppUIDiagnosticLimit = 10_000
const AppUIDiagnosticGroupLimit = 100
const AppUIDiagnosticRecentLimit = 20

var diagnosticNonce = regexp.MustCompile(`^[0-9a-f]{32}$`)
var diagnosticRequestID = regexp.MustCompile(`^trace_[0-9a-f]{32}$`)
var diagnosticEndpoint = regexp.MustCompile(`^/[A-Za-z0-9_./{}:-]+$`)

func ValidAppUIDiagnosticID(value string) bool { return diagnosticNonce.MatchString(value) }

// Only gateway-generated trace IDs are retained. Caller-supplied arbitrary
// identifiers may contain credentials or personal data and remain local only.
func NormalizeAppUIDiagnosticRequestID(value string) string {
	if diagnosticRequestID.MatchString(value) {
		return value
	}
	return ""
}

// Endpoint is a registered OpenAPI template, never an instantiated path or URL.
// The HTTP boundary additionally checks the method/template against the catalog.
// No error message, stack, user, query, request or response content belongs here.
type AppUIDiagnostic struct {
	FeatureID string `json:"feature_id"`
	Kind      string `json:"kind"`
	UIVersion string `json:"ui_version"`
	Endpoint  string `json:"endpoint"`
	Method    string `json:"method"`
	Status    int    `json:"status"`
	RequestID string `json:"request_id"`
	Failure   string `json:"failure"`
	Boundary  string `json:"boundary"`
}

func (d AppUIDiagnostic) Valid() bool {
	if len(d.FeatureID) > 64 || !appUITelemetryFeaturePattern.MatchString(d.FeatureID) ||
		d.UIVersion != NormalizeAppUIReleaseVersion(d.UIVersion) ||
		d.RequestID != NormalizeAppUIDiagnosticRequestID(d.RequestID) {
		return false
	}
	if d.Kind == "js_error" {
		if d.Endpoint != "" || d.Method != "" || d.Status != 0 || d.RequestID != "" || (d.Boundary != "root" && d.Boundary != "route") {
			return false
		}
		switch d.Failure {
		case "error", "type", "range", "reference", "syntax", "uri", "eval", "aggregate", "unknown":
			return true
		}
		return false
	}
	if d.Kind != "api_error" || d.Boundary != "" || len(d.Endpoint) > 256 || !diagnosticEndpoint.MatchString(d.Endpoint) ||
		(d.Status != 0 && (d.Status < 100 || d.Status > 599)) {
		return false
	}
	switch d.Method {
	case "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD":
	default:
		return false
	}
	switch d.Failure {
	case "http":
		return d.Status >= 400
	case "auth":
		return d.Status == 401
	case "permission":
		return d.Status == 403
	case "contract", "network", "timeout":
		return true
	}
	return false
}

// The caller validates the registered feature and endpoint and applies opt-in,
// identity, feature access and intake quotas. Replays cannot change content or
// extend retention, and the capacity reservation is shared across processes.
func (s *SQLStore) RecordAppUIDiagnostic(ctx context.Context, nonce string, event AppUIDiagnostic, now time.Time) (bool, error) {
	if !diagnosticNonce.MatchString(nonce) || !event.Valid() || now.IsZero() || now.Unix() <= 0 {
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
	var previous AppUIDiagnostic
	err = tx.QueryRowContext(ctx, s.bind(`SELECT feature_id, kind, ui_version, endpoint, method, status, request_id, failure, boundary FROM app_ui_diagnostics WHERE event_hash = ?`), hash).
		Scan(&previous.FeatureID, &previous.Kind, &previous.UIVersion, &previous.Endpoint, &previous.Method, &previous.Status, &previous.RequestID, &previous.Failure, &previous.Boundary)
	if err == nil {
		if previous != event {
			return false, ErrAppUITelemetryVisitConflict
		}
		return true, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	reserved, err := tx.ExecContext(ctx, s.bind(`UPDATE app_ui_telemetry_capacity SET live_diagnostics = live_diagnostics + 1 WHERE singleton = 1 AND live_diagnostics < ?`), AppUIDiagnosticLimit)
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
	_, err = tx.ExecContext(ctx, s.bind(`INSERT INTO app_ui_diagnostics (event_hash, feature_id, kind, received_epoch, ui_version, endpoint, method, status, request_id, failure, boundary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		hash, event.FeatureID, event.Kind, now.Unix(), event.UIVersion, event.Endpoint, event.Method, event.Status, event.RequestID, event.Failure, event.Boundary)
	if err != nil {
		return false, err
	}
	return true, tx.Commit()
}

type AppUIDiagnosticGroup struct {
	AppUIDiagnostic
	Events int64 `json:"events"`
}

type AppUIDiagnosticRecent struct {
	AppUIDiagnostic
	ReceivedAt string `json:"received_at"`
}

type AppUIDiagnosticsSummary struct {
	Total            int64                   `json:"total"`
	OtherGroupEvents int64                   `json:"other_group_events"`
	Groups           []AppUIDiagnosticGroup  `json:"groups"`
	Recent           []AppUIDiagnosticRecent `json:"recent"`
}

func (s *SQLStore) AppUIDiagnosticsSummary(ctx context.Context, since, now time.Time, features []string) (AppUIDiagnosticsSummary, error) {
	out := AppUIDiagnosticsSummary{Groups: []AppUIDiagnosticGroup{}, Recent: []AppUIDiagnosticRecent{}}
	if now.IsZero() || now.Unix() <= 0 || len(features) > 256 {
		return out, ErrAppUITelemetryInvalidInput
	}
	if len(features) == 0 || since.After(now) {
		return out, nil
	}
	cutoff := now.Add(-AppUITelemetryRetentionDays * 24 * time.Hour).Unix()
	args := []any{cutoff, since.Unix(), now.Unix()}
	placeholders := []string{}
	seen := map[string]bool{}
	for _, id := range features {
		if len(id) > 64 || !appUITelemetryFeaturePattern.MatchString(id) || seen[id] {
			return out, ErrAppUITelemetryInvalidInput
		}
		seen[id] = true
		placeholders = append(placeholders, "?")
		args = append(args, id)
	}
	where := ` FROM app_ui_diagnostics WHERE received_epoch > ? AND received_epoch >= ? AND received_epoch <= ? AND feature_id IN (` + strings.Join(placeholders, ",") + `)`
	options := &sql.TxOptions{ReadOnly: true}
	if s.dialect == "postgres" {
		options.Isolation = sql.LevelRepeatableRead
	}
	tx, err := s.db.BeginTx(ctx, options)
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	if err := tx.QueryRowContext(ctx, s.bind(`SELECT COUNT(*)`+where), args...).Scan(&out.Total); err != nil {
		return out, err
	}
	out.OtherGroupEvents = out.Total
	columns := `feature_id, kind, ui_version, endpoint, method, status, failure, boundary`
	rows, err := tx.QueryContext(ctx, s.bind(`SELECT `+columns+`, COUNT(*) AS events`+where+` GROUP BY `+columns+` ORDER BY events DESC, `+columns+` LIMIT 100`), args...)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var group AppUIDiagnosticGroup
		if err := rows.Scan(&group.FeatureID, &group.Kind, &group.UIVersion, &group.Endpoint, &group.Method, &group.Status, &group.Failure, &group.Boundary, &group.Events); err != nil {
			rows.Close()
			return out, err
		}
		group.UIVersion = NormalizeAppUIReleaseVersion(group.UIVersion)
		if group.Valid() {
			out.Groups = append(out.Groups, group)
			out.OtherGroupEvents -= group.Events
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	rows, err = tx.QueryContext(ctx, s.bind(`SELECT `+columns+`, request_id, received_epoch`+where+` ORDER BY received_epoch DESC, event_hash ASC LIMIT 20`), args...)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var row AppUIDiagnosticRecent
		var epoch int64
		if err := rows.Scan(&row.FeatureID, &row.Kind, &row.UIVersion, &row.Endpoint, &row.Method, &row.Status, &row.Failure, &row.Boundary, &row.RequestID, &epoch); err != nil {
			rows.Close()
			return out, err
		}
		row.UIVersion = NormalizeAppUIReleaseVersion(row.UIVersion)
		row.RequestID = NormalizeAppUIDiagnosticRequestID(row.RequestID)
		row.ReceivedAt = time.Unix(epoch, 0).UTC().Format(time.RFC3339)
		if row.Valid() {
			out.Recent = append(out.Recent, row)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	return out, tx.Commit()
}

func (s *SQLStore) purgeAppUIDiagnosticsTx(ctx context.Context, tx *sql.Tx, cutoff int64) error {
	result, err := tx.ExecContext(ctx, s.bind(`DELETE FROM app_ui_diagnostics WHERE received_epoch <= ?`), cutoff)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil || n == 0 {
		return err
	}
	_, err = tx.ExecContext(ctx, s.bind(`UPDATE app_ui_telemetry_capacity SET live_diagnostics = live_diagnostics - ? WHERE singleton = 1`), n)
	return err
}
