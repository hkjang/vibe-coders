package proxy

import "testing"

func TestPersonalConsoleOpenAPIContract(t *testing.T) {
	spec := buildOpenAPISpec()
	paths := spec["paths"].(map[string]any)
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	for path, name := range map[string]string{
		"/me/dashboard": "MeConsoleDashboard", "/me/actions": "MeConsoleActions", "/me/notifications": "MeConsoleNotifications",
		"/me/report": "MeConsoleReport", "/me/requests": "MeConsoleRequests", "/me/requests/{id}/receipt": "MeConsoleReceipt",
		"/me/recommended-models": "MeConsoleModels", "/me/skills": "MeConsoleSkills", "/me/recommendations": "MeConsoleRecommendations",
	} {
		assertJSONOperationSchema(t, paths, path, "get", "200", name)
		op := paths[path].(map[string]any)["get"].(map[string]any)
		if op["requestBody"] != nil || schemas[name] == nil {
			t.Fatal("invalid personal read contract")
		}
	}
	for _, tc := range []struct{ path, status, schema string }{
		{"/me/actions/snooze", "200", "MeConsoleSnoozeResult"},
		{"/me/skills/{name}/request-access", "201", "MeConsoleSkillActionResult"},
		{"/me/skills/{name}/feedback", "201", "MeConsoleSkillActionResult"},
		{"/me/recommendations/{id}/feedback", "200", "MeConsoleRecommendationFeedbackResult"},
		{"/me/recommendations/feedback", "200", "MeConsoleRecommendationFeedbackResult"},
	} {
		assertJSONOperationSchema(t, paths, tc.path, "post", tc.status, tc.schema)
	}
	parameters := paths["/me/recommendations"].(map[string]any)["get"].(map[string]any)["parameters"].([]any)
	if len(parameters) != 1 || parameters[0].(map[string]any)["name"] != "refresh" || parameters[0].(map[string]any)["schema"].(map[string]any)["default"] != true {
		t.Fatal("stored/legacy recommendation query contract missing")
	}
	receipt := schemas["MeConsoleReceipt"].(map[string]any)["properties"].(map[string]any)
	tool := receipt["mcp_tools"].(map[string]any)["items"].(map[string]any)["properties"].(map[string]any)
	if tool["error"].(map[string]any)["type"] != "boolean" {
		t.Fatal("tool error must be boolean")
	}
	skill := schemas["MeConsoleSkills"].(map[string]any)["properties"].(map[string]any)["available"].(map[string]any)["items"].(map[string]any)["properties"].(map[string]any)
	if skill["success_rate"].(map[string]any)["maximum"] != 100 {
		t.Fatal("skill rate must be 0..100 percent")
	}
}
