package proxy

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestRedTeamEvidenceReadOpenAPI(t *testing.T) {
	s, _, _ := newAdminModelsTestServer(t, "")
	w := httptest.NewRecorder()
	s.Routes().ServeHTTP(w, httptest.NewRequest("GET", "/openapi.json", nil))
	var d map[string]any
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &d) != nil {
		t.Fatal("missing contract")
	}
	paths := d["paths"].(map[string]any)
	for path, count := range map[string]int{"/admin/redteam/results/{id}/evidence": 3, "/admin/redteam/runs/{id}/results": 2} {
		op := paths[path].(map[string]any)["get"].(map[string]any)
		if len(op["parameters"].([]any)) != count {
			t.Fatal("missing explicit read parameters", path)
		}
		responses := op["responses"].(map[string]any)
		if responses["403"] == nil || responses["503"] == nil {
			t.Fatal("read errors undocumented", path)
		}
	}
	schemas := d["components"].(map[string]any)["schemas"].(map[string]any)
	for _, name := range []string{"RedTeamEvidenceRead", "RedTeamResultsRead", "RedTeamEvidenceLegacyRead", "RedTeamResultsLegacyRead"} {
		if schemas[name] == nil {
			t.Fatal("missing read schema", name)
		}
	}
}
