package proxy

import "vibe-coders/internal/store"

func appUITelemetryOpenAPISchemas() map[string]any {
	featureIDs := make([]string, 0, len(appUIFeatures))
	for _, feature := range appUIFeatures {
		featureIDs = append(featureIDs, feature.FeatureID)
	}
	featureID := map[string]any{"type": "string", "enum": featureIDs}
	count := map[string]any{"type": "integer", "minimum": 0, "maximum": store.AppUITelemetryVisitLimit}
	return map[string]any{
		"UITelemetryEventRequest": map[string]any{
			"type": "object", "additionalProperties": false, "required": []string{"feature_id", "visit_id", "event"},
			"properties": map[string]any{
				"feature_id": featureID,
				"visit_id":   map[string]any{"type": "string", "minLength": 32, "maxLength": 32, "pattern": "^[0-9a-f]{32}$", "description": "128-bit cryptographically random per-feature visit nonce. Never derive from identity or persist in browser storage. Server retains only its SHA-256 hash."},
				"event":      map[string]any{"type": "string", "enum": []string{"visit", "legacy_fallback"}},
			},
		},
		"UITelemetryFeatureCount": map[string]any{
			"type": "object", "additionalProperties": false, "required": []string{"feature_id", "visits", "legacy_opens"},
			"properties": map[string]any{"feature_id": featureID, "visits": count, "legacy_opens": count},
		},
		"UITelemetrySummaryResponse": map[string]any{
			"type": "object", "additionalProperties": false,
			"required": []string{"enabled", "days", "from", "to", "retention_days", "visit_limit", "features"},
			"properties": map[string]any{
				"enabled":        map[string]any{"type": "boolean"},
				"days":           map[string]any{"type": "integer", "enum": []int{7, 30}},
				"from":           map[string]any{"type": "string", "format": "date-time"},
				"to":             map[string]any{"type": "string", "format": "date-time"},
				"retention_days": map[string]any{"type": "integer", "enum": []int{store.AppUITelemetryRetentionDays}},
				"visit_limit":    map[string]any{"type": "integer", "enum": []int{store.AppUITelemetryVisitLimit}},
				"features":       map[string]any{"type": "array", "maxItems": len(appUIFeatures), "items": schemaRef("UITelemetryFeatureCount")},
			},
		},
	}
}
