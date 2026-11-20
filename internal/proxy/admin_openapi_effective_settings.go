package proxy

func effectiveSettingsOpenAPISchemas(base map[string]any) map[string]any {
	text := map[string]any{"type": "string"}
	flag := map[string]any{"type": "boolean"}
	integer := map[string]any{"type": "integer", "minimum": 0}
	object := func(required []string, props map[string]any) map[string]any {
		schema := map[string]any{"type": "object", "properties": props, "additionalProperties": false}
		if len(required) > 0 {
			schema["required"] = required
		}
		return schema
	}
	array := func(item map[string]any) map[string]any { return map[string]any{"type": "array", "items": item} }
	properties := map[string]any{}
	for key, value := range base["properties"].(map[string]any) {
		properties[key] = value
	}
	for _, key := range []string{"effective_source", "active_layer", "permission_group"} {
		properties[key] = text
	}
	for _, key := range []string{"can_write", "runtime_overridden", "request_scoped"} {
		properties[key] = flag
	}
	properties["layers"] = array(schemaRef("EffectiveSettingLayer"))
	return map[string]any{
		"EffectiveSettingView": object(base["required"].([]string), properties),
		"EffectiveSettingLayer": object([]string{"name", "source", "configured", "active", "value", "is_set", "writable"}, map[string]any{
			"name": text, "source": text, "configured": flag, "active": flag, "value": text, "is_set": flag, "writable": flag,
			"version": integer, "updated_by": text, "updated_at": text, "error": flag,
		}),
		"SettingsPodStatus": object(nil, map[string]any{
			"hostname": text, "last_reload_at": text, "applied_token": text, "current_token": text, "up_to_date": flag, "reload_interval": text,
		}),
		"EffectiveSettingsResponse": object([]string{"settings"}, map[string]any{
			"settings": array(schemaRef("EffectiveSettingView")), "category": text, "layers": array(text), "resolution_order": array(text), "this_pod": schemaRef("SettingsPodStatus"),
		}),
	}
}
