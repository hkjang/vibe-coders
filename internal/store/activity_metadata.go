package store

import (
	"context"
	"time"
)

// These projections deliberately never load audit values, actor identities,
// rule names, webhook addresses or delivery error text into the overview read.
type AdminAuditMetadata struct {
	Action    string
	CreatedAt string
}

func (s *SQLStore) RecentAdminAuditMetadata(ctx context.Context, since, until time.Time) ([]AdminAuditMetadata, error) {
	where, args := metadataTimestampWindowSQL("created_at", since, until)
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT action, created_at FROM admin_audit_logs
		WHERE `+where+` ORDER BY `+metadataTimestampOrderSQL("created_at")+` DESC, id DESC LIMIT 6`), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []AdminAuditMetadata{}
	for rows.Next() {
		var entry AdminAuditMetadata
		if err := rows.Scan(&entry.Action, &entry.CreatedAt); err != nil {
			return nil, err
		}
		result = append(result, entry)
	}
	return result, rows.Err()
}

type AlertEventMetadata struct {
	Metric         string  `json:"metric"`
	Value          float64 `json:"value"`
	Threshold      float64 `json:"threshold"`
	Delivered      bool    `json:"delivered"`
	DeliveryFailed bool    `json:"delivery_failed"`
	CreatedAt      string  `json:"created_at"`
}

func (s *SQLStore) RecentAlertEventMetadata(ctx context.Context, since, until time.Time) ([]AlertEventMetadata, error) {
	where, args := metadataTimestampWindowSQL("created_at", since, until)
	rows, err := s.db.QueryContext(ctx, s.bind(`SELECT metric, value, threshold, delivered,
		CASE WHEN COALESCE(delivery_error, '') <> '' THEN 1 ELSE 0 END, created_at FROM alert_events
		WHERE `+where+` ORDER BY `+metadataTimestampOrderSQL("created_at")+` DESC, id DESC LIMIT 6`), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []AlertEventMetadata{}
	for rows.Next() {
		var entry AlertEventMetadata
		var delivered, failed int
		if err := rows.Scan(&entry.Metric, &entry.Value, &entry.Threshold, &delivered, &failed, &entry.CreatedAt); err != nil {
			return nil, err
		}
		entry.Delivered, entry.DeliveryFailed = delivered != 0, failed != 0
		result = append(result, entry)
	}
	return result, rows.Err()
}
