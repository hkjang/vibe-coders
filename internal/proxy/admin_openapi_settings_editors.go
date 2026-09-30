package proxy

// Settings editor contracts describe persisted snapshots rather than claiming
// that every pod has already activated the stored values.
func settingsEditorOpenAPISchemas() map[string]any {
	str := func() map[string]any { return map[string]any{"type": "string"} }
	boolean := func() map[string]any { return map[string]any{"type": "boolean"} }
	nullable := func(schema map[string]any) map[string]any {
		schema["nullable"] = true
		return schema
	}
	strings := func() map[string]any {
		return map[string]any{"type": "array", "items": str()}
	}
	roleMap := func() map[string]any {
		return map[string]any{"type": "object", "additionalProperties": str()}
	}
	keycloak := func() map[string]any {
		return map[string]any{
			"enabled": boolean(), "issuer_url": str(), "client_id": str(), "redirect_uri": str(),
			"scopes": strings(), "default_role": str(), "role_claim": str(), "group_claim": str(),
			"allow_local_login": boolean(), "auto_login": boolean(), "role_map": roleMap(),
		}
	}
	request := keycloak()
	request["scopes"].(map[string]any)["nullable"] = true
	request["scopes"].(map[string]any)["description"] = "Send null or an empty list to use default scopes; this does not retain a previous custom list."
	request["role_map"].(map[string]any)["nullable"] = true
	request["role_map"].(map[string]any)["description"] = "Omit or null to retain the stored mapping; an empty object restores built-in defaults."
	request["client_secret"] = map[string]any{"type": "string", "nullable": true, "writeOnly": true, "description": "Omit or null to retain the stored secret; empty string explicitly clears it."}
	request["expected_version"] = map[string]any{"type": "integer", "nullable": true, "minimum": 0, "description": "Version reviewed with the draft; 0 when no stored override exists. Omit or null for legacy requests without a client version precondition."}
	response := keycloak()
	response["scopes"].(map[string]any)["nullable"] = true
	response["client_secret_set"] = boolean()
	response["role_map_default"] = roleMap()
	response["role_map_custom"] = boolean()
	response["source"] = map[string]any{"type": "string", "enum": []string{"db", "env"}}
	response["db_backed"] = boolean()
	response["updated_at"], response["updated_by"], response["note"] = str(), str(), str()
	response["version"] = map[string]any{"type": "integer", "minimum": 0}
	return map[string]any{
		"KeycloakConfigRequest": map[string]any{
			"type": "object", "description": "Full replacement of the non-secret configuration, not a partial update. Only client_secret, role_map, and expected_version have omission semantics.",
			"required":   []string{"enabled", "issuer_url", "client_id", "redirect_uri", "scopes", "default_role", "role_claim", "group_claim", "allow_local_login", "auto_login"},
			"properties": request,
		},
		"KeycloakConfigResponse": map[string]any{
			"type": "object", "required": []string{"enabled", "issuer_url", "client_id", "client_secret_set", "redirect_uri", "scopes", "default_role", "role_claim", "group_claim", "allow_local_login", "auto_login", "role_map", "role_map_default", "role_map_custom", "source", "db_backed", "updated_at", "updated_by", "version", "note"},
			"properties": response,
		},
		"MattermostConfigRequest": map[string]any{"type": "object", "properties": map[string]any{
			"enabled": nullable(boolean()), "channel": nullable(str()),
			"events":      map[string]any{"type": "array", "items": str(), "nullable": true, "description": "Omit or null to retain the stored selection; an empty list disables every event category."},
			"webhook_url": map[string]any{"type": "string", "nullable": true, "writeOnly": true, "description": "Input-only webhook URL. Omit or null to keep; empty string clears it."},
		}},
		"MattermostConfigResponse": map[string]any{
			"type": "object", "required": []string{"enabled", "webhook_url", "webhook_url_set", "channel", "events", "available_events"},
			"properties": map[string]any{
				"enabled": boolean(), "channel": str(), "events": strings(), "available_events": strings(), "webhook_url_set": boolean(),
				"webhook_url": map[string]any{"type": "string", "enum": []string{"", "********"}, "description": "Presence mask only, never the stored URL."},
			},
		},
		"MattermostTestResponse": map[string]any{"type": "object", "required": []string{"status", "webhook_status"}, "properties": map[string]any{
			"status": map[string]any{"type": "string", "enum": []string{"sent"}}, "webhook_status": map[string]any{"type": "integer"},
		}},
	}
}
