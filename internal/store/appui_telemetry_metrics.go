package store

import (
	"context"
	"database/sql"
	"regexp"
	"strings"
	"time"
)

const AppUITelemetryVersionLimit = 20

// Arbitrary build labels may contain branch names, user data or secrets. Only
// bounded numeric releases enter storage; missing/custom builds remain unknown.
var appUIReleasePattern = regexp.MustCompile(`^v?(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$`)

func NormalizeAppUIReleaseVersion(value string) string {
	if !appUIReleasePattern.MatchString(value) {
		return ""
	}
	return "v" + strings.TrimPrefix(value, "v")
}

type AppUITelemetryMetrics struct {
	UIVersion string
	LoadMS    *int64
}

func (m AppUITelemetryMetrics) valid() bool {
	return (m.UIVersion == "" || m.UIVersion == NormalizeAppUIReleaseVersion(m.UIVersion)) &&
		(m.LoadMS == nil || (*m.LoadMS >= 0 && *m.LoadMS <= AppUITelemetryLoadLimitMS))
}

type AppUITelemetryVersionCount struct {
	UIVersion   string `json:"ui_version"`
	Visits      int64  `json:"visits"`
	LoadSamples int64  `json:"load_samples"`
	LoadTotalMS int64  `json:"load_total_ms"`
	LoadMaxMS   int64  `json:"load_max_ms"`
}

type AppUITelemetryUsage struct {
	Features           []AppUITelemetryCount
	Versions           []AppUITelemetryVersionCount
	OtherVersionVisits int64
}

// AppUITelemetryUsageSummary projects authorized features only. Both groups are
// read from one database snapshot, so a concurrent intake cannot make version
// totals exceed the feature totals. Version output is bounded independently of
// the visit cap and never returns arbitrary labels stored outside this API.
func (s *SQLStore) AppUITelemetryUsageSummary(ctx context.Context, since, now time.Time, features []string) (AppUITelemetryUsage, error) {
	out := AppUITelemetryUsage{Features: []AppUITelemetryCount{}, Versions: []AppUITelemetryVersionCount{}}
	if now.IsZero() || now.Unix() <= 0 || len(features) > 256 {
		return out, ErrAppUITelemetryInvalidInput
	}
	if len(features) == 0 || since.After(now) {
		return out, nil
	}
	cutoff := now.Add(-AppUITelemetryRetentionDays * 24 * time.Hour).Unix()
	if since.Unix() < cutoff {
		since = time.Unix(cutoff, 0)
	}
	args := []any{cutoff, since.Unix(), now.Unix()}
	placeholders := make([]string, 0, len(features))
	seen := map[string]bool{}
	for _, feature := range features {
		if len(feature) > 64 || !appUITelemetryFeaturePattern.MatchString(feature) || seen[feature] {
			return out, ErrAppUITelemetryInvalidInput
		}
		seen[feature] = true
		placeholders = append(placeholders, "?")
		args = append(args, feature)
	}
	where := ` FROM app_ui_telemetry_visits WHERE first_seen_epoch > ? AND first_seen_epoch >= ? AND first_seen_epoch <= ? AND feature_id IN (` + strings.Join(placeholders, ",") + `)`
	options := &sql.TxOptions{ReadOnly: true}
	if s.dialect == "postgres" {
		options.Isolation = sql.LevelRepeatableRead
	}
	tx, err := s.db.BeginTx(ctx, options)
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, s.bind(`SELECT feature_id, COUNT(*), SUM(legacy_open), COUNT(load_ms), COALESCE(SUM(load_ms), 0), COALESCE(MAX(load_ms), 0)`+where+` GROUP BY feature_id ORDER BY feature_id`), args...)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var count AppUITelemetryCount
		if err := rows.Scan(&count.FeatureID, &count.Visits, &count.LegacyOpens, &count.LoadSamples, &count.LoadTotalMS, &count.LoadMaxMS); err != nil {
			rows.Close()
			return out, err
		}
		out.Features = append(out.Features, count)
		out.OtherVersionVisits += count.Visits
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	rows, err = tx.QueryContext(ctx, s.bind(`SELECT ui_version, COUNT(*) AS visits, COUNT(load_ms), COALESCE(SUM(load_ms), 0), COALESCE(MAX(load_ms), 0)`+where+` GROUP BY ui_version ORDER BY visits DESC, ui_version ASC LIMIT 20`), args...)
	if err != nil {
		return out, err
	}
	versionIndex := map[string]int{}
	for rows.Next() {
		var count AppUITelemetryVersionCount
		if err := rows.Scan(&count.UIVersion, &count.Visits, &count.LoadSamples, &count.LoadTotalMS, &count.LoadMaxMS); err != nil {
			rows.Close()
			return out, err
		}
		// A manual DB write must not turn this aggregate into a string channel.
		count.UIVersion = NormalizeAppUIReleaseVersion(count.UIVersion)
		if index, exists := versionIndex[count.UIVersion]; exists {
			previous := &out.Versions[index]
			previous.Visits += count.Visits
			previous.LoadSamples += count.LoadSamples
			previous.LoadTotalMS += count.LoadTotalMS
			previous.LoadMaxMS = max(previous.LoadMaxMS, count.LoadMaxMS)
		} else {
			versionIndex[count.UIVersion] = len(out.Versions)
			out.Versions = append(out.Versions, count)
		}
		out.OtherVersionVisits -= count.Visits
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	return out, tx.Commit()
}
