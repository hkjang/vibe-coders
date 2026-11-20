package proxy

import (
	"encoding/json"
	"testing"
)

func TestRedTeamJobOpenAPI(t *testing.T) {
	raw, err := json.Marshal(buildOpenAPISpec())
	if err != nil {
		t.Fatal(err)
	}
	var spec map[string]any
	if err := json.Unmarshal(raw, &spec); err != nil {
		t.Fatal(err)
	}
	paths := spec["paths"].(map[string]any)
	path := "/admin/redteam/campaigns/{id}/run-reviewed"
	assertJSONOperationSchema(t, paths, path, "get", "200", "RedTeamExecutionJob")
	assertJSONOperationSchema(t, paths, path, "post", "200", "RedTeamReviewedWriteResponse")
	assertJSONOperationSchema(t, paths, path, "post", "202", "RedTeamExecutionJob")
	assertJSONRequestSchema(t, paths, path, "post", "RedTeamReviewedExecutionRequest")
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	job := schemas["RedTeamExecutionJob"].(map[string]any)["properties"].(map[string]any)
	for _, private := range []string{"actor", "worker_token", "lease_until", "proxy_key", "review_token", "prompt", "response"} {
		if _, ok := job[private]; ok {
			t.Fatal("private schema field", private)
		}
	}
	review := schemas["RedTeamRunReviewResponse"].(map[string]any)
	if _, ok := review["properties"].(map[string]any)["job_id"]; !ok {
		t.Fatal("review lacks pre-admission recovery reference")
	}
	for _, required := range review["required"].([]any) {
		if required == "job_id" {
			t.Fatal("optional capability made required for older servers")
		}
	}
	if _, ok := schemas["RedTeamReplayReviewResponse"].(map[string]any)["properties"].(map[string]any)["job_id"]; ok {
		t.Fatal("single-case replay incorrectly advertises campaign jobs")
	}
}
