package proxy

import (
	"encoding/json"
	"testing"
)

func TestClickHouseRetryOpenAPIContract(t *testing.T) {
	raw, err := json.Marshal(buildOpenAPISpec())
	if err != nil {
		t.Fatal(err)
	}
	var spec map[string]any
	if err := json.Unmarshal(raw, &spec); err != nil {
		t.Fatal(err)
	}
	paths := spec["paths"].(map[string]any)
	assertJSONOperationSchema(t, paths, "/admin/dw/sink-retry", "get", "200", "DwRetryReadResponse")
	assertJSONOperationSchema(t, paths, "/admin/dw/sink-retry", "post", "200", "DwRetryWriteResponse")
	assertJSONOperationSchema(t, paths, "/admin/dw/sink-retry", "post", "202", "DwRetryRun")
	assertJSONRequestSchema(t, paths, "/admin/dw/sink-retry", "post", "DwRetryReviewedRequest")
	schemas := spec["components"].(map[string]any)["schemas"].(map[string]any)
	for _, name := range []string{"DwRetryReview", "DwRetryRun", "DwRetryDimension", "DwRetryProgress"} {
		properties := schemas[name].(map[string]any)["properties"].(map[string]any)
		for _, private := range []string{"actor", "worker_token", "lease_until", "url", "password", "reason"} {
			if _, exists := properties[private]; exists {
				t.Fatalf("private field %s exposed in %s", private, name)
			}
		}
	}
}
