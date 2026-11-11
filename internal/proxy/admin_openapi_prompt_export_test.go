package proxy

import "testing"

func TestPromptExportCSVOpenAPIContract(t *testing.T) {
	paths := buildOpenAPISpec()["paths"].(map[string]any)
	op := paths["/admin/export.csv"].(map[string]any)["get"].(map[string]any)
	responses := op["responses"].(map[string]any)
	response := responses["200"].(map[string]any)
	content := response["content"].(map[string]any)
	if len(content) != 1 || content["text/csv"].(map[string]any)["schema"].(map[string]any)["type"] != "string" {
		t.Fatal("CSV export must be typed text, not a JSON response")
	}
	if op["requestBody"] != nil || len(op["parameters"].([]any)) != 6 {
		t.Fatal("existing bodyless GET filters changed")
	}
	for _, status := range []string{"401", "405", "500"} {
		assertJSONOperationSchema(t, paths, "/admin/export.csv", "get", status, "AppError")
	}
}
