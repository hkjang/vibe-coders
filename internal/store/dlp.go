package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// DLPSettings is the stored DLP configuration document and its revision. The
// document's shape belongs to internal/dlp; the store only keeps it consistent.
type DLPSettings struct {
	ConfigJSON string `json:"-"`
	Revision   int    `json:"revision"`
	UpdatedBy  string `json:"updated_by"`
	UpdatedAt  string `json:"updated_at"`
}

// ErrDLPSettingsConflict means another administrator saved since the caller read.
var ErrDLPSettingsConflict = errors.New("dlp settings changed concurrently")

// DLPEvent is one profile that matched one side of one request. The matched values
// themselves are never stored: only partial previews (or nothing, per settings)
// and fingerprints.
type DLPEvent struct {
	ID         string    `json:"id"`
	RequestID  string    `json:"request_id"`
	APIKeyID   string    `json:"api_key_id"`
	UserID     string    `json:"user_id"`
	TeamID     string    `json:"team_id"`
	Check      string    `json:"check"`
	Action     string    `json:"action"`
	PolicyIDs  []string  `json:"policy_ids"`
	ProfileID  string    `json:"profile_id"`
	EntryIDs   []string  `json:"entry_ids"`
	MatchCount int       `json:"match_count"`
	Confidence string    `json:"confidence"`
	Evidence   []string  `json:"evidence"`
	Hashes     []string  `json:"hashes"`
	Endpoint   string    `json:"endpoint"`
	Model      string    `json:"model"`
	CreatedAt  time.Time `json:"created_at"`
}

// DLPEventFilter narrows an event listing.
type DLPEventFilter struct {
	Since     time.Time
	Limit     int
	RequestID string
	TeamID    string
	Action    string
	Check     string
	ProfileID string
}

// GetDLPSettings returns the stored configuration; found is false before the first save.
func (s *SQLStore) GetDLPSettings(ctx context.Context) (DLPSettings, bool, error) {
	var out DLPSettings
	err := s.db.QueryRowContext(ctx, `SELECT config_json, revision, COALESCE(updated_by, ''), updated_at FROM dlp_settings WHERE id = 'default'`).
		Scan(&out.ConfigJSON, &out.Revision, &out.UpdatedBy, &out.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return DLPSettings{}, false, nil
	}
	if err != nil {
		return DLPSettings{}, false, err
	}
	return out, true, nil
}

// SaveDLPSettings stores a configuration on top of expectedRevision (0 before the
// first save) and returns the new revision.
func (s *SQLStore) SaveDLPSettings(ctx context.Context, configJSON string, expectedRevision int, actor string) (DLPSettings, error) {
	now := formatTime(time.Now())
	saved := DLPSettings{ConfigJSON: configJSON, Revision: expectedRevision + 1, UpdatedBy: actor, UpdatedAt: now}
	if expectedRevision == 0 {
		_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO dlp_settings (id, config_json, revision, updated_by, updated_at)
			VALUES ('default', ?, 1, ?, ?) ON CONFLICT(id) DO NOTHING`), cleanArgs([]any{configJSON, actor, now})...)
		if err != nil {
			return DLPSettings{}, err
		}
		current, _, err := s.GetDLPSettings(ctx)
		if err != nil {
			return DLPSettings{}, err
		}
		if current.Revision != 1 || current.ConfigJSON != configJSON || current.UpdatedAt != now {
			return DLPSettings{}, ErrDLPSettingsConflict
		}
		return saved, nil
	}
	res, err := s.db.ExecContext(ctx, s.bind(`UPDATE dlp_settings SET config_json = ?, revision = revision + 1, updated_by = ?, updated_at = ?
		WHERE id = 'default' AND revision = ?`), cleanArgs([]any{configJSON, actor, now, expectedRevision})...)
	if err != nil {
		return DLPSettings{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return DLPSettings{}, ErrDLPSettingsConflict
	}
	return saved, nil
}

func encodeList(values []string) string {
	if values == nil {
		values = []string{}
	}
	encoded, _ := json.Marshal(values)
	return string(encoded)
}

func decodeList(raw string) []string {
	out := []string{}
	_ = json.Unmarshal([]byte(raw), &out)
	return out
}

func (s *SQLStore) insertDLPEvents(ctx context.Context, tx *sql.Tx, req RequestLog, events []DLPEvent) error {
	for _, e := range events {
		if e.RequestID == "" {
			e.RequestID = req.ID
		}
		if e.CreatedAt.IsZero() {
			e.CreatedAt = req.CreatedAt
		}
		if e.Endpoint == "" {
			e.Endpoint = req.Endpoint
		}
		if e.Model == "" {
			e.Model = req.Model
		}
		if _, err := tx.ExecContext(ctx, s.bind(`INSERT INTO dlp_events
			(id, request_id, api_key_id, user_id, team_id, check_side, action, policy_ids, profile_id, entry_ids,
			 match_count, confidence, evidence, hashes, endpoint, model, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
			cleanArgs([]any{e.ID, e.RequestID, e.APIKeyID, e.UserID, e.TeamID, e.Check, e.Action, encodeList(e.PolicyIDs),
				e.ProfileID, encodeList(e.EntryIDs), e.MatchCount, e.Confidence, encodeList(e.Evidence), encodeList(e.Hashes),
				e.Endpoint, e.Model, formatTime(e.CreatedAt)})...); err != nil {
			return err
		}
	}
	return nil
}

