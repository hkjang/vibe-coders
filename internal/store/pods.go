package store

import (
	"context"
	"time"
)

// PodStatus is one gateway pod's last-known operational state, for the multi-pod operations map.
// Each pod heartbeats its own row; operators can see which pods are alive and whether every pod
// has converged on the latest runtime settings (applied_token == current_token).
type PodStatus struct {
	Hostname        string `json:"hostname"`
	BuildVersion    string `json:"build_version"`
	AppliedToken    string `json:"applied_token"`
	CurrentToken    string `json:"current_token"`
	ReloadIntervalS int    `json:"reload_interval_s"`
	LastSeen        string `json:"last_seen"`
	Stale           bool   `json:"stale"`      // computed: no heartbeat within the stale window
	UpToDate        bool   `json:"up_to_date"` // applied_token == current_token
}

// UpsertPodStatus records (or refreshes) a pod's heartbeat row, keyed by hostname.
func (s *SQLStore) UpsertPodStatus(ctx context.Context, p PodStatus) error {
	if p.LastSeen == "" {
		p.LastSeen = time.Now().UTC().Format(time.RFC3339Nano)
	}
	_, err := s.db.ExecContext(ctx, s.bind(`INSERT INTO pod_status
		(hostname, build_version, applied_token, current_token, reload_interval_s, last_seen)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (hostname) DO UPDATE SET
			build_version = excluded.build_version,
			applied_token = excluded.applied_token,
			current_token = excluded.current_token,
			reload_interval_s = excluded.reload_interval_s,
			last_seen = excluded.last_seen`),
		p.Hostname, p.BuildVersion, p.AppliedToken, p.CurrentToken, p.ReloadIntervalS, p.LastSeen)
	return err
}

// ListPods returns all known pods (newest heartbeat first), flagging pods whose last heartbeat is
// older than staleAfter and whether each has applied the latest settings token.
func (s *SQLStore) ListPods(ctx context.Context, staleAfter time.Duration) ([]PodStatus, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT hostname, COALESCE(build_version, ''), COALESCE(applied_token, ''),
		COALESCE(current_token, ''), COALESCE(reload_interval_s, 0), last_seen
		FROM pod_status ORDER BY last_seen DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	now := time.Now().UTC()
	out := []PodStatus{}
	for rows.Next() {
		var p PodStatus
		if err := rows.Scan(&p.Hostname, &p.BuildVersion, &p.AppliedToken, &p.CurrentToken, &p.ReloadIntervalS, &p.LastSeen); err != nil {
			return nil, err
		}
		p.UpToDate = p.AppliedToken == p.CurrentToken
		if t := parseOptionalTime(p.LastSeen); !t.IsZero() && now.Sub(t) > staleAfter {
			p.Stale = true
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
