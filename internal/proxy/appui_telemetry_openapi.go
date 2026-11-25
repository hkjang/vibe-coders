package proxy

import "vibe-coders/internal/store"

func appUITelemetryOpenAPISchemas() map[string]any {
	featureIDs := make([]string, 0, len(appUIFeatures))
	for _, feature := range appUIFeatures {
		featureIDs = append(featureIDs, feature.FeatureID)
	}
	featureID := map[string]any{"type": "string", "enum": featureIDs}
	count := map[string]any{"type": "integer", "minimum": 0, "maximum": store.AppUITelemetryVisitLimit}
	load := map[string]any{"type": "integer", "minimum": 0, "maximum": store.AppUITelemetryLoadLimitMS}
	totalLoad := map[string]any{"type": "integer", "minimum": 0, "maximum": int64(store.AppUITelemetryVisitLimit) * store.AppUITelemetryLoadLimitMS}
	return map[string]any{
		"UITelemetryEventRequest": map[string]any{
			"type": "object", "additionalProperties": false, "required": []string{"feature_id", "visit_id", "event"},
			"properties": map[string]any{
				"feature_id": featureID,
				"visit_id":   map[string]any{"type": "string", "minLength": 32, "maxLength": 32, "pattern": "^[0-9a-f]{32}$", "description": "128-bit cryptographically random per-feature visit nonce. Never derive from identity or persist in browser storage. Server retains only its SHA-256 hash."},
				"event":      map[string]any{"type": "string", "enum": []string{"visit", "legacy_fallback", "page_load"}},
				"load_ms":    load,
			},
			"oneOf": []any{
				map[string]any{"properties": map[string]any{"event": map[string]any{"enum": []string{"visit", "legacy_fallback"}}}, "not": map[string]any{"required": []string{"load_ms"}}},
				map[string]any{"required": []string{"load_ms"}, "properties": map[string]any{"event": map[string]any{"enum": []string{"page_load"}}}},
			},
			"description": "Opt-in, lossy observation. page_load measures initial route display, not completion of all data queries. The first accepted sample is immutable. X-Vibe-UI-Version is stored only when it is a bounded numeric release; all other labels become unknown.",
		},
		"UITelemetryFeatureCount": map[string]any{
			"type": "object", "additionalProperties": false, "required": []string{"feature_id", "visits", "legacy_opens"},
			"properties": map[string]any{"feature_id": featureID, "visits": count, "legacy_opens": count, "load_samples": count, "load_total_ms": totalLoad, "load_max_ms": load},
		},
		"UITelemetryVersionCount": map[string]any{
			"type": "object", "additionalProperties": false, "required": []string{"ui_version", "visits", "load_samples", "load_total_ms", "load_max_ms"},
			"properties": map[string]any{"ui_version": map[string]any{"type": "string", "maxLength": 32, "pattern": "^(v(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5}))?$", "description": "Empty means unknown or a custom build; never an arbitrary build label."}, "visits": count, "load_samples": count, "load_total_ms": totalLoad, "load_max_ms": load},
		},
		"UITelemetrySummaryResponse": map[string]any{
			"type": "object", "additionalProperties": false,
			"required": []string{"enabled", "days", "from", "to", "retention_days", "visit_limit", "features"},
			"properties": map[string]any{
				"enabled":                map[string]any{"type": "boolean"},
				"days":                   map[string]any{"type": "integer", "enum": []int{7, 30}},
				"from":                   map[string]any{"type": "string", "format": "date-time"},
				"to":                     map[string]any{"type": "string", "format": "date-time"},
				"retention_days":         map[string]any{"type": "integer", "enum": []int{store.AppUITelemetryRetentionDays}},
				"visit_limit":            map[string]any{"type": "integer", "enum": []int{store.AppUITelemetryVisitLimit}},
				"features":               map[string]any{"type": "array", "maxItems": len(appUIFeatures), "items": schemaRef("UITelemetryFeatureCount")},
				"load_metrics_available": map[string]any{"type": "boolean"},
				"load_limit_ms":          map[string]any{"type": "integer", "enum": []int{store.AppUITelemetryLoadLimitMS}},
				"version_limit":          map[string]any{"type": "integer", "enum": []int{store.AppUITelemetryVersionLimit}},
				"versions":               map[string]any{"type": "array", "maxItems": store.AppUITelemetryVersionLimit, "items": schemaRef("UITelemetryVersionCount")},
				"other_version_visits":   count,
			},
		},
	}
}