func dlpEventWhere(f DLPEventFilter) (string, []any) {
	where := []string{"1=1"}
	args := []any{}
	if !f.Since.IsZero() {
		where = append(where, "created_at >= ?")
		args = append(args, formatTime(f.Since))
	}
	add := func(column, value string) {
		if value != "" {
			where = append(where, column+" = ?")
			args = append(args, value)
		}
	}
	add("request_id", f.RequestID)
	add("team_id", f.TeamID)
	add("action", strings.ToUpper(f.Action))
	add("check_side", strings.ToUpper(f.Check))
	add("profile_id", f.ProfileID)
	return strings.Join(where, " AND "), args
}

// ListDLPEvents returns the newest matching events.
func (s *SQLStore) ListDLPEvents(ctx context.Context, f DLPEventFilter) ([]DLPEvent, error) {
	if f.Limit <= 0 || f.Limit > 500 {
		f.Limit = 100
	}
	where, args := dlpEventWhere(f)
	args = append(args, f.Limit)
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT id, request_id, COALESCE(api_key_id, ''), COALESCE(user_id, ''), COALESCE(team_id, ''),
		check_side, action, policy_ids, profile_id, entry_ids, match_count, COALESCE(confidence, ''), evidence, hashes,
		COALESCE(endpoint, ''), COALESCE(model, ''), created_at
		FROM dlp_events WHERE `+where+` ORDER BY created_at DESC, id DESC LIMIT ?`), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DLPEvent{}
	for rows.Next() {
		var e DLPEvent
		var policies, entries, evidence, hashes, created string
		if err := rows.Scan(&e.ID, &e.RequestID, &e.APIKeyID, &e.UserID, &e.TeamID, &e.Check, &e.Action, &policies, &e.ProfileID,
			&entries, &e.MatchCount, &e.Confidence, &evidence, &hashes, &e.Endpoint, &e.Model, &created); err != nil {
			return nil, err
		}
		e.PolicyIDs, e.EntryIDs, e.Evidence, e.Hashes = decodeList(policies), decodeList(entries), decodeList(evidence), decodeList(hashes)
		e.CreatedAt, _ = parseStoredTime(created)
		out = append(out, e)
	}
	return out, rows.Err()
}

// DLPEventCount is one group of a DLP summary.
type DLPEventCount struct {
	Key      string `json:"key"`
	Events   int64  `json:"events"`
	Requests int64  `json:"requests"`
	Matches  int64  `json:"matches"`
}

// DLPEventSummary groups the events matching f by one dimension: action, check_side,
// profile_id, team_id or day.
func (s *SQLStore) DLPEventSummary(ctx context.Context, f DLPEventFilter, by string) ([]DLPEventCount, error) {
	column := ""
	switch by {
	case "action", "check_side", "profile_id", "team_id":
		column = by
	case "day":
		column = "SUBSTR(created_at, 1, 10)"
	default:
		return nil, errors.New("unsupported dlp summary dimension")
	}
	where, args := dlpEventWhere(f)
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT `+column+`, COUNT(*), COUNT(DISTINCT request_id), COALESCE(SUM(match_count), 0)
		FROM dlp_events WHERE `+where+` GROUP BY `+column+` ORDER BY COUNT(*) DESC LIMIT 100`), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DLPEventCount{}
	for rows.Next() {
		var c DLPEventCount
		if err := rows.Scan(&c.Key, &c.Events, &c.Requests, &c.Matches); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
