package proxy

import "testing"

func TestTeamConsoleOpenAPIContract(t *testing.T) {
	spec := buildOpenAPISpec()
	paths := spec["paths"].(map[string]any)
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	for path, name := range map[string]string{
		"/team/dashboard": "TeamConsoleDashboard", "/team/reports": "TeamConsoleReports", "/team/portal": "TeamConsolePortal", "/team/risk": "TeamConsoleRisk",
		"/team/onboarding": "TeamConsoleOnboarding", "/team/savings-challenge": "TeamConsoleSavings", "/team/skills/popular": "TeamConsoleSkills", "/team/templates/candidates": "TeamConsoleCandidates",
	} {
		assertJSONOperationSchema(t, paths, path, "get", "200", name)
		op := paths[path].(map[string]any)["get"].(map[string]any)
		if op["requestBody"] != nil {
			t.Fatal("read operation has a body")
		}
		if schemas[name] == nil {
			t.Fatal("missing response schema")
		}
		for _, status := range []string{"400", "401", "403", "405", "500"} {
			assertJSONOperationSchema(t, paths, path, "get", status, "AppError")
		}
	}
	assertJSONOperationSchema(t, paths, "/team/reports", "post", "200", "TeamConsoleDecisionResult")
	risk := schemas["TeamConsoleRisk"].(map[string]any)["properties"].(map[string]any)
	if risk["blocked_trend"].(map[string]any)["type"] != "integer" {
		t.Fatal("risk delta is not an integer")
	}
	report := schemas["TeamConsoleReport"].(map[string]any)["properties"].(map[string]any)
	if report["revision"].(map[string]any)["pattern"] != "^[a-f0-9]{64}$" {
		t.Fatal("review revision contract missing")
	}
}
